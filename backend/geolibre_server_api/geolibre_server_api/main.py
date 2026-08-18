from __future__ import annotations

import hashlib
import hmac
import json
import logging
import os
import re
import secrets
import shutil
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Annotated, Literal
from urllib.parse import quote

UTC = getattr(timezone, "utc", timezone.utc)

from fastapi import Depends, FastAPI, Header, HTTPException, Query, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, RedirectResponse
from pydantic import BaseModel, Field
from sqlalchemy import (
    Boolean,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
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
from sqlalchemy.orm import (
    DeclarativeBase,
    Mapped,
    Session,
    mapped_column,
    relationship,
    selectinload,
    sessionmaker,
)

Visibility = Literal["public", "unlisted", "private", "organization"]
OrganizationRole = Literal["administrator", "publisher", "member", "viewer"]
GroupRole = Literal["owner", "manager", "member"]
PublicSharingPolicy = Literal["yes", "publishers", "no"]
JoinPolicy = Literal["invite", "request", "open"]
# 3-39 chars, starting and ending alphanumeric. The middle group is *not*
# optional: making it so would let a single character through, which contradicts
# both the error text and the limits table in docs/server-api.md.
USERNAME_RE = re.compile(r"^[a-z0-9][a-z0-9-]{1,37}[a-z0-9]$")
SLUG_RE = re.compile(r"[^a-z0-9]+")
IMAGE_TYPES = {"image/png", "image/jpeg", "image/webp"}

logger = logging.getLogger(__name__)


class Base(DeclarativeBase):
    pass


class Account(Base):
    __tablename__ = "accounts"
    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    username: Mapped[str | None] = mapped_column(String(39), unique=True, nullable=True)
    email: Mapped[str | None] = mapped_column(String(320), unique=True, nullable=True)
    password_hash: Mapped[str] = mapped_column(Text)
    created_at: Mapped[str] = mapped_column(String(32))
    projects: Mapped[list[Project]] = relationship(
        back_populates="owner", foreign_keys="Project.owner_id"
    )


class Organization(Base):
    __tablename__ = "organizations"
    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    slug: Mapped[str] = mapped_column(String(100), unique=True)
    name: Mapped[str] = mapped_column(String(100))
    public_sharing_policy: Mapped[str] = mapped_column(String(16), default="yes")
    default_visibility: Mapped[str] = mapped_column(String(16), default="organization")
    categories_json: Mapped[str] = mapped_column(Text, default="[]")
    created_at: Mapped[str] = mapped_column(String(32))
    members: Mapped[list[OrganizationMember]] = relationship(
        back_populates="organization", cascade="all, delete-orphan"
    )


class OrganizationMember(Base):
    __tablename__ = "organization_members"
    organization_id: Mapped[str] = mapped_column(
        ForeignKey("organizations.id", ondelete="CASCADE"), primary_key=True
    )
    account_id: Mapped[str] = mapped_column(
        ForeignKey("accounts.id", ondelete="CASCADE"), primary_key=True
    )
    role: Mapped[str] = mapped_column(String(16))
    created_at: Mapped[str] = mapped_column(String(32))
    organization: Mapped[Organization] = relationship(back_populates="members")
    account: Mapped[Account] = relationship()


class OrganizationInvitation(Base):
    __tablename__ = "organization_invitations"
    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    organization_id: Mapped[str] = mapped_column(
        ForeignKey("organizations.id", ondelete="CASCADE"), index=True
    )
    invited_by_id: Mapped[str] = mapped_column(ForeignKey("accounts.id", ondelete="CASCADE"))
    username: Mapped[str | None] = mapped_column(String(39), nullable=True, index=True)
    email: Mapped[str | None] = mapped_column(String(320), nullable=True, index=True)
    role: Mapped[str] = mapped_column(String(16), default="member")
    status: Mapped[str] = mapped_column(String(16), default="pending")
    token_digest: Mapped[str] = mapped_column(String(64), unique=True)
    created_at: Mapped[str] = mapped_column(String(32))
    accepted_at: Mapped[str | None] = mapped_column(String(32), nullable=True)
    revoked_at: Mapped[str | None] = mapped_column(String(32), nullable=True)
    organization: Mapped[Organization] = relationship()


class Group(Base):
    __tablename__ = "groups"
    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    organization_id: Mapped[str | None] = mapped_column(
        ForeignKey("organizations.id", ondelete="CASCADE"), nullable=True, index=True
    )
    owner_id: Mapped[str] = mapped_column(ForeignKey("accounts.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(100))
    description: Mapped[str] = mapped_column(Text, default="")
    thumbnail_type: Mapped[str | None] = mapped_column(String(20), nullable=True)
    join_policy: Mapped[str] = mapped_column(String(16), default="invite")
    shared_update: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[str] = mapped_column(String(32))
    members: Mapped[list[GroupMember]] = relationship(
        back_populates="group", cascade="all, delete-orphan"
    )


class GroupMember(Base):
    __tablename__ = "group_members"
    __table_args__ = (
        Index(
            "uq_group_accepted_owner",
            "group_id",
            unique=True,
            sqlite_where=text("role = 'owner' AND status = 'accepted'"),
            postgresql_where=text("role = 'owner' AND status = 'accepted'"),
        ),
    )
    group_id: Mapped[str] = mapped_column(
        ForeignKey("groups.id", ondelete="CASCADE"), primary_key=True
    )
    account_id: Mapped[str] = mapped_column(
        ForeignKey("accounts.id", ondelete="CASCADE"), primary_key=True
    )
    role: Mapped[str] = mapped_column(String(16))
    status: Mapped[str] = mapped_column(String(16), default="accepted")
    created_at: Mapped[str] = mapped_column(String(32))
    group: Mapped[Group] = relationship(back_populates="members")
    account: Mapped[Account] = relationship()


class GroupInvitation(Base):
    __tablename__ = "group_invitations"
    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    group_id: Mapped[str] = mapped_column(ForeignKey("groups.id", ondelete="CASCADE"), index=True)
    invited_by_id: Mapped[str] = mapped_column(ForeignKey("accounts.id", ondelete="CASCADE"))
    username: Mapped[str | None] = mapped_column(String(39), nullable=True, index=True)
    email: Mapped[str | None] = mapped_column(String(320), nullable=True, index=True)
    role: Mapped[str] = mapped_column(String(16), default="member")
    status: Mapped[str] = mapped_column(String(16), default="pending")
    token_digest: Mapped[str] = mapped_column(String(64), unique=True)
    created_at: Mapped[str] = mapped_column(String(32))
    accepted_at: Mapped[str | None] = mapped_column(String(32), nullable=True)
    revoked_at: Mapped[str | None] = mapped_column(String(32), nullable=True)
    group: Mapped[Group] = relationship()


class Token(Base):
    __tablename__ = "tokens"
    digest: Mapped[str] = mapped_column(String(64), primary_key=True)
    account_id: Mapped[str] = mapped_column(
        ForeignKey("accounts.id", ondelete="CASCADE"), index=True
    )
    created_at: Mapped[str] = mapped_column(String(32))


class Project(Base):
    __tablename__ = "projects"
    __table_args__ = (
        UniqueConstraint("owner_id", "slug", name="uq_project_owner_slug"),
        UniqueConstraint("organization_id", "slug", name="uq_project_org_slug"),
    )
    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    owner_id: Mapped[str | None] = mapped_column(
        ForeignKey("accounts.id", ondelete="SET NULL"), nullable=True, index=True
    )
    created_by_id: Mapped[str | None] = mapped_column(
        ForeignKey("accounts.id", ondelete="SET NULL"), nullable=True, index=True
    )
    organization_id: Mapped[str | None] = mapped_column(
        ForeignKey("organizations.id", ondelete="SET NULL"), nullable=True, index=True
    )
    slug: Mapped[str] = mapped_column(String(100))
    title: Mapped[str] = mapped_column(String(100))
    description: Mapped[str] = mapped_column(Text, default="")
    visibility: Mapped[str] = mapped_column(String(16))
    tags_json: Mapped[str] = mapped_column(Text, default="[]")
    thumbnail_type: Mapped[str | None] = mapped_column(String(20), nullable=True)
    views: Mapped[int] = mapped_column(Integer, default=0)
    fork_count: Mapped[int] = mapped_column(Integer, default=0)
    featured: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[str] = mapped_column(String(32))
    updated_at: Mapped[str] = mapped_column(String(32), index=True)
    owner: Mapped[Account | None] = relationship(back_populates="projects", foreign_keys=[owner_id])
    organization: Mapped[Organization | None] = relationship()
    versions: Mapped[list[Version]] = relationship(
        back_populates="project",
        cascade="all, delete-orphan",
        order_by="Version.number",
    )
    group_shares: Mapped[list[ProjectGroup]] = relationship(
        back_populates="project", cascade="all, delete-orphan"
    )


class ProjectGroup(Base):
    __tablename__ = "project_groups"
    project_id: Mapped[str] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), primary_key=True
    )
    group_id: Mapped[str] = mapped_column(
        ForeignKey("groups.id", ondelete="CASCADE"), primary_key=True
    )
    project: Mapped[Project] = relationship(back_populates="group_shares")
    group: Mapped[Group] = relationship()


class Version(Base):
    __tablename__ = "versions"
    project_id: Mapped[str] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), primary_key=True
    )
    number: Mapped[int] = mapped_column(Integer, primary_key=True)
    object_key: Mapped[str] = mapped_column(Text)
    created_at: Mapped[str] = mapped_column(String(32))
    project: Mapped[Project] = relationship(back_populates="versions")


