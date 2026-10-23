"""Ownership transfer and delete protection (GeoLibre#1670).

The transfer keeps a project's identity (id, views, versions, activity) while
moving its address, leaves the old address 301-redirecting, and reserves that
address against reuse. Delete protection is a per-project owner switch that
makes DELETE refuse with a message naming it.
"""

from __future__ import annotations

import json
import uuid

import pytest
from geolibre_server_api.project_models import ProjectTransfer
from helpers import account, auth, create_project
from sqlalchemy.exc import IntegrityError


def patch_project(client, token, project_id, body):
    return client.patch(f"/api/projects/{project_id}", headers=auth(token), json=body)


def test_delete_protection_blocks_delete_until_turned_off(client):
    ada = account(client, "ada")
    project, _ = create_project(client, ada, "public", "Wetlands")

    protected = patch_project(client, ada, project["id"], {"deleteProtected": True})
    assert protected.status_code == 200, protected.text
    assert protected.json()["project"]["deleteProtected"] is True

    refused = client.delete(f"/api/projects/{project['id']}", headers=auth(ada))
    assert refused.status_code == 409
    assert "delete-protected" in refused.json()["error"]

    unprotected = patch_project(client, ada, project["id"], {"deleteProtected": False})
    assert unprotected.json()["project"]["deleteProtected"] is False
    assert client.delete(f"/api/projects/{project['id']}", headers=auth(ada)).status_code == 204


def test_delete_protection_rejects_an_explicit_null(client):
    ada = account(client, "ada")
    project, _ = create_project(client, ada, "public", "Wetlands")
    response = patch_project(client, ada, project["id"], {"deleteProtected": None})
    assert response.status_code == 422, response.text


def test_organization_deletion_refuses_a_protected_project(client):
    admin = account(client, "admin")
    organization = client.post(
        "/api/organizations", headers=auth(admin), json={"slug": "lab", "name": "Lab"}
    ).json()["organization"]
    project, content = create_project(client, admin, "public", "Wetlands")
    assert patch_project(client, admin, project["id"], {"deleteProtected": True}).status_code == 200
    moved = client.post(
        f"/api/projects/{project['id']}/transfers",
        headers=auth(admin),
        json={"organizationId": organization["id"]},
    )
    assert moved.status_code == 201, moved.text

    refused = client.delete(f"/api/organizations/{organization['id']}", headers=auth(admin))
    assert refused.status_code == 409
    assert "delete-protected" in refused.json()["error"]
    assert client.get(f"/api/projects/{project['id']}", headers=auth(admin)).status_code == 200
    assert client.get(
        "/org/lab/wetlands.geolibre.json",
        headers=auth(admin),
        follow_redirects=False,
    ).json() == json.loads(content)

    assert (
        patch_project(client, admin, project["id"], {"deleteProtected": False}).status_code == 200
    )
    assert (
        client.delete(f"/api/organizations/{organization['id']}", headers=auth(admin)).status_code
        == 204
    )
    assert client.get(f"/api/projects/{project['id']}", headers=auth(admin)).status_code == 404


def test_user_transfer_requires_acceptance_then_redirects_the_old_path(client):
    ada = account(client, "ada")
    bob = account(client, "bob")
    project, _ = create_project(client, ada, "public", "Wetlands")
    before = client.get(f"/api/projects/{project['id']}", headers=auth(ada)).json()["project"]

    # The offer does not move anything until it is accepted.
    offered = client.post(
        f"/api/projects/{project['id']}/transfers",
        headers=auth(ada),
        json={"username": "bob"},
    )
    assert offered.status_code == 201, offered.text
    transfer = offered.json()["transfer"]
    assert transfer["status"] == "pending"
    assert transfer["toUsername"] == "bob"
    assert transfer["slug"] == "wetlands"
    assert client.get("/ada/wetlands", follow_redirects=False).status_code == 302  # still ada's

    incoming = client.get("/api/transfers/incoming", headers=auth(bob))
    assert incoming.status_code == 200, incoming.text
    assert [item["id"] for item in incoming.json()["transfers"]] == [transfer["id"]]

    accepted = client.post(f"/api/transfers/{transfer['id']}/accept", headers=auth(bob))
    assert accepted.status_code == 200, accepted.text
    moved = accepted.json()["project"]
    assert moved["id"] == before["id"]
    assert moved["views"] == before["views"]
    assert moved["versionCount"] == before["versionCount"]
    assert moved["username"] == "bob"
    assert moved["slug"] == "wetlands"

    raw_redirect = client.get("/ada/wetlands.geolibre.json", follow_redirects=False)
    assert raw_redirect.status_code == 301
    assert raw_redirect.headers["location"].endswith("/bob/wetlands.geolibre.json")
    assert raw_redirect.headers["cache-control"] == "public, no-cache"
    page_redirect = client.get("/ada/wetlands", follow_redirects=False)
    assert page_redirect.status_code == 301
    assert page_redirect.headers["location"].endswith("/bob/wetlands")
    assert page_redirect.headers["cache-control"] == "public, no-cache"

    # The vacated slug stays reserved against a new upload of the same title.
    reused, _ = create_project(client, ada, "public", "Wetlands")
    assert reused["slug"] == "wetlands-2"

    # A second hand-off changes the first old path's canonical destination;
    # clients must revalidate its 301 instead of keeping Bob's old address.
    carol = account(client, "carol")
    next_offer = client.post(
        f"/api/projects/{project['id']}/transfers",
        headers=auth(bob),
        json={"username": "carol"},
    )
    assert next_offer.status_code == 201, next_offer.text
    assert (
        client.post(
            f"/api/transfers/{next_offer.json()['transfer']['id']}/accept",
            headers=auth(carol),
        ).status_code
        == 200
    )
    latest_redirect = client.get("/ada/wetlands", follow_redirects=False)
    assert latest_redirect.status_code == 301
    assert latest_redirect.headers["location"].endswith("/carol/wetlands")
    assert latest_redirect.headers["cache-control"] == "public, no-cache"


