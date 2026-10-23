from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import secrets
import shutil
import threading
import time
import uuid
from contextlib import asynccontextmanager, suppress
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Annotated, Callable, Literal
from urllib.parse import quote, urlparse

import httpx
from fastapi import Depends, FastAPI, HTTPException, Query, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, RedirectResponse
from pydantic import BaseModel, Field
from sqlalchemy import (
    create_engine,
    delete,
    event,
    func,
    inspect,
    or_,
    select,
    text,
    update,
)
from sqlalchemy.exc import IntegrityError, OperationalError
from sqlalchemy.orm import Session, selectinload, sessionmaker

from geolibre_server_api.auth import (
    AuthPrincipal,
    InsufficientScopeError,
    bearer_challenge,
    build_identity_router,
    build_oauth_router,
    cleanup_expired_security_rows,
    ensure_scope,
    get_session,
    make_oauth_config,
    now,
    optional_principal,
    password_hash,
    password_matches,
    require_scope,
    token_digest,
)
from geolibre_server_api.auth_models import OAUTH_INDEXES, Account, Base
from geolibre_server_api.enterprise_admin import build_enterprise_admin_router
from geolibre_server_api.enterprise_models import FEDERATED_IDENTITY_INDEXES
from geolibre_server_api.oidc import build_http_client, build_transport
from geolibre_server_api.org_models import (
    Group,
    GroupInvitation,
    GroupMember,
    GroupRole,
    Organization,
    OrganizationInvitation,
    OrganizationMember,
    OrganizationRole,
)
from geolibre_server_api.policy import (
    is_last_active_admin,
    organization_role,
    require_not_break_glass,
    require_organization_admin,
)
from geolibre_server_api.project_models import (
    PENDING_TRANSFER_INDEX,
    Project,
    ProjectActivity,
    ProjectGroup,
    ProjectRedirect,
    ProjectTransfer,
    Version,
)
from geolibre_server_api.projects import demote_disallowed_public_projects, log_project_activity
from geolibre_server_api.proxy_identity import client_ip, load_trusted_proxy_config
from geolibre_server_api.scim import SCIM_MEDIA_TYPE, ScimError, build_scim_router

Visibility = Literal["public", "unlisted", "private", "organization"]
PublicSharingPolicy = Literal["yes", "publishers", "no"]
SHARE_ACCESS_MAX_FAILURES = 10
SHARE_ACCESS_WINDOW_SECONDS = 300
SHARE_EXPIRY_DELTAS = {
    "24h": timedelta(hours=24),
    "7d": timedelta(days=7),
    "30d": timedelta(days=30),
}
JoinPolicy = Literal["invite", "request", "open"]
SLUG_RE = re.compile(r"[^a-z0-9]+")
# One entity-tag (RFC 9110 §8.8.3): optional weak prefix, then a quoted opaque
# value. Matching whole tags keeps a comma inside the quotes part of the tag.
ENTITY_TAG_RE = re.compile(r'(?:W/)?"[^"]*"')
IMAGE_TYPES = {"image/png", "image/jpeg", "image/webp"}

OAUTH_CLEANUP_INTERVAL_SECONDS = 300
logger = logging.getLogger(__name__)


# project_json reads project.owner.username and len(project.versions), both lazy.
# Without these a single listing page (up to 100 rows) fires ~201 queries instead
# of three.
LISTING_EAGER_LOADS = (
    selectinload(Project.owner),
    selectinload(Project.organization),
    selectinload(Project.versions),
    selectinload(Project.group_shares).selectinload(ProjectGroup.group),
)


class ProjectCreate(BaseModel):
    filename: str = Field(max_length=255)
    content: str
    visibility: Visibility | None = None
    organization_id: str | None = Field(default=None, alias="organizationId")
    group_ids: list[str] = Field(default_factory=list, alias="groupIds", max_length=20)
    role: Literal["view", "comment", "edit"] = "edit"
    expires_in: Literal["24h", "7d", "30d", "never"] | None = Field(default=None, alias="expiresIn")
    password: str | None = Field(default=None, min_length=1, max_length=200)


class ProjectPatch(BaseModel):
    title: str | None = Field(default=None, max_length=100)
    description: str | None = Field(default=None, max_length=2000)
    visibility: Visibility | None = None
    tags: list[str] | None = None
    organization_id: str | None = Field(default=None, alias="organizationId")
    group_ids: list[str] | None = Field(default=None, alias="groupIds", max_length=20)
    delete_protected: bool | None = Field(default=None, alias="deleteProtected")


class OrganizationCreate(BaseModel):
    slug: str = Field(min_length=3, max_length=100)
    name: str = Field(min_length=1, max_length=100)
    public_sharing_policy: PublicSharingPolicy = Field(default="yes", alias="publicSharingPolicy")
    default_visibility: Visibility = Field(default="organization", alias="defaultVisibility")
    categories: list[str] = Field(default_factory=list, max_length=50)


class OrganizationMemberChange(BaseModel):
    username: str
    role: OrganizationRole


class OrganizationInvitationCreate(BaseModel):
    username: str | None = None
    email: str | None = Field(default=None, max_length=320)
    role: OrganizationRole = "member"

    model_config = {"extra": "forbid"}


class OrganizationSettingsPatch(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=100)
    public_sharing_policy: PublicSharingPolicy | None = Field(
        default=None, alias="publicSharingPolicy"
    )
    default_visibility: Visibility | None = Field(default=None, alias="defaultVisibility")
    categories: list[str] | None = Field(default=None, max_length=50)

    model_config = {"extra": "forbid"}


class GroupCreate(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    description: str = Field(default="", max_length=2000)
    organization_id: str | None = Field(default=None, alias="organizationId")
    join_policy: JoinPolicy = Field(default="invite", alias="joinPolicy")
    shared_update: bool = Field(default=False, alias="sharedUpdate")


class GroupMemberChange(BaseModel):
    username: str
    role: GroupRole = "member"


class GroupInvitationCreate(BaseModel):
    username: str | None = None
    email: str | None = Field(default=None, max_length=320)
    role: GroupRole = "member"

    model_config = {"extra": "forbid"}


class GroupSettingsPatch(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=100)
    description: str | None = Field(default=None, max_length=2000)
    join_policy: JoinPolicy | None = Field(default=None, alias="joinPolicy")

    model_config = {"extra": "forbid"}


class JoinRequestDecision(BaseModel):
    decision: Literal["accept", "reject"]


class ContentUpdate(BaseModel):
    content: str
    expected_version: int | None = Field(default=None, alias="expectedVersion", ge=1)


class ForkRequest(BaseModel):
    visibility: Visibility = "private"


class ShareAccessRequest(BaseModel):
    password: str = Field(min_length=1, max_length=200)


class ProjectTransferCreate(BaseModel):
    """Start a transfer: exactly one of ``username`` / ``organizationId``."""

    username: str | None = None
    organization_id: str | None = Field(default=None, alias="organizationId")
    slug: str | None = Field(default=None, min_length=1, max_length=100)

    model_config = {"extra": "forbid"}


class ProjectTransferAccept(BaseModel):
    """Accept a pending transfer, optionally choosing a new slug."""

    slug: str | None = Field(default=None, min_length=1, max_length=100)

    model_config = {"extra": "forbid"}


# Stable refusal phrases. The client maps these substrings to typed error codes
# (see share-gallery.ts), so they are part of the v1 contract; changing one is a
# breaking change even though the status code stays the same.
TRANSFER_SLUG_CONFLICT = "slug already exists for the new owner"
TRANSFER_PENDING = "a transfer is already pending for this project"
TRANSFER_INVALID = "transfer is no longer valid"
DELETE_PROTECTED = "project is delete-protected; turn off deleteProtected before deleting it"


def activity_json(act: ProjectActivity) -> dict:
    """Serialize an activity row with the API's camelCase field names."""
    details = json.loads(act.details_json)
    if act.bucket_key is not None:
        details["count"] = act.count
    return {
        "id": act.id,
        "action": act.action,
        "actorId": act.actor_id,
        "details": details,
        "createdAt": act.created_at,
    }


class FileStorage:
    def __init__(self, root: str):
        self.root = Path(root).resolve()
        self.root.mkdir(parents=True, exist_ok=True)

    def put(self, key: str, data: bytes, content_type: str) -> None:
        path = self.root / key
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)

    def get(self, key: str) -> bytes:
        try:
            return (self.root / key).read_bytes()
        except FileNotFoundError as exc:
            raise KeyError(key) from exc

    def delete(self, key: str) -> None:
        (self.root / key).unlink(missing_ok=True)

    def delete_project(self, project_id: str) -> None:
        shutil.rmtree(self.root / "projects" / project_id, ignore_errors=True)


class S3Storage:
    def __init__(self, bucket: str, endpoint: str | None, region: str | None):
        try:
            import boto3
        except ImportError as exc:
            raise RuntimeError("S3 storage requires the 's3' optional dependency") from exc
        self.bucket = bucket
        self.client = boto3.client("s3", endpoint_url=endpoint, region_name=region)

    def put(self, key: str, data: bytes, content_type: str) -> None:
        self.client.put_object(Bucket=self.bucket, Key=key, Body=data, ContentType=content_type)

    def get(self, key: str) -> bytes:
        try:
            return self.client.get_object(Bucket=self.bucket, Key=key)["Body"].read()
        except self.client.exceptions.NoSuchKey as exc:
            raise KeyError(key) from exc

    def delete(self, key: str) -> None:
        self.client.delete_object(Bucket=self.bucket, Key=key)

    def delete_project(self, project_id: str) -> None:
        prefix = f"projects/{project_id}/"
        paginator = self.client.get_paginator("list_objects_v2")
        for page in paginator.paginate(Bucket=self.bucket, Prefix=prefix):
            objects = [{"Key": item["Key"]} for item in page.get("Contents", [])]
            if objects:
                self.client.delete_objects(Bucket=self.bucket, Delete={"Objects": objects})


def make_storage():
    if os.getenv("GEOLIBRE_STORAGE", "filesystem").lower() == "s3":
        bucket = os.getenv("GEOLIBRE_S3_BUCKET")
        if not bucket:
            raise RuntimeError("GEOLIBRE_S3_BUCKET is required for S3 storage")
        return S3Storage(bucket, os.getenv("GEOLIBRE_S3_ENDPOINT"), os.getenv("GEOLIBRE_S3_REGION"))
    return FileStorage(os.getenv("GEOLIBRE_STORAGE_PATH", "./data"))


def parse_content(content: str, max_bytes: int) -> dict:
    if len(content.encode()) > max_bytes:
        raise HTTPException(413, f"project document exceeds the {max_bytes} byte limit")
    try:
        value = json.loads(content)
    except json.JSONDecodeError as exc:
        raise HTTPException(422, f"content must be valid JSON: {exc.msg}") from exc
    if not isinstance(value, dict):
        raise HTTPException(422, "content must contain a JSON object")
    return value


def slugify(value: str) -> str:
    slug = SLUG_RE.sub("-", value.lower()).strip("-")[:100].rstrip("-")
    return slug or "project"


def title_from(document: dict, filename: str) -> str:
    candidate = document.get("title")
    if not isinstance(candidate, str) or not candidate.strip():
        candidate = Path(filename).name.removesuffix(".geolibre.json").removesuffix(".json")
    candidate = candidate.strip()
    if len(candidate) > 100:
        raise HTTPException(422, "project title must not exceed 100 characters")
    return candidate or "Untitled"


def postgresql_upgrade_statements() -> list[str]:
    """Return idempotent DDL for databases created by pre-organization releases."""
    return [
        "ALTER TABLE accounts ADD COLUMN IF NOT EXISTS email VARCHAR(320)",
        "CREATE UNIQUE INDEX IF NOT EXISTS uq_accounts_email ON accounts (email)",
        "ALTER TABLE projects ADD COLUMN IF NOT EXISTS organization_id VARCHAR(36)",
        "ALTER TABLE projects ADD COLUMN IF NOT EXISTS created_by_id VARCHAR(36)",
        "ALTER TABLE projects ADD COLUMN IF NOT EXISTS delete_protected "
        "BOOLEAN NOT NULL DEFAULT FALSE",
        "ALTER TABLE projects ADD COLUMN IF NOT EXISTS share_role VARCHAR(8) "
        "NOT NULL DEFAULT 'edit'",
        "ALTER TABLE projects ADD COLUMN IF NOT EXISTS share_expires_at VARCHAR(32)",
        "ALTER TABLE projects ADD COLUMN IF NOT EXISTS share_password_hash VARCHAR(200)",
        "ALTER TABLE projects ALTER COLUMN visibility TYPE VARCHAR(16)",
        "ALTER TABLE projects ALTER COLUMN owner_id DROP NOT NULL",
        "UPDATE projects SET created_by_id = owner_id WHERE created_by_id IS NULL",
        "CREATE INDEX IF NOT EXISTS ix_projects_owner_id ON projects (owner_id)",
        "CREATE INDEX IF NOT EXISTS ix_projects_organization_id ON projects (organization_id)",
        "CREATE INDEX IF NOT EXISTS ix_projects_created_by_id ON projects (created_by_id)",
        "CREATE INDEX IF NOT EXISTS ix_projects_updated_at ON projects (updated_at)",
        "CREATE UNIQUE INDEX IF NOT EXISTS uq_project_org_slug_idx "
        "ON projects (organization_id, slug)",
        """
        DO $$
        DECLARE constraint_name text;
        BEGIN
          FOR constraint_name IN
            SELECT c.conname
            FROM pg_constraint c
            JOIN pg_attribute a ON a.attrelid = c.conrelid
              AND a.attnum = ANY (c.conkey)
            WHERE c.conrelid = 'projects'::regclass
              AND c.contype = 'f'
              AND a.attname = 'owner_id'
              AND c.confdeltype <> 'n'
          LOOP
            EXECUTE format('ALTER TABLE projects DROP CONSTRAINT %I', constraint_name);
          END LOOP;
          IF NOT EXISTS (
            SELECT 1
            FROM pg_constraint c
            JOIN pg_attribute a ON a.attrelid = c.conrelid
              AND a.attnum = ANY (c.conkey)
            WHERE c.conrelid = 'projects'::regclass
              AND c.contype = 'f'
              AND a.attname = 'owner_id'
          ) THEN
            ALTER TABLE projects ADD CONSTRAINT fk_projects_owner_id
              FOREIGN KEY (owner_id) REFERENCES accounts(id) ON DELETE SET NULL;
          END IF;
        END $$
        """,
        """
        DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1
            FROM pg_constraint c
            JOIN pg_attribute a ON a.attrelid = c.conrelid
              AND a.attnum = ANY (c.conkey)
            WHERE c.conrelid = 'projects'::regclass
              AND c.contype = 'f'
              AND a.attname = 'created_by_id'
          ) THEN
            ALTER TABLE projects ADD CONSTRAINT fk_projects_created_by_id
              FOREIGN KEY (created_by_id) REFERENCES accounts(id) ON DELETE SET NULL;
          END IF;
          IF NOT EXISTS (
            SELECT 1
            FROM pg_constraint c
            JOIN pg_attribute a ON a.attrelid = c.conrelid
              AND a.attnum = ANY (c.conkey)
            WHERE c.conrelid = 'projects'::regclass
              AND c.contype = 'f'
              AND a.attname = 'organization_id'
          ) THEN
            ALTER TABLE projects ADD CONSTRAINT fk_projects_organization_id
              FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE SET NULL;
          END IF;
        END $$
        """,
        """
        UPDATE group_members AS member
        SET role = 'manager'
        FROM groups AS owning_group
        WHERE member.group_id = owning_group.id
          AND member.role = 'owner'
          AND member.account_id <> owning_group.owner_id
        """,
        """
        UPDATE group_members AS member
        SET role = 'owner', status = 'accepted'
        FROM groups AS owning_group
        WHERE member.group_id = owning_group.id
          AND member.account_id = owning_group.owner_id
        """,
        """
        CREATE UNIQUE INDEX IF NOT EXISTS uq_group_accepted_owner
        ON group_members (group_id)
        WHERE role = 'owner' AND status = 'accepted'
        """,
        "ALTER TABLE oauth_authorization_codes ADD COLUMN IF NOT EXISTS authenticated_at INTEGER",
        "ALTER TABLE oauth_sessions ADD COLUMN IF NOT EXISTS authenticated_at INTEGER",
        "ALTER TABLE federated_identities ADD COLUMN IF NOT EXISTS claimed_username VARCHAR(255)",
        "ALTER TABLE federated_identities ADD COLUMN IF NOT EXISTS claimed_email VARCHAR(320)",
    ]


