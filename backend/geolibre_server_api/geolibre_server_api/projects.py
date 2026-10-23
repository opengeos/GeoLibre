"""Project rules shared by the projects API and single sign-on: activity and public sharing."""

from __future__ import annotations

import json
import os
import uuid
from datetime import UTC, datetime, timedelta

from sqlalchemy import and_, delete, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from geolibre_server_api.auth import now
from geolibre_server_api.org_models import Organization, OrganizationMember
from geolibre_server_api.project_models import Project, ProjectActivity

# Activity rows older than this are pruned the next time the project logs an
# event, so the log never grows without bound (GeoLibre#1678 asks for a stated
# retention period plus owner-initiated deletion, the latter being
# DELETE /api/projects/{id}/activity).
ACTIVITY_RETENTION_DAYS = int(os.getenv("GEOLIBRE_ACTIVITY_RETENTION_DAYS", "90"))
# Actions an anonymous visitor can trigger. These are never stored per hit:
# they are aggregated into one row per project, action and UTC day carrying a
# count, so the owner learns "opened 40 times on 2026-08-21" and nothing about
# who did it.
AGGREGATED_ANONYMOUS_ACTIONS = frozenset({"open", "fetch"})


def log_project_activity(
    session: Session,
    project_id: str,
    actor_id: str | None,
    action: str,
    details: dict | None = None,
) -> None:
    """Record a project event, aggregating anonymous opens/fetches per day.

    Args:
        session: The open database session; the caller commits.
        project_id: The project the event belongs to.
        actor_id: The authenticated account, or ``None`` for an anonymous visitor.
        action: A short action name such as ``"fork"`` or ``"visibility_change"``.
        details: Optional JSON-serializable context stored with the row.
    """
    timestamp = now()
    cutoff = (
        (datetime.now(UTC) - timedelta(days=ACTIVITY_RETENTION_DAYS))
        .isoformat()
        .replace("+00:00", "Z")
    )
    session.execute(
        delete(ProjectActivity).where(
            ProjectActivity.project_id == project_id, ProjectActivity.created_at < cutoff
        )
    )
    bucket_key = None
    if actor_id is None and action in AGGREGATED_ANONYMOUS_ACTIONS:
        day = timestamp[:10]
        bucket_key = f"{project_id}:{action}:{day}"
        details = {"date": day}
        # Atomic increment: no read-modify-write, so two concurrent hits cannot
        # overwrite each other's count.
        updated = session.execute(
            update(ProjectActivity)
            .where(ProjectActivity.bucket_key == bucket_key)
            .values(count=ProjectActivity.count + 1)
        ).rowcount
        if updated:
            return
    row = ProjectActivity(
        id=str(uuid.uuid4()),
        project_id=project_id,
        actor_id=actor_id,
        action=action,
        details_json=json.dumps(details or {}),
        bucket_key=bucket_key,
        count=1,
        created_at=timestamp,
    )
    if bucket_key is None:
        session.add(row)
        return
    # Two requests can both miss the UPDATE and race to create the day's bucket;
    # the unique key makes the loser's INSERT fail, and it falls back to the
    # increment.
    try:
        with session.begin_nested():
            session.add(row)
            session.flush()
    except IntegrityError:
        session.execute(
            update(ProjectActivity)
            .where(ProjectActivity.bucket_key == bucket_key)
            .values(count=ProjectActivity.count + 1)
        )


def demote_disallowed_public_projects(
    session: Session, organization: Organization, actor_id: str
) -> None:
    """Make public org projects organization-only when their creator may no longer publish.

    Mirrors ``can_publish_public``: a project stays public only while its
    creator, in their current role, could publish it publicly now. Call it
    after lowering a role or tightening the policy; the caller commits.
    """
    policy = organization.public_sharing_policy
    if policy == "yes":
        return
    rows = session.execute(
        select(Project, OrganizationMember.role)
        .outerjoin(
            OrganizationMember,
            and_(
                OrganizationMember.organization_id == Project.organization_id,
                OrganizationMember.account_id == Project.created_by_id,
            ),
        )
        .where(Project.organization_id == organization.id, Project.visibility == "public")
    ).all()
    for project, role in rows:
        if role == "administrator" or (policy == "publishers" and role == "publisher"):
            continue
        project.visibility = "organization"
        project.updated_at = now()
        log_project_activity(
            session,
            project.id,
            actor_id,
            "visibility_change",
            {"before": "public", "after": "organization"},
        )
