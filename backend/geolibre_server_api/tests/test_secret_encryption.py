"""Identity provider client secrets are encrypted at rest under GEOLIBRE_SECRET_KEYS."""

from __future__ import annotations

import json
import logging
from pathlib import Path

import pytest
from alembic import command
from alembic.config import Config
from conftest import OAUTH_CLIENTS, PUBLIC_URL, TEST_SECRET_KEY
from cryptography.fernet import Fernet
from fake_idp import FakeIdp
from fastapi.testclient import TestClient
from geolibre_server_api.main import FileStorage, create_app
from geolibre_server_api.secret_crypto import (
    CIPHERTEXT_PREFIX,
    SecretKeyError,
    decrypt_secret,
    encrypt_secret,
)
from helpers import account, admin_token, configure_idp, create_org
from sqlalchemy import create_engine, text

ALEMBIC_INI = Path(__file__).resolve().parents[1] / "alembic.ini"


@pytest.fixture
def keep_loggers_enabled():
    """Undo alembic.ini's fileConfig, which disables every existing logger.

    Without this, later tests that assert on ``caplog`` see no records.
    """
    loggers = [logging.getLogger(name) for name in logging.root.manager.loggerDict]
    states = [(logger, logger.disabled) for logger in loggers]
    root_level, root_handlers = logging.root.level, list(logging.root.handlers)
    yield
    for logger, disabled in states:
        logger.disabled = disabled
    logging.root.setLevel(root_level)
    logging.root.handlers[:] = root_handlers


def _raw_secrets(db_url: str) -> list[str]:
    engine = create_engine(db_url)
    try:
        with engine.connect() as connection:
            return list(
                connection.scalars(
                    text("SELECT client_secret FROM organization_identity_providers")
                )
            )
    finally:
        engine.dispose()


def _app(db_url: str, tmp_path: Path, public_url: str = PUBLIC_URL, transport=None):
    return create_app(
        db_url,
        public_url=public_url,
        storage=FileStorage(str(tmp_path / "objects")),
        oidc_transport=transport,
    )


def _store_provider(db_url: str, tmp_path: Path, fake_idp: FakeIdp, monkeypatch):
    monkeypatch.setenv("GEOLIBRE_OAUTH_CLIENTS", json.dumps(OAUTH_CLIENTS))
    app = _app(db_url, tmp_path, transport=fake_idp.transport)
    with TestClient(app, base_url=PUBLIC_URL) as client:
        token = admin_token(client)
        org_id = create_org(client, token)
        response = configure_idp(client, token, org_id)
    app.state.engine.dispose()
    return response


def _insert_plaintext_secret(db_url: str, secret: str) -> None:
    engine = create_engine(db_url)
    try:
        with engine.begin() as connection:
            connection.execute(
                text("UPDATE organization_identity_providers SET client_secret=:s"), {"s": secret}
            )
    finally:
        engine.dispose()


def test_round_trip_and_wrong_key(monkeypatch):
    stored = encrypt_secret("s3cret")
    assert stored.startswith(CIPHERTEXT_PREFIX)
    assert "s3cret" not in stored
    assert decrypt_secret(stored) == "s3cret"
    # Legacy plaintext reads back unchanged.
    assert decrypt_secret("plain") == "plain"
    monkeypatch.setenv("GEOLIBRE_SECRET_KEYS", Fernet.generate_key().decode())
    with pytest.raises(SecretKeyError, match="cannot be decrypted"):
        decrypt_secret(stored)
    monkeypatch.delenv("GEOLIBRE_SECRET_KEYS")
    with pytest.raises(SecretKeyError, match="not set"):
        decrypt_secret(stored)


def test_crypto_rejects_public_plaintext_opt_out(monkeypatch):
    """Protect direct crypto callers when the configured deployment is public.

    Args:
        monkeypatch: The pytest patch fixture.
    """
    monkeypatch.delenv("GEOLIBRE_SECRET_KEYS")
    monkeypatch.setenv("GEOLIBRE_ALLOW_PLAINTEXT_SECRETS", "1")
    monkeypatch.setenv("GEOLIBRE_PUBLIC_URL", PUBLIC_URL)
    with pytest.raises(SecretKeyError, match="loopback"):
        encrypt_secret("must-not-be-written-in-plaintext")


