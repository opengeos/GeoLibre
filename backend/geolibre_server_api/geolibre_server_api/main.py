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
from datetime import UTC, datetime
from pathlib import Path
from typing import Annotated, Literal
from urllib.parse import quote

from fastapi import Depends, FastAPI, Header, HTTPException, Query, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, RedirectResponse
from pydantic import BaseModel, Field
from sqlalchemy import (
    Boolean,
    ForeignKey,
    Integer,
    String,
    Text,
    UniqueConstraint,
    create_engine,
    delete,
    event,
    func,
    select,
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

Visibility = Literal["public", "unlisted", "private"]
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
    password_hash: Mapped[str] = mapped_column(Text)
    created_at: Mapped[str] = mapped_column(String(32))
    projects: Mapped[list[Project]] = relationship(
        back_populates="owner", cascade="all, delete-orphan"
    )


class Token(Base):
    __tablename__ = "tokens"
    digest: Mapped[str] = mapped_column(String(64), primary_key=True)
    account_id: Mapped[str] = mapped_column(
        ForeignKey("accounts.id", ondelete="CASCADE"), index=True
    )
    created_at: Mapped[str] = mapped_column(String(32))


class Project(Base):
    __tablename__ = "projects"
    __table_args__ = (UniqueConstraint("owner_id", "slug", name="uq_project_owner_slug"),)
    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    owner_id: Mapped[str] = mapped_column(ForeignKey("accounts.id", ondelete="CASCADE"), index=True)
    slug: Mapped[str] = mapped_column(String(100))
    title: Mapped[str] = mapped_column(String(100))
    description: Mapped[str] = mapped_column(Text, default="")
    visibility: Mapped[str] = mapped_column(String(10))
    tags_json: Mapped[str] = mapped_column(Text, default="[]")
    thumbnail_type: Mapped[str | None] = mapped_column(String(20), nullable=True)
    views: Mapped[int] = mapped_column(Integer, default=0)
    fork_count: Mapped[int] = mapped_column(Integer, default=0)
    featured: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[str] = mapped_column(String(32))
    updated_at: Mapped[str] = mapped_column(String(32), index=True)
    owner: Mapped[Account] = relationship(back_populates="projects")
    versions: Mapped[list[Version]] = relationship(
        back_populates="project", cascade="all, delete-orphan", order_by="Version.number"
    )


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
LISTING_EAGER_LOADS = (selectinload(Project.owner), selectinload(Project.versions))


class Credentials(BaseModel):
    # Both endpoints taking this model are unauthenticated, and password_hash
    # feeds the value straight to scrypt (n=2**14, ~16 MiB per call). Without an
    # upper bound a caller can drive that cost with an arbitrarily large body.
    username: str = Field(max_length=39)
    password: str = Field(max_length=1024)


class ProjectCreate(BaseModel):
    filename: str = Field(max_length=255)
    content: str
    visibility: Visibility


class ProjectPatch(BaseModel):
    title: str | None = Field(default=None, max_length=100)
    description: str | None = Field(default=None, max_length=2000)
    visibility: Visibility | None = None
    tags: list[str] | None = None


class ContentUpdate(BaseModel):
    content: str


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

    def required_account(account: Account | None = Depends(optional_account)) -> Account:
        if account is None:
            raise HTTPException(401, "authentication required")
        return account

    def account_json(account: Account) -> dict:
        return {"id": account.id, "username": account.username, "createdAt": account.created_at}

    def issue_token(session: Session, account: Account) -> str:
        value = secrets.token_urlsafe(32)
        session.add(Token(digest=token_digest(value), account_id=account.id, created_at=now()))
        session.commit()
        return value

    def unique_slug(session: Session, owner_id: str, desired: str) -> str:
        base = slugify(desired)
        candidate = base
        suffix = 2
        while session.scalar(
            select(Project.id).where(Project.owner_id == owner_id, Project.slug == candidate)
        ):
            tail = f"-{suffix}"
            candidate = base[: 100 - len(tail)].rstrip("-") + tail
            suffix += 1
        return candidate

    def project_json(project: Project) -> dict:
        username = project.owner.username or ""
        raw = f"{base_url}/{quote(username)}/{quote(project.slug)}.geolibre.json"
        page = f"{base_url}/{quote(username)}/{quote(project.slug)}"
        return {
            "id": project.id,
            "username": username,
            "slug": project.slug,
            "title": project.title,
            "description": project.description,
            "visibility": project.visibility,
            "thumbnailUrl": f"/api/projects/{project.id}/thumbnail"
            if project.thumbnail_type
            else None,
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

    def visible(project: Project | None, account: Account | None) -> Project:
        if project is None or (
            project.visibility == "private" and (account is None or project.owner_id != account.id)
        ):
            raise HTTPException(404, "project not found")
        return project

    def owned(project: Project | None, account: Account) -> Project:
        if project is None:
            raise HTTPException(404, "project not found")
        if project.owner_id != account.id:
            raise HTTPException(403, "project ownership required")
        return project

    def create_project(
        session: Session,
        account: Account,
        content: str,
        filename: str,
        visibility: Visibility,
        *,
        commit: bool = True,
    ) -> Project:
        if not account.username:
            raise HTTPException(400, "username required")
        document = parse_content(content, max_project_bytes)
        title = title_from(document, filename)
        timestamp = now()
        # unique_slug SELECTs and this INSERTs, so two concurrent creates with
        # the same title from one account can pick the same slug and the loser
        # hits uq_project_owner_slug. Retry the allocation instead of surfacing
        # that as a 500, matching how version numbers are allocated below.
        for _ in range(5):
            project = Project(
                id=str(uuid.uuid4()),
                owner_id=account.id,
                slug=unique_slug(session, account.id, title or filename),
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
        if commit:
            session.commit()
            session.refresh(project)
        return project

    @app.post("/api/accounts", status_code=201)
    def create_account(body: Credentials, session: Session = Depends(db)):
        username = body.username.strip()
        if not USERNAME_RE.fullmatch(username):
            raise HTTPException(422, "username must be 3-39 lowercase letters, digits, or hyphens")
        if len(body.password) < 8:
            raise HTTPException(422, "password must be at least 8 characters")
        if session.scalar(select(Account.id).where(Account.username == username)):
            raise HTTPException(409, "username already exists")
        account = Account(
            id=str(uuid.uuid4()),
            username=username,
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
            raise HTTPException(409, "username already exists") from None
        return {"account": account_json(account), "token": issue_token(session, account)}

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
        return {"account": account_json(account), "token": issue_token(session, account)}

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
    def get_account(account: Account = Depends(required_account)):
        return {"account": account_json(account)}

    @app.get("/api/users/me")
    def get_current_user(account: Account = Depends(required_account)):
        # The full account shape, matching what docs/server-api.md publishes and
        # what /api/account returns. The gallery client reads only `username`.
        return {"user": account_json(account)}

    @app.get("/api/users/{username}/projects")
    def get_user_projects(
        username: str,
        limit: Annotated[int, Query(ge=1, le=100)] = 24,
        offset: Annotated[int, Query(ge=0)] = 0,
        account: Account | None = Depends(optional_account),
        session: Session = Depends(db),
    ):
        owner = session.scalar(select(Account).where(Account.username == username))
        if owner is None:
            raise HTTPException(404, "user not found")
        own = account is not None and account.id == owner.id
        query = select(Project).where(Project.owner_id == owner.id)
        if not own:
            query = query.where(Project.visibility == "public")
        projects = session.scalars(
            query.options(*LISTING_EAGER_LOADS)
            .order_by(Project.updated_at.desc())
            .offset(offset)
            .limit(limit)
        ).all()
        return {"projects": [project_json(project) for project in projects]}

    @app.post("/api/projects", status_code=201)
    def post_project(
        body: ProjectCreate,
        account: Account = Depends(required_account),
        session: Session = Depends(db),
    ):
        return {
            "project": project_json(
                create_project(session, account, body.content, body.filename, body.visibility)
            )
        }

    @app.get("/api/projects")
    def list_projects(
        limit: Annotated[int, Query(ge=1, le=100)] = 24,
        offset: Annotated[int, Query(ge=0)] = 0,
        featured: bool = False,
        mine: bool = False,
        account: Account | None = Depends(optional_account),
        session: Session = Depends(db),
    ):
        query = select(Project)
        count = select(func.count()).select_from(Project)
        if mine:
            if account is None:
                raise HTTPException(401, "authentication required")
            query, count = (
                query.where(Project.owner_id == account.id),
                count.where(Project.owner_id == account.id),
            )
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
        return {
            "projects": [project_json(p) for p in projects],
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
        return {"project": project_json(visible(session.get(Project, project_id), account))}

    @app.patch("/api/projects/{project_id}")
    def patch_project(
        project_id: str,
        body: ProjectPatch,
        account: Account = Depends(required_account),
        session: Session = Depends(db),
    ):
        project = owned(session.get(Project, project_id), account)
        updates = body.model_dump(exclude_unset=True)
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
        if "tags" in updates:
            tags = updates["tags"] or []
            if len(tags) > 20 or any(not tag or len(tag) > 40 for tag in tags):
                raise HTTPException(422, "tags must contain at most 20 non-empty 40-character tags")
            project.tags_json = json.dumps(tags)
        project.updated_at = now()
        session.commit()
        return {"project": project_json(project)}

    @app.put("/api/projects/{project_id}/content", status_code=201)
    def update_content(
        project_id: str,
        body: ContentUpdate,
        account: Account = Depends(required_account),
        session: Session = Depends(db),
    ):
        project = owned(session.get(Project, project_id), account)
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
                Version(project_id=project.id, number=number, object_key=key, created_at=now())
            )
            try:
                session.flush()
                break
            except (IntegrityError, OperationalError):
                # See create_project: a SQLite lock is transient and retryable.
                session.rollback()
                project = owned(session.get(Project, project_id), account)
        else:
            raise HTTPException(409, "could not allocate a version number; retry")
        object_storage.put(key, body.content.encode(), "application/json")
        project.updated_at = now()
        session.commit()
        session.refresh(project)
        return {"project": project_json(project), "version": number}

    @app.delete("/api/projects/{project_id}", status_code=204)
    def delete_project_route(
        project_id: str,
        account: Account = Depends(required_account),
        session: Session = Depends(db),
    ):
        project = owned(session.get(Project, project_id), account)
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
        source = visible(session.get(Project, project_id), account)
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
        return {"project": project_json(fork)}

    def raw_response(project: Project, version: Version, immutable: bool) -> Response:
        try:
            content = object_storage.get(version.object_key)
        except KeyError:
            raise HTTPException(404, "project content not found")
        cache = (
            "public, max-age=3600"
            if immutable and project.visibility != "private"
            else "private, no-store"
            if project.visibility == "private"
            else "public, max-age=60"
        )
        return Response(content, media_type="application/json", headers={"Cache-Control": cache})

    @app.get("/api/projects/{project_id}/versions/{number}")
    def get_version(
        project_id: str,
        number: int,
        account: Account | None = Depends(optional_account),
        session: Session = Depends(db),
    ):
        project = visible(session.get(Project, project_id), account)
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
        project = owned(session.get(Project, project_id), account)
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
        project = visible(session.get(Project, project_id), account)
        if not project.thumbnail_type:
            raise HTTPException(404, "thumbnail not found")
        try:
            data = object_storage.get(f"projects/{project.id}/thumbnail")
        except KeyError:
            raise HTTPException(404, "thumbnail not found")
        cache = "private, no-store" if project.visibility == "private" else "public, max-age=3600"
        return Response(data, media_type=project.thumbnail_type, headers={"Cache-Control": cache})

    @app.delete("/api/projects/{project_id}/thumbnail", status_code=204)
    def delete_thumbnail(
        project_id: str,
        account: Account = Depends(required_account),
        session: Session = Depends(db),
    ):
        project = owned(session.get(Project, project_id), account)
        object_storage.delete(f"projects/{project.id}/thumbnail")
        project.thumbnail_type = None
        project.updated_at = now()
        session.commit()

    @app.get("/{username}/{slug}.geolibre.json")
    def latest_raw(
        username: str,
        slug: str,
        account: Account | None = Depends(optional_account),
        session: Session = Depends(db),
    ):
        project = session.scalar(
            select(Project).join(Account).where(Account.username == username, Project.slug == slug)
        )
        project = visible(project, account)
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
            select(Project).join(Account).where(Account.username == username, Project.slug == slug)
        )
        project = visible(project, account)
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
