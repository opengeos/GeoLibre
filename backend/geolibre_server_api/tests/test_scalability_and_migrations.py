"""Regression tests for N+1 query elimination, pagination, pooling, and Alembic."""

from __future__ import annotations

import json
from contextlib import contextmanager
from pathlib import Path

from alembic import command
from alembic.config import Config
from geolibre_server_api.main import _build_engine_kwargs, create_app
from helpers import account, auth, configure_idp, create_org, create_project
from sqlalchemy import create_engine, event, inspect


@contextmanager
def count_queries(engine):
    """Count SQL statements executed on *engine* inside a with-block."""
    queries: list[str] = []

    def _before_cursor_execute(_conn, _cursor, statement, _params, _context, _executemany):
        queries.append(statement)

    event.listen(engine, "before_cursor_execute", _before_cursor_execute)
    try:
        yield queries
    finally:
        event.remove(engine, "before_cursor_execute", _before_cursor_execute)


def test_postgres_engine_kwargs_set_pool_hygiene(monkeypatch) -> None:
    monkeypatch.setenv("GEOLIBRE_DB_POOL_SIZE", "12")
    monkeypatch.setenv("GEOLIBRE_DB_MAX_OVERFLOW", "24")
    monkeypatch.setenv("GEOLIBRE_DB_POOL_RECYCLE", "900")
    kwargs = _build_engine_kwargs("postgresql+psycopg://user:pass@localhost/geolibre")
    assert kwargs["pool_pre_ping"] is True
    assert kwargs["pool_size"] == 12
    assert kwargs["max_overflow"] == 24
    assert kwargs["pool_recycle"] == 900

    sqlite_kwargs = _build_engine_kwargs("sqlite:///./local.db")
    assert sqlite_kwargs["connect_args"] == {"check_same_thread": False}
    assert "pool_size" not in sqlite_kwargs


def test_list_projects_and_shares_query_count_stays_constant(client) -> None:
    ada = account(client, "ada")
    org_id = create_org(client, ada, slug="geo-org", name="Geo Org")
    group_res = client.post(
        "/api/groups",
        headers=auth(ada),
        json={"name": "Editors", "organizationId": org_id, "sharedUpdate": True},
    )
    assert group_res.status_code == 201, group_res.text
    group_id = group_res.json()["group"]["id"]

    engine = client.app.state.engine

    def _create_org_project(idx: int) -> None:
        res = client.post(
            "/api/projects",
            headers=auth(ada),
            json={
                "filename": f"map-{idx}.geolibre.json",
                "content": json.dumps({"version": "0.2.0", "name": f"Map {idx}", "layers": []}),
                "visibility": "public",
                "organizationId": org_id,
                "groupIds": [group_id],
            },
        )
        assert res.status_code == 201, res.text

    _create_org_project(0)
    with count_queries(engine) as q1_projects:
        r1 = client.get("/api/projects?shared_with_me=true", headers=auth(ada))
        assert r1.status_code == 200
        assert len(r1.json()["projects"]) == 1
    with count_queries(engine) as q1_shares:
        s1 = client.get("/api/shares", headers=auth(ada))
        assert s1.status_code == 200
        assert s1.json()["total"] == 1

    # Add 7 more org+group-shared projects; query count must not grow linearly.
    for i in range(1, 8):
        _create_org_project(i)

    with count_queries(engine) as q8_projects:
        r8 = client.get("/api/projects?shared_with_me=true", headers=auth(ada))
        assert r8.status_code == 200
        assert len(r8.json()["projects"]) == 8
        assert all(p["canEdit"] is True for p in r8.json()["projects"])
    assert len(q8_projects) == len(q1_projects)

    with count_queries(engine) as q8_shares:
        s8 = client.get("/api/shares?limit=3&offset=2", headers=auth(ada))
        assert s8.status_code == 200
        body = s8.json()
        assert body["total"] == 8
        assert body["limit"] == 3
        assert body["offset"] == 2
        assert len(body["shares"]) == 3
    assert len(q8_shares) == len(q1_shares)


