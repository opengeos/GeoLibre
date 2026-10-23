"""Project ORM models: projects, versions, group shares, activity, transfers, redirects."""

from __future__ import annotations

from sqlalchemy import Boolean, ForeignKey, Index, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from geolibre_server_api.auth_models import Account, Base
from geolibre_server_api.org_models import Group, Organization


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
    # Owner opt-in: while true the project refuses DELETE with a 409 naming this
    # switch. Off by default, per GeoLibre#1670.
    delete_protected: Mapped[bool] = mapped_column(Boolean, default=False)
    # Share-link settings. Role is advisory metadata echoed to viewers; expiry and
    # password are enforced by the server on every anonymous read.
    share_role: Mapped[str] = mapped_column(String(8), default="edit", server_default="edit")
    share_expires_at: Mapped[str | None] = mapped_column(String(32), nullable=True)
    share_password_hash: Mapped[str | None] = mapped_column(String(200), nullable=True)
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
    # Cascaded so "delete project" still removes its pending transfers and its
    # redirect rows on a database whose foreign keys are not enforced.
    transfers: Mapped[list[ProjectTransfer]] = relationship(
        back_populates="project", cascade="all, delete-orphan"
    )
    redirects: Mapped[list[ProjectRedirect]] = relationship(
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


class ProjectActivity(Base):
    __tablename__ = "project_activities"
    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    project_id: Mapped[str] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), index=True
    )
    actor_id: Mapped[str | None] = mapped_column(
        ForeignKey("accounts.id", ondelete="SET NULL"), nullable=True, index=True
    )
    action: Mapped[str] = mapped_column(String(50))
    details_json: Mapped[str] = mapped_column(Text, default="{}")
    # Anonymous open/fetch events collapse into one row per project, action and
    # UTC day: `bucket_key` ("<project>:<action>:<YYYY-MM-DD>") is unique so two
    # concurrent requests cannot create duplicate buckets, and `count` is
    # incremented database-side so they cannot lose each other's increment.
    bucket_key: Mapped[str | None] = mapped_column(String(100), nullable=True, unique=True)
    count: Mapped[int] = mapped_column(Integer, default=1)
    created_at: Mapped[str] = mapped_column(String(32), index=True)


class ProjectTransfer(Base):
    """A pending or resolved hand-off of a project to a user or organization.

    A user target stays ``pending`` until that user accepts; an organization
    target is applied immediately by an administrator and is stored as
    ``accepted`` so the project's history shows who moved it and where.
    """

    __tablename__ = "project_transfers"
    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    project_id: Mapped[str] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), index=True
    )
    from_account_id: Mapped[str] = mapped_column(ForeignKey("accounts.id", ondelete="CASCADE"))
    to_account_id: Mapped[str | None] = mapped_column(
        ForeignKey("accounts.id", ondelete="CASCADE"), nullable=True, index=True
    )
    to_organization_id: Mapped[str | None] = mapped_column(
        ForeignKey("organizations.id", ondelete="CASCADE"), nullable=True
    )
    slug: Mapped[str] = mapped_column(String(100))
    status: Mapped[str] = mapped_column(String(16), default="pending")
    created_at: Mapped[str] = mapped_column(String(32), index=True)
    resolved_at: Mapped[str | None] = mapped_column(String(32), nullable=True)
    project: Mapped[Project] = relationship(back_populates="transfers")
    from_account: Mapped[Account] = relationship(foreign_keys=[from_account_id])
    to_account: Mapped[Account | None] = relationship(foreign_keys=[to_account_id])
    to_organization: Mapped[Organization | None] = relationship()


PENDING_TRANSFER_INDEX = Index(
    "uq_project_transfers_pending",
    ProjectTransfer.project_id,
    unique=True,
    sqlite_where=ProjectTransfer.status == "pending",
    postgresql_where=ProjectTransfer.status == "pending",
)


class ProjectRedirect(Base):
    """The namespace and slug a project vacated when it was transferred.

    Rows keep the old ``<username>/<slug>`` (or ``/org/<slug>/<slug>``) address
    answering 301 to the project's new home, and keep ``unique_slug`` from
    handing that address to a new upload.
    """

    __tablename__ = "project_redirects"
    __table_args__ = (
        UniqueConstraint("account_id", "slug", name="uq_redirect_account_slug"),
        UniqueConstraint("organization_id", "slug", name="uq_redirect_org_slug"),
    )
    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    project_id: Mapped[str] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), index=True
    )
    account_id: Mapped[str | None] = mapped_column(
        ForeignKey("accounts.id", ondelete="CASCADE"), nullable=True, index=True
    )
    organization_id: Mapped[str | None] = mapped_column(
        ForeignKey("organizations.id", ondelete="CASCADE"), nullable=True, index=True
    )
    slug: Mapped[str] = mapped_column(String(100))
    created_at: Mapped[str] = mapped_column(String(32))
    project: Mapped[Project] = relationship(back_populates="redirects")
    account: Mapped[Account | None] = relationship(foreign_keys=[account_id])
    organization: Mapped[Organization | None] = relationship()
