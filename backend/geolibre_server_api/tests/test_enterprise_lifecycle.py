"""Tests for enterprise lifecycle, TOTP MFA, admin:org scope, audit log, search, and quotas."""

from __future__ import annotations

import json

from fastapi.testclient import TestClient
from geolibre_server_api.account_lifecycle import totp_code
from geolibre_server_api.main import create_app


class _FakeClock:
    def __init__(self, ts: int = 1_700_000_000) -> None:
        self.ts = ts

    def __call__(self) -> int:
        return self.ts


def _project_payload(title: str, extra: str = "") -> str:
    return json.dumps(
        {
            "version": 1,
            "name": title,
            "mapView": {"center": [0, 0], "zoom": 2},
            "layers": [],
            "note": extra,
        }
    )


def test_self_registration_can_be_disabled_for_sso_only_deployments(tmp_path):
    db_url = f"sqlite:///{tmp_path / 'sso.db'}"
    app = create_app(database_url=db_url, allow_self_registration=False)
    client = TestClient(app)

    res = client.post(
        "/api/accounts",
        json={"username": "blocked", "password": "correct horse"},
    )
    assert res.status_code == 403
    assert "self-registration" in res.json()["error"]


def test_email_verification_and_password_reset_flows(tmp_path):
    clock = _FakeClock()
    delivered: list[dict] = []
    app = create_app(
        database_url=f"sqlite:///{tmp_path / 'lifecycle.db'}",
        clock=clock,
        lifecycle_delivery=delivered.append,
    )
    client = TestClient(app)

    reg = client.post(
        "/api/accounts",
        json={
            "username": "alice",
            "email": "alice@example.com",
            "password": "initial password 1",
        },
    )
    assert reg.status_code == 201
    token = reg.json()["token"]
    headers = {"Authorization": f"Bearer {token}"}

    # Request email verification and confirm once; replay must fail.
    req = client.post("/api/auth/verify-email/request", headers=headers)
    assert req.status_code == 202
    assert len(delivered) == 1
    verify_token = delivered[-1]["token"]

    confirm = client.post("/api/auth/verify-email/confirm", json={"token": verify_token})
    assert confirm.status_code == 200
    assert confirm.json()["verified"] is True
    assert confirm.json()["email"] == "alice@example.com"

    replay = client.post("/api/auth/verify-email/confirm", json={"token": verify_token})
    assert replay.status_code == 400

    # Password reset request never reveals whether an account exists.
    unknown = client.post("/api/auth/password-reset/request", json={"identifier": "nobody"})
    assert unknown.status_code == 202
    assert len(delivered) == 1

    reset_req = client.post(
        "/api/auth/password-reset/request",
        json={"identifier": "alice@example.com"},
    )
    assert reset_req.status_code == 202
    assert len(delivered) == 2
    reset_token = delivered[-1]["token"]

    reset_ok = client.post(
        "/api/auth/password-reset/confirm",
        json={"token": reset_token, "newPassword": "updated password 2"},
    )
    assert reset_ok.status_code == 204

    # Replay must fail and old password must no longer work.
    assert (
        client.post(
            "/api/auth/password-reset/confirm",
            json={"token": reset_token, "newPassword": "another password 3"},
        ).status_code
        == 400
    )
    assert (
        client.post(
            "/api/auth/token",
            json={"username": "alice", "password": "initial password 1"},
        ).status_code
        == 401
    )
    assert (
        client.post(
            "/api/auth/token",
            json={"username": "alice", "password": "updated password 2"},
        ).status_code
        == 200
    )