def upgrade_postgresql_schema(engine) -> None:
    with engine.begin() as connection:
        for statement in postgresql_upgrade_statements():
            connection.execute(text(statement))


def upgrade_sqlite_schema(engine) -> None:
    """Add nullable columns introduced after the initial SQLite release.

    SQLAlchemy's create_all creates new tables but deliberately does not alter
    existing ones. These additive changes keep old installations bootable; a
    fresh database still receives the complete constraints from the models.
    """
    inspector = inspect(engine)
    tables = set(inspector.get_table_names())
    additions = {
        "accounts": [("email", "VARCHAR(320)")],
        "federated_identities": [
            ("claimed_username", "VARCHAR(255)"),
            ("claimed_email", "VARCHAR(320)"),
        ],
        "oauth_authorization_codes": [("authenticated_at", "INTEGER")],
        "oauth_sessions": [("authenticated_at", "INTEGER")],
        "projects": [
            ("organization_id", "VARCHAR(36)"),
            ("created_by_id", "VARCHAR(36)"),
            ("delete_protected", "BOOLEAN NOT NULL DEFAULT 0"),
            ("share_role", "VARCHAR(8) NOT NULL DEFAULT 'edit'"),
            ("share_expires_at", "VARCHAR(32)"),
            ("share_password_hash", "VARCHAR(200)"),
        ],
    }
    with engine.begin() as connection:
        for table_name, columns in additions.items():
            if table_name not in tables:
                continue
            existing = {column["name"] for column in inspector.get_columns(table_name)}
            for column_name, column_type in columns:
                if column_name not in existing:
                    connection.execute(
                        text(f"ALTER TABLE {table_name} ADD COLUMN {column_name} {column_type}")
                    )
            if table_name == "projects" and "organization_id" not in existing:
                connection.execute(
                    text(
                        "CREATE UNIQUE INDEX IF NOT EXISTS uq_project_org_slug_idx "
                        "ON projects (organization_id, slug)"
                    )
                )
            if table_name == "projects" and "created_by_id" not in existing:
                connection.execute(text("UPDATE projects SET created_by_id = owner_id"))
        if "projects" in tables:
            connection.execute(
                text(
                    "CREATE INDEX IF NOT EXISTS ix_projects_organization_id "
                    "ON projects (organization_id)"
                )
            )
            connection.execute(
                text(
                    "CREATE INDEX IF NOT EXISTS ix_projects_created_by_id "
                    "ON projects (created_by_id)"
                )
            )
        if "accounts" in tables:
            connection.execute(
                text("CREATE UNIQUE INDEX IF NOT EXISTS uq_accounts_email ON accounts (email)")
            )
        if "group_members" in tables:
            connection.execute(
                text(
                    "UPDATE group_members SET role = 'manager' "
                    "WHERE role = 'owner' AND EXISTS ("
                    "SELECT 1 FROM groups WHERE groups.id = group_members.group_id "
                    "AND groups.owner_id <> group_members.account_id)"
                )
            )
            connection.execute(
                text(
                    "UPDATE group_members SET role = 'owner', status = 'accepted' "
                    "WHERE EXISTS (SELECT 1 FROM groups "
                    "WHERE groups.id = group_members.group_id "
                    "AND groups.owner_id = group_members.account_id)"
                )
            )
            connection.execute(
                text(
                    "CREATE UNIQUE INDEX IF NOT EXISTS uq_group_accepted_owner "
                    "ON group_members (group_id) "
                    "WHERE role = 'owner' AND status = 'accepted'"
                )
            )

    inspector = inspect(engine)
    if "projects" not in tables:
        return
    owner_column = next(
        column for column in inspector.get_columns("projects") if column["name"] == "owner_id"
    )
    owner_foreign_key = next(
        (
            key
            for key in inspector.get_foreign_keys("projects")
            if key["constrained_columns"] == ["owner_id"]
        ),
        None,
    )
    if (
        owner_column["nullable"]
        and owner_foreign_key is not None
        and (owner_foreign_key.get("options", {}).get("ondelete", "").upper() == "SET NULL")
    ):
        return

    # SQLite cannot alter nullability or an FK action. Keep child tables in
    # place and rebuild only projects with legacy rename behavior enabled so
    # versions/project_groups continue to reference the new `projects` table.
    raw = engine.raw_connection()
    try:
        cursor = raw.cursor()
        cursor.execute("PRAGMA foreign_keys=OFF")
        cursor.execute("PRAGMA legacy_alter_table=ON")
        cursor.execute("BEGIN")
        cursor.execute("ALTER TABLE projects RENAME TO projects_legacy")
        cursor.execute("""
            CREATE TABLE projects (
                id VARCHAR(36) NOT NULL PRIMARY KEY,
                owner_id VARCHAR(36) REFERENCES accounts(id) ON DELETE SET NULL,
                created_by_id VARCHAR(36) REFERENCES accounts(id) ON DELETE SET NULL,
                organization_id VARCHAR(36) REFERENCES organizations(id) ON DELETE SET NULL,
                slug VARCHAR(100) NOT NULL,
                title VARCHAR(100) NOT NULL,
                description TEXT NOT NULL DEFAULT '',
                visibility VARCHAR(16) NOT NULL,
                tags_json TEXT NOT NULL DEFAULT '[]',
                thumbnail_type VARCHAR(20),
                views INTEGER NOT NULL DEFAULT 0,
                fork_count INTEGER NOT NULL DEFAULT 0,
                featured BOOLEAN NOT NULL DEFAULT 0,
                delete_protected BOOLEAN NOT NULL DEFAULT 0,
                share_role VARCHAR(8) NOT NULL DEFAULT 'edit',
                share_expires_at VARCHAR(32),
                share_password_hash VARCHAR(200),
                created_at VARCHAR(32) NOT NULL,
                updated_at VARCHAR(32) NOT NULL,
                CONSTRAINT uq_project_owner_slug UNIQUE (owner_id, slug),
                CONSTRAINT uq_project_org_slug UNIQUE (organization_id, slug)
            )
        """)
        cursor.execute("""
            INSERT INTO projects (
                id, owner_id, created_by_id, organization_id, slug, title,
                description, visibility, tags_json, thumbnail_type, views,
                fork_count, featured, delete_protected, share_role, share_expires_at,
                share_password_hash, created_at, updated_at
            )
            SELECT id, owner_id, COALESCE(created_by_id, owner_id), organization_id,
                slug, title, description, visibility, tags_json, thumbnail_type,
                views, fork_count, featured, delete_protected, share_role, share_expires_at,
                share_password_hash, created_at, updated_at
            FROM projects_legacy
        """)
        cursor.execute("DROP TABLE projects_legacy")
        cursor.execute("CREATE INDEX ix_projects_owner_id ON projects (owner_id)")
        cursor.execute("CREATE INDEX ix_projects_created_by_id ON projects (created_by_id)")
        cursor.execute("CREATE INDEX ix_projects_organization_id ON projects (organization_id)")
        cursor.execute("CREATE INDEX ix_projects_updated_at ON projects (updated_at)")
        raw.commit()
        cursor.execute("PRAGMA foreign_keys=ON")
    except Exception:
        raw.rollback()
        raise
    finally:
        raw.close()


class PathCORSMiddleware:
    """Route CORS by request path.

    API routes keep the deployment's configured CORS (including its wildcard
    default). OAuth endpoints use only explicitly registered browser origins:
    registered web callbacks plus, from ``GEOLIBRE_CORS_ORIGINS``, the packaged
    Tauri origins and desktop development origins. CORS is never authorization:
    it only decides which origins may *read* cross-origin responses, and a
    wildcard API policy must not overwrite the narrow OAuth choice.

    The two CORSMiddleware instances are built from the incoming ``app`` (the
    chain this middleware wraps) rather than captured around an outer object:
    wrapping the FastAPI app itself would regenerate the full middleware stack
    -- including this dispatcher -- on every request, recursing forever.
    """

    def __init__(self, app, api_origins, api_credentials, oauth_origins):
        self.api = CORSMiddleware(
            app,
            allow_origins=api_origins,
            allow_credentials=api_credentials,
            allow_methods=["*"],
            allow_headers=["Authorization", "Content-Type"],
            expose_headers=["WWW-Authenticate"],
        )
        self.oauth = CORSMiddleware(
            app,
            allow_origins=oauth_origins,
            allow_credentials=False,
            allow_methods=["*"],
            allow_headers=["Authorization", "Content-Type"],
            expose_headers=["WWW-Authenticate"],
        )

    async def __call__(self, scope, receive, send):
        path = scope.get("path", "")
        if path.startswith("/oauth/") or path.startswith("/.well-known/oauth-authorization-server"):
            await self.oauth(scope, receive, send)
        else:
            await self.api(scope, receive, send)