def test_transfer_slug_conflicts_are_reported_and_resolvable(client):
    ada = account(client, "ada")
    bob = account(client, "bob")
    create_project(client, bob, "public", "Wetlands")
    project, _ = create_project(client, ada, "public", "Wetlands")

    conflict = client.post(
        f"/api/projects/{project['id']}/transfers",
        headers=auth(ada),
        json={"username": "bob"},
    )
    assert conflict.status_code == 409, conflict.text
    assert conflict.json()["error"] == "slug already exists for the new owner"

    offered = client.post(
        f"/api/projects/{project['id']}/transfers",
        headers=auth(ada),
        json={"username": "bob", "slug": "wetlands-ada"},
    )
    assert offered.status_code == 201, offered.text
    transfer_id = offered.json()["transfer"]["id"]
    assert offered.json()["transfer"]["slug"] == "wetlands-ada"

    # bob claims the offered slug before accepting, so the accept now collides.
    create_project(client, bob, "public", "Wetlands Ada")
    blocked = client.post(f"/api/transfers/{transfer_id}/accept", headers=auth(bob))
    assert blocked.status_code == 409, blocked.text

    accepted = client.post(
        f"/api/transfers/{transfer_id}/accept", headers=auth(bob), json={"slug": "other"}
    )
    assert accepted.status_code == 200, accepted.text
    assert accepted.json()["project"]["slug"] == "other"


def test_organization_transfer_applies_immediately_and_clamps_visibility(client):
    admin = account(client, "admin")
    member = account(client, "member")
    organization = client.post(
        "/api/organizations",
        headers=auth(admin),
        json={
            "slug": "watershed-lab",
            "name": "Watershed Lab",
            "publicSharingPolicy": "no",
        },
    ).json()["organization"]
    assert (
        client.put(
            f"/api/organizations/{organization['id']}/members",
            headers=auth(admin),
            json={"username": "member", "role": "member"},
        ).status_code
        == 200
    )

    project, _ = create_project(client, admin, "public", "Wetlands")
    # A member cannot hand a project to an organization they do not administer.
    own = create_project(client, member, "public", "Member map")[0]
    forbidden = client.post(
        f"/api/projects/{own['id']}/transfers",
        headers=auth(member),
        json={"organizationId": organization["id"]},
    )
    assert forbidden.status_code == 403, forbidden.text

    moved = client.post(
        f"/api/projects/{project['id']}/transfers",
        headers=auth(admin),
        json={"organizationId": organization["id"]},
    )
    assert moved.status_code == 201, moved.text
    assert moved.json()["transfer"]["status"] == "accepted"
    body = moved.json()["project"]
    assert body["organization"]["id"] == organization["id"]
    assert body["visibility"] == "organization"
    assert body["groupIds"] == []

    # The clamp makes the project organization-only, so the redirect resolves
    # for a member (and stays 404 for an anonymous visitor).
    assert client.get("/admin/wetlands", follow_redirects=False).status_code == 404
    redirect = client.get("/admin/wetlands", headers=auth(admin), follow_redirects=False)
    assert redirect.status_code == 301
    assert redirect.headers["location"].endswith("/org/watershed-lab/wetlands")


def test_org_creator_needs_admin_role_to_transfer_out(client):
    admin = account(client, "admin")
    successor = account(client, "successor")
    recipient = account(client, "recipient")
    organization = client.post(
        "/api/organizations",
        headers=auth(admin),
        json={"slug": "lab", "name": "Lab"},
    ).json()["organization"]
    project, _ = create_project(client, admin, "private", "Wetlands")
    moved = patch_project(client, admin, project["id"], {"organizationId": organization["id"]})
    assert moved.status_code == 200, moved.text
    offered = client.post(
        f"/api/projects/{project['id']}/transfers",
        headers=auth(admin),
        json={"username": "recipient"},
    )
    assert offered.status_code == 201, offered.text

    members = f"/api/organizations/{organization['id']}/members"
    assert (
        client.put(
            members,
            headers=auth(admin),
            json={"username": "successor", "role": "administrator"},
        ).status_code
        == 200
    )
    assert (
        client.put(
            members,
            headers=auth(successor),
            json={"username": "admin", "role": "member"},
        ).status_code
        == 200
    )

    # The former administrator still created this project, but can no longer
    # move organization property into a personal account.
    accepted = client.post(
        f"/api/transfers/{offered.json()['transfer']['id']}/accept",
        headers=auth(recipient),
    )
    assert accepted.status_code == 409, accepted.text
    assert accepted.json()["error"] == "transfer is no longer valid"
    assert (
        client.post(
            f"/api/projects/{project['id']}/transfers",
            headers=auth(admin),
            json={"username": "recipient"},
        ).status_code
        == 403
    )
    unchanged = client.get(f"/api/projects/{project['id']}", headers=auth(successor))
    assert unchanged.json()["project"]["organization"]["id"] == organization["id"]