def test_totp_mfa_enrollment_login_enforcement_and_backup_codes(tmp_path):
    clock = _FakeClock(1_700_000_000)
    app = create_app(database_url=f"sqlite:///{tmp_path / 'mfa.db'}", clock=clock)
    client = TestClient(app)

    reg = client.post(
        "/api/accounts",
        json={"username": "admin1", "password": "correct horse"},
    )
    assert reg.status_code == 201
    headers = {"Authorization": f"Bearer {reg.json()['token']}"}

    status_before = client.get("/api/account/mfa/totp", headers=headers)
    assert status_before.status_code == 200
    assert status_before.json()["enabled"] is False

    enroll = client.post("/api/account/mfa/totp/enroll", headers=headers)
    assert enroll.status_code == 201
    assert "no-store" in enroll.headers.get("cache-control", "")
    secret = enroll.json()["secret"]
    backup_codes = enroll.json()["backupCodes"]
    assert enroll.json()["otpauthUri"].startswith("otpauth://totp/GeoLibre:admin1?")
    assert len(backup_codes) == 8
    assert len(backup_codes[0].replace("-", "")) == 20

    # Invalid code rejected during confirm.
    assert (
        client.post(
            "/api/account/mfa/totp/confirm", headers=headers, json={"code": "000000"}
        ).status_code
        == 400
    )

    valid_code = totp_code(secret, clock.ts)
    confirm = client.post(
        "/api/account/mfa/totp/confirm", headers=headers, json={"code": valid_code}
    )
    assert confirm.status_code == 200
    assert confirm.json()["enabled"] is True

    # Password login now requires TOTP or backup code.
    missing = client.post(
        "/api/auth/token",
        json={"username": "admin1", "password": "correct horse"},
    )
    assert missing.status_code == 401
    assert missing.json()["error"] == "mfa_required"

    wrong = client.post(
        "/api/auth/token",
        json={"username": "admin1", "password": "correct horse", "totpCode": "999999"},
    )
    assert wrong.status_code == 401
    assert wrong.json()["error"] == "invalid_mfa_code"

    # Replaying the already-used enrollment confirmation TOTP step is rejected (RFC 6238 §5.2).
    replayed = client.post(
        "/api/auth/token",
        json={"username": "admin1", "password": "correct horse", "totpCode": valid_code},
    )
    assert replayed.status_code == 401

    clock.ts += 30
    next_code = totp_code(secret, clock.ts)
    with_totp = client.post(
        "/api/auth/token",
        json={"username": "admin1", "password": "correct horse", "totpCode": next_code},
    )
    assert with_totp.status_code == 200

    # Single-use backup code works once, then cannot be reused.
    first_backup = backup_codes[0]
    with_backup = client.post(
        "/api/auth/token",
        json={"username": "admin1", "password": "correct horse", "totpCode": first_backup},
    )
    assert with_backup.status_code == 200
    reuse_backup = client.post(
        "/api/auth/token",
        json={"username": "admin1", "password": "correct horse", "totpCode": first_backup},
    )
    assert reuse_backup.status_code == 401

    # Disable MFA with a fresh TOTP code; password login succeeds without totpCode afterwards.
    clock.ts += 30
    disable = client.request(
        "DELETE",
        "/api/account/mfa/totp",
        headers=headers,
        json={"code": totp_code(secret, clock.ts)},
    )
    assert disable.status_code == 204
    after_disable = client.post(
        "/api/auth/token",
        json={"username": "admin1", "password": "correct horse"},
    )
    assert after_disable.status_code == 200