# project_json reads project.owner.username and len(project.versions), both lazy.
# Without these a single listing page (up to 100 rows) fires ~201 queries instead
# of three.
LISTING_EAGER_LOADS = (
    selectinload(Project.owner),
    selectinload(Project.organization),
    selectinload(Project.versions),
    selectinload(Project.group_shares).selectinload(ProjectGroup.group),
)


class Credentials(BaseModel):
    # Both endpoints taking this model are unauthenticated, and password_hash
    # feeds the value straight to scrypt (n=2**14, ~16 MiB per call). Without an
    # upper bound a caller can drive that cost with an arbitrarily large body.
    username: str = Field(max_length=39)
    password: str = Field(max_length=1024)


class AccountCreate(Credentials):
    email: str | None = Field(default=None, max_length=320)


class AccountPatch(BaseModel):
    email: str | None = Field(max_length=320)

    model_config = {"extra": "forbid"}


class ProjectCreate(BaseModel):
    filename: str = Field(max_length=255)
    content: str
    visibility: Visibility
    organization_id: str | None = Field(default=None, alias="organizationId")
    group_ids: list[str] = Field(default_factory=list, alias="groupIds", max_length=20)


class ProjectPatch(BaseModel):
    title: str | None = Field(default=None, max_length=100)
    description: str | None = Field(default=None, max_length=2000)
    visibility: Visibility | None = None
    tags: list[str] | None = None
    organization_id: str | None = Field(default=None, alias="organizationId")
    group_ids: list[str] | None = Field(default=None, alias="groupIds", max_length=20)


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