def create_app(
    database_url: str | None = None,
    storage=None,
    public_url: str | None = None,
    clock: Callable[[], int] | None = None,
    *,
    oidc_transport: httpx.BaseTransport | None = None,
) -> FastAPI:
    """Build the FastAPI app, wiring the engine, sessions, storage, and routes.

    ``oidc_transport`` replaces the network for outbound identity-provider
    calls (tests pass an ``httpx.MockTransport``).
    """
    database_url = database_url or os.getenv(
        "GEOLIBRE_DATABASE_URL", "sqlite:///./geolibre-server-api.db"
    )
    connect_args = {"check_same_thread": False} if database_url.startswith("sqlite") else {}
    engine = create_engine(database_url, connect_args=connect_args)
    if database_url.startswith("sqlite"):
        # SQLite disables foreign keys per connection, which makes every
        # ondelete="CASCADE" inert. The ORM cascade covers projects and versions,
        # but tokens have no relationship, so deleting an account would otherwise
        # strand its tokens.
        @event.listens_for(engine, "connect")
        def _enable_foreign_keys(dbapi_connection, _record):  # pragma: no cover - driver hook
            dbapi_connection.execute("PRAGMA foreign_keys=ON")

    Base.metadata.create_all(engine)
    if database_url.startswith("sqlite"):
        upgrade_sqlite_schema(engine)
    elif engine.dialect.name == "postgresql":
        upgrade_postgresql_schema(engine)
    legacy_project_owner_required = database_url.startswith("sqlite") and not next(
        column["nullable"]
        for column in inspect(engine).get_columns("projects")
        if column["name"] == "owner_id"
    )
    # create_all leaves pre-existing tables untouched, including their indexes.
    # Add the OAuth indexes idempotently when upgrading a persisted database.
    for index in OAUTH_INDEXES:
        index.create(engine, checkfirst=True)
    # create_all does not add an index to an already-existing transfer table.
    PENDING_TRANSFER_INDEX.create(engine, checkfirst=True)
    # Nor the federated identity indexes to a table from an earlier release.
    for index in FEDERATED_IDENTITY_INDEXES:
        index.create(engine, checkfirst=True)
    sessions = sessionmaker(engine, expire_on_commit=False)
    oauth_config = make_oauth_config(public_url)
    clock_fn = clock or (lambda: int(datetime.now(UTC).timestamp()))

    def cleanup_oauth_state() -> None:
        with sessions() as cleanup_session:
            cleanup_expired_security_rows(cleanup_session, clock_fn())

    if oauth_config is not None:
        # Bound each sweep so accumulated state cannot stall startup or serving.
        cleanup_oauth_state()

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        async def sweep() -> None:
            while True:
                await asyncio.sleep(OAUTH_CLEANUP_INTERVAL_SECONDS)
                try:
                    await asyncio.to_thread(cleanup_oauth_state)
                except Exception:
                    logger.exception("periodic OAuth security-state cleanup failed")

        task = asyncio.create_task(sweep()) if oauth_config is not None else None
        try:
            yield
        finally:
            if task is not None:
                task.cancel()
                with suppress(asyncio.CancelledError):
                    await task
            # Drops pooled IdP connections; the pool reconnects on demand, so a
            # restarted app (tests re-enter the lifespan) keeps working.
            idp_transport.close()

    object_storage = storage or make_storage()
    base_url = (public_url or os.getenv("GEOLIBRE_PUBLIC_URL", "http://localhost:8000")).rstrip("/")
    viewer_url = os.getenv("GEOLIBRE_VIEWER_URL", "https://app.geolibre.org/").rstrip("/") + "/"
    max_project_bytes = int(os.getenv("GEOLIBRE_MAX_PROJECT_BYTES", str(50 * 1024 * 1024)))
    max_thumbnail_bytes = int(os.getenv("GEOLIBRE_MAX_THUMBNAIL_BYTES", str(5 * 1024 * 1024)))

    app = FastAPI(
        title="GeoLibre projects and identity API",
        version="1.0",
        lifespan=lifespan,
    )
    app.state.engine = engine
    app.state.storage = object_storage
    app.state.session_factory = sessions
    app.state.clock = clock_fn
    app.state.oauth_config = oauth_config
    app.state.base_url = base_url
    app.state.trusted_proxy = load_trusted_proxy_config()
    # Outbound identity-provider HTTP; lives for the process.
    idp_transport = oidc_transport or build_transport()
    app.state.oidc_http = build_http_client(idp_transport)
    # A declared Content-Length past the largest thing any route accepts is
    # rejected before the body is read at all. Without this, the JSON `content`
    # routes let Pydantic materialize the whole payload in memory *before*
    # parse_content could answer 413 -- the same exposure the thumbnail route
    # avoids by streaming. The per-route checks stay authoritative; this only
    # sheds the obviously-too-big requests early, so the factor has to be the
    # worst case rather than a typical one: parse_content bounds the *decoded*
    # string, and JSON may encode any ASCII byte as a six-byte \u00XX escape, so
    # a legitimate document at max_project_bytes can be six times that on the
    # wire. A tighter bound would 413 valid uploads.
    body_ceiling = max(max_project_bytes * 6, max_thumbnail_bytes) + 1024

    # Known limit: this reads the declared length only, so a chunked or HTTP/2
    # request without Content-Length skips it and is still parsed in full. The
    # per-route checks bound what gets *stored* either way; closing the parsing
    # cost for those requests needs a streaming body reader, which is why the
    # deployment notes put a request-size limit at the proxy.
    @app.middleware("http")
    async def limit_body(request: Request, call_next):
        declared = request.headers.get("content-length")
        if declared and declared.isdigit() and int(declared) > body_ceiling:
            return JSONResponse({"error": "request body too large"}, status_code=413)
        return await call_next(request)

    origins = [x.strip() for x in os.getenv("GEOLIBRE_CORS_ORIGINS", "*").split(",") if x.strip()]
    # CORSMiddleware treats a "*" anywhere in the list as allow-all, so a value
    # like "*,https://app.example" would otherwise pair allow-all with
    # allow_credentials=True (the list is not exactly ["*"]) and accept
    # credentialed requests from any origin. Wildcard wins, and drops credentials
    # with it.
    wildcard = "*" in origins

    oauth_origins: set[str] = set()
    if oauth_config is not None:
        for client in oauth_config.clients.values():
            for uri in client.redirect_uris:
                if uri.startswith(("http://", "https://")):
                    parsed = urlparse(uri)
                    oauth_origins.add(f"{parsed.scheme}://{parsed.netloc}")
        for origin in origins:
            if origin in (
                "tauri://localhost",
                "http://tauri.localhost",
                "http://localhost:5173",
                "http://127.0.0.1:5173",
            ):
                oauth_origins.add(origin)
    # Registered last so it is the outermost layer: Starlette wraps in reverse
    # order of registration, and with limit_body outermost its 413 returned
    # without CORS headers, leaving a browser unable to read the documented
    # error body.
    if oauth_config is not None:
        app.add_middleware(
            PathCORSMiddleware,
            api_origins=["*"] if wildcard else origins,
            api_credentials=not wildcard,
            oauth_origins=sorted(oauth_origins),
        )
    else:
        app.add_middleware(
            CORSMiddleware,
            allow_origins=["*"] if wildcard else origins,
            allow_credentials=not wildcard,
            allow_methods=["*"],
            allow_headers=["Authorization", "Content-Type"],
            expose_headers=["WWW-Authenticate"],
        )

    @app.get("/health")
    def health():
        return {"ok": True, "service": "geolibre-server"}

    @app.exception_handler(HTTPException)
    async def http_error(_request: Request, exc: HTTPException):
        detail = exc.detail if isinstance(exc.detail, str) else "request failed"
        return JSONResponse({"error": detail}, status_code=exc.status_code, headers=exc.headers)

    @app.exception_handler(InsufficientScopeError)
    async def insufficient_scope_handler(_request: Request, exc: InsufficientScopeError):
        """Serialize an insufficient-scope failure as a documented 403."""
        return JSONResponse(
            {"error": "insufficient_scope", "requiredScope": exc.required_scope},
            status_code=403,
            headers=exc.headers,
        )

    @app.exception_handler(RequestValidationError)
    async def validation_error(_request: Request, exc: RequestValidationError):
        return JSONResponse({"error": str(exc.errors()[0]["msg"])}, status_code=422)

    @app.exception_handler(ScimError)
    async def scim_error(_request: Request, exc: ScimError):
        """Serialize a SCIM failure as an RFC 7644 error message."""
        return JSONResponse(
            {
                "schemas": ["urn:ietf:params:scim:api:messages:2.0:Error"],
                "status": str(exc.status),
                "detail": exc.detail,
                **({"scimType": exc.scim_type} if exc.scim_type else {}),
            },
            status_code=exc.status,
            media_type=SCIM_MEDIA_TYPE,
            headers=exc.headers,
        )

    @app.exception_handler(Exception)
    async def unexpected_error(_request: Request, exc: Exception):
        # Only HTTPException and RequestValidationError were handled, so anything
        # else (a database error, say) escaped as a plain-text 500 and broke the
        # documented "errors are JSON objects with an error string" contract. The
        # detail is logged rather than returned, so internals are not disclosed.
        logger.exception("unhandled error", exc_info=exc)
        return JSONResponse({"error": "internal server error"}, status_code=500)

    # Identity routes must precede the username/slug catch-alls below.
    app.include_router(build_identity_router())
    app.include_router(build_enterprise_admin_router())
    app.include_router(build_scim_router())
    if oauth_config is not None:
        app.include_router(build_oauth_router(oauth_config))

    def unique_slug(
        session: Session,
        owner_id: str | None,
        desired: str,
        organization_id: str | None = None,
    ) -> str:
        """Allocate a free slug in a namespace, skipping live projects and redirects.

        A slug a previous transfer vacated still has a 301 pointing at it, so it
        stays reserved: a new upload of the same title gets ``-2`` rather than
        stealing an address that old links depend on.
        """
        base = slugify(desired)

        def taken(candidate: str) -> bool:
            if organization_id:
                if session.scalar(
                    select(Project.id).where(
                        Project.slug == candidate,
                        or_(
                            Project.organization_id == organization_id,
                            *(
                                [Project.owner_id == owner_id]
                                if legacy_project_owner_required
                                else []
                            ),
                        ),
                    )
                ):
                    return True
                return (
                    session.scalar(
                        select(ProjectRedirect.id).where(
                            ProjectRedirect.slug == candidate,
                            ProjectRedirect.organization_id == organization_id,
                        )
                    )
                    is not None
                )
            if session.scalar(
                select(Project.id).where(Project.owner_id == owner_id, Project.slug == candidate)
            ):
                return True
            return (
                session.scalar(
                    select(ProjectRedirect.id).where(
                        ProjectRedirect.slug == candidate,
                        ProjectRedirect.account_id == owner_id,
                    )
                )
                is not None
            )

        candidate = base
        suffix = 2
        while taken(candidate):
            tail = f"-{suffix}"
            candidate = base[: 100 - len(tail)].rstrip("-") + tail
            suffix += 1
        return candidate

    def path_reserved(
        session: Session,
        account_id: str | None,
        organization_id: str | None,
        slug: str,
        except_project_id: str | None = None,
    ) -> bool:
        """Whether a namespace already answers for ``slug``.

        Covers both a live project and a redirect a transfer left behind. A
        transfer names the destination slug explicitly, so unlike ``unique_slug``
        it reports a conflict instead of silently picking another name.
        """
        if organization_id:
            project_query = select(Project.id).where(
                Project.slug == slug, Project.organization_id == organization_id
            )
            redirect_query = select(ProjectRedirect.id).where(
                ProjectRedirect.slug == slug, ProjectRedirect.organization_id == organization_id
            )
        else:
            project_query = select(Project.id).where(
                Project.slug == slug,
                Project.owner_id == account_id,
                Project.organization_id.is_(None),
            )
            redirect_query = select(ProjectRedirect.id).where(
                ProjectRedirect.slug == slug, ProjectRedirect.account_id == account_id
            )
        if except_project_id is not None:
            project_query = project_query.where(Project.id != except_project_id)
            redirect_query = redirect_query.where(ProjectRedirect.project_id != except_project_id)
        return (
            session.scalar(project_query) is not None or session.scalar(redirect_query) is not None
        )

    def group_membership(session: Session, group_id: str, account_id: str) -> GroupMember | None:
        member = session.get(GroupMember, (group_id, account_id))
        return member if member is not None and member.status == "accepted" else None

    def require_group(session: Session, group_id: str) -> Group:
        group = session.get(Group, group_id)
        if group is None:
            raise HTTPException(404, "group not found")
        return group

    def require_group_manager(session: Session, group_id: str, account: Account) -> Group:
        group = require_group(session, group_id)
        membership = group_membership(session, group_id, account.id)
        if membership is None or membership.role not in {"owner", "manager"}:
            raise HTTPException(403, "group manager permission required")
        return group

    def require_group_owner(session: Session, group_id: str, account: Account) -> Group:
        group = require_group(session, group_id)
        membership = group_membership(session, group_id, account.id)
        if membership is None or membership.role != "owner":
            raise HTTPException(403, "group owner permission required")
        return group

    def require_group_organization_member(session: Session, group: Group, account_id: str) -> None:
        """An organization's group only admits members of that organization."""
        if (
            group.organization_id
            and organization_role(session, group.organization_id, account_id) is None
        ):
            raise HTTPException(403, "organization membership required for this group")

    def detach_from_organization_groups(
        session: Session, organization_id: str, target: Account, actor: Account
    ) -> None:
        """Drop ``target``'s memberships and pending invitations in the organization's groups.

        Called when ``target`` leaves or is removed, so group shares stop granting
        them organization content. Groups ``target`` owns pass to ``actor`` (an
        administrator removing them); leaving while owning one is a 409, matching
        the group rule that ownership is transferred before the owner goes.
        """
        group_ids = list(
            session.scalars(select(Group.id).where(Group.organization_id == organization_id))
        )
        if not group_ids:
            return
        owned_groups = session.scalars(
            select(Group).where(Group.id.in_(group_ids), Group.owner_id == target.id)
        ).all()
        if owned_groups and actor.id == target.id:
            raise HTTPException(
                409, "transfer ownership of your organization groups before leaving"
            )
        session.execute(
            delete(GroupMember).where(
                GroupMember.group_id.in_(group_ids), GroupMember.account_id == target.id
            )
        )
        for group in owned_groups:
            group.owner_id = actor.id
            member = session.get(GroupMember, (group.id, actor.id))
            if member is None:
                session.add(
                    GroupMember(
                        group_id=group.id,
                        account_id=actor.id,
                        role="owner",
                        status="accepted",
                        created_at=now(),
                    )
                )
            else:
                member.role = "owner"
                member.status = "accepted"
        invitation_target_predicate = GroupInvitation.username == target.username
        if target.email:
            invitation_target_predicate = or_(
                invitation_target_predicate,
                GroupInvitation.email == target.email.strip().lower(),
            )
        session.execute(
            update(GroupInvitation)
            .where(
                GroupInvitation.group_id.in_(group_ids),
                GroupInvitation.status == "pending",
                invitation_target_predicate,
            )
            .values(status="revoked", revoked_at=now())
        )

    def shared_group_ids(session: Session, project_id: str) -> list[str]:
        return list(
            session.scalars(
                select(ProjectGroup.group_id).where(ProjectGroup.project_id == project_id)
            )
        )

    def can_publish_public(
        session: Session, organization: Organization | None, account: Account
    ) -> bool:
        if organization is None:
            return True
        role = organization_role(session, organization.id, account.id)
        if role == "administrator":
            return True
        return organization.public_sharing_policy == "yes" or (
            organization.public_sharing_policy == "publishers" and role == "publisher"
        )

    def validate_default_visibility(policy: str, default: str) -> None:
        """Reject a default visibility the organization's own policy forbids."""
        if default == "public" and policy != "yes":
            raise HTTPException(422, "defaultVisibility public requires publicSharingPolicy yes")

    def delete_group_rows(session: Session, group_ids: list[str]) -> list[str]:
        """Delete groups with their project shares, invitations, and members; no commit.

        Explicit deletes rather than FK cascades: ``Group`` has no relationship to
        shares or invitations, and SQLite cascades depend on the connect pragma.
        Returns the ids of deleted groups that had a stored thumbnail.
        """
        if not group_ids:
            return []
        thumbnail_group_ids = list(
            session.scalars(
                select(Group.id).where(Group.id.in_(group_ids), Group.thumbnail_type.is_not(None))
            )
        )
        session.execute(delete(ProjectGroup).where(ProjectGroup.group_id.in_(group_ids)))
        session.execute(delete(GroupInvitation).where(GroupInvitation.group_id.in_(group_ids)))
        session.execute(delete(GroupMember).where(GroupMember.group_id.in_(group_ids)))
        session.execute(delete(Group).where(Group.id.in_(group_ids)))
        return thumbnail_group_ids

    def validate_access_targets(
        session: Session,
        account: Account,
        visibility: str,
        organization_id: str | None,
        group_ids: list[str],
    ) -> Organization | None:
        organization = session.get(Organization, organization_id) if organization_id else None
        if organization_id and organization is None:
            raise HTTPException(404, "organization not found")
        role = organization_role(session, organization_id, account.id) if organization_id else None
        if organization is not None and role not in {
            "administrator",
            "publisher",
            "member",
        }:
            raise HTTPException(403, "organization publishing permission required")
        if visibility == "organization" and organization is None:
            raise HTTPException(422, "organization visibility requires an organization")
        if visibility == "public" and not can_publish_public(session, organization, account):
            raise HTTPException(403, "your organization does not allow public sharing")
        if len(set(group_ids)) != len(group_ids):
            raise HTTPException(422, "groupIds must not contain duplicates")
        for group_id in group_ids:
            group = session.get(Group, group_id)
            if group is None:
                raise HTTPException(404, "group not found")
            if group_membership(session, group_id, account.id) is None:
                raise HTTPException(403, "group membership required")
            # Only an administrator may widen organization content beyond the
            # organization; everyone else shares within the organization's groups.
            if (
                organization is not None
                and role != "administrator"
                and group.organization_id != organization.id
            ):
                raise HTTPException(
                    403, "organization projects can only be shared with the organization's groups"
                )
        return organization

    def organization_json(organization: Organization, role: str | None = None) -> dict:
        value = {
            "id": organization.id,
            "slug": organization.slug,
            "name": organization.name,
            "publicSharingPolicy": organization.public_sharing_policy,
            "defaultVisibility": organization.default_visibility,
            "categories": json.loads(organization.categories_json),
        }
        if role is not None:
            value["role"] = role
        return value

    def group_json(group: Group, membership: GroupMember | None = None) -> dict:
        return {
            "id": group.id,
            "name": group.name,
            "description": group.description,
            "organizationId": group.organization_id,
            "ownerId": group.owner_id,
            "joinPolicy": group.join_policy,
            "sharedUpdate": group.shared_update,
            "thumbnailUrl": (f"/api/groups/{group.id}/thumbnail" if group.thumbnail_type else None),
            "role": membership.role if membership else None,
            "membershipStatus": membership.status if membership else None,
            "createdAt": group.created_at,
        }

    def member_json(member: OrganizationMember | GroupMember) -> dict:
        return {
            "id": member.account.id,
            "username": member.account.username,
            "role": member.role,
            "status": getattr(member, "status", "accepted"),
            "createdAt": member.created_at,
        }

    def invitation_target(username: str | None, email: str | None) -> tuple[str | None, str | None]:
        username = username.strip().lower() if username else None
        email = email.strip().lower() if email else None
        if bool(username) == bool(email):
            raise HTTPException(422, "provide exactly one of username or email")
        return username, email

    def invitation_account(
        session: Session, username: str | None, email: str | None
    ) -> Account | None:
        if username:
            return session.scalar(select(Account).where(Account.username == username))
        return session.scalar(select(Account).where(func.lower(Account.email) == email))

    def invitation_belongs_to(
        invitation: OrganizationInvitation | GroupInvitation, account: Account
    ) -> bool:
        return bool(
            (invitation.username and invitation.username == account.username)
            or (
                invitation.email
                and account.email
                and invitation.email == account.email.strip().lower()
            )
        )

    def invitation_json(
        invitation: OrganizationInvitation | GroupInvitation,
        raw_token: str | None = None,
    ) -> dict:
        value = {
            "id": invitation.id,
            "username": invitation.username,
            "email": invitation.email,
            "role": invitation.role,
            "status": invitation.status,
            "createdAt": invitation.created_at,
            "acceptedAt": invitation.accepted_at,
            "revokedAt": invitation.revoked_at,
        }
        if isinstance(invitation, OrganizationInvitation):
            value["organizationId"] = invitation.organization_id
        else:
            value["groupId"] = invitation.group_id
        if raw_token is not None:
            value["token"] = raw_token
        return value

    def replace_group_shares(session: Session, project: Project, group_ids: list[str]) -> None:
        session.execute(delete(ProjectGroup).where(ProjectGroup.project_id == project.id))
        session.add_all(
            ProjectGroup(project_id=project.id, group_id=group_id) for group_id in group_ids
        )

    def can_edit_project(session: Session, project: Project, account: Account | None) -> bool:
        if account is None:
            return False
        if project.organization_id is None and project.owner_id == account.id:
            return True
        if project.organization_id:
            role = organization_role(session, project.organization_id, account.id)
            if role == "administrator" or (
                project.created_by_id == account.id and role in {"publisher", "member"}
            ):
                return True
        for share in project.group_shares:
            if share.group.shared_update and group_membership(session, share.group_id, account.id):
                return True
        return False

    def canonical_urls(project: Project) -> tuple[str, str]:
        """The project's own current raw-JSON and page URLs (raw, page)."""
        if project.organization is not None:
            org_slug = project.organization.slug
            return (
                f"{base_url}/org/{quote(org_slug)}/{quote(project.slug)}.geolibre.json",
                f"{base_url}/org/{quote(org_slug)}/{quote(project.slug)}",
            )
        username = project.owner.username if project.owner and project.owner.username else ""
        return (
            f"{base_url}/{quote(username)}/{quote(project.slug)}.geolibre.json",
            f"{base_url}/{quote(username)}/{quote(project.slug)}",
        )

    def redirect_response(
        session: Session,
        redirect: ProjectRedirect | None,
        principal: AuthPrincipal | None,
        *,
        page: bool,
    ) -> RedirectResponse | None:
        """Follow a transfer redirect with a permanent 301, or return None.

        Visibility is checked against the *target* project, so an old address
        never discloses where a private project went to someone who could not
        open it themselves. The hop does not count a view or an activity event;
        the target route does that.
        """
        if redirect is None:
            return None
        target = visible_read(session, session.get(Project, redirect.project_id), principal)
        raw, page_url = canonical_urls(target)
        response = RedirectResponse(page_url if page else raw, status_code=301)
        response.headers["Cache-Control"] = (
            "private, no-store" if protected(target) else "public, no-cache"
        )
        return response

    def project_json(
        project: Project,
        session: Session | None = None,
        account: Account | None = None,
    ) -> dict:
        raw, page = canonical_urls(project)
        value = {
            "id": project.id,
            "username": (
                project.owner.username
                if project.organization_id is None and project.owner
                else None
            ),
            "slug": project.slug,
            "title": project.title,
            "description": project.description,
            "visibility": project.visibility,
            "organization": (
                {
                    "id": project.organization.id,
                    "slug": project.organization.slug,
                    "name": project.organization.name,
                }
                if project.organization
                else None
            ),
            "groupIds": [share.group_id for share in project.group_shares],
            "thumbnailUrl": (
                f"/api/projects/{project.id}/thumbnail" if project.thumbnail_type else None
            ),
            "views": project.views,
            "forkCount": project.fork_count,
            "versionCount": len(project.versions),
            "featured": project.featured,
            "deleteProtected": project.delete_protected,
            "role": project.share_role,
            "expiresAt": project.share_expires_at,
            "hasPassword": project.share_password_hash is not None,
            "createdAt": project.created_at,
            "updatedAt": project.updated_at,
            "tags": json.loads(project.tags_json),
            "rawJsonUrl": raw,
            "projectUrl": page,
            "viewerUrl": viewer_url + "?project=" + quote(raw, safe=""),
        }
        if account is not None:
            assert session is not None
            value["canEdit"] = can_edit_project(session, project, account)
        return value

    def visible(
        session: Session, project: Project | None, principal: AuthPrincipal | None
    ) -> Project:
        """Return the project or 404 when the caller may not see it."""
        if project is None:
            raise HTTPException(404, "project not found")
        if project.visibility in {"public", "unlisted"}:
            return project
        account = principal.account if principal is not None else None
        if (
            account is not None
            and project.organization_id is None
            and project.owner_id == account.id
        ):
            return project
        if (
            account is not None
            and project.visibility == "organization"
            and project.organization_id
            and organization_role(session, project.organization_id, account.id)
        ):
            return project
        if account is not None and project.organization_id:
            role = organization_role(session, project.organization_id, account.id)
            if role == "administrator" or (
                project.created_by_id == account.id and role in {"publisher", "member"}
            ):
                return project
        if account is not None and any(
            group_membership(session, group_id, account.id)
            for group_id in shared_group_ids(session, project.id)
        ):
            return project
        raise HTTPException(404, "project not found")

    def link_gate(
        session: Session,
        project: Project,
        principal: AuthPrincipal | None,
        password: str | None,
    ) -> None:
        """Enforce a share link's expiry and password against a non-manager reader.

        Managers always read their own projects. Everyone else gets 410 once the
        link has expired, and 401 until the project's password is supplied.
        """
        if project.share_expires_at is None and project.share_password_hash is None:
            return
        if principal is not None and can_manage_project(session, project, principal.account):
            return
        if project.share_expires_at is not None and (
            datetime.fromisoformat(project.share_expires_at.replace("Z", "+00:00"))
            <= datetime.now(UTC)
        ):
            raise HTTPException(410, "share link expired")
        if project.share_password_hash is not None and not (
            password is not None and password_matches(password, project.share_password_hash)
        ):
            raise HTTPException(401, "share password required")

    def visible_read(
        session: Session,
        project: Project | None,
        principal: AuthPrincipal | None,
        password: str | None = None,
    ) -> Project:
        """visible() plus the read:projects scope for any non-public read.

        A public or unlisted project is readable anonymously, so no scope is
        needed. Anything else (private, organization, or reached only through
        a group share) is the caller's protected data and needs read:projects.
        A share link's expiry and password are enforced here for every reader.
        """
        project = visible(session, project, principal)
        if project.visibility not in {"public", "unlisted"}:
            # visible() 404s callers without access, so a protected project
            # reaching here implies an authenticated principal.
            assert principal is not None
            ensure_scope(principal, "read:projects")
        link_gate(session, project, principal, password)
        return project

    def can_manage_project(session: Session, project: Project, account: Account) -> bool:
        """Whether the account owns, or administers, the project's namespace."""
        if project.organization_id is None and project.owner_id == account.id:
            return True
        if project.organization_id:
            role = organization_role(session, project.organization_id, account.id)
            if role == "administrator" or (
                project.created_by_id == account.id and role in {"publisher", "member"}
            ):
                return True
        return False

    def can_transfer_project(session: Session, project: Project, account: Account) -> bool:
        """An organization owns its projects; only an administrator can move one."""
        if project.organization_id is not None:
            return (
                organization_role(session, project.organization_id, account.id) == "administrator"
            )
        return project.owner_id == account.id

    def owned(session: Session, project: Project | None, principal: AuthPrincipal) -> Project:
        """Return the project or 403/404 when the caller cannot manage it."""
        if project is None:
            raise HTTPException(404, "project not found")
        if not can_manage_project(session, project, principal.account):
            raise HTTPException(403, "project ownership required")
        return project

    def editable(project: Project | None, principal: AuthPrincipal, session: Session) -> Project:
        """Return the project or 403/404 when the caller cannot save content to it."""
        if project is None:
            raise HTTPException(404, "project not found")
        if can_edit_project(session, project, principal.account):
            return project
        raise HTTPException(403, "project edit permission required")

    def protected(project: Project) -> bool:
        """Whether a project's responses must not be publicly cached."""
        return project.visibility in {"private", "organization"} or (
            project.share_password_hash is not None
        )

    def transfer_json(transfer: ProjectTransfer) -> dict:
        """Serialize a transfer row with the API's camelCase field names."""
        return {
            "id": transfer.id,
            "projectId": transfer.project_id,
            "projectTitle": transfer.project.title,
            "projectSlug": transfer.project.slug,
            "fromUsername": transfer.from_account.username,
            "toUsername": transfer.to_account.username if transfer.to_account else None,
            "toOrganization": (
                {
                    "id": transfer.to_organization.id,
                    "slug": transfer.to_organization.slug,
                    "name": transfer.to_organization.name,
                }
                if transfer.to_organization
                else None
            ),
            "slug": transfer.slug,
            "status": transfer.status,
            "createdAt": transfer.created_at,
            "resolvedAt": transfer.resolved_at,
        }

    def resolve_pending_transfer(session: Session, transfer_id: str, status: str) -> bool:
        """Only one concurrent accept, decline, or cancel may resolve an offer."""
        result = session.execute(
            update(ProjectTransfer)
            .where(ProjectTransfer.id == transfer_id, ProjectTransfer.status == "pending")
            .values(status=status, resolved_at=now())
        )
        return result.rowcount == 1

    def apply_transfer(
        session: Session,
        project: Project,
        actor: Account,
        *,
        to_account: Account | None,
        to_organization: Organization | None,
        slug: str,
    ) -> None:
        """Move a project to its new owner; the caller commits.

        Keeps the project id, views, fork count, versions and activity: only the
        namespace moves. Leaves a redirect covering the vacated address, clears
        group shares (they were grants to the old audience), and clamps the
        visibility to what the new owner can actually keep.
        """
        old_account_id = project.owner_id if project.organization_id is None else None
        old_organization_id = project.organization_id
        old_slug = project.slug
        if old_organization_id is not None:
            from_label = f"org:{project.organization.slug}"
        else:
            from_label = project.owner.username if project.owner and project.owner.username else ""
        if to_organization is not None:
            to_label = f"org:{to_organization.slug}"
        else:
            to_label = to_account.username if to_account and to_account.username else ""
        # A transfer back to a former home must not leave a redirect shadowing
        # the project's own new address.
        if to_organization is not None:
            namespace_filter = ProjectRedirect.organization_id == to_organization.id
        else:
            namespace_filter = ProjectRedirect.account_id == to_account.id
        session.execute(
            delete(ProjectRedirect).where(
                ProjectRedirect.project_id == project.id,
                ProjectRedirect.slug == slug,
                namespace_filter,
            )
        )
        session.add(
            ProjectRedirect(
                id=str(uuid.uuid4()),
                project_id=project.id,
                account_id=old_account_id,
                organization_id=old_organization_id,
                slug=old_slug,
                created_at=now(),
            )
        )
        if to_organization is not None:
            project.organization_id = to_organization.id
            # Matches patch_project: a legacy SQLite install keeps a compat owner
            # because its uq_project_owner_slug cannot span NULLs.
            project.owner_id = actor.id if legacy_project_owner_required else None
        else:
            project.owner_id = to_account.id
            project.organization_id = None
        project.slug = slug
        replace_group_shares(session, project, [])
        before = project.visibility
        if to_organization is not None:
            if project.visibility == "public" and to_organization.public_sharing_policy != "yes":
                project.visibility = "organization"
        elif project.visibility == "organization":
            # An organization-only project has no organization any more.
            project.visibility = "private"
        if project.visibility != before:
            log_project_activity(
                session,
                project.id,
                actor.id,
                "visibility_change",
                {"before": before, "after": project.visibility},
            )
        project.updated_at = now()
        log_project_activity(
            session, project.id, actor.id, "transfer", {"from": from_label, "to": to_label}
        )

    def create_project(
        session: Session,
        account: Account,
        content: str,
        filename: str,
        visibility: Visibility,
        organization_id: str | None = None,
        group_ids: list[str] | None = None,
        share_role: str = "edit",
        share_expires_at: str | None = None,
        share_password: str | None = None,
        *,
        commit: bool = True,
    ) -> Project:
        group_ids = group_ids or []
        validate_access_targets(session, account, visibility, organization_id, group_ids)
        document = parse_content(content, max_project_bytes)
        title = title_from(document, filename)
        timestamp = now()

        if not account.username:
            raise HTTPException(400, "username required")

        # unique_slug SELECTs and this INSERTs, so two concurrent creates with
        # the same title from one account can pick the same slug and the loser
        # hits uq_project_owner_slug or uq_project_org_slug. Retry the allocation
        # instead of surfacing that as a 500, matching how version numbers are
        # allocated below.
        for _ in range(5):
            project = Project(
                id=str(uuid.uuid4()),
                owner_id=(
                    account.id if organization_id is None or legacy_project_owner_required else None
                ),
                created_by_id=account.id,
                organization_id=organization_id,
                slug=unique_slug(session, account.id, title or filename, organization_id),
                title=title,
                description="",
                visibility=visibility,
                tags_json="[]",
                share_role=share_role,
                share_expires_at=share_expires_at,
                share_password_hash=password_hash(share_password) if share_password else None,
                created_at=timestamp,
                updated_at=timestamp,
            )
            session.add(project)
            try:
                session.flush()
                break
            except (IntegrityError, OperationalError):
                # OperationalError covers SQLite's "database is locked", which is how
                # a concurrent writer usually surfaces on the default deployment;
                # it is transient, so it belongs in the retry rather than in a 500.
                session.rollback()
                account = session.get(Account, account.id)
                if account is None:
                    raise HTTPException(401, "authentication required") from None
        else:
            raise HTTPException(409, "could not allocate a project slug; retry")
        key = f"projects/{project.id}/versions/1.json"
        object_storage.put(key, content.encode(), "application/json")
        session.add(Version(project_id=project.id, number=1, object_key=key, created_at=timestamp))
        session.add_all(
            ProjectGroup(project_id=project.id, group_id=group_id) for group_id in group_ids
        )
        if commit:
            session.commit()
            session.refresh(project)
        return project

    @app.post("/api/organizations", status_code=201)
    def create_organization(
        body: OrganizationCreate,
        principal: AuthPrincipal = Depends(require_scope("write:projects")),
        session: Session = Depends(get_session),
    ):
        account = principal.account
        slug = body.slug.strip().lower()
        if not re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{1,98}[a-z0-9])", slug):
            raise HTTPException(
                422,
                "organization slug must be 3-100 lowercase letters, digits, or hyphens",
            )
        if session.scalar(select(Organization.id).where(Organization.slug == slug)):
            raise HTTPException(409, "organization slug already exists")
        validate_default_visibility(body.public_sharing_policy, body.default_visibility)
        organization = Organization(
            id=str(uuid.uuid4()),
            slug=slug,
            name=body.name.strip(),
            public_sharing_policy=body.public_sharing_policy,
            default_visibility=body.default_visibility,
            categories_json=json.dumps(body.categories),
            created_at=now(),
        )
        session.add(organization)
        session.add(
            OrganizationMember(
                organization_id=organization.id,
                account_id=account.id,
                role="administrator",
                created_at=now(),
            )
        )
        try:
            session.commit()
        except IntegrityError:
            session.rollback()
            raise HTTPException(409, "organization slug already exists") from None
        return {"organization": organization_json(organization, "administrator")}

    @app.get("/api/organizations/mine")
    def list_my_organizations(
        response: Response,
        principal: AuthPrincipal = Depends(require_scope("read:projects")),
        session: Session = Depends(get_session),
    ):
        account = principal.account
        rows = session.execute(
            select(Organization, OrganizationMember.role)
            .join(OrganizationMember)
            .where(OrganizationMember.account_id == account.id)
            .order_by(Organization.name)
        ).all()
        response.headers["Cache-Control"] = "private, no-store"
        return {"organizations": [organization_json(org, role) for org, role in rows]}

    @app.get("/api/organizations/{organization_id}")
    def get_organization(
        organization_id: str,
        response: Response,
        principal: AuthPrincipal = Depends(require_scope("read:projects")),
        session: Session = Depends(get_session),
    ):
        account = principal.account
        organization = session.get(Organization, organization_id)
        if organization is None:
            raise HTTPException(404, "organization not found")
        role = organization_role(session, organization_id, account.id)
        if role is None:
            raise HTTPException(404, "organization not found")
        response.headers["Cache-Control"] = "private, no-store"
        return {"organization": organization_json(organization, role)}

    @app.patch("/api/organizations/{organization_id}")
    def patch_organization(
        organization_id: str,
        body: OrganizationSettingsPatch,
        request: Request,
        principal: AuthPrincipal = Depends(require_scope("write:projects")),
        session: Session = Depends(get_session),
    ):
        account = principal.account
        organization = require_organization_admin(
            session, organization_id, principal, request, mutation=True
        )
        updates = body.model_dump(exclude_unset=True)
        validate_default_visibility(
            updates.get("public_sharing_policy") or organization.public_sharing_policy,
            updates.get("default_visibility") or organization.default_visibility,
        )
        if updates.get("name") is not None:
            organization.name = updates["name"].strip()
        if updates.get("public_sharing_policy") is not None:
            organization.public_sharing_policy = updates["public_sharing_policy"]
        if updates.get("default_visibility") is not None:
            organization.default_visibility = updates["default_visibility"]
        if updates.get("categories") is not None:
            organization.categories_json = json.dumps(updates["categories"])
        if updates.get("public_sharing_policy") in {"no", "publishers"}:
            demote_disallowed_public_projects(session, organization, account.id)
        session.commit()
        return {"organization": organization_json(organization, "administrator")}

    @app.delete("/api/organizations/{organization_id}", status_code=204)
    def delete_organization(
        organization_id: str,
        request: Request,
        principal: AuthPrincipal = Depends(require_scope("write:projects")),
        session: Session = Depends(get_session),
    ):
        """Delete an organization with its projects, groups, members, and invitations."""
        organization = require_organization_admin(
            session, organization_id, principal, request, mutation=True
        )
        project_rows = session.execute(
            select(Project.id, Project.delete_protected)
            .where(Project.organization_id == organization.id)
            .with_for_update()
        ).all()
        if any(delete_protected for _, delete_protected in project_rows):
            raise HTTPException(409, DELETE_PROTECTED)
        project_ids = [project_id for project_id, _ in project_rows]
        for project_id in project_ids:
            session.delete(session.get(Project, project_id))
        thumbnail_group_ids = delete_group_rows(
            session,
            list(session.scalars(select(Group.id).where(Group.organization_id == organization.id))),
        )
        session.execute(
            delete(OrganizationInvitation).where(
                OrganizationInvitation.organization_id == organization.id
            )
        )
        session.execute(
            delete(OrganizationMember).where(OrganizationMember.organization_id == organization.id)
        )
        session.delete(organization)
        session.commit()
        for project_id in project_ids:
            object_storage.delete_project(project_id)
        for group_id in thumbnail_group_ids:
            object_storage.delete(f"groups/{group_id}/thumbnail")

    @app.get("/api/organizations/{organization_id}/members")
    def list_organization_members(
        organization_id: str,
        response: Response,
        principal: AuthPrincipal = Depends(require_scope("read:projects")),
        session: Session = Depends(get_session),
    ):
        account = principal.account
        if organization_role(session, organization_id, account.id) is None:
            if session.get(Organization, organization_id) is None:
                raise HTTPException(404, "organization not found")
            raise HTTPException(403, "organization membership required")
        members = session.scalars(
            select(OrganizationMember)
            .where(OrganizationMember.organization_id == organization_id)
            .options(selectinload(OrganizationMember.account))
            .order_by(OrganizationMember.created_at)
        ).all()
        response.headers["Cache-Control"] = "private, no-store"
        return {"members": [member_json(member) for member in members]}

    @app.put("/api/organizations/{organization_id}/members")
    def put_organization_member(
        organization_id: str,
        body: OrganizationMemberChange,
        request: Request,
        principal: AuthPrincipal = Depends(require_scope("write:projects")),
        session: Session = Depends(get_session),
    ):
        account = principal.account
        require_organization_admin(session, organization_id, principal, request, mutation=True)
        target = session.scalar(select(Account).where(Account.username == body.username))
        if target is None:
            raise HTTPException(404, "user not found")
        member = session.get(OrganizationMember, (organization_id, target.id))
        if member is None:
            member = OrganizationMember(
                organization_id=organization_id,
                account_id=target.id,
                role=body.role,
                created_at=now(),
            )
            session.add(member)
        else:
            if member.role == "administrator" and body.role != "administrator":
                if is_last_active_admin(session, organization_id, target.id):
                    raise HTTPException(409, "organization must have an administrator")
                require_not_break_glass(session, organization_id, target.id)
            member.role = body.role
        invitation_target_predicate = OrganizationInvitation.username == target.username
        if target.email:
            invitation_target_predicate = or_(
                invitation_target_predicate,
                OrganizationInvitation.email == target.email.strip().lower(),
            )
        session.execute(
            update(OrganizationInvitation)
            .where(
                OrganizationInvitation.organization_id == organization_id,
                OrganizationInvitation.status == "pending",
                invitation_target_predicate,
            )
            .values(status="revoked", revoked_at=now())
        )
        organization = session.get(Organization, organization_id)
        assert organization is not None
        # A lowered role may no longer publish what the member made public.
        demote_disallowed_public_projects(session, organization, account.id)
        session.commit()
        member.account = target
        return {"member": member_json(member)}

    @app.delete("/api/organizations/{organization_id}/members/{username}", status_code=204)
    def delete_organization_member(
        organization_id: str,
        username: str,
        request: Request,
        principal: AuthPrincipal = Depends(require_scope("write:projects")),
        session: Session = Depends(get_session),
    ):
        account = principal.account
        if username == "me":
            if session.get(Organization, organization_id) is None:
                raise HTTPException(404, "organization not found")
            target = account
        else:
            require_organization_admin(session, organization_id, principal, request, mutation=True)
            target = session.scalar(select(Account).where(Account.username == username))
        member = session.get(OrganizationMember, (organization_id, target.id)) if target else None
        if member is None:
            raise HTTPException(404, "organization member not found")
        if is_last_active_admin(session, organization_id, target.id):
            raise HTTPException(409, "organization must have an administrator")
        require_not_break_glass(session, organization_id, target.id)
        session.delete(member)
        detach_from_organization_groups(session, organization_id, target, account)
        organization = session.get(Organization, organization_id)
        assert organization is not None
        session.flush()
        # A former member can no longer publish, so their public projects fall
        # back to organization visibility under a restrictive policy.
        demote_disallowed_public_projects(session, organization, account.id)
        session.commit()

    @app.post("/api/organizations/{organization_id}/invitations", status_code=201)
    def create_organization_invitation(
        organization_id: str,
        body: OrganizationInvitationCreate,
        request: Request,
        principal: AuthPrincipal = Depends(require_scope("write:projects")),
        session: Session = Depends(get_session),
    ):
        account = principal.account
        require_organization_admin(session, organization_id, principal, request, mutation=True)
        username, email = invitation_target(body.username, body.email)
        target = invitation_account(session, username, email)
        if username and target is None:
            raise HTTPException(404, "user not found")
        if target and session.get(OrganizationMember, (organization_id, target.id)):
            raise HTTPException(409, "user is already an organization member")
        target_predicate = (
            OrganizationInvitation.username == username
            if username
            else OrganizationInvitation.email == email
        )
        if session.scalar(
            select(OrganizationInvitation.id).where(
                OrganizationInvitation.organization_id == organization_id,
                OrganizationInvitation.status == "pending",
                target_predicate,
            )
        ):
            raise HTTPException(409, "invitation already pending")
        raw_token = secrets.token_urlsafe(32)
        invitation = OrganizationInvitation(
            id=str(uuid.uuid4()),
            organization_id=organization_id,
            invited_by_id=account.id,
            username=username,
            email=email,
            role=body.role,
            status="pending",
            token_digest=token_digest(raw_token),
            created_at=now(),
        )
        session.add(invitation)
        session.commit()
        return {"invitation": invitation_json(invitation, raw_token)}

    @app.get("/api/organizations/{organization_id}/invitations")
    def list_organization_invitations(
        organization_id: str,
        response: Response,
        request: Request,
        principal: AuthPrincipal = Depends(require_scope("read:projects")),
        session: Session = Depends(get_session),
    ):
        require_organization_admin(session, organization_id, principal, request, mutation=False)
        invitations = session.scalars(
            select(OrganizationInvitation)
            .where(OrganizationInvitation.organization_id == organization_id)
            .order_by(OrganizationInvitation.created_at)
        ).all()
        response.headers["Cache-Control"] = "private, no-store"
        return {"invitations": [invitation_json(item) for item in invitations]}

    @app.delete(
        "/api/organizations/{organization_id}/invitations/{invitation_id}",
        status_code=204,
    )
    def revoke_organization_invitation(
        organization_id: str,
        invitation_id: str,
        request: Request,
        principal: AuthPrincipal = Depends(require_scope("write:projects")),
        session: Session = Depends(get_session),
    ):
        require_organization_admin(session, organization_id, principal, request, mutation=True)
        invitation = session.get(OrganizationInvitation, invitation_id)
        if (
            invitation is None
            or invitation.organization_id != organization_id
            or invitation.status != "pending"
        ):
            raise HTTPException(404, "invitation not found")
        invitation.status = "revoked"
        invitation.revoked_at = now()
        session.commit()

    @app.post("/api/organizations/invitations/{token}/accept", status_code=204)
    def accept_organization_invitation(
        token: str,
        principal: AuthPrincipal = Depends(require_scope("write:projects")),
        session: Session = Depends(get_session),
    ):
        account = principal.account
        invitation = session.scalar(
            select(OrganizationInvitation).where(
                OrganizationInvitation.token_digest == token_digest(token),
                OrganizationInvitation.status == "pending",
            )
        )
        if invitation is None:
            raise HTTPException(404, "invitation not found")
        if not invitation_belongs_to(invitation, account):
            raise HTTPException(403, "invitation belongs to another user")
        if session.get(OrganizationMember, (invitation.organization_id, account.id)):
            raise HTTPException(409, "user is already an organization member")
        session.add(
            OrganizationMember(
                organization_id=invitation.organization_id,
                account_id=account.id,
                role=invitation.role,
                created_at=now(),
            )
        )
        invitation.status = "accepted"
        invitation.accepted_at = now()
        try:
            session.commit()
        except IntegrityError:
            session.rollback()
            raise HTTPException(409, "user is already an organization member") from None

    @app.get("/api/organizations/{organization_id}/projects")
    def list_organization_projects(
        organization_id: str,
        response: Response,
        limit: Annotated[int, Query(ge=1, le=100)] = 24,
        offset: Annotated[int, Query(ge=0)] = 0,
        principal: AuthPrincipal = Depends(require_scope("read:projects")),
        session: Session = Depends(get_session),
    ):
        account = principal.account
        role = organization_role(session, organization_id, account.id)
        if role is None:
            if session.get(Organization, organization_id) is None:
                raise HTTPException(404, "organization not found")
            raise HTTPException(403, "organization membership required")
        query = select(Project).where(Project.organization_id == organization_id)
        if role != "administrator":
            group_ids = (
                select(ProjectGroup.project_id)
                .join(GroupMember, GroupMember.group_id == ProjectGroup.group_id)
                .where(
                    GroupMember.account_id == account.id,
                    GroupMember.status == "accepted",
                )
            )
            query = query.where(
                or_(
                    Project.visibility.in_(["public", "organization"]),
                    Project.id.in_(group_ids),
                    (
                        (Project.created_by_id == account.id)
                        & (role in {"publisher", "member"} if role is not None else False)
                    ),
                )
            )
        projects = session.scalars(
            query.options(*LISTING_EAGER_LOADS)
            .order_by(Project.updated_at.desc())
            .offset(offset)
            .limit(limit)
        ).all()
        response.headers["Cache-Control"] = "private, no-store"
        return {"projects": [project_json(project, session, account) for project in projects]}

    @app.post("/api/groups", status_code=201)
    def create_group(
        body: GroupCreate,
        principal: AuthPrincipal = Depends(require_scope("write:projects")),
        session: Session = Depends(get_session),
    ):
        account = principal.account
        if body.organization_id:
            role = organization_role(session, body.organization_id, account.id)
            if session.get(Organization, body.organization_id) is None:
                raise HTTPException(404, "organization not found")
            if role not in {"administrator", "publisher", "member"}:
                raise HTTPException(403, "organization membership required")
        group = Group(
            id=str(uuid.uuid4()),
            organization_id=body.organization_id,
            owner_id=account.id,
            name=body.name.strip(),
            description=body.description,
            join_policy=body.join_policy,
            shared_update=body.shared_update,
            created_at=now(),
        )
        session.add(group)
        member = GroupMember(
            group_id=group.id,
            account_id=account.id,
            role="owner",
            status="accepted",
            created_at=now(),
        )
        session.add(member)
        session.commit()
        return {"group": group_json(group, member)}

    @app.get("/api/groups/mine")
    def list_my_groups(
        response: Response,
        principal: AuthPrincipal = Depends(require_scope("read:projects")),
        session: Session = Depends(get_session),
    ):
        account = principal.account
        rows = session.execute(
            select(Group, GroupMember)
            .join(GroupMember)
            .where(GroupMember.account_id == account.id, GroupMember.status == "accepted")
            .order_by(Group.name)
        ).all()
        response.headers["Cache-Control"] = "private, no-store"
        return {"groups": [group_json(group, member) for group, member in rows]}

    @app.get("/api/groups/{group_id}")
    def get_group(
        group_id: str,
        response: Response,
        principal: AuthPrincipal = Depends(require_scope("read:projects")),
        session: Session = Depends(get_session),
    ):
        account = principal.account
        group = require_group(session, group_id)
        response.headers["Cache-Control"] = "private, no-store"
        return {"group": group_json(group, group_membership(session, group_id, account.id))}

    @app.patch("/api/groups/{group_id}")
    def patch_group(
        group_id: str,
        body: GroupSettingsPatch,
        principal: AuthPrincipal = Depends(require_scope("write:projects")),
        session: Session = Depends(get_session),
    ):
        account = principal.account
        group = require_group_manager(session, group_id, account)
        updates = body.model_dump(exclude_unset=True)
        if updates.get("name") is not None:
            group.name = updates["name"].strip()
        if updates.get("description") is not None:
            group.description = updates["description"]
        if updates.get("join_policy") is not None:
            group.join_policy = updates["join_policy"]
        session.commit()
        return {"group": group_json(group, group_membership(session, group_id, account.id))}

    @app.delete("/api/groups/{group_id}", status_code=204)
    def delete_group(
        group_id: str,
        principal: AuthPrincipal = Depends(require_scope("write:projects")),
        session: Session = Depends(get_session),
    ):
        """Delete a group (owner only); shared projects survive without the group target."""
        require_group_owner(session, group_id, principal.account)
        thumbnail_group_ids = delete_group_rows(session, [group_id])
        session.commit()
        for thumbnail_group_id in thumbnail_group_ids:
            object_storage.delete(f"groups/{thumbnail_group_id}/thumbnail")

    @app.get("/api/groups/{group_id}/members")
    def list_group_members(
        group_id: str,
        response: Response,
        principal: AuthPrincipal = Depends(require_scope("read:projects")),
        session: Session = Depends(get_session),
    ):
        account = principal.account
        if group_membership(session, group_id, account.id) is None:
            require_group(session, group_id)
            raise HTTPException(403, "group membership required")
        membership = group_membership(session, group_id, account.id)
        query = select(GroupMember).where(GroupMember.group_id == group_id)
        if membership is None or membership.role not in {"owner", "manager"}:
            query = query.where(GroupMember.status == "accepted")
        members = session.scalars(
            query.options(selectinload(GroupMember.account)).order_by(GroupMember.created_at)
        ).all()
        response.headers["Cache-Control"] = "private, no-store"
        return {"members": [member_json(member) for member in members]}

    @app.put("/api/groups/{group_id}/members")
    def put_group_member(
        group_id: str,
        body: GroupMemberChange,
        principal: AuthPrincipal = Depends(require_scope("write:projects")),
        session: Session = Depends(get_session),
    ):
        account = principal.account
        group = require_group_manager(session, group_id, account)
        actor = group_membership(session, group_id, account.id)
        target = session.scalar(select(Account).where(Account.username == body.username))
        if target is None:
            raise HTTPException(404, "user not found")
        require_group_organization_member(session, group, target.id)
        member = session.get(GroupMember, (group_id, target.id))
        if target.id == group.owner_id and body.role != "owner":
            raise HTTPException(409, "transfer group ownership before changing the owner role")
        if body.role == "owner":
            if actor is None or actor.role != "owner":
                raise HTTPException(403, "only the group owner can transfer ownership")
            # PostgreSQL serializes competing transfers on the group row. SQLite
            # ignores FOR UPDATE but serializes writers and the partial unique
            # index below still enforces the final invariant.
            group = session.scalar(select(Group).where(Group.id == group_id).with_for_update())
            assert group is not None
            session.execute(
                update(GroupMember)
                .where(
                    GroupMember.group_id == group_id,
                    GroupMember.role == "owner",
                    GroupMember.account_id != target.id,
                )
                .values(role="manager")
            )
            group.owner_id = target.id
        elif actor is None or (
            actor.role != "owner"
            and (body.role == "manager" or (member and member.role in {"owner", "manager"}))
        ):
            raise HTTPException(403, "only the group owner can manage managers")
        if member is None:
            member = GroupMember(
                group_id=group_id,
                account_id=target.id,
                role=body.role,
                status="accepted",
                created_at=now(),
            )
            session.add(member)
        else:
            member.role = body.role
            member.status = "accepted"
        invitation_target_predicate = GroupInvitation.username == target.username
        if target.email:
            invitation_target_predicate = or_(
                invitation_target_predicate,
                GroupInvitation.email == target.email.strip().lower(),
            )
        session.execute(
            update(GroupInvitation)
            .where(
                GroupInvitation.group_id == group_id,
                GroupInvitation.status == "pending",
                invitation_target_predicate,
            )
            .values(status="revoked", revoked_at=now())
        )
        session.commit()
        member.account = target
        return {"member": member_json(member)}

    @app.delete("/api/groups/{group_id}/members/{username}", status_code=204)
    def delete_group_member(
        group_id: str,
        username: str,
        principal: AuthPrincipal = Depends(require_scope("write:projects")),
        session: Session = Depends(get_session),
    ):
        account = principal.account
        require_group(session, group_id)
        actor = group_membership(session, group_id, account.id)
        leaving = username == "me"
        if leaving:
            target = account
        else:
            if actor is None or actor.role not in {"owner", "manager"}:
                raise HTTPException(403, "group manager permission required")
            target = session.scalar(select(Account).where(Account.username == username))
        member = session.get(GroupMember, (group_id, target.id)) if target else None
        if member is None:
            raise HTTPException(404, "group member not found")
        if member.role == "owner":
            raise HTTPException(409, "transfer group ownership before removing the owner")
        if not leaving and (actor is None or (actor.role != "owner" and member.role == "manager")):
            raise HTTPException(403, "only the group owner can remove a manager")
        session.delete(member)
        session.commit()

    @app.post("/api/groups/{group_id}/invitations", status_code=201)
    def create_group_invitation(
        group_id: str,
        body: GroupInvitationCreate,
        principal: AuthPrincipal = Depends(require_scope("write:projects")),
        session: Session = Depends(get_session),
    ):
        account = principal.account
        group = require_group_manager(session, group_id, account)
        actor = group_membership(session, group_id, account.id)
        username, email = invitation_target(body.username, body.email)
        if body.role == "owner":
            raise HTTPException(422, "ownership must be transferred through the member route")
        if body.role == "manager" and actor and actor.role != "owner":
            raise HTTPException(403, "only the group owner can invite a manager")
        target = invitation_account(session, username, email)
        if username and target is None:
            raise HTTPException(404, "user not found")
        if target:
            require_group_organization_member(session, group, target.id)
        if target and group_membership(session, group_id, target.id):
            raise HTTPException(409, "user is already a group member")
        target_predicate = (
            GroupInvitation.username == username if username else GroupInvitation.email == email
        )
        existing = session.scalar(
            select(GroupInvitation.id).where(
                GroupInvitation.group_id == group_id,
                GroupInvitation.status == "pending",
                target_predicate,
            )
        )
        if existing:
            raise HTTPException(409, "invitation already pending")
        raw_token = secrets.token_urlsafe(32)
        invitation = GroupInvitation(
            id=str(uuid.uuid4()),
            group_id=group.id,
            invited_by_id=account.id,
            username=username,
            email=email,
            role=body.role,
            status="pending",
            token_digest=token_digest(raw_token),
            created_at=now(),
        )
        session.add(invitation)
        session.commit()
        return {"invitation": invitation_json(invitation, raw_token)}

    @app.get("/api/groups/{group_id}/invitations")
    def list_group_invitations(
        group_id: str,
        response: Response,
        principal: AuthPrincipal = Depends(require_scope("read:projects")),
        session: Session = Depends(get_session),
    ):
        account = principal.account
        require_group_manager(session, group_id, account)
        invitations = session.scalars(
            select(GroupInvitation)
            .where(GroupInvitation.group_id == group_id)
            .order_by(GroupInvitation.created_at)
        ).all()
        response.headers["Cache-Control"] = "private, no-store"
        return {"invitations": [invitation_json(item) for item in invitations]}

    @app.delete("/api/groups/{group_id}/invitations/{invitation_id}", status_code=204)
    def revoke_group_invitation(
        group_id: str,
        invitation_id: str,
        principal: AuthPrincipal = Depends(require_scope("write:projects")),
        session: Session = Depends(get_session),
    ):
        account = principal.account
        require_group_manager(session, group_id, account)
        invitation = session.get(GroupInvitation, invitation_id)
        if invitation is None or invitation.group_id != group_id or invitation.status != "pending":
            raise HTTPException(404, "invitation not found")
        invitation.status = "revoked"
        invitation.revoked_at = now()
        session.commit()

    @app.post("/api/groups/invitations/{token}/accept", status_code=204)
    def accept_group_invitation(
        token: str,
        principal: AuthPrincipal = Depends(require_scope("write:projects")),
        session: Session = Depends(get_session),
    ):
        account = principal.account
        invitation = session.scalar(
            select(GroupInvitation).where(
                GroupInvitation.token_digest == token_digest(token),
                GroupInvitation.status == "pending",
            )
        )
        if invitation is None:
            raise HTTPException(404, "invitation not found")
        if not invitation_belongs_to(invitation, account):
            raise HTTPException(403, "invitation belongs to another user")
        require_group_organization_member(
            session, require_group(session, invitation.group_id), account.id
        )
        member = session.get(GroupMember, (invitation.group_id, account.id))
        if member is not None and member.status == "accepted":
            raise HTTPException(409, "user is already a group member")
        if member is None:
            session.add(
                GroupMember(
                    group_id=invitation.group_id,
                    account_id=account.id,
                    role=invitation.role,
                    status="accepted",
                    created_at=now(),
                )
            )
        else:
            member.role = invitation.role
            member.status = "accepted"
        invitation.status = "accepted"
        invitation.accepted_at = now()
        try:
            session.commit()
        except IntegrityError:
            session.rollback()
            raise HTTPException(409, "already a group member") from None

    @app.post("/api/groups/{group_id}/join", status_code=204)
    def join_group(
        group_id: str,
        principal: AuthPrincipal = Depends(require_scope("write:projects")),
        session: Session = Depends(get_session),
    ):
        account = principal.account
        group = require_group(session, group_id)
        require_group_organization_member(session, group, account.id)
        existing = session.get(GroupMember, (group_id, account.id))
        if existing and existing.status == "accepted":
            raise HTTPException(409, "already a group member")
        if group.join_policy == "invite":
            raise HTTPException(403, "group is invitation-only")
        status = "accepted" if group.join_policy == "open" else "pending"
        if existing is None:
            session.add(
                GroupMember(
                    group_id=group_id,
                    account_id=account.id,
                    role="member",
                    status=status,
                    created_at=now(),
                )
            )
        elif existing.status == "pending":
            raise HTTPException(409, "join request already pending")
        else:
            existing.status = status
            existing.role = "member"
        try:
            session.commit()
        except IntegrityError:
            session.rollback()
            raise HTTPException(409, "already a group member") from None

    @app.post("/api/groups/{group_id}/members/{username}/decide", status_code=204)
    def decide_group_join_request(
        group_id: str,
        username: str,
        body: JoinRequestDecision,
        principal: AuthPrincipal = Depends(require_scope("write:projects")),
        session: Session = Depends(get_session),
    ):
        account = principal.account
        group = require_group_manager(session, group_id, account)
        target = session.scalar(select(Account).where(Account.username == username))
        member = session.get(GroupMember, (group_id, target.id)) if target else None
        if member is None or member.status != "pending":
            raise HTTPException(404, "join request not found")
        if body.decision == "accept":
            require_group_organization_member(session, group, target.id)
            member.status = "accepted"
        else:
            session.delete(member)
        session.commit()

    @app.get("/api/groups/{group_id}/projects")
    def list_group_projects(
        group_id: str,
        response: Response,
        limit: Annotated[int, Query(ge=1, le=100)] = 24,
        offset: Annotated[int, Query(ge=0)] = 0,
        principal: AuthPrincipal = Depends(require_scope("read:projects")),
        session: Session = Depends(get_session),
    ):
        account = principal.account
        if group_membership(session, group_id, account.id) is None:
            require_group(session, group_id)
            raise HTTPException(403, "group membership required")
        projects = session.scalars(
            select(Project)
            .join(ProjectGroup)
            .where(ProjectGroup.group_id == group_id)
            .options(*LISTING_EAGER_LOADS)
            .order_by(Project.updated_at.desc())
            .limit(limit)
            .offset(offset)
        ).all()
        response.headers["Cache-Control"] = "private, no-store"
        return {"projects": [project_json(project, session, account) for project in projects]}

    @app.delete("/api/groups/{group_id}/projects/{project_id}", status_code=204)
    def moderate_group_project(
        group_id: str,
        project_id: str,
        principal: AuthPrincipal = Depends(require_scope("write:projects")),
        session: Session = Depends(get_session),
    ):
        account = principal.account
        require_group_manager(session, group_id, account)
        share = session.get(ProjectGroup, (project_id, group_id))
        if share is None:
            raise HTTPException(404, "group project not found")
        session.delete(share)
        session.commit()

    @app.put("/api/groups/{group_id}/thumbnail", status_code=204)
    async def put_group_thumbnail(
        group_id: str,
        request: Request,
        principal: AuthPrincipal = Depends(require_scope("write:projects")),
        session: Session = Depends(get_session),
    ):
        account = principal.account
        group = require_group_manager(session, group_id, account)
        content_type = request.headers.get("content-type", "").split(";")[0]
        if content_type not in IMAGE_TYPES:
            raise HTTPException(422, "thumbnail must be PNG, JPEG, or WebP")
        data = bytearray()
        async for chunk in request.stream():
            data.extend(chunk)
            if len(data) > max_thumbnail_bytes:
                raise HTTPException(413, f"thumbnail exceeds the {max_thumbnail_bytes} byte limit")
        object_storage.put(f"groups/{group.id}/thumbnail", bytes(data), content_type)
        group.thumbnail_type = content_type
        session.commit()

    @app.get("/api/groups/{group_id}/thumbnail")
    def get_group_thumbnail(
        group_id: str,
        principal: AuthPrincipal | None = Depends(optional_principal),
        session: Session = Depends(get_session),
    ):
        account = principal.account if principal is not None else None
        group = require_group(session, group_id)
        confined = group.join_policy != "open"
        if confined and (
            account is None or group_membership(session, group_id, account.id) is None
        ):
            raise HTTPException(404, "thumbnail not found")
        if confined:
            # A confined group's thumbnail is member-only data, like a private
            # project's: reading it needs the read scope.
            assert principal is not None
            ensure_scope(principal, "read:projects")
        if not group.thumbnail_type:
            raise HTTPException(404, "thumbnail not found")
        try:
            data = object_storage.get(f"groups/{group.id}/thumbnail")
        except KeyError:
            raise HTTPException(404, "thumbnail not found")
        cache = "private, no-store" if confined else "public, max-age=3600"
        return Response(data, media_type=group.thumbnail_type, headers={"Cache-Control": cache})

    @app.delete("/api/groups/{group_id}/thumbnail", status_code=204)
    def delete_group_thumbnail(
        group_id: str,
        principal: AuthPrincipal = Depends(require_scope("write:projects")),
        session: Session = Depends(get_session),
    ):
        account = principal.account
        group = require_group_manager(session, group_id, account)
        object_storage.delete(f"groups/{group.id}/thumbnail")
        group.thumbnail_type = None
        session.commit()

    @app.get("/api/users/{username}/projects")
    def get_user_projects(
        username: str,
        response: Response,
        limit: Annotated[int, Query(ge=1, le=100)] = 24,
        offset: Annotated[int, Query(ge=0)] = 0,
        principal: AuthPrincipal | None = Depends(optional_principal),
        session: Session = Depends(get_session),
    ):
        """List a user's projects; the owner's own listing needs read:projects."""
        owner = session.scalar(select(Account).where(Account.username == username))
        if owner is None:
            raise HTTPException(404, "user not found")
        account = principal.account if principal is not None else None
        own = account is not None and account.id == owner.id
        if own:
            # The owner's listing includes unlisted and private records; that
            # breadth requires the read scope. A valid owner credential missing
            # it gets a 403 rather than a silently narrowed listing.
            ensure_scope(principal, "read:projects")
        query = select(Project).where(
            Project.owner_id == owner.id, Project.organization_id.is_(None)
        )
        if not own:
            query = query.where(Project.visibility == "public")
        projects = session.scalars(
            query.options(*LISTING_EAGER_LOADS)
            .order_by(Project.updated_at.desc())
            .offset(offset)
            .limit(limit)
        ).all()
        if account is not None:
            response.headers["Cache-Control"] = "private, no-store"
        return {"projects": [project_json(project, session, account) for project in projects]}

    @app.post("/api/projects", status_code=201)
    def post_project(
        body: ProjectCreate,
        principal: AuthPrincipal = Depends(require_scope("write:projects")),
        session: Session = Depends(get_session),
    ):
        """Create a project; publishing to public additionally needs share:public.

        Without ``visibility`` the organization's ``defaultVisibility`` applies,
        or ``private`` for a personal project.
        """
        organization = (
            session.get(Organization, body.organization_id) if body.organization_id else None
        )
        visibility = body.visibility or (
            organization.default_visibility if organization is not None else "private"
        )
        if visibility == "public":
            ensure_scope(principal, "share:public")
        if visibility not in {"public", "unlisted"} and (
            body.password or body.role != "edit" or body.expires_in not in (None, "never")
        ):
            # Link settings gate readers who reach the project through the link.
            # On an organization or private project they would lock out members
            # who have no way to learn the password.
            raise HTTPException(
                422, "role, expiry, and password apply only to public or unlisted shares"
            )
        delta = SHARE_EXPIRY_DELTAS.get(body.expires_in or "never")
        expires_at = (
            (datetime.now(UTC) + delta).isoformat().replace("+00:00", "Z") if delta else None
        )
        return {
            "project": project_json(
                create_project(
                    session,
                    principal.account,
                    body.content,
                    body.filename,
                    visibility,
                    body.organization_id,
                    body.group_ids,
                    body.role,
                    expires_at,
                    body.password,
                ),
                session,
                principal.account,
            )
        }

    @app.get("/api/shares")
    def list_shares(
        principal: AuthPrincipal = Depends(require_scope("read:projects")),
        session: Session = Depends(get_session),
    ):
        """The caller's active shares: managed public or unlisted projects.

        A share's id is its project id. Expired links stay listed so the owner can
        see and revoke them.
        """
        account = principal.account
        candidates = session.scalars(
            select(Project)
            .options(*LISTING_EAGER_LOADS)
            .where(
                (Project.owner_id == account.id)
                | (Project.created_by_id == account.id)
                | Project.organization_id.in_(
                    select(OrganizationMember.organization_id).where(
                        OrganizationMember.account_id == account.id,
                        OrganizationMember.role == "administrator",
                    )
                ),
                Project.visibility.in_(("public", "unlisted")),
            )
            .order_by(Project.updated_at.desc())
        ).all()
        return {
            "shares": [
                project_json(project, session, account) | {"projectSlug": project.slug}
                for project in candidates
                if can_manage_project(session, project, account)
            ]
        }

    @app.delete("/api/shares/{share_id}", status_code=204)
    def revoke_share(
        share_id: str,
        principal: AuthPrincipal = Depends(require_scope("write:projects")),
        session: Session = Depends(get_session),
    ):
        """Revoke a share: make the project private and clear its link settings.

        The project and its versions are kept; only the link stops working.
        """
        project = owned(session, session.get(Project, share_id), principal)
        if project.visibility not in {"public", "unlisted"}:
            # Organization-wide access is not a link share; revoking it here would
            # silently remove it, so it stays managed through project settings.
            raise HTTPException(404, "share not found")
        project.visibility = "private"
        project.share_role = "edit"
        project.share_expires_at = None
        project.share_password_hash = None
        project.updated_at = now()
        session.commit()

    @app.get("/api/projects")
    def list_projects(
        response: Response,
        limit: Annotated[int, Query(ge=1, le=100)] = 24,
        offset: Annotated[int, Query(ge=0)] = 0,
        featured: bool = False,
        mine: bool = False,
        shared_with_me: bool = False,
        shared_source: Literal["organizations", "groups"] | None = None,
        principal: AuthPrincipal | None = Depends(optional_principal),
        session: Session = Depends(get_session),
    ):
        """List public projects, the caller's own, or projects shared with the caller.

        ``mine`` and ``shared_with_me`` both need the read:projects scope.
        """
        account = principal.account if principal is not None else None
        query = select(Project)
        count = select(func.count()).select_from(Project)
        if mine and shared_with_me:
            raise HTTPException(422, "mine and shared_with_me cannot both be true")
        if shared_source and not shared_with_me:
            raise HTTPException(422, "shared_source requires shared_with_me=true")
        if mine:
            if principal is None:
                raise HTTPException(401, "authentication required", headers=bearer_challenge())
            ensure_scope(principal, "read:projects")
            query, count = (
                query.where(
                    Project.owner_id == principal.account.id, Project.organization_id.is_(None)
                ),
                count.where(
                    Project.owner_id == principal.account.id, Project.organization_id.is_(None)
                ),
            )
        elif shared_with_me:
            if principal is None or account is None:
                raise HTTPException(401, "authentication required", headers=bearer_challenge())
            ensure_scope(principal, "read:projects")
            organization_ids = select(OrganizationMember.organization_id).where(
                OrganizationMember.account_id == account.id
            )
            admin_organization_ids = select(OrganizationMember.organization_id).where(
                OrganizationMember.account_id == account.id,
                OrganizationMember.role == "administrator",
            )
            active_creator_organization_ids = select(OrganizationMember.organization_id).where(
                OrganizationMember.account_id == account.id,
                OrganizationMember.role.in_(["administrator", "publisher", "member"]),
            )
            group_project_ids = (
                select(ProjectGroup.project_id)
                .join(GroupMember, GroupMember.group_id == ProjectGroup.group_id)
                .where(
                    GroupMember.account_id == account.id,
                    GroupMember.status == "accepted",
                )
            )
            organization_condition = Project.organization_id.in_(organization_ids) & or_(
                Project.visibility.in_(["public", "organization"]),
                Project.organization_id.in_(admin_organization_ids),
                (
                    (Project.created_by_id == account.id)
                    & Project.organization_id.in_(active_creator_organization_ids)
                ),
            )
            group_condition = Project.id.in_(group_project_ids)
            condition = (
                organization_condition
                if shared_source == "organizations"
                else group_condition
                if shared_source == "groups"
                else or_(organization_condition, group_condition)
            )
            query, count = query.where(condition), count.where(condition)
        else:
            # Possession of a token must not broaden the public listing by itself.
            query, count = (
                query.where(Project.visibility == "public"),
                count.where(Project.visibility == "public"),
            )
        if featured:
            query, count = (
                query.where(Project.featured.is_(True)),
                count.where(Project.featured.is_(True)),
            )
        projects = session.scalars(
            query.options(*LISTING_EAGER_LOADS)
            .order_by(Project.updated_at.desc())
            .offset(offset)
            .limit(limit)
        ).all()
        if account is not None:
            response.headers["Cache-Control"] = "private, no-store"
        return {
            "projects": [project_json(p, session, account) for p in projects],
            "limit": limit,
            "offset": offset,
            "total": session.scalar(count),
        }

    @app.get("/api/projects/{project_id}")
    def get_project(
        project_id: str,
        principal: AuthPrincipal | None = Depends(optional_principal),
        session: Session = Depends(get_session),
    ):
        """Return one project; non-public reads need read:projects."""
        account = principal.account if principal is not None else None
        project = visible_read(session, session.get(Project, project_id), principal)
        response = JSONResponse({"project": project_json(project, session, account)})
        if protected(project) or account is not None:
            response.headers["Cache-Control"] = "private, no-store"
        return response

    @app.get("/api/projects/{project_id}/activity")
    def get_project_activity(
        project_id: str,
        principal: AuthPrincipal = Depends(require_scope("read:projects")),
        session: Session = Depends(get_session),
    ):
        """Return the activity log for one of the caller's own projects."""
        project = owned(session, session.get(Project, project_id), principal)
        activities = session.scalars(
            select(ProjectActivity)
            .where(ProjectActivity.project_id == project.id)
            .order_by(ProjectActivity.created_at.desc())
            .limit(100)
        ).all()
        return {"activity": [activity_json(act) for act in activities]}

    @app.delete("/api/projects/{project_id}/activity", status_code=204)
    def delete_project_activity(
        project_id: str,
        principal: AuthPrincipal = Depends(require_scope("write:projects")),
        session: Session = Depends(get_session),
    ):
        """Clear the activity log of one of the caller's own projects."""
        project = owned(session, session.get(Project, project_id), principal)
        session.execute(delete(ProjectActivity).where(ProjectActivity.project_id == project.id))
        session.commit()
        return Response(status_code=204)

    @app.patch("/api/projects/{project_id}")
    def patch_project(
        project_id: str,
        body: ProjectPatch,
        principal: AuthPrincipal = Depends(require_scope("write:projects")),
        session: Session = Depends(get_session),
    ):
        """Patch one of the caller's projects; raising to public needs share:public."""
        account = principal.account
        project = owned(session, session.get(Project, project_id), principal)
        old_visibility = project.visibility
        updates = body.model_dump(exclude_unset=True)
        final_visibility = updates.get("visibility", project.visibility)
        final_organization_id = updates.get("organization_id", project.organization_id)
        final_group_ids = updates.get("group_ids", shared_group_ids(session, project.id))
        if final_visibility is None:
            raise HTTPException(422, "visibility must not be null")
        # Existing targets may outlive the creator's membership. They must still
        # be able to remove a stale target or edit unrelated metadata; only a
        # submitted replacement target list requires current membership. Moving
        # the project to another organization re-checks every target, as creating
        # it there would, so groups outside the organization cannot come along.
        organization_changes = final_organization_id != project.organization_id
        group_ids_to_validate = (
            final_group_ids if "group_ids" in updates or organization_changes else []
        )
        validate_access_targets(
            session,
            account,
            final_visibility,
            final_organization_id,
            group_ids_to_validate or [],
        )
        if "title" in updates:
            if not updates["title"] or not updates["title"].strip():
                raise HTTPException(422, "title must not be empty")
            project.title = updates["title"].strip()
        if "description" in updates:
            project.description = updates["description"] or ""
        if "visibility" in updates:
            # exclude_unset keeps a field the client sent as an explicit null, so
            # these two need their own guards: null visibility would hit a
            # non-nullable column at commit, and null tags would reach len().
            # Both surfaced as an unhandled 500 rather than a 422.
            if updates["visibility"] is None:
                raise HTTPException(422, "visibility must not be null")
            if updates["visibility"] == "public" and old_visibility != "public":
                # Raising to public is a publication; reducing exposure is not.
                ensure_scope(principal, "share:public")
            project.visibility = updates["visibility"]
        if "organization_id" in updates and updates["organization_id"] != project.organization_id:
            # The organization owns its projects: only its administrator may move
            # one out, so a creator cannot take team work (or dodge the public
            # sharing policy) by re-parenting it.
            if (
                project.organization_id
                and organization_role(session, project.organization_id, account.id)
                != "administrator"
            ):
                raise HTTPException(
                    403, "organization administrator permission required to move a project"
                )
            # A project leaving an organization returns to its creator, not to
            # whichever administrator moved it.
            new_owner_id = (
                (project.created_by_id or account.id) if project.organization_id else account.id
            )
            project.slug = unique_slug(
                session, new_owner_id, project.slug, updates["organization_id"]
            )
            project.organization_id = updates["organization_id"]
            if not updates["organization_id"] or legacy_project_owner_required:
                project.owner_id = new_owner_id
            else:
                project.owner_id = None
        if "group_ids" in updates:
            replace_group_shares(session, project, updates["group_ids"] or [])
        if "delete_protected" in updates:
            # exclude_unset keeps an explicit null, which would hit the
            # non-nullable column at commit; answer 422 instead of a 500.
            if updates["delete_protected"] is None:
                raise HTTPException(422, "deleteProtected must not be null")
            project.delete_protected = updates["delete_protected"]
        if "tags" in updates:
            tags = updates["tags"] or []
            if len(tags) > 20 or any(not tag or len(tag) > 40 for tag in tags):
                raise HTTPException(422, "tags must contain at most 20 non-empty 40-character tags")
            project.tags_json = json.dumps(tags)
        project.updated_at = now()
        if old_visibility != project.visibility:
            log_project_activity(
                session,
                project.id,
                principal.account.id,
                "visibility_change",
                {"before": old_visibility, "after": project.visibility},
            )
        try:
            session.commit()
        except IntegrityError:
            session.rollback()
            raise HTTPException(409, "project slug already exists") from None
        return {"project": project_json(project, session, account)}

    @app.put("/api/projects/{project_id}/content", status_code=201)
    def update_content(
        project_id: str,
        body: ContentUpdate,
        principal: AuthPrincipal = Depends(require_scope("write:projects")),
        session: Session = Depends(get_session),
    ):
        """Write a new version of a project the caller owns or may shared-update."""
        project = editable(session.get(Project, project_id), principal, session)
        parse_content(body.content, max_project_bytes)
        # Allocated from max(number) and committed *before* the object is
        # written. Deriving it from len(project.versions) let two concurrent
        # updates pick the same number: both wrote the same storage key, the
        # second lost the primary-key race with a 500, and the winner's content
        # had already been overwritten. Reserving the row first means a loser
        # fails before touching storage, and can retry on the next free number.
        for _ in range(5):
            number = (
                session.scalar(
                    select(func.max(Version.number)).where(Version.project_id == project.id)
                )
                or 0
            ) + 1
            key = f"projects/{project.id}/versions/{number}.json"
            session.add(
                Version(
                    project_id=project.id,
                    number=number,
                    object_key=key,
                    created_at=now(),
                )
            )
            try:
                session.flush()
                break
            except (IntegrityError, OperationalError):
                # See create_project: a SQLite lock is transient and retryable.
                session.rollback()
                project = editable(session.get(Project, project_id), principal, session)
        else:
            raise HTTPException(409, "could not allocate a version number; retry")
        current_number = number - 1
        conflict = body.expected_version is not None and body.expected_version != current_number
        object_storage.put(key, body.content.encode(), "application/json")
        project.updated_at = now()
        log_project_activity(
            session, project.id, principal.account.id, "version_save", {"version": number}
        )
        session.commit()
        session.refresh(project)
        result = {
            "project": project_json(project, session, principal.account),
            "version": number,
        }
        if conflict:
            result["warning"] = (
                f"version conflict: expected {body.expected_version}, "
                f"but version {current_number} was current; update saved as version {number}"
            )
        return result

    @app.delete("/api/projects/{project_id}", status_code=204)
    def delete_project_route(
        project_id: str,
        principal: AuthPrincipal = Depends(require_scope("write:projects")),
        session: Session = Depends(get_session),
    ):
        """Delete one of the caller's projects and its stored objects."""
        project = owned(session, session.get(Project, project_id), principal)
        if project.delete_protected:
            raise HTTPException(409, DELETE_PROTECTED)
        session.delete(project)
        session.commit()
        object_storage.delete_project(project_id)

    @app.post("/api/projects/{project_id}/forks", status_code=201)
    def fork_project(
        project_id: str,
        # Optional so the body may be omitted entirely: "fork this project" with
        # no options is the common call, and every field already has a default.
        # Without this FastAPI treats the body as required and answers 422. The
        # default is None rather than ForkRequest() so the model is not
        # constructed at import time (ruff B008).
        body: ForkRequest | None = None,
        principal: AuthPrincipal = Depends(require_scope("write:projects")),
        session: Session = Depends(get_session),
    ):
        """Fork a project; forking a protected source or publishing needs extra scopes."""
        source = visible_read(session, session.get(Project, project_id), principal)
        content = object_storage.get(source.versions[-1].object_key).decode()
        fork_visibility = (body or ForkRequest()).visibility
        if fork_visibility == "public":
            ensure_scope(principal, "share:public")
        # A fork of protected organization content stays inside the organization,
        # so the fork is held to the same roles and public-sharing policy.
        fork_organization_id = (
            source.organization_id
            if source.organization_id and source.visibility not in {"public", "unlisted"}
            else None
        )
        fork = create_project(
            session,
            principal.account,
            content,
            source.title + ".geolibre.json",
            fork_visibility,
            fork_organization_id,
            commit=False,
        )
        # Incremented in SQL rather than read-modify-write in Python, so
        # concurrent forks cannot lose each other's increments. The contract in
        # docs/server-api.md promises this counter rises atomically.
        session.execute(
            update(Project).where(Project.id == source.id).values(fork_count=Project.fork_count + 1)
        )
        log_project_activity(
            session, source.id, principal.account.id, "fork", {"forked_project_id": fork.id}
        )
        session.commit()
        session.refresh(fork)
        return {"project": project_json(fork, session, principal.account)}

    @app.post("/api/projects/{project_id}/transfers", status_code=201)
    def create_project_transfer(
        project_id: str,
        body: ProjectTransferCreate,
        request: Request,
        principal: AuthPrincipal = Depends(require_scope("write:projects")),
        session: Session = Depends(get_session),
    ):
        """Transfer a project to a user (pending their accept) or an administered org.

        A user target stays pending until they accept, so the project keeps its
        current address and owner in the meantime. An organization target is
        applied immediately: the initiator already administers the recipient.
        """
        account = principal.account
        # Serialize offers and immediate organization moves on the same project.
        project = owned(
            session,
            session.scalar(select(Project).where(Project.id == project_id).with_for_update()),
            principal,
        )
        if not can_transfer_project(session, project, account):
            raise HTTPException(
                403, "organization administrator permission required to move a project"
            )
        if (body.username is None) == (body.organization_id is None):
            raise HTTPException(422, "provide exactly one of username or organizationId")
        if session.scalar(
            select(ProjectTransfer.id).where(
                ProjectTransfer.project_id == project.id,
                ProjectTransfer.status == "pending",
            )
        ):
            raise HTTPException(409, TRANSFER_PENDING)
        slug = slugify(body.slug) if body.slug else project.slug
        timestamp = now()

        if body.username is not None:
            target = session.scalar(
                select(Account).where(Account.username == body.username.strip().lower())
            )
            if target is None:
                raise HTTPException(404, "user not found")
            if project.organization_id is None and project.owner_id == target.id:
                raise HTTPException(422, "project already belongs to that owner")
            if path_reserved(session, target.id, None, slug, project.id):
                raise HTTPException(409, TRANSFER_SLUG_CONFLICT)
            transfer = ProjectTransfer(
                id=str(uuid.uuid4()),
                project_id=project.id,
                from_account_id=account.id,
                to_account_id=target.id,
                slug=slug,
                status="pending",
                created_at=timestamp,
            )
            session.add(transfer)
            try:
                session.commit()
            except IntegrityError:
                session.rollback()
                if session.scalar(
                    select(ProjectTransfer.id).where(
                        ProjectTransfer.project_id == project_id,
                        ProjectTransfer.status == "pending",
                    )
                ):
                    raise HTTPException(409, TRANSFER_PENDING) from None
                raise HTTPException(409, TRANSFER_INVALID) from None
            return {
                "transfer": transfer_json(transfer),
                "project": project_json(project, session, account),
            }

        organization = require_organization_admin(
            session, body.organization_id, principal, request, mutation=True
        )
        if project.organization_id == organization.id:
            raise HTTPException(422, "project already belongs to that owner")
        if path_reserved(session, None, organization.id, slug, project.id):
            raise HTTPException(409, TRANSFER_SLUG_CONFLICT)
        apply_transfer(
            session,
            project,
            account,
            to_account=None,
            to_organization=organization,
            slug=slug,
        )
        transfer = ProjectTransfer(
            id=str(uuid.uuid4()),
            project_id=project.id,
            from_account_id=account.id,
            to_organization_id=organization.id,
            slug=slug,
            status="accepted",
            created_at=timestamp,
            resolved_at=timestamp,
        )
        session.add(transfer)
        try:
            session.commit()
        except IntegrityError:
            session.rollback()
            raise HTTPException(409, TRANSFER_SLUG_CONFLICT) from None
        session.refresh(project)
        return {
            "transfer": transfer_json(transfer),
            "project": project_json(project, session, account),
        }

    @app.get("/api/transfers/incoming")
    def list_incoming_transfers(
        response: Response,
        principal: AuthPrincipal = Depends(require_scope("read:projects")),
        session: Session = Depends(get_session),
    ):
        """List transfers offered to the caller that are still pending."""
        transfers = session.scalars(
            select(ProjectTransfer)
            .where(
                ProjectTransfer.to_account_id == principal.account.id,
                ProjectTransfer.status == "pending",
            )
            .order_by(ProjectTransfer.created_at.desc())
        ).all()
        response.headers["Cache-Control"] = "private, no-store"
        return {"transfers": [transfer_json(item) for item in transfers]}

    @app.get("/api/transfers/outgoing")
    def list_outgoing_transfers(
        response: Response,
        principal: AuthPrincipal = Depends(require_scope("read:projects")),
        session: Session = Depends(get_session),
    ):
        """List the caller's transfers that are still pending acceptance."""
        transfers = session.scalars(
            select(ProjectTransfer)
            .where(
                ProjectTransfer.from_account_id == principal.account.id,
                ProjectTransfer.status == "pending",
            )
            .order_by(ProjectTransfer.created_at.desc())
        ).all()
        response.headers["Cache-Control"] = "private, no-store"
        return {"transfers": [transfer_json(item) for item in transfers]}

    @app.post("/api/transfers/{transfer_id}/accept")
    def accept_project_transfer(
        transfer_id: str,
        # Optional so the body may be omitted: accepting with the proposed slug
        # is the common call. Same idiom as fork_project.
        body: ProjectTransferAccept | None = None,
        principal: AuthPrincipal = Depends(require_scope("write:projects")),
        session: Session = Depends(get_session),
    ):
        """Accept a pending transfer; the project moves to the caller's namespace."""
        account = principal.account
        transfer = session.scalar(
            select(ProjectTransfer).where(
                ProjectTransfer.id == transfer_id,
                ProjectTransfer.status == "pending",
                ProjectTransfer.to_account_id == account.id,
            )
        )
        if transfer is None:
            raise HTTPException(404, "transfer not found")
        # Lock the same project row as transfer creation before rechecking
        # authority; a concurrent organization move cannot overtake acceptance.
        project = session.scalar(
            select(Project).where(Project.id == transfer.project_id).with_for_update()
        )
        if project is None:
            raise HTTPException(409, TRANSFER_INVALID)
        # The initiator may have lost the right to hand the project over (left
        # the organization, say) since offering it. Void the offer rather than
        # completing a transfer they can no longer authorize.
        if transfer.from_account is None or not can_transfer_project(
            session, project, transfer.from_account
        ):
            if resolve_pending_transfer(session, transfer.id, "cancelled"):
                session.commit()
            raise HTTPException(409, TRANSFER_INVALID)
        slug = slugify(body.slug) if body and body.slug else transfer.slug
        if path_reserved(session, account.id, None, slug, project.id):
            raise HTTPException(409, TRANSFER_SLUG_CONFLICT)
        if not resolve_pending_transfer(session, transfer.id, "accepted"):
            raise HTTPException(409, TRANSFER_INVALID)
        apply_transfer(
            session,
            project,
            account,
            to_account=account,
            to_organization=None,
            slug=slug,
        )
        transfer.slug = slug
        try:
            session.commit()
        except IntegrityError:
            session.rollback()
            raise HTTPException(409, TRANSFER_SLUG_CONFLICT) from None
        session.refresh(project)
        session.refresh(transfer)
        return {
            "project": project_json(project, session, account),
            "transfer": transfer_json(transfer),
        }

    @app.post("/api/transfers/{transfer_id}/decline", status_code=204)
    def decline_project_transfer(
        transfer_id: str,
        principal: AuthPrincipal = Depends(require_scope("write:projects")),
        session: Session = Depends(get_session),
    ):
        """Decline a transfer offered to the caller."""
        transfer = session.scalar(
            select(ProjectTransfer).where(
                ProjectTransfer.id == transfer_id,
                ProjectTransfer.status == "pending",
                ProjectTransfer.to_account_id == principal.account.id,
            )
        )
        if transfer is None:
            raise HTTPException(404, "transfer not found")
        if not resolve_pending_transfer(session, transfer.id, "declined"):
            raise HTTPException(404, "transfer not found")
        session.commit()
        return Response(status_code=204)

    @app.delete("/api/transfers/{transfer_id}", status_code=204)
    def cancel_project_transfer(
        transfer_id: str,
        principal: AuthPrincipal = Depends(require_scope("write:projects")),
        session: Session = Depends(get_session),
    ):
        """Cancel a pending transfer the caller started or can still manage."""
        transfer = session.scalar(
            select(ProjectTransfer).where(
                ProjectTransfer.id == transfer_id,
                ProjectTransfer.status == "pending",
            )
        )
        if transfer is None:
            raise HTTPException(404, "transfer not found")
        if transfer.from_account_id != principal.account.id and not can_transfer_project(
            session, transfer.project, principal.account
        ):
            raise HTTPException(404, "transfer not found")
        if not resolve_pending_transfer(session, transfer.id, "cancelled"):
            raise HTTPException(404, "transfer not found")
        session.commit()
        return Response(status_code=204)

    def raw_response(project: Project, version: Version, request: Request) -> Response:
        """Serve a stored project body with cache headers matching its visibility.

        Protected bodies are never stored by caches. Public and unlisted bodies
        carry a strong ETag and ``no-cache``, so every cached copy is revalidated
        against the origin: a project made private (or demoted by an organization
        policy change) stops being served at once instead of after a max-age.

        A version's stored body is written once and never changed, so the
        project id and version number identify the bytes exactly. The ETag is
        derived from them, and a matching ``If-None-Match`` is answered before
        the body is read, so revalidation costs no storage read or hashing.
        """
        if not protected(project):
            etag = f'"{project.id}-v{version.number}"'
            headers = {"Cache-Control": "public, no-cache", "ETag": etag}
            if_none_match = request.headers.get("if-none-match", "").strip()
            # Either the bare wildcard or a list of entity-tags; a "*" inside a
            # quoted tag is part of that tag, not a wildcard.
            candidates = {tag.removeprefix("W/") for tag in ENTITY_TAG_RE.findall(if_none_match)}
            if if_none_match == "*" or etag in candidates:
                return Response(status_code=304, headers=headers)
        try:
            content = object_storage.get(version.object_key)
        except KeyError:
            raise HTTPException(404, "project content not found")
        if protected(project):
            return Response(
                content,
                media_type="application/json",
                headers={"Cache-Control": "private, no-store"},
            )
        return Response(content, media_type="application/json", headers=headers)

    @app.get("/api/projects/{project_id}/versions")
    def list_versions(
        project_id: str,
        principal: AuthPrincipal = Depends(require_scope("read:projects")),
        session: Session = Depends(get_session),
    ):
        """List a visible project's versions, newest first (needs read:projects)."""
        project = visible(session, session.get(Project, project_id), principal)
        link_gate(session, project, principal, None)
        body = {
            "versions": [
                {
                    "number": version.number,
                    "createdAt": version.created_at,
                    "url": f"{base_url}/api/projects/{project.id}/versions/{version.number}",
                }
                for version in reversed(project.versions)
            ]
        }
        response = JSONResponse(body)
        if protected(project):
            response.headers["Cache-Control"] = "private, no-store"
        return response

    @app.get("/api/projects/{project_id}/versions/{number}")
    def get_version(
        project_id: str,
        number: int,
        request: Request,
        principal: AuthPrincipal | None = Depends(optional_principal),
        session: Session = Depends(get_session),
    ):
        """Fetch one project version; non-public fetches need read:projects."""
        project = visible_read(session, session.get(Project, project_id), principal)
        version = session.get(Version, (project_id, number))
        if version is None:
            raise HTTPException(404, "project version not found")
        log_project_activity(
            session,
            project.id,
            principal.account.id if principal else None,
            "fetch",
            {"version": number},
        )
        session.commit()
        return raw_response(project, version, request)

    @app.put("/api/projects/{project_id}/thumbnail", status_code=204)
    async def put_thumbnail(
        project_id: str,
        request: Request,
        principal: AuthPrincipal = Depends(require_scope("write:projects")),
        session: Session = Depends(get_session),
    ):
        """Upload a thumbnail image for one of the caller's projects."""
        project = owned(session, session.get(Project, project_id), principal)
        content_type = request.headers.get("content-type", "").split(";")[0]
        if content_type not in IMAGE_TYPES:
            raise HTTPException(422, "thumbnail must be PNG, JPEG, or WebP")
        # Streamed rather than `await request.body()`, which materializes the
        # whole upload before the size is ever checked: an authenticated caller
        # could otherwise push a multi-gigabyte body and exhaust worker memory to
        # earn a 413. Aborting mid-stream caps what is ever held.
        chunks: list[bytes] = []
        total = 0
        async for chunk in request.stream():
            total += len(chunk)
            if total > max_thumbnail_bytes:
                raise HTTPException(413, f"thumbnail exceeds the {max_thumbnail_bytes} byte limit")
            chunks.append(chunk)
        data = b"".join(chunks)
        object_storage.put(f"projects/{project.id}/thumbnail", data, content_type)
        project.thumbnail_type = content_type
        project.updated_at = now()
        session.commit()

    @app.get("/api/projects/{project_id}/thumbnail")
    def get_thumbnail(
        project_id: str,
        principal: AuthPrincipal | None = Depends(optional_principal),
        session: Session = Depends(get_session),
    ):
        """Fetch a project thumbnail; non-public reads need read:projects."""
        project = visible_read(session, session.get(Project, project_id), principal)
        if not project.thumbnail_type:
            raise HTTPException(404, "thumbnail not found")
        try:
            data = object_storage.get(f"projects/{project.id}/thumbnail")
        except KeyError:
            raise HTTPException(404, "thumbnail not found")
        cache = "private, no-store" if protected(project) else "public, max-age=3600"
        return Response(data, media_type=project.thumbnail_type, headers={"Cache-Control": cache})

    @app.delete("/api/projects/{project_id}/thumbnail", status_code=204)
    def delete_thumbnail(
        project_id: str,
        principal: AuthPrincipal = Depends(require_scope("write:projects")),
        session: Session = Depends(get_session),
    ):
        """Remove a project's thumbnail."""
        project = owned(session, session.get(Project, project_id), principal)
        object_storage.delete(f"projects/{project.id}/thumbnail")
        project.thumbnail_type = None
        project.updated_at = now()
        session.commit()

    @app.get("/org/{organization_slug}/{slug}.geolibre.json")
    def latest_organization_raw(
        organization_slug: str,
        slug: str,
        request: Request,
        principal: AuthPrincipal | None = Depends(optional_principal),
        session: Session = Depends(get_session),
    ):
        """Serve an organization project's latest raw JSON, counting a view."""
        project = session.scalar(
            select(Project)
            .join(Organization)
            .where(Organization.slug == organization_slug, Project.slug == slug)
        )
        if project is None:
            redirect = session.scalar(
                select(ProjectRedirect)
                .join(Organization, ProjectRedirect.organization_id == Organization.id)
                .where(Organization.slug == organization_slug, ProjectRedirect.slug == slug)
            )
            response = redirect_response(session, redirect, principal, page=False)
            if response is not None:
                return response
        project = visible_read(session, project, principal)
        body = raw_response(project, project.versions[-1], request)
        session.execute(
            update(Project).where(Project.id == project.id).values(views=Project.views + 1)
        )
        log_project_activity(
            session,
            project.id,
            principal.account.id if principal else None,
            "fetch",
            {"version": project.versions[-1].number},
        )
        session.commit()
        return body

    @app.get("/org/{organization_slug}/{slug}")
    def organization_project_page(
        organization_slug: str,
        slug: str,
        principal: AuthPrincipal | None = Depends(optional_principal),
        session: Session = Depends(get_session),
    ):
        """Redirect to the viewer for an organization project, counting an open."""
        project = session.scalar(
            select(Project)
            .join(Organization)
            .where(Organization.slug == organization_slug, Project.slug == slug)
        )
        if project is None:
            redirect = session.scalar(
                select(ProjectRedirect)
                .join(Organization, ProjectRedirect.organization_id == Organization.id)
                .where(Organization.slug == organization_slug, ProjectRedirect.slug == slug)
            )
            response = redirect_response(session, redirect, principal, page=True)
            if response is not None:
                return response
        project = visible_read(session, project, principal)
        log_project_activity(
            session, project.id, principal.account.id if principal else None, "open"
        )
        session.commit()
        raw = f"{base_url}/org/{quote(organization_slug)}/{quote(slug)}.geolibre.json"
        return RedirectResponse(viewer_url + "?project=" + quote(raw, safe=""), status_code=302)

    @app.get("/{username}/{slug}.geolibre.json")
    def latest_raw(
        username: str,
        slug: str,
        request: Request,
        principal: AuthPrincipal | None = Depends(optional_principal),
        session: Session = Depends(get_session),
    ):
        """Serve the latest raw project JSON, counting a view for anonymous fetches."""
        project = session.scalar(
            select(Project)
            .join(Account, Project.owner_id == Account.id)
            .where(
                Account.username == username,
                Project.slug == slug,
                Project.organization_id.is_(None),
            )
        )
        if project is None:
            # The address may have been vacated by a transfer; follow it rather
            # than 404 so old links keep working.
            redirect = session.scalar(
                select(ProjectRedirect)
                .join(Account, ProjectRedirect.account_id == Account.id)
                .where(Account.username == username, ProjectRedirect.slug == slug)
            )
            response = redirect_response(session, redirect, principal, page=False)
            if response is not None:
                return response
        project = visible_read(session, project, principal)
        # Read the object first: a missing object is a 404 that should not count
        # as a view. Incremented in SQL so concurrent reads do not lose counts.
        body = raw_response(project, project.versions[-1], request)
        session.execute(
            update(Project).where(Project.id == project.id).values(views=Project.views + 1)
        )
        log_project_activity(
            session,
            project.id,
            principal.account.id if principal else None,
            "fetch",
            {"version": project.versions[-1].number},
        )
        session.commit()
        return body

    access_attempts: dict[tuple[str, str], list[float]] = {}
    access_attempts_lock = threading.Lock()

    def reserve_access_attempt(key: tuple[str, str]) -> float:
        """Count one attempt against ``key`` or raise 429, atomically.

        The attempt is reserved before the password is checked so concurrent
        requests cannot all pass the limit check ahead of any recorded failure.
        """
        stamp = time.monotonic()
        cutoff = stamp - SHARE_ACCESS_WINDOW_SECONDS
        with access_attempts_lock:
            if len(access_attempts) > 1024:
                for stale in [
                    other
                    for other, stamps in access_attempts.items()
                    if not stamps or stamps[-1] <= cutoff
                ]:
                    del access_attempts[stale]
            recent = [seen for seen in access_attempts.get(key, []) if seen > cutoff]
            if len(recent) >= SHARE_ACCESS_MAX_FAILURES:
                access_attempts[key] = recent
                raise HTTPException(429, "too many incorrect passwords; try again later")
            access_attempts[key] = [*recent, stamp]
        return stamp

    def release_access_attempt(key: tuple[str, str], stamp: float) -> None:
        """Give back a reserved attempt that was not a wrong password."""
        with access_attempts_lock:
            stamps = access_attempts.get(key, [])
            if stamp in stamps:
                stamps.remove(stamp)

    def share_access_response(
        request: Request,
        session: Session,
        project: Project | None,
        principal: AuthPrincipal | None,
        password: str,
    ) -> Response:
        """Return the latest content and share role once the link password checks out.

        Wrong guesses are throttled per project and client address, because each
        check costs a scrypt hash and the route is anonymous.
        """
        project = visible(session, project, principal)
        key = (project.id, str(client_ip(request) or ""))
        stamp = reserve_access_attempt(key)
        try:
            project = visible_read(session, project, principal, password)
        except HTTPException as error:
            if error.status_code != 401:
                release_access_attempt(key, stamp)
            raise
        release_access_attempt(key, stamp)
        try:
            content = object_storage.get(project.versions[-1].object_key)
        except KeyError:
            raise HTTPException(404, "project content not found")
        return Response(
            json.dumps({"content": content.decode(), "role": project.share_role}),
            media_type="application/json",
            headers={"Cache-Control": "private, no-store"},
        )

    @app.post("/org/{organization_slug}/{slug}/access")
    def organization_share_access(
        organization_slug: str,
        slug: str,
        body: ShareAccessRequest,
        request: Request,
        principal: AuthPrincipal | None = Depends(optional_principal),
        session: Session = Depends(get_session),
    ):
        """Unlock a password-protected organization project link."""
        project = session.scalar(
            select(Project)
            .join(Organization)
            .where(Organization.slug == organization_slug, Project.slug == slug)
        )
        return share_access_response(request, session, project, principal, body.password)

    @app.post("/{username}/{slug}/access")
    def share_access(
        username: str,
        slug: str,
        body: ShareAccessRequest,
        request: Request,
        principal: AuthPrincipal | None = Depends(optional_principal),
        session: Session = Depends(get_session),
    ):
        """Unlock a password-protected personal project link."""
        project = session.scalar(
            select(Project)
            .join(Account, Project.owner_id == Account.id)
            .where(
                Account.username == username,
                Project.slug == slug,
                Project.organization_id.is_(None),
            )
        )
        return share_access_response(request, session, project, principal, body.password)

    @app.get("/{username}/{slug}")
    def project_page(
        username: str,
        slug: str,
        principal: AuthPrincipal | None = Depends(optional_principal),
        session: Session = Depends(get_session),
    ):
        """Redirect to the viewer for a project, counting an anonymous open."""
        project = session.scalar(
            select(Project)
            .join(Account, Project.owner_id == Account.id)
            .where(
                Account.username == username,
                Project.slug == slug,
                Project.organization_id.is_(None),
            )
        )
        if project is None:
            redirect = session.scalar(
                select(ProjectRedirect)
                .join(Account, ProjectRedirect.account_id == Account.id)
                .where(Account.username == username, ProjectRedirect.slug == slug)
            )
            response = redirect_response(session, redirect, principal, page=True)
            if response is not None:
                return response
        project = visible_read(session, project, principal)
        log_project_activity(
            session, project.id, principal.account.id if principal else None, "open"
        )
        session.commit()
        raw = f"{base_url}/{quote(username)}/{quote(slug)}.geolibre.json"
        return RedirectResponse(viewer_url + "?project=" + quote(raw, safe=""), status_code=302)

    return app


def run() -> None:
    import uvicorn

    # A factory, not a module-level `app = create_app()`. Building the app at
    # import time opens the database and creates the storage root as a side
    # effect of importing this module -- which the test suite does, leaving a
    # stray ./geolibre-server-api.db and ./data in whatever directory pytest ran
    # from.
    uvicorn.run(
        "geolibre_server_api.main:create_app",
        factory=True,
        host=os.getenv("GEOLIBRE_HOST", "0.0.0.0"),  # noqa: S104 - containers bind all interfaces
        port=int(os.getenv("GEOLIBRE_PORT", "8000")),
    )