def test_transfer_listings_paginate_and_avoid_n_plus_one(client) -> None:
    ada = account(client, "ada")
    grace = account(client, "grace")
    engine = client.app.state.engine

    def _offer(idx: int) -> None:
        proj, _ = create_project(client, ada, "public", f"Transfer {idx}")
        res = client.post(
            f"/api/projects/{proj['id']}/transfers",
            headers=auth(ada),
            json={"username": "grace"},
        )
        assert res.status_code == 201, res.text

    _offer(0)
    with count_queries(engine) as q1_in:
        r1 = client.get("/api/transfers/incoming", headers=auth(grace))
        assert r1.status_code == 200
        assert r1.json()["total"] == 1
    with count_queries(engine) as q1_out:
        o1 = client.get("/api/transfers/outgoing", headers=auth(ada))
        assert o1.status_code == 200
        assert o1.json()["total"] == 1

    for i in range(1, 6):
        _offer(i)

    with count_queries(engine) as q6_in:
        r6 = client.get("/api/transfers/incoming?limit=2&offset=1", headers=auth(grace))
        assert r6.status_code == 200
        body = r6.json()
        assert body["total"] == 6
        assert body["limit"] == 2
        assert body["offset"] == 1
        assert len(body["transfers"]) == 2
    assert len(q6_in) == len(q1_in)

    with count_queries(engine) as q6_out:
        o6 = client.get("/api/transfers/outgoing?limit=3&offset=0", headers=auth(ada))
        assert o6.status_code == 200
        assert o6.json()["total"] == 6
        assert len(o6.json()["transfers"]) == 3
    assert len(q6_out) == len(q1_out)


def test_scim_list_groups_batches_member_queries(client) -> None:
    ada = account(client, "ada")
    org_id = create_org(client, ada, slug="scim-batch", name="SCIM Batch")
    assert configure_idp(client, ada, org_id).status_code == 200
    minted = client.post(
        f"/api/organizations/{org_id}/scim-tokens",
        json={"label": "Okta"},
        headers=auth(ada),
    )
    assert minted.status_code == 201, minted.text
    scim_token = minted.json()["token"]
    headers = {
        "Authorization": f"Bearer {scim_token}",
        "Content-Type": "application/scim+json",
    }

    user_res = client.post(
        f"/scim/v2/{org_id}/Users",
        headers=headers,
        content=json.dumps({"userName": "member@scim.example"}),
    )
    assert user_res.status_code == 201, user_res.text
    user_id = user_res.json()["id"]

    engine = client.app.state.engine

    def _create_group(idx: int) -> None:
        res = client.post(
            f"/scim/v2/{org_id}/Groups",
            headers=headers,
            content=json.dumps({"displayName": f"Team {idx}", "members": [{"value": user_id}]}),
        )
        assert res.status_code == 201, res.text

    scim_auth = {"Authorization": f"Bearer {scim_token}"}
    _create_group(0)
    with count_queries(engine) as q1:
        r1 = client.get(f"/scim/v2/{org_id}/Groups", headers=scim_auth)
        assert r1.status_code == 200
        assert len(r1.json()["Resources"]) == 1
        assert len(r1.json()["Resources"][0]["members"]) == 1

    for i in range(1, 6):
        _create_group(i)

    with count_queries(engine) as q6:
        r6 = client.get(f"/scim/v2/{org_id}/Groups", headers=scim_auth)
        assert r6.status_code == 200
        resources = r6.json()["Resources"]
        assert len(resources) == 6
        assert all(len(g["members"]) == 1 for g in resources)
    assert len(q6) == len(q1)


def test_alembic_upgrade_head_builds_full_schema(tmp_path: Path, monkeypatch) -> None:
    db_file = tmp_path / "alembic-test.db"
    db_url = f"sqlite:///{db_file}"
    monkeypatch.setenv("GEOLIBRE_DATABASE_URL", db_url)
    alembic_ini = Path(__file__).resolve().parents[1] / "alembic.ini"
    cfg = Config(str(alembic_ini))
    cfg.set_main_option("sqlalchemy.url", db_url)
    command.upgrade(cfg, "head")

    engine = create_engine(db_url)
    try:
        tables = set(inspect(engine).get_table_names())
        expected = {
            "accounts",
            "projects",
            "organizations",
            "groups",
            "project_transfers",
            "alembic_version",
        }
        assert expected <= tables
    finally:
        engine.dispose()

    # App boots cleanly with GEOLIBRE_SKIP_DDL_CREATE_ALL=1 against Alembic-migrated DB.
    monkeypatch.setenv("GEOLIBRE_SKIP_DDL_CREATE_ALL", "1")
    app = create_app(database_url=db_url)
    app.state.engine.dispose()