def test_secret_is_stored_encrypted_and_used_decrypted(tmp_path, fake_idp, monkeypatch):
    db_url = f"sqlite:///{tmp_path / 'enc.db'}"
    response = _store_provider(db_url, tmp_path, fake_idp, monkeypatch)
    assert response.status_code == 200, response.text
    (raw,) = _raw_secrets(db_url)
    assert raw.startswith(CIPHERTEXT_PREFIX)
    assert FakeIdp.CLIENT_SECRET not in raw
    assert decrypt_secret(raw) == FakeIdp.CLIENT_SECRET


def test_startup_encrypts_legacy_plaintext_and_rotates_keys(tmp_path, fake_idp, monkeypatch):
    db_url = f"sqlite:///{tmp_path / 'legacy.db'}"
    _store_provider(db_url, tmp_path, fake_idp, monkeypatch)
    _insert_plaintext_secret(db_url, "legacy-plain")

    _app(db_url, tmp_path).state.engine.dispose()
    (raw,) = _raw_secrets(db_url)
    assert raw.startswith(CIPHERTEXT_PREFIX)
    assert decrypt_secret(raw) == "legacy-plain"

    # Prepend a new key: startup moves the row onto it, and the old key can go.
    new_key = Fernet.generate_key().decode()
    monkeypatch.setenv("GEOLIBRE_SECRET_KEYS", f"{new_key},{TEST_SECRET_KEY}")
    _app(db_url, tmp_path).state.engine.dispose()
    monkeypatch.setenv("GEOLIBRE_SECRET_KEYS", new_key)
    (rotated,) = _raw_secrets(db_url)
    assert rotated != raw
    assert decrypt_secret(rotated) == "legacy-plain"


def test_production_startup_fails_without_key_when_secrets_exist(tmp_path, fake_idp, monkeypatch):
    db_url = f"sqlite:///{tmp_path / 'prod.db'}"
    _store_provider(db_url, tmp_path, fake_idp, monkeypatch)
    monkeypatch.delenv("GEOLIBRE_SECRET_KEYS")
    with pytest.raises(RuntimeError, match="GEOLIBRE_SECRET_KEYS is required"):
        _app(db_url, tmp_path)


def test_wrong_key_fails_startup_clearly(tmp_path, fake_idp, monkeypatch):
    db_url = f"sqlite:///{tmp_path / 'wrong.db'}"
    _store_provider(db_url, tmp_path, fake_idp, monkeypatch)
    monkeypatch.setenv("GEOLIBRE_SECRET_KEYS", Fernet.generate_key().decode())
    with pytest.raises(RuntimeError, match="cannot be decrypted"):
        _app(db_url, tmp_path)


def test_malformed_key_fails_startup(tmp_path, monkeypatch):
    monkeypatch.setenv("GEOLIBRE_SECRET_KEYS", "not-a-fernet-key")
    with pytest.raises(RuntimeError, match="Fernet keys"):
        _app(f"sqlite:///{tmp_path / 'bad.db'}", tmp_path)


def test_production_refuses_to_store_secret_without_key(tmp_path, fake_idp, monkeypatch):
    monkeypatch.delenv("GEOLIBRE_SECRET_KEYS")
    response = _store_provider(
        f"sqlite:///{tmp_path / 'nokey.db'}", tmp_path, fake_idp, monkeypatch
    )
    assert response.status_code == 503
    assert "GEOLIBRE_SECRET_KEYS" in response.json()["error"]


def test_development_without_key_keeps_plaintext(tmp_path, fake_idp, monkeypatch):
    db_url = f"sqlite:///{tmp_path / 'dev.db'}"
    _store_provider(db_url, tmp_path, fake_idp, monkeypatch)
    _insert_plaintext_secret(db_url, "dev-plain")
    monkeypatch.delenv("GEOLIBRE_SECRET_KEYS")
    monkeypatch.setenv("GEOLIBRE_ALLOW_PLAINTEXT_SECRETS", "1")
    monkeypatch.delenv("GEOLIBRE_OAUTH_CLIENTS")
    app = _app(db_url, tmp_path, public_url="http://localhost:8000")
    assert app.state.secrets_unprotected is False
    app.state.engine.dispose()
    assert _raw_secrets(db_url) == ["dev-plain"]
    assert encrypt_secret("dev") == "dev"


