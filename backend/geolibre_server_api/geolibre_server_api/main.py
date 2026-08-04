from __future__ import annotations

import hashlib
import hmac
import json
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
    func,
    select,
)
from sqlalchemy.orm import (
    DeclarativeBase,
    Mapped,
    Session,
    mapped_column,
    relationship,
    sessionmaker,
)

Visibility = Literal["public", "unlisted", "private"]
USERNAME_RE = re.compile(r"^[a-z0-9](?:[a-z0-9-]{1,37}[a-z0-9])?$")
SLUG_RE = re.compile(r"[^a-z0-9]+")
IMAGE_TYPES = {"image/png", "image/jpeg", "image/webp"}


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


class Credentials(BaseModel):
    username: str
    password: str


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
    origins = [x.strip() for x in os.getenv("GEOLIBRE_CORS_ORIGINS", "*").split(",")]
    app.add_middleware(
        CORSMiddleware,
        allow_origins=origins,
        allow_credentials=origins != ["*"],
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
        session.flush()
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
        session.commit()
        return {"account": account_json(account), "token": issue_token(session, account)}

    @app.post("/api/auth/token")
    def login(body: Credentials, session: Session = Depends(db)):
        account = session.scalar(select(Account).where(Account.username == body.username))
        if account is None or not password_matches(body.password, account.password_hash):
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
        return {"user": {"username": account.username}}

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
            query.order_by(Project.updated_at.desc()).offset(offset).limit(limit)
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
            query.order_by(Project.updated_at.desc()).offset(offset).limit(limit)
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
            project.visibility = updates["visibility"]
        if "tags" in updates:
            tags = updates["tags"]
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
        number = len(project.versions) + 1
        key = f"projects/{project.id}/versions/{number}.json"
        object_storage.put(key, body.content.encode(), "application/json")
        project.updated_at = now()
        session.add(Version(project_id=project.id, number=number, object_key=key, created_at=now()))
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
        body: ForkRequest,
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
            body.visibility,
            commit=False,
        )
        source.fork_count += 1
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
        data = await request.body()
        if len(data) > max_thumbnail_bytes:
            raise HTTPException(413, f"thumbnail exceeds the {max_thumbnail_bytes} byte limit")
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
        project.views += 1
        session.commit()
        return raw_response(project, project.versions[-1], False)

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


app = create_app()


def run() -> None:
    import uvicorn

    uvicorn.run("geolibre_server_api.main:app", host="0.0.0.0", port=8000)