def test_admin_org_scope_and_immutable_organization_audit_log(tmp_path):
    clock = _FakeClock(1_700_000_000)
    app = create_app(database_url=f"sqlite:///{tmp_path / 'audit.db'}", clock=clock)
    client = TestClient(app)

    reg = client.post(
        "/api/accounts",
        json={"username": "orgadmin", "password": "correct horse"},
    )
    assert reg.status_code == 201
    default_headers = {"Authorization": f"Bearer {reg.json()['token']}"}

    org = client.post(
        "/api/organizations",
        headers=default_headers,
        json={"name": "Acme GIS", "slug": "acme-gis"},
    )
    assert org.status_code == 201
    org_id = org.json()["organization"]["id"]

    # Mint a dedicated `admin:org`-only PAT (no `write:projects` or `read:projects`).
    admin_tok = client.post(
        "/api/auth/token",
        json={
            "username": "orgadmin",
            "password": "correct horse",
            "scopes": ["admin:org"],
        },
    )
    assert admin_tok.status_code == 200
    assert admin_tok.json()["scopes"] == ["admin:org"]
    admin_headers = {"Authorization": f"Bearer {admin_tok.json()['token']}"}

    # Update security policy and create a SCIM token using ONLY `admin:org` scope.
    policy_res = client.put(
        f"/api/organizations/{org_id}/security-policy",
        headers=admin_headers,
        json={"passwordMinLength": 12},
    )
    assert policy_res.status_code == 200

    scim_res = client.post(
        f"/api/organizations/{org_id}/scim-tokens",
        headers=admin_headers,
        json={"label": "Okta"},
    )
    assert scim_res.status_code == 201
    scim_id = scim_res.json()["scimToken"]["id"]

    revoke_res = client.delete(
        f"/api/organizations/{org_id}/scim-tokens/{scim_id}",
        headers=admin_headers,
    )
    assert revoke_res.status_code == 204

    audit = client.get(f"/api/organizations/{org_id}/audit-log", headers=admin_headers)
    assert audit.status_code == 200
    actions = [entry["action"] for entry in audit.json()["entries"]]
    assert "org.security_policy.update" in actions
    assert "org.scim_token.create" in actions
    assert "org.scim_token.revoke" in actions

    filtered = client.get(
        f"/api/organizations/{org_id}/audit-log",
        headers=admin_headers,
        params={"action": "org.scim_token.create"},
    )
    assert filtered.status_code == 200
    assert filtered.json()["total"] == 1


def test_projects_search_filter_sort_and_storage_quotas(tmp_path):
    app = create_app(
        database_url=f"sqlite:///{tmp_path / 'quota.db'}",
        user_storage_quota_bytes=500,
    )
    client = TestClient(app)

    alice = client.post(
        "/api/accounts",
        json={"username": "alice", "password": "correct horse"},
    ).json()["token"]
    bob = client.post(
        "/api/accounts",
        json={"username": "bob", "password": "correct horse"},
    ).json()["token"]

    p1 = client.post(
        "/api/projects",
        headers={"Authorization": f"Bearer {alice}"},
        json={
            "filename": "watershed.geolibre.json",
            "title": "Watershed Analysis",
            "content": _project_payload("Watershed Analysis"),
            "visibility": "public",
        },
    )
    assert p1.status_code == 201

    p2 = client.post(
        "/api/projects",
        headers={"Authorization": f"Bearer {bob}"},
        json={
            "filename": "transit.geolibre.json",
            "title": "City Transit Map",
            "content": _project_payload("City Transit Map"),
            "visibility": "public",
        },
    )
    assert p2.status_code == 201

    # Server-side search (`q`), owner filter, and name sort.
    searched = client.get("/api/projects", params={"q": "watershed"})
    assert searched.status_code == 200
    assert searched.json()["total"] == 1
    assert searched.json()["projects"][0]["title"] == "watershed"

    by_owner = client.get("/api/projects", params={"owner": "bob"})
    assert by_owner.status_code == 200
    assert [p["title"] for p in by_owner.json()["projects"]] == ["transit"]

    by_name = client.get("/api/projects", params={"sort": "name"})
    assert by_name.status_code == 200
    assert [p["title"] for p in by_name.json()["projects"]] == [
        "transit",
        "watershed",
    ]

    # Exceeding per-user storage quota returns 413.
    over_quota = client.post(
        "/api/projects",
        headers={"Authorization": f"Bearer {alice}"},
        json={
            "filename": "huge.geolibre.json",
            "content": _project_payload("Huge", extra="x" * 600),
            "visibility": "private",
        },
    )
    assert over_quota.status_code == 413
    assert "quota" in over_quota.json()["error"]