def test_alembic_migration_encrypts_existing_rows(
    tmp_path, fake_idp, monkeypatch, keep_loggers_enabled
):
    db_url = f"sqlite:///{tmp_path / 'migrate.db'}"
    monkeypatch.setenv("GEOLIBRE_DATABASE_URL", db_url)
    cfg = Config(str(ALEMBIC_INI))
    cfg.set_main_option("sqlalchemy.url", db_url)
    command.upgrade(cfg, "0002_enterprise_lifecycle")
    monkeypatch.setenv("GEOLIBRE_SKIP_DDL_CREATE_ALL", "1")
    _store_provider(db_url, tmp_path, fake_idp, monkeypatch)
    _insert_plaintext_secret(db_url, "pre-migration")

    command.upgrade(cfg, "head")
    (raw,) = _raw_secrets(db_url)
    assert raw.startswith(CIPHERTEXT_PREFIX)
    assert decrypt_secret(raw) == "pre-migration"

    command.downgrade(cfg, "0002_enterprise_lifecycle")
    assert _raw_secrets(db_url) == ["pre-migration"]


@pytest.mark.parametrize("public_url", [PUBLIC_URL, "http://localhost:8000"])
@pytest.mark.parametrize("opt_out", [False, True])
def test_alembic_migration_matches_startup_key_policy(
    tmp_path, fake_idp, monkeypatch, keep_loggers_enabled, public_url, opt_out
):
    """Require a key except for an explicit loopback development opt-out.

    Args:
        tmp_path: Isolated database directory.
        fake_idp: The test identity provider.
        monkeypatch: The pytest patch fixture.
        keep_loggers_enabled: Restore logging after Alembic configuration.
        public_url: The deployment URL supplied to migration and startup.
        opt_out: Whether development plaintext storage was explicitly enabled.
    """
    db_url = f"sqlite:///{tmp_path / 'migrate-nokey.db'}"
    monkeypatch.setenv("GEOLIBRE_DATABASE_URL", db_url)
    cfg = Config(str(ALEMBIC_INI))
    cfg.set_main_option("sqlalchemy.url", db_url)
    command.upgrade(cfg, "0002_enterprise_lifecycle")
    monkeypatch.setenv("GEOLIBRE_SKIP_DDL_CREATE_ALL", "1")
    _store_provider(db_url, tmp_path, fake_idp, monkeypatch)
    _insert_plaintext_secret(db_url, "pre-migration")

    monkeypatch.delenv("GEOLIBRE_SECRET_KEYS")
    monkeypatch.setenv("GEOLIBRE_PUBLIC_URL", public_url)
    monkeypatch.setenv("GEOLIBRE_ALLOW_PLAINTEXT_SECRETS", "1" if opt_out else "0")
    if opt_out and public_url.startswith("http://localhost"):
        command.upgrade(cfg, "head")
        app = _app(db_url, tmp_path, public_url=public_url)
        app.state.engine.dispose()
        assert _raw_secrets(db_url) == ["pre-migration"]
    else:
        with pytest.raises(SecretKeyError, match="before upgrading"):
            command.upgrade(cfg, "head")
        assert _raw_secrets(db_url) == ["pre-migration"]


