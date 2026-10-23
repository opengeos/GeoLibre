from __future__ import annotations

from typing import Literal

from sqlalchemy import Boolean, ForeignKey, Index, String, Text, text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from geolibre_server_api.auth_models import Account, Base

OrganizationRole = Literal["administrator", "publisher", "member", "viewer"]
GroupRole = Literal["owner", "manager", "member"]
ROLE_RANK: dict[str, int] = {"viewer": 0, "member": 1, "publisher": 2, "administrator": 3}


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
