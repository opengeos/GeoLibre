"""Application-level encryption for secrets stored in the database.

Secrets such as an organization identity provider's OIDC ``client_secret`` are
encrypted with Fernet (AES-128-CBC plus HMAC-SHA256) under a key read from
``GEOLIBRE_SECRET_KEYS``: a comma-separated list of Fernet keys. The first key
encrypts; every key decrypts, so an operator rotates by prepending a new key
and restarting (startup re-encrypts rows still under an older key).

Ciphertext is stored with the ``enc:v1:`` prefix. A value without the prefix is
a legacy plaintext row from before encryption existed: it reads back unchanged
and startup (or ``alembic upgrade head``) encrypts it in place. A legacy
plaintext credential that already used this prefix is ambiguous and needs
operator repair; a value marked as ciphertext is never silently treated as plaintext.
"""

from __future__ import annotations

import functools
import logging
import os
from collections.abc import Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from urllib.parse import urlparse

from cryptography.fernet import Fernet, InvalidToken, MultiFernet
from sqlalchemy import Text, literal, select, type_coerce, update
from sqlalchemy.engine import Connection
from sqlalchemy.types import TypeDecorator

SECRET_KEYS_ENV = "GEOLIBRE_SECRET_KEYS"
PLAINTEXT_SECRETS_ENV = "GEOLIBRE_ALLOW_PLAINTEXT_SECRETS"
CIPHERTEXT_PREFIX = "enc:v1:"
LOOPBACK_HOSTS = frozenset({"localhost", "127.0.0.1", "::1"})

logger = logging.getLogger(__name__)
_storage_public_url: ContextVar[str | None] = ContextVar("secret_storage_public_url", default=None)


@contextmanager
def secret_storage_policy(public_url: str) -> Iterator[None]:
    """Scope storage checks to the effective URL of the application.

    Args:
        public_url: The URL selected by the application factory.

    Yields:
        Control with that application's plaintext storage policy active.
    """
    token = _storage_public_url.set(public_url)
    try:
        yield
    finally:
        _storage_public_url.reset(token)


class SecretKeyError(RuntimeError):
    """Raised when secrets cannot be encrypted or decrypted with the configured keys."""


@functools.lru_cache(maxsize=8)
def _cipher_for(raw: str) -> tuple[Fernet, MultiFernet]:
    keys = [part.strip() for part in raw.split(",") if part.strip()]
    try:
        fernets = [Fernet(key.encode("ascii")) for key in keys]
    except (ValueError, UnicodeEncodeError) as exc:
        raise SecretKeyError(
            f"{SECRET_KEYS_ENV} must be a comma-separated list of Fernet keys "
            "(32 url-safe base64-encoded bytes each; generate one with "
            '`python -c "from cryptography.fernet import Fernet; '
            'print(Fernet.generate_key().decode())"`)'
        ) from exc
    return fernets[0], MultiFernet(fernets)


def secret_ciphers() -> tuple[Fernet, MultiFernet] | None:
    """Return the (primary, all-keys) ciphers from the environment.

    Returns:
        The primary Fernet used to encrypt and a MultiFernet over every
        configured key used to decrypt, or ``None`` when no key is configured.

    Raises:
        SecretKeyError: If the configured value is not a list of Fernet keys.
    """
    raw = os.getenv(SECRET_KEYS_ENV, "").strip()
    if not raw.strip(", "):
        return None
    return _cipher_for(raw)


def is_encrypted(value: str | None) -> bool:
    """Return whether a stored value carries the ciphertext prefix.

    Args:
        value: A raw column value.

    Returns:
        True for a value written by :func:`encrypt_secret` under a key.
    """
    return value is not None and value.startswith(CIPHERTEXT_PREFIX)


def plaintext_secrets_enabled() -> bool:
    """Return whether the operator explicitly opted out of secret encryption.

    Returns:
        True for an explicit development opt-out. The app additionally requires
        a loopback public URL before honoring this setting.
    """
    return os.getenv(PLAINTEXT_SECRETS_ENV, "").strip().lower() in {"1", "true", "yes", "on"}


def encrypt_secret(plaintext: str) -> str:
    """Encrypt a secret for storage, requiring an explicit plaintext opt-out.

    Args:
        plaintext: The secret to store.

    Returns:
        ``enc:v1:<fernet token>``, or ``plaintext`` unchanged when
        ``GEOLIBRE_SECRET_KEYS`` is unset and the operator explicitly enabled
        ``GEOLIBRE_ALLOW_PLAINTEXT_SECRETS`` for development.

    Raises:
        SecretKeyError: If encryption is required or plaintext is ambiguous.
    """
    ciphers = secret_ciphers()
    if ciphers is None:
        validate_plaintext_secret(plaintext)
        if not plaintext_secrets_enabled() or is_production_url(
            _storage_public_url.get() or os.getenv("GEOLIBRE_PUBLIC_URL", "http://localhost:8000")
        ):
            raise SecretKeyError(
                f"{SECRET_KEYS_ENV} is required before storing secrets; only loopback "
                "development may explicitly opt out"
            )
        return plaintext
    token = ciphers[0].encrypt(plaintext.encode("utf-8")).decode("ascii")
    return CIPHERTEXT_PREFIX + token