@pytest.mark.parametrize("secret", ["enc:v1:", "enc:v1:legacy-plaintext", "enc:v1:雪"])
def test_ambiguous_legacy_secrets_report_the_row_and_support_repair(
    tmp_path, fake_idp, monkeypatch, keep_loggers_enabled, secret
):
    """Identify ambiguous legacy rows without treating corrupted ciphertext as plaintext.

    Args:
        tmp_path: Isolated database directory.
        fake_idp: The test identity provider.
        monkeypatch: The pytest patch fixture.
        keep_loggers_enabled: Restore logging after Alembic configuration.
        secret: A legacy plaintext value using the reserved ciphertext prefix.
    """
    db_url = f"sqlite:///{tmp_path / 'ambiguous.db'}"
    monkeypatch.setenv("GEOLIBRE_DATABASE_URL", db_url)
    cfg = Config(str(ALEMBIC_INI))
    cfg.set_main_option("sqlalchemy.url", db_url)
    command.upgrade(cfg, "0002_enterprise_lifecycle")
    monkeypatch.setenv("GEOLIBRE_SKIP_DDL_CREATE_ALL", "1")
    _store_provider(db_url, tmp_path, fake_idp, monkeypatch)
    _insert_plaintext_secret(db_url, secret)
    engine = create_engine(db_url)
    with engine.connect() as connection:
        row_id = connection.scalar(text("SELECT id FROM organization_identity_providers"))
    engine.dispose()
    for operation, error_type in (
        (lambda: _app(db_url, tmp_path), RuntimeError),
        (lambda: command.upgrade(cfg, "head"), SecretKeyError),
    ):
        with pytest.raises(error_type) as error:
            operation()
        message = str(error.value)
        assert row_id in message
        assert "re-enter" in message
        assert secret not in message
    # Repair only the secret column, retaining the provider and its identities.
    _insert_plaintext_secret(db_url, encrypt_secret(secret))
    command.upgrade(cfg, "head")
    app = _app(db_url, tmp_path)
    app.state.engine.dispose()
    assert decrypt_secret(_raw_secrets(db_url)[0]) == secret


@pytest.mark.parametrize("secret", ["enc:v1:not-a-token", "enc:v1:"])
def test_plaintext_with_ciphertext_prefix_is_encrypted(tmp_path, fake_idp, monkeypatch, secret):
    """A ciphertext-looking plaintext secret survives ORM reads and restarts.

    Args:
        tmp_path: An isolated temporary directory.
        fake_idp: The test identity provider.
        monkeypatch: The pytest patch fixture.
        secret: A plaintext credential using the storage prefix.
    """
    from geolibre_server_api.enterprise_models import OrganizationIdentityProvider
    from sqlalchemy import select
    from sqlalchemy.orm import Session

    monkeypatch.setenv("GEOLIBRE_OAUTH_CLIENTS", json.dumps(OAUTH_CLIENTS))
    db_url = f"sqlite:///{tmp_path / 'prefixed-secret.db'}"
    app = _app(db_url, tmp_path, transport=fake_idp.transport)
    try:
        with TestClient(app, base_url=PUBLIC_URL) as client:
            token = admin_token(client)
            org_id = create_org(client, token)
            response = configure_idp(client, token, org_id, clientSecret=secret)
            assert response.status_code == 200, response.text
        (raw,) = _raw_secrets(db_url)
        assert raw != secret
        assert decrypt_secret(raw) == secret
        with Session(app.state.engine) as session:
            assert session.scalar(select(OrganizationIdentityProvider.client_secret)) == secret
    finally:
        app.state.engine.dispose()
    restarted = _app(db_url, tmp_path)
    restarted.state.engine.dispose()
    assert decrypt_secret(_raw_secrets(db_url)[0]) == secret


@pytest.mark.parametrize("public_url", [PUBLIC_URL, "http://localhost:8000"])
def test_missing_key_refuses_legacy_secrets_even_with_default_public_url(
    tmp_path, fake_idp, monkeypatch, public_url
):
    """The default loopback public URL must not silently allow plaintext storage.

    Args:
        tmp_path: An isolated temporary directory.
        fake_idp: The test identity provider.
        monkeypatch: The pytest patch fixture.
        public_url: The configured external API URL.
    """
    db_url = f"sqlite:///{tmp_path / 'missing-key.db'}"
    _store_provider(db_url, tmp_path, fake_idp, monkeypatch)
    _insert_plaintext_secret(db_url, "legacy-plain")
    monkeypatch.delenv("GEOLIBRE_SECRET_KEYS")
    with pytest.raises(RuntimeError, match="GEOLIBRE_SECRET_KEYS is required"):
        _app(db_url, tmp_path, public_url=public_url)