def test_private_project_old_path_does_not_leak_via_redirect(client):
    ada = account(client, "ada")
    bob = account(client, "bob")
    project, _ = create_project(client, ada, "private", "Secret")
    offered = client.post(
        f"/api/projects/{project['id']}/transfers",
        headers=auth(ada),
        json={"username": "bob"},
    ).json()["transfer"]
    assert (
        client.post(f"/api/transfers/{offered['id']}/accept", headers=auth(bob)).status_code == 200
    )

    # Anonymous: the redirect exists but the target is private, so 404 not 301.
    assert client.get("/ada/secret.geolibre.json", follow_redirects=False).status_code == 404

    # An authorized redirect must not be retained after the caller signs out.
    for path in ("/ada/secret", "/ada/secret.geolibre.json"):
        response = client.get(path, headers=auth(bob), follow_redirects=False)
        assert response.status_code == 301
        assert response.headers["cache-control"] == "private, no-store"


def test_only_one_pending_offer_is_allowed_in_storage(client):
    ada = account(client, "ada")
    account(client, "bob")
    project, _ = create_project(client, ada)
    first = client.post(
        f"/api/projects/{project['id']}/transfers",
        headers=auth(ada),
        json={"username": "bob"},
    )
    assert first.status_code == 201, first.text

    # The database, not just the API's preflight SELECT, must reject a second
    # offer so two simultaneous requests cannot both persist a pending row.
    with client.app.state.session_factory() as session:
        original = session.get(ProjectTransfer, first.json()["transfer"]["id"])
        session.add(
            ProjectTransfer(
                id=str(uuid.uuid4()),
                project_id=original.project_id,
                from_account_id=original.from_account_id,
                to_account_id=original.to_account_id,
                slug="another",
                status="pending",
                created_at=original.created_at,
            )
        )
        with pytest.raises(IntegrityError):
            session.commit()
        session.rollback()

    assert (
        client.delete(
            f"/api/transfers/{first.json()['transfer']['id']}", headers=auth(ada)
        ).status_code
        == 204
    )
    replacement = client.post(
        f"/api/projects/{project['id']}/transfers",
        headers=auth(ada),
        json={"username": "bob"},
    )
    assert replacement.status_code == 201, replacement.text


def test_transfer_guards_pending_decline_cancel_and_delete(client):
    ada = account(client, "ada")
    bob = account(client, "bob")
    carol = account(client, "carol")
    project, _ = create_project(client, ada, "public", "Wetlands")

    first = client.post(
        f"/api/projects/{project['id']}/transfers",
        headers=auth(ada),
        json={"username": "bob"},
    )
    assert first.status_code == 201, first.text
    duplicate = client.post(
        f"/api/projects/{project['id']}/transfers",
        headers=auth(ada),
        json={"username": "carol"},
    )
    assert duplicate.status_code == 409
    assert duplicate.json()["error"] == "a transfer is already pending for this project"

    # A third party cannot accept someone else's offer.
    assert (
        client.post(
            f"/api/transfers/{first.json()['transfer']['id']}/accept", headers=auth(carol)
        ).status_code
        == 404
    )

    # The initiator can cancel; the offer leaves the recipient's inbox.
    assert (
        client.delete(
            f"/api/transfers/{first.json()['transfer']['id']}", headers=auth(ada)
        ).status_code
        == 204
    )
    assert client.get("/api/transfers/incoming", headers=auth(bob)).json()["transfers"] == []

    second = client.post(
        f"/api/projects/{project['id']}/transfers",
        headers=auth(ada),
        json={"username": "bob"},
    ).json()["transfer"]
    assert client.get("/api/transfers/outgoing", headers=auth(ada)).json()["transfers"] != []
    assert (
        client.post(f"/api/transfers/{second['id']}/decline", headers=auth(bob)).status_code == 204
    )
    assert client.get("/api/transfers/incoming", headers=auth(bob)).json()["transfers"] == []

    # Deleting the project takes its pending offer with it.
    third = client.post(
        f"/api/projects/{project['id']}/transfers",
        headers=auth(ada),
        json={"username": "bob"},
    ).json()["transfer"]
    assert client.delete(f"/api/projects/{project['id']}", headers=auth(ada)).status_code == 204
    assert client.get("/api/transfers/incoming", headers=auth(bob)).json()["transfers"] == []
    assert client.post(f"/api/transfers/{third['id']}/accept", headers=auth(bob)).status_code == 404