def validate_plaintext_secret(plaintext: str) -> None:
    """Reject credentials that cannot be stored unambiguously without a key.

    Args:
        plaintext: The credential supplied by an administrator.

    Raises:
        SecretKeyError: If unencrypted text would resemble stored ciphertext.
    """
    if plaintext.startswith(CIPHERTEXT_PREFIX) and secret_ciphers() is None:
        raise SecretKeyError(
            f"a secret starting with {CIPHERTEXT_PREFIX!r} needs {SECRET_KEYS_ENV} set"
        )


def decrypt_secret(stored: str) -> str:
    """Decrypt a stored secret; legacy plaintext values pass through.

    Args:
        stored: The raw column value.

    Returns:
        The plaintext secret.

    Raises:
        SecretKeyError: If the value is encrypted but no configured key opens it.
    """
    if not is_encrypted(stored):
        return stored
    ciphers = secret_ciphers()
    if ciphers is None:
        raise SecretKeyError(
            f"an encrypted secret is stored but {SECRET_KEYS_ENV} is not set; "
            "restore the key the database was written with"
        )
    try:
        return ciphers[1].decrypt(stored[len(CIPHERTEXT_PREFIX) :].encode("ascii")).decode("utf-8")
    except (InvalidToken, UnicodeError) as exc:
        raise SecretKeyError(
            f"a stored secret cannot be decrypted with any key in {SECRET_KEYS_ENV}; "
            "keep older keys in the list until every secret is re-encrypted"
        ) from exc


class EncryptedText(TypeDecorator):
    """A Text column that encrypts on write and decrypts on read."""

    impl = Text
    cache_ok = True

    def process_bind_param(self, value, dialect):
        """Encrypt a value on its way to the database.

        Args:
            value: The plaintext attribute value, or None.
            dialect: The SQLAlchemy dialect (unused).

        Returns:
            The value to store.
        """
        if value is None:
            return value
        return encrypt_secret(value)

    def process_result_value(self, value, dialect):
        """Decrypt a value read from the database.

        Args:
            value: The stored column value, or None.
            dialect: The SQLAlchemy dialect (unused).

        Returns:
            The plaintext attribute value.
        """
        if value is None:
            return None
        return decrypt_secret(value)


def is_production_url(public_url: str) -> bool:
    """Return whether the public API URL names a non-loopback deployment.

    Args:
        public_url: The externally reachable API URL (``GEOLIBRE_PUBLIC_URL``).

    Returns:
        False for localhost/loopback development URLs, True otherwise.
    """
    try:
        host = (urlparse(public_url).hostname or "").lower()
    except ValueError:
        return True
    return host not in LOOPBACK_HOSTS


def reencrypt_stored_secrets(connection: Connection, table, column) -> int:
    """Encrypt plaintext rows and move rows under older keys to the primary key.

    Reads and writes the raw column (bypassing :class:`EncryptedText`) so it
    works from Alembic with lightweight table definitions as well as from the
    ORM table at startup.

    Args:
        connection: An open connection inside a transaction.
        table: The table holding the secret.
        column: The secret column of ``table``; the table must have an ``id``.

    Returns:
        The number of rows rewritten.

    Raises:
        SecretKeyError: If no key is configured while plaintext or encrypted
            rows exist, or a stored value cannot be decrypted.
    """
    ciphers = secret_ciphers()
    # type_coerce to plain Text skips EncryptedText's result processing.
    rows = connection.execute(
        select(table.c.id, type_coerce(column, Text)).where(column.is_not(None)).with_for_update()
    ).all()
    if not rows:
        return 0
    if ciphers is None:
        if any(is_encrypted(value) for _id, value in rows):
            raise SecretKeyError(
                f"encrypted secrets are stored but {SECRET_KEYS_ENV} is not set; "
                "restore the key the database was written with"
            )
        return 0
    primary, every = ciphers
    rewritten = 0
    for row_id, value in rows:
        if is_encrypted(value):
            try:
                token = value[len(CIPHERTEXT_PREFIX) :].encode("ascii")
                try:
                    primary.decrypt(token)
                    continue
                except InvalidToken:
                    pass
                plaintext = every.decrypt(token)
            except (InvalidToken, UnicodeError) as exc:
                raise SecretKeyError(
                    f"a stored secret cannot be decrypted with any key in {SECRET_KEYS_ENV} "
                    f"for {table.name} row {row_id!r}. Restore the original key for "
                    "ciphertext. If this is a legacy plaintext credential using the "
                    "reserved prefix, re-enter the credential encrypted under the "
                    "configured key before retrying; see the server API recovery guide."
                ) from exc
        else:
            plaintext = value.encode("utf-8")
        new_value = CIPHERTEXT_PREFIX + primary.encrypt(plaintext).decode("ascii")
        connection.execute(
            update(table)
            .where(table.c.id == row_id)
            .values({column.name: literal(new_value, Text)})
        )
        rewritten += 1
    if rewritten:
        logger.info("encrypted or re-keyed %d stored secret(s)", rewritten)
    return rewritten