@pytest.mark.parametrize("public_url", [PUBLIC_URL, "http://localhost:8000"])
def test_secret_writes_require_key_even_with_default_public_url(
    tmp_path, fake_idp, monkeypatch, public_url
):
    """New providers require encryption unless development explicitly opts out.

    Args:
        tmp_path: An isolated temporary directory.
        fake_idp: The test identity provider.
        monkeypatch: The pytest patch fixture.
        public_url: The configured external API URL.
    """
    monkeypatch.delenv("GEOLIBRE_SECRET_KEYS")
    monkeypatch.setenv("GEOLIBRE_OAUTH_CLIENTS", json.dumps(OAUTH_CLIENTS))
    db_url = f"sqlite:///{tmp_path / 'write-key.db'}"
    app = _app(db_url, tmp_path, public_url=public_url, transport=fake_idp.transport)
    try:
        with TestClient(app, base_url=public_url) as client:
            token = account(client)
            org_id = create_org(client, token)
            response = configure_idp(client, token, org_id)
            assert response.status_code == 503, response.text
        assert _raw_secrets(db_url) == []
    finally:
        app.state.engine.dispose()


@pytest.mark.parametrize("secret", ["enc:v1:not-a-token", "enc:v1:"])
def test_development_rejects_reserved_prefix_without_key(tmp_path, fake_idp, monkeypatch, secret):
    """Ambiguous plaintext is rejected before it can poison a development database.

    Args:
        tmp_path: An isolated temporary directory.
        fake_idp: The test identity provider.
        monkeypatch: The pytest patch fixture.
        secret: A plaintext credential using the ciphertext prefix.
    """
    monkeypatch.delenv("GEOLIBRE_SECRET_KEYS")
    monkeypatch.setenv("GEOLIBRE_OAUTH_CLIENTS", json.dumps(OAUTH_CLIENTS))
    monkeypatch.setenv("GEOLIBRE_ALLOW_PLAINTEXT_SECRETS", "1")
    url = "http://localhost:8000"
    db_url = f"sqlite:///{tmp_path / 'dev-reserved.db'}"
    app = _app(db_url, tmp_path, public_url=url, transport=fake_idp.transport)
    try:
        with TestClient(app, base_url=url) as client:
            token = account(client)
            org_id = create_org(client, token)
            response = configure_idp(client, token, org_id, clientSecret=secret)
            assert response.status_code == 422, response.text
            assert "GEOLIBRE_SECRET_KEYS" in response.json()["error"]
        assert _raw_secrets(db_url) == []
    finally:
        app.state.engine.dispose()
    _app(db_url, tmp_path, public_url=url).state.engine.dispose()


def test_public_url_cannot_opt_out_of_secret_encryption(tmp_path, fake_idp, monkeypatch):
    """A public deployment ignores the development-only opt-out.

    Args:
        tmp_path: An isolated temporary directory.
        fake_idp: The test identity provider.
        monkeypatch: The pytest patch fixture.
    """
    monkeypatch.delenv("GEOLIBRE_SECRET_KEYS")
    monkeypatch.setenv("GEOLIBRE_ALLOW_PLAINTEXT_SECRETS", "1")
    response = _store_provider(
        f"sqlite:///{tmp_path / 'public.db'}", tmp_path, fake_idp, monkeypatch
    )
    assert response.status_code == 503


def test_encryption_helper_requires_explicit_opt_out(monkeypatch):
    """Direct storage callers also fail closed when a key is missing.

    Args:
        monkeypatch: The pytest patch fixture.
    """
    monkeypatch.delenv("GEOLIBRE_SECRET_KEYS")
    for setting in ("", "0", "typo"):
        monkeypatch.setenv("GEOLIBRE_ALLOW_PLAINTEXT_SECRETS", setting)
        with pytest.raises(SecretKeyError, match="required before storing"):
            encrypt_secret("plain")
    monkeypatch.setenv("GEOLIBRE_ALLOW_PLAINTEXT_SECRETS", "1")
    assert encrypt_secret("plain") == "plain"
    with pytest.raises(SecretKeyError, match="needs GEOLIBRE_SECRET_KEYS"):
        encrypt_secret("enc:v1:not-a-token")