def now() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


def password_hash(password: str, salt: bytes | None = None) -> str:
    if not password:
        raise ValueError("password is required")
    salt = salt or secrets.token_bytes(16)
    digest = hashlib.scrypt(password.encode(), salt=salt, n=2**14, r=8, p=1)
    return f"scrypt${salt.hex()}${digest.hex()}"


def password_matches(password: str, encoded: str) -> bool:
    try:
        _, salt, expected = encoded.split("$")
        return hmac.compare_digest(
            password_hash(password, bytes.fromhex(salt)).split("$")[2], expected
        )
    except (ValueError, TypeError):
        return False


def token_digest(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


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


def normalize_email(value: str | None) -> str | None:
    if value is None:
        return None
    email = value.strip().lower()
    if (
        len(email) > 320
        or not re.fullmatch(
            r"[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@"
            r"[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?\.[a-z]{2,63}",
            email,
        )
        or ".." in email
    ):
        raise HTTPException(422, "email must be a valid email address")
    return email


def postgresql_upgrade_statements() -> list[str]:
    """Return idempotent DDL for databases created by pre-organization releases."""
    return [
        "ALTER TABLE accounts ADD COLUMN IF NOT EXISTS email VARCHAR(320)",
        "CREATE UNIQUE INDEX IF NOT EXISTS uq_accounts_email ON accounts (email)",
        "ALTER TABLE projects ADD COLUMN IF NOT EXISTS organization_id VARCHAR(36)",
        "ALTER TABLE projects ADD COLUMN IF NOT EXISTS created_by_id VARCHAR(36)",
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
        "projects": [
            ("organization_id", "VARCHAR(36)"),
            ("created_by_id", "VARCHAR(36)"),
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
                fork_count, featured, created_at, updated_at
            )
            SELECT id, owner_id, COALESCE(created_by_id, owner_id), organization_id,
                slug, title, description, visibility, tags_json, thumbnail_type,
                views, fork_count, featured, created_at, updated_at
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


def create_app(
    database_url: str | None = None,
    storage=None,
    public_url: str | None = None,
) -> FastAPI:
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
    sessions = sessionmaker(engine, expire_on_commit=False)
    object_storage = storage or make_storage()
    base_url = (public_url or os.getenv("GEOLIBRE_PUBLIC_URL", "http://localhost:8000")).rstrip("/")
    viewer_url = os.getenv("GEOLIBRE_VIEWER_URL", "https://app.geolibre.org/").rstrip("/") + "/"
    max_project_bytes = int(os.getenv("GEOLIBRE_MAX_PROJECT_BYTES", str(50 * 1024 * 1024)))
    max_thumbnail_bytes = int(os.getenv("GEOLIBRE_MAX_THUMBNAIL_BYTES", str(5 * 1024 * 1024)))

    app = FastAPI(title="GeoLibre projects and identity API", version="1.0")
    app.state.engine = engine
    app.state.storage = object_storage
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
    # Registered last so it is the outermost layer: Starlette wraps in reverse
    # order of registration, and with limit_body outermost its 413 returned
    # without CORS headers, leaving a browser unable to read the documented
    # error body.
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"] if wildcard else origins,
        allow_credentials=not wildcard,
        allow_methods=["*"],
        allow_headers=["Authorization", "Content-Type"],
    )

    @app.get("/health")
    def health():
        return {"ok": True, "service": "geolibre-server"}

    @app.exception_handler(HTTPException)
    async def http_error(_request: Request, exc: HTTPException):
        detail = exc.detail if isinstance(exc.detail, str) else "request failed"
        return JSONResponse({"error": detail}, status_code=exc.status_code, headers=exc.headers)

    @app.exception_handler(RequestValidationError)
    async def validation_error(_request: Request, exc: RequestValidationError):
        return JSONResponse({"error": str(exc.errors()[0]["msg"])}, status_code=422)

    @app.exception_handler(Exception)
    async def unexpected_error(_request: Request, exc: Exception):
        # Only HTTPException and RequestValidationError were handled, so anything
        # else (a database error, say) escaped as a plain-text 500 and broke the
        # documented "errors are JSON objects with an error string" contract. The
        # detail is logged rather than returned, so internals are not disclosed.
        logger.exception("unhandled error", exc_info=exc)
        return JSONResponse({"error": "internal server error"}, status_code=500)

    def db():
        with sessions() as session:
            yield session

    def optional_account(
        authorization: Annotated[str | None, Header()] = None,
        session: Session = Depends(db),
    ) -> Account | None:
        if not authorization:
            return None
        if not authorization.startswith("Bearer "):
            raise HTTPException(401, "invalid authorization")
        row = session.get(Token, token_digest(authorization[7:]))
        if row is None:
            raise HTTPException(401, "invalid or expired token")
        return session.get(Account, row.account_id)

    def required_account(
        account: Account | None = Depends(optional_account),
    ) -> Account:
        if account is None:
            raise HTTPException(401, "authentication required")
        return account

    def account_json(account: Account) -> dict:
        return {
            "id": account.id,
            "username": account.username,
            "email": account.email,
            "createdAt": account.created_at,
        }

    def issue_token(session: Session, account: Account) -> str:
        value = secrets.token_urlsafe(32)
        session.add(Token(digest=token_digest(value), account_id=account.id, created_at=now()))
        session.commit()
        return value

    def unique_slug(
        session: Session,
        owner_id: str | None,
        desired: str,
        organization_id: str | None = None,
    ) -> str:
        base = slugify(desired)
        candidate = base
        suffix = 2
        if organization_id:
            while session.scalar(
                select(Project.id).where(
                    Project.slug == candidate,
                    or_(
                        Project.organization_id == organization_id,
                        *([Project.owner_id == owner_id] if legacy_project_owner_required else []),
                    ),
                )
            ):
                tail = f"-{suffix}"
                candidate = base[: 100 - len(tail)].rstrip("-") + tail
                suffix += 1
        else:
            while session.scalar(
                select(Project.id).where(Project.owner_id == owner_id, Project.slug == candidate)
            ):
                tail = f"-{suffix}"
                candidate = base[: 100 - len(tail)].rstrip("-") + tail
                suffix += 1
        return candidate

    def organization_role(session: Session, organization_id: str, account_id: str) -> str | None:
        return session.scalar(
            select(OrganizationMember.role).where(
                OrganizationMember.organization_id == organization_id,
                OrganizationMember.account_id == account_id,
            )
        )

    def require_organization_admin(
        session: Session, organization_id: str, account: Account
    ) -> Organization:
        organization = session.get(Organization, organization_id)
        if organization is None:
            raise HTTPException(404, "organization not found")
        if organization_role(session, organization_id, account.id) != "administrator":
            raise HTTPException(403, "organization administrator permission required")
        return organization

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
            if session.get(Group, group_id) is None:
                raise HTTPException(404, "group not found")
            if group_membership(session, group_id, account.id) is None:
                raise HTTPException(403, "group membership required")
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

    def project_json(
        project: Project,
        session: Session | None = None,
        account: Account | None = None,
    ) -> dict:
        if project.organization is not None:
            org_slug = project.organization.slug
            raw = f"{base_url}/org/{quote(org_slug)}/{quote(project.slug)}.geolibre.json"
            page = f"{base_url}/org/{quote(org_slug)}/{quote(project.slug)}"
        else:
            username = project.owner.username if project.owner and project.owner.username else ""
            raw = f"{base_url}/{quote(username)}/{quote(project.slug)}.geolibre.json"
            page = f"{base_url}/{quote(username)}/{quote(project.slug)}"
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

    def visible(session: Session, project: Project | None, account: Account | None) -> Project:
        if project is None:
            raise HTTPException(404, "project not found")
        if project.visibility in {"public", "unlisted"}:
            return project
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
        if project.visibility == "organization" or project.visibility == "private":
            raise HTTPException(404, "project not found")
        return project

    def owned(session: Session, project: Project | None, account: Account) -> Project:
        if project is None:
            raise HTTPException(404, "project not found")
        if project.organization_id is None and project.owner_id == account.id:
            return project
        if project.organization_id:
            role = organization_role(session, project.organization_id, account.id)
            if role == "administrator" or (
                project.created_by_id == account.id and role in {"publisher", "member"}
            ):
                return project
        raise HTTPException(403, "project ownership required")

    def editable(project: Project | None, account: Account, session: Session) -> Project:
        if project is None:
            raise HTTPException(404, "project not found")
        if can_edit_project(session, project, account):
            return project
        raise HTTPException(403, "project edit permission required")

    def protected(project: Project) -> bool:
        return project.visibility in {"private", "organization"}

    def create_project(
        session: Session,
        account: Account,
        content: str,
        filename: str,
        visibility: Visibility,
        organization_id: str | None = None,
        group_ids: list[str] | None = None,
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

    @app.post("/api/accounts", status_code=201)
    def create_account(body: AccountCreate, session: Session = Depends(db)):
        username = body.username.strip()
        email = normalize_email(body.email)
        if not USERNAME_RE.fullmatch(username):
            raise HTTPException(422, "username must be 3-39 lowercase letters, digits, or hyphens")
        if len(body.password) < 8:
            raise HTTPException(422, "password must be at least 8 characters")
        if session.scalar(select(Account.id).where(Account.username == username)):
            raise HTTPException(409, "username already exists")
        if email and session.scalar(select(Account.id).where(Account.email == email)):
            raise HTTPException(409, "email already exists")
        account = Account(
            id=str(uuid.uuid4()),
            username=username,
            email=email,
            password_hash=password_hash(body.password),
            created_at=now(),
        )
        session.add(account)
        try:
            session.commit()
        except IntegrityError:
            # The check above and this commit are not atomic, so two requests
            # racing for one username can both pass it. Without this the loser
            # escapes as a raw 500 (no IntegrityError exception handler is
            # registered), contradicting the documented 409 for a uniqueness
            # conflict.
            session.rollback()
            raise HTTPException(409, "username or email already exists") from None
        return {
            "account": account_json(account),
            "token": issue_token(session, account),
        }

    @app.post("/api/auth/token")
    def login(body: Credentials, session: Session = Depends(db)):
        account = session.scalar(select(Account).where(Account.username == body.username))
        if account is None:
            # Hash anyway before failing. Short-circuiting here would skip the
            # scrypt call that a real username always pays for, and the timing
            # difference enumerates accounts one request at a time, which a
            # request-count rate limiter does not address.
            password_hash(body.password or "unused")
            raise HTTPException(401, "invalid username or password")
        if not password_matches(body.password, account.password_hash):
            raise HTTPException(401, "invalid username or password")
        return {
            "account": account_json(account),
            "token": issue_token(session, account),
        }

    @app.delete("/api/auth/token", status_code=204)
    def revoke(
        authorization: Annotated[str | None, Header()] = None,
        _account: Account = Depends(required_account),
        session: Session = Depends(db),
    ):
        assert authorization is not None
        session.execute(delete(Token).where(Token.digest == token_digest(authorization[7:])))
        session.commit()

    @app.get("/api/account")
    def get_account(response: Response, account: Account = Depends(required_account)):
        response.headers["Cache-Control"] = "private, no-store"
        return {"account": account_json(account)}

    @app.patch("/api/account")
    def patch_account(
        body: AccountPatch,
        response: Response,
        account: Account = Depends(required_account),
        session: Session = Depends(db),
    ):
        email = normalize_email(body.email)
        if email and session.scalar(
            select(Account.id).where(Account.email == email, Account.id != account.id)
        ):
            raise HTTPException(409, "email already exists")
        account.email = email
        try:
            session.commit()
        except IntegrityError:
            session.rollback()
            raise HTTPException(409, "email already exists") from None
        response.headers["Cache-Control"] = "private, no-store"
        return {"account": account_json(account)}

    @app.get("/api/users/me")
    def get_current_user(response: Response, account: Account = Depends(required_account)):
        # The full account shape, matching what docs/server-api.md publishes and
        # what /api/account returns. The gallery client reads only `username`.
        response.headers["Cache-Control"] = "private, no-store"
        return {"user": account_json(account)}

    @app.post("/api/organizations", status_code=201)
    def create_organization(
        body: OrganizationCreate,
        account: Account = Depends(required_account),
        session: Session = Depends(db),
    ):
        slug = body.slug.strip().lower()
        if not re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{1,98}[a-z0-9])", slug):
            raise HTTPException(
                422,
                "organization slug must be 3-100 lowercase letters, digits, or hyphens",
            )
        if session.scalar(select(Organization.id).where(Organization.slug == slug)):
            raise HTTPException(409, "organization slug already exists")
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
        account: Account = Depends(required_account),
        session: Session = Depends(db),
    ):
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
        account: Account = Depends(required_account),
        session: Session = Depends(db),
    ):
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
        account: Account = Depends(required_account),
        session: Session = Depends(db),
    ):
        organization = require_organization_admin(session, organization_id, account)
        updates = body.model_dump(exclude_unset=True)
        if updates.get("name") is not None:
            organization.name = updates["name"].strip()
        if updates.get("public_sharing_policy") is not None:
            organization.public_sharing_policy = updates["public_sharing_policy"]
        if updates.get("default_visibility") is not None:
            organization.default_visibility = updates["default_visibility"]
        if updates.get("categories") is not None:
            organization.categories_json = json.dumps(updates["categories"])
        session.commit()
        return {"organization": organization_json(organization, "administrator")}

    @app.get("/api/organizations/{organization_id}/members")
    def list_organization_members(
        organization_id: str,
        response: Response,
        account: Account = Depends(required_account),
        session: Session = Depends(db),
    ):
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
        account: Account = Depends(required_account),
        session: Session = Depends(db),
    ):
        require_organization_admin(session, organization_id, account)
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
                admin_count = session.scalar(
                    select(func.count())
                    .select_from(OrganizationMember)
                    .where(
                        OrganizationMember.organization_id == organization_id,
                        OrganizationMember.role == "administrator",
                    )
                )
                if admin_count == 1:
                    raise HTTPException(409, "organization must have an administrator")
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
        session.commit()
        member.account = target
        return {"member": member_json(member)}

    @app.delete("/api/organizations/{organization_id}/members/{username}", status_code=204)
    def delete_organization_member(
        organization_id: str,
        username: str,
        account: Account = Depends(required_account),
        session: Session = Depends(db),
    ):
        require_organization_admin(session, organization_id, account)
        target = session.scalar(select(Account).where(Account.username == username))
        member = session.get(OrganizationMember, (organization_id, target.id)) if target else None
        if member is None:
            raise HTTPException(404, "organization member not found")
        if member.role == "administrator":
            admin_count = session.scalar(
                select(func.count())
                .select_from(OrganizationMember)
                .where(
                    OrganizationMember.organization_id == organization_id,
                    OrganizationMember.role == "administrator",
                )
            )
            if admin_count == 1:
                raise HTTPException(409, "organization must have an administrator")
        session.delete(member)
        session.commit()

    @app.post("/api/organizations/{organization_id}/invitations", status_code=201)
    def create_organization_invitation(
        organization_id: str,
        body: OrganizationInvitationCreate,
        account: Account = Depends(required_account),
        session: Session = Depends(db),
    ):
        require_organization_admin(session, organization_id, account)
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
        account: Account = Depends(required_account),
        session: Session = Depends(db),
    ):
        require_organization_admin(session, organization_id, account)
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
        account: Account = Depends(required_account),
        session: Session = Depends(db),
    ):
        require_organization_admin(session, organization_id, account)
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
        account: Account = Depends(required_account),
        session: Session = Depends(db),
    ):
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
        account: Account = Depends(required_account),
        session: Session = Depends(db),
    ):
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
        account: Account = Depends(required_account),
        session: Session = Depends(db),
    ):
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
        account: Account = Depends(required_account),
        session: Session = Depends(db),
    ):
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
        account: Account = Depends(required_account),
        session: Session = Depends(db),
    ):
        group = require_group(session, group_id)
        response.headers["Cache-Control"] = "private, no-store"
        return {"group": group_json(group, group_membership(session, group_id, account.id))}

    @app.patch("/api/groups/{group_id}")
    def patch_group(
        group_id: str,
        body: GroupSettingsPatch,
        account: Account = Depends(required_account),
        session: Session = Depends(db),
    ):
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

    @app.get("/api/groups/{group_id}/members")
    def list_group_members(
        group_id: str,
        response: Response,
        account: Account = Depends(required_account),
        session: Session = Depends(db),
    ):
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
        account: Account = Depends(required_account),
        session: Session = Depends(db),
    ):
        group = require_group_manager(session, group_id, account)
        actor = group_membership(session, group_id, account.id)
        target = session.scalar(select(Account).where(Account.username == body.username))
        if target is None:
            raise HTTPException(404, "user not found")
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
        account: Account = Depends(required_account),
        session: Session = Depends(db),
    ):
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
        account: Account = Depends(required_account),
        session: Session = Depends(db),
    ):
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
        account: Account = Depends(required_account),
        session: Session = Depends(db),
    ):
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
        account: Account = Depends(required_account),
        session: Session = Depends(db),
    ):
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
        account: Account = Depends(required_account),
        session: Session = Depends(db),
    ):
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
        account: Account = Depends(required_account),
        session: Session = Depends(db),
    ):
        group = require_group(session, group_id)
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
        account: Account = Depends(required_account),
        session: Session = Depends(db),
    ):
        require_group_manager(session, group_id, account)
        target = session.scalar(select(Account).where(Account.username == username))
        member = session.get(GroupMember, (group_id, target.id)) if target else None
        if member is None or member.status != "pending":
            raise HTTPException(404, "join request not found")
        if body.decision == "accept":
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
        account: Account = Depends(required_account),
        session: Session = Depends(db),
    ):
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
        account: Account = Depends(required_account),
        session: Session = Depends(db),
    ):
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
        account: Account = Depends(required_account),
        session: Session = Depends(db),
    ):
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
        account: Account | None = Depends(optional_account),
        session: Session = Depends(db),
    ):
        group = require_group(session, group_id)
        confined = group.join_policy != "open"
        if confined and (
            account is None or group_membership(session, group_id, account.id) is None
        ):
            raise HTTPException(404, "thumbnail not found")
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
        account: Account = Depends(required_account),
        session: Session = Depends(db),
    ):
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
        account: Account | None = Depends(optional_account),
        session: Session = Depends(db),
    ):
        owner = session.scalar(select(Account).where(Account.username == username))
        if owner is None:
            raise HTTPException(404, "user not found")
        own = account is not None and account.id == owner.id
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
        account: Account = Depends(required_account),
        session: Session = Depends(db),
    ):
        return {
            "project": project_json(
                create_project(
                    session,
                    account,
                    body.content,
                    body.filename,
                    body.visibility,
                    body.organization_id,
                    body.group_ids,
                ),
                session,
                account,
            )
        }

    @app.get("/api/projects")
    def list_projects(
        response: Response,
        limit: Annotated[int, Query(ge=1, le=100)] = 24,
        offset: Annotated[int, Query(ge=0)] = 0,
        featured: bool = False,
        mine: bool = False,
        shared_with_me: bool = False,
        shared_source: Literal["organizations", "groups"] | None = None,
        account: Account | None = Depends(optional_account),
        session: Session = Depends(db),
    ):
        query = select(Project)
        count = select(func.count()).select_from(Project)
        if mine and shared_with_me:
            raise HTTPException(422, "mine and shared_with_me cannot both be true")
        if shared_source and not shared_with_me:
            raise HTTPException(422, "shared_source requires shared_with_me=true")
        if mine:
            if account is None:
                raise HTTPException(401, "authentication required")
            query, count = (
                query.where(Project.owner_id == account.id, Project.organization_id.is_(None)),
                count.where(Project.owner_id == account.id, Project.organization_id.is_(None)),
            )
        elif shared_with_me:
            if account is None:
                raise HTTPException(401, "authentication required")
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
        account: Account | None = Depends(optional_account),
        session: Session = Depends(db),
    ):
        project = visible(session, session.get(Project, project_id), account)
        response = JSONResponse({"project": project_json(project, session, account)})
        if protected(project) or account is not None:
            response.headers["Cache-Control"] = "private, no-store"
        return response

    @app.patch("/api/projects/{project_id}")
    def patch_project(
        project_id: str,
        body: ProjectPatch,
        account: Account = Depends(required_account),
        session: Session = Depends(db),
    ):
        project = owned(session, session.get(Project, project_id), account)
        updates = body.model_dump(exclude_unset=True)
        final_visibility = updates.get("visibility", project.visibility)
        final_organization_id = updates.get("organization_id", project.organization_id)
        final_group_ids = updates.get("group_ids", shared_group_ids(session, project.id))
        if final_visibility is None:
            raise HTTPException(422, "visibility must not be null")
        # Existing targets may outlive the creator's membership. They must still
        # be able to remove a stale target or edit unrelated metadata; only a
        # submitted replacement target list requires current membership.
        group_ids_to_validate = final_group_ids if "group_ids" in updates else []
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
            project.visibility = updates["visibility"]
        if "organization_id" in updates:
            if updates["organization_id"] != project.organization_id:
                project.slug = unique_slug(
                    session, account.id, project.slug, updates["organization_id"]
                )
            project.organization_id = updates["organization_id"]
            if not updates["organization_id"] or legacy_project_owner_required:
                project.owner_id = account.id
            else:
                project.owner_id = None
        if "group_ids" in updates:
            replace_group_shares(session, project, updates["group_ids"] or [])
        if "tags" in updates:
            tags = updates["tags"] or []
            if len(tags) > 20 or any(not tag or len(tag) > 40 for tag in tags):
                raise HTTPException(422, "tags must contain at most 20 non-empty 40-character tags")
            project.tags_json = json.dumps(tags)
        project.updated_at = now()
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
        account: Account = Depends(required_account),
        session: Session = Depends(db),
    ):
        project = editable(session.get(Project, project_id), account, session)
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
                project = editable(session.get(Project, project_id), account, session)
        else:
            raise HTTPException(409, "could not allocate a version number; retry")
        current_number = number - 1
        conflict = body.expected_version is not None and body.expected_version != current_number
        object_storage.put(key, body.content.encode(), "application/json")
        project.updated_at = now()
        session.commit()
        session.refresh(project)
        result = {
            "project": project_json(project, session, account),
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
        account: Account = Depends(required_account),
        session: Session = Depends(db),
    ):
        project = owned(session, session.get(Project, project_id), account)
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
        account: Account = Depends(required_account),
        session: Session = Depends(db),
    ):
        source = visible(session, session.get(Project, project_id), account)
        content = object_storage.get(source.versions[-1].object_key).decode()
        fork = create_project(
            session,
            account,
            content,
            source.title + ".geolibre.json",
            (body or ForkRequest()).visibility,
            commit=False,
        )
        # Incremented in SQL rather than read-modify-write in Python, so
        # concurrent forks cannot lose each other's increments. The contract in
        # docs/server-api.md promises this counter rises atomically.
        session.execute(
            update(Project).where(Project.id == source.id).values(fork_count=Project.fork_count + 1)
        )
        session.commit()
        session.refresh(fork)
        return {"project": project_json(fork, session, account)}

    def raw_response(project: Project, version: Version, immutable: bool) -> Response:
        try:
            content = object_storage.get(version.object_key)
        except KeyError:
            raise HTTPException(404, "project content not found")
        cache = (
            "public, max-age=3600"
            if immutable and not protected(project)
            else "private, no-store"
            if protected(project)
            else "public, max-age=60"
        )
        return Response(content, media_type="application/json", headers={"Cache-Control": cache})

    @app.get("/api/projects/{project_id}/versions")
    def list_versions(
        project_id: str,
        account: Account = Depends(required_account),
        session: Session = Depends(db),
    ):
        project = visible(session, session.get(Project, project_id), account)
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
        account: Account | None = Depends(optional_account),
        session: Session = Depends(db),
    ):
        project = visible(session, session.get(Project, project_id), account)
        version = session.get(Version, (project_id, number))
        if version is None:
            raise HTTPException(404, "project version not found")
        return raw_response(project, version, True)

    @app.put("/api/projects/{project_id}/thumbnail", status_code=204)
    async def put_thumbnail(
        project_id: str,
        request: Request,
        account: Account = Depends(required_account),
        session: Session = Depends(db),
    ):
        project = owned(session, session.get(Project, project_id), account)
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
        account: Account | None = Depends(optional_account),
        session: Session = Depends(db),
    ):
        project = visible(session, session.get(Project, project_id), account)
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
        account: Account = Depends(required_account),
        session: Session = Depends(db),
    ):
        project = owned(session, session.get(Project, project_id), account)
        object_storage.delete(f"projects/{project.id}/thumbnail")
        project.thumbnail_type = None
        project.updated_at = now()
        session.commit()

    @app.get("/org/{organization_slug}/{slug}.geolibre.json")
    def latest_organization_raw(
        organization_slug: str,
        slug: str,
        account: Account | None = Depends(optional_account),
        session: Session = Depends(db),
    ):
        project = session.scalar(
            select(Project)
            .join(Organization)
            .where(Organization.slug == organization_slug, Project.slug == slug)
        )
        project = visible(session, project, account)
        body = raw_response(project, project.versions[-1], False)
        session.execute(
            update(Project).where(Project.id == project.id).values(views=Project.views + 1)
        )
        session.commit()
        return body

    @app.get("/org/{organization_slug}/{slug}")
    def organization_project_page(
        organization_slug: str,
        slug: str,
        account: Account | None = Depends(optional_account),
        session: Session = Depends(db),
    ):
        project = session.scalar(
            select(Project)
            .join(Organization)
            .where(Organization.slug == organization_slug, Project.slug == slug)
        )
        visible(session, project, account)
        raw = f"{base_url}/org/{quote(organization_slug)}/{quote(slug)}.geolibre.json"
        return RedirectResponse(viewer_url + "?project=" + quote(raw, safe=""), status_code=302)

    @app.get("/{username}/{slug}.geolibre.json")
    def latest_raw(
        username: str,
        slug: str,
        account: Account | None = Depends(optional_account),
        session: Session = Depends(db),
    ):
        project = session.scalar(
            select(Project)
            .join(Account, Project.owner_id == Account.id)
            .where(
                Account.username == username,
                Project.slug == slug,
                Project.organization_id.is_(None),
            )
        )
        project = visible(session, project, account)
        # Read the object first: a missing object is a 404 that should not count
        # as a view. Incremented in SQL so concurrent reads do not lose counts.
        body = raw_response(project, project.versions[-1], False)
        session.execute(
            update(Project).where(Project.id == project.id).values(views=Project.views + 1)
        )
        session.commit()
        return body

    @app.get("/{username}/{slug}")
    def project_page(
        username: str,
        slug: str,
        account: Account | None = Depends(optional_account),
        session: Session = Depends(db),
    ):
        project = session.scalar(
            select(Project)
            .join(Account, Project.owner_id == Account.id)
            .where(
                Account.username == username,
                Project.slug == slug,
                Project.organization_id.is_(None),
            )
        )
        project = visible(session, project, account)
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
