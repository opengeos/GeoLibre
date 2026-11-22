"""Regression tests for N+1 query elimination, pagination, pooling, and Alembic."""

from __future__ import annotations

import json
from contextlib import contextmanager
from pathlib import Path

import pytest
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

    # Offline SQL generation must not emit duplicate CREATE INDEX statements.
    import io
    import re
    from contextlib import redirect_stdout

    buf = io.StringIO()
    with redirect_stdout(buf):
        command.upgrade(cfg, "head", sql=True)
    sql_out = buf.getvalue()
    created_indexes = re.findall(r"CREATE\s+(?:UNIQUE\s+)?INDEX\s+(\S+)", sql_out, flags=re.I)
    assert len(created_indexes) == len(set(created_indexes)), (
        f"Duplicate CREATE INDEX in offline SQL: {created_indexes}"
    )

    # App boots cleanly with GEOLIBRE_SKIP_DDL_CREATE_ALL=1 against Alembic-migrated DB.
    monkeypatch.setenv("GEOLIBRE_SKIP_DDL_CREATE_ALL", "1")
    app = create_app(database_url=db_url)
    app.state.engine.dispose()

    # Baseline revision refuses destructive downgrade.
    with pytest.raises(NotImplementedError, match="restore from backup"):
        command.downgrade(cfg, "base")

    # Unmigrated database with GEOLIBRE_SKIP_DDL_CREATE_ALL=1 fails with actionable message.
    empty_url = f"sqlite:///{tmp_path / 'empty.db'}"
    with pytest.raises(RuntimeError, match="alembic upgrade head"):
        create_app(database_url=empty_url)


def test_schema_upgrade_helpers_run_on_active_connection(tmp_path: Path) -> None:
    from geolibre_server_api.auth_models import Base
    from geolibre_server_api.main import upgrade_sqlite_schema
    from sqlalchemy import text

    engine = create_engine(f"sqlite:///{tmp_path / 'conn-upgrade.db'}")
    try:
        with engine.begin() as conn:
            Base.metadata.create_all(bind=conn, checkfirst=True)
            # Runs inside the same connection/transaction without opening a second connection.
            upgrade_sqlite_schema(conn)
            assert "projects" in set(inspect(conn).get_table_names())
    finally:
        engine.dispose()

    # Legacy SQLite file DB (owner_id NOT NULL + child version row) must rebuild
    # atomically inside Alembic's migration transaction without locking.
    legacy_db = tmp_path / "legacy-alembic.db"
    legacy_url = f"sqlite:///{legacy_db}"
    legacy_engine = create_engine(legacy_url)
    try:
        with legacy_engine.begin() as conn:
            conn.execute(
                text(
                    "CREATE TABLE accounts (id VARCHAR(36) NOT NULL PRIMARY KEY, "
                    "username VARCHAR(40) NOT NULL, password_hash VARCHAR(200) NOT NULL, "
                    "created_at VARCHAR(32) NOT NULL)"
                )
            )
            conn.execute(
                text(
                    "CREATE TABLE projects (id VARCHAR(36) NOT NULL PRIMARY KEY, "
                    "owner_id VARCHAR(36) NOT NULL REFERENCES accounts(id), "
                    "slug VARCHAR(100) NOT NULL, title VARCHAR(100) NOT NULL, "
                    "description TEXT NOT NULL DEFAULT '', visibility VARCHAR(16) NOT NULL, "
                    "tags_json TEXT NOT NULL DEFAULT '[]', thumbnail_type VARCHAR(20), "
                    "views INTEGER NOT NULL DEFAULT 0, fork_count INTEGER NOT NULL DEFAULT 0, "
                    "featured BOOLEAN NOT NULL DEFAULT 0, created_at VARCHAR(32) NOT NULL, "
                    "updated_at VARCHAR(32) NOT NULL)"
                )
            )
            conn.execute(
                text(
                    "CREATE TABLE project_versions (id VARCHAR(36) NOT NULL PRIMARY KEY, "
                    "project_id VARCHAR(36) NOT NULL REFERENCES projects(id) ON DELETE CASCADE, "
                    "version INTEGER NOT NULL, storage_key VARCHAR(200) NOT NULL, "
                    "size_bytes INTEGER NOT NULL, created_at VARCHAR(32) NOT NULL)"
                )
            )
            conn.execute(
                text(
                    "INSERT INTO accounts (id, username, password_hash, created_at) "
                    "VALUES ('a1', 'ada', 'h', '2026-01-01T00:00:00Z')"
                )
            )
            conn.execute(
                text(
                    "INSERT INTO projects "
                    "(id, owner_id, slug, title, visibility, created_at, updated_at) "
                    "VALUES ('p1', 'a1', 'map', 'Map', 'private', "
                    "'2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')"
                )
            )
            conn.execute(
                text(
                    "INSERT INTO project_versions "
                    "(id, project_id, version, storage_key, size_bytes, created_at) "
                    "VALUES ('v1', 'p1', 1, 'k1', 10, '2026-01-01T00:00:00Z')"
                )
            )
    finally:
        legacy_engine.dispose()

    alembic_ini = Path(__file__).resolve().parents[1] / "alembic.ini"
    cfg = Config(str(alembic_ini))
    cfg.set_main_option("sqlalchemy.url", legacy_url)
    command.upgrade(cfg, "head")

    verify_engine = create_engine(legacy_url)
    try:
        owner_col = next(
            c for c in inspect(verify_engine).get_columns("projects") if c["name"] == "owner_id"
        )
        assert owner_col["nullable"] is True
        with verify_engine.connect() as conn:
            assert conn.execute(text("SELECT COUNT(*) FROM projects")).scalar() == 1
            assert conn.execute(text("SELECT COUNT(*) FROM project_versions")).scalar() == 1
    finally:
        verify_engine.dispose()
