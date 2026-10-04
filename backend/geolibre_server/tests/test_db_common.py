from __future__ import annotations

import pytest
from fastapi import HTTPException

from geolibre_server.app.db_common import (
    host_port_allowed,
    json_safe,
    normalize_host,
    parse_host_allowlist,
    plan_feature_diff,
    scrub_secrets,
)


def test_json_safe_stringifies_unsafe_integers() -> None:
    """Integers beyond JavaScript's safe range must not round through JSON."""
    assert json_safe(42) == 42
    assert json_safe(2**53 - 1) == 2**53 - 1
    assert json_safe(2**60) == str(2**60)
    assert json_safe(-(2**60)) == str(-(2**60))
    assert json_safe(True) is True


def test_host_allowlist_parses_hosts_ips_and_ports() -> None:
    """Hosts, ports, wildcards, and IPv6 brackets parse into normalized targets."""
    assert parse_host_allowlist("DB.EXAMPLE., db.internal:5433, 10.0.0.4, [2001:db8::1]:5432") == {
        ("db.example", None),
        ("db.internal", 5433),
        ("10.0.0.4", None),
        ("2001:db8::1", 5432),
    }
    with pytest.raises(ValueError):
        parse_host_allowlist("2001:db8::1:5432")
    assert parse_host_allowlist("[2001:db8::1]") == {("2001:db8::1", None)}
    assert parse_host_allowlist("*") is None
    with pytest.raises(ValueError):
        parse_host_allowlist("db.example,*")
    with pytest.raises(ValueError):
        parse_host_allowlist("[]")
    assert normalize_host("DB.EXAMPLE.") == "db.example"


def test_scrub_secrets_covers_urls_odbc_and_known_literals() -> None:
    """URL, key/value, ODBC-braced, and literal secrets are all redacted."""
    url = "connection to postgresql://alice:hunter2@db.example.com/gis failed"
    assert "hunter2" not in scrub_secrets(url)
    kv = "invalid dsn: host=db user=alice password=hunter2 dbname=gis"
    assert "hunter2" not in scrub_secrets(kv)
    assert "hunter2" not in scrub_secrets("postgresql://:hunter2@db.example.com/gis")
    scrubbed = scrub_secrets("postgresql://alice:p@ss@db.example.com/gis")
    assert "p@ss" not in scrubbed
    assert "****@db.example.com" in scrubbed
    assert "secret" not in scrub_secrets("db_password=secret")
    assert "secret" not in scrub_secrets("old_pwd=secret")
    assert "secret" not in scrub_secrets("userPassword=secret")
    assert "a}}b" not in scrub_secrets("PWD={a}}b};")
    assert "sekret" not in scrub_secrets("token sekret", ["sekret"])


def test_host_port_allowed_named_instance_host_only() -> None:
    """A port-less target (named instance) matches only a host-only entry."""
    assert host_port_allowed({("db.example", None)}, "DB.EXAMPLE.", None)
    assert not host_port_allowed({("db.example", 1433)}, "db.example", None)
    assert host_port_allowed({("db.example", 1433)}, "db.example", 1433)


def test_plan_feature_diff_semantics() -> None:
    """Unchanged rows and dropped insert keys are skipped, not rewritten."""
    geometry = {"type": "Point", "coordinates": [0, 0]}
    existing = {1: (geometry, {"name": "old"})}
    diff = plan_feature_diff(
        [
            {
                "type": "Feature",
                "id": 1,
                "properties": {"id": None, "name": "old", "extra": 2},
                "geometry": geometry,
            },
            {"type": "Feature", "id": 2, "properties": {"id": 2, "name": "new"}, "geometry": None},
            {"type": "Feature", "properties": {"name": "new"}, "geometry": None},
        ],
        primary_key="id",
        writable_columns=["name"],
        existing_rows=existing,
        pk_is_generated=True,
        insert_explicit_key=False,
        baseline_keys=[1, 3],
        capabilities=None,
        table_label="dbo.t",
    )
    assert diff.updates == []
    assert [row.key for row in diff.inserts] == [None, None]
    assert diff.deletes == []
    assert diff.skipped_fields == ["extra"]


def test_plan_feature_diff_key_fallback_drives_explicit_insert() -> None:
    """feature.id may stand in for a cleared key only where the DB accepts it."""
    feature = {"id": 42, "properties": {"name": "new"}, "geometry": None}
    options = dict(
        primary_key="id",
        writable_columns=["name"],
        existing_rows={},
        baseline_keys=None,
        capabilities=None,
        table_label="dbo.t",
    )
    diff = plan_feature_diff(
        [feature],
        **{**options, "pk_is_generated": True, "insert_explicit_key": True},
    )
    assert [change.key for change in diff.inserts] == [42]

    # A non-generated key column cannot accept the dropped fallback value.
    with pytest.raises(HTTPException) as exc:
        plan_feature_diff(
            [feature],
            **{**options, "pk_is_generated": False, "insert_explicit_key": False},
        )
    assert exc.value.status_code == 400


def test_plan_feature_diff_rejects_keyless_non_generated() -> None:
    """A keyless insert against a non-generated key column is rejected."""
    with pytest.raises(HTTPException) as exc:
        plan_feature_diff(
            [{"properties": {}, "geometry": None}],
            primary_key="id",
            writable_columns=[],
            existing_rows={},
            pk_is_generated=False,
            insert_explicit_key=True,
            baseline_keys=None,
            capabilities=None,
            table_label="dbo.t",
        )
    assert exc.value.status_code == 400


def test_plan_feature_diff_reports_updates_and_enforces_each_capability() -> None:
    """Updates are planned and each denied capability raises 403."""
    existing = {1: (None, {"name": "before"})}
    update = {"id": 1, "properties": {"name": "after"}, "geometry": None}
    insert = {"properties": {"name": "new"}, "geometry": None}
    options = dict(
        primary_key="id",
        writable_columns=["name"],
        existing_rows=existing,
        pk_is_generated=True,
        insert_explicit_key=True,
        baseline_keys=None,
        capabilities=None,
        table_label="dbo.t",
    )
    diff = plan_feature_diff([update], **options)
    assert [(change.key, change.values) for change in diff.updates] == [(1, {"name": "after"})]

    cases = [
        ([insert], {"create": False}, "Layer capability excludes feature creation."),
        ([update], {"update": False}, "Layer capability excludes feature updates."),
        ([], {"delete": False}, "Layer capability excludes feature deletion."),
    ]
    for features, capabilities, message in cases:
        with pytest.raises(HTTPException) as exc:
            plan_feature_diff(features, **{**options, "capabilities": capabilities})
        assert exc.value.status_code == 403
        assert exc.value.detail == message


def test_plan_feature_diff_baseline_protects_concurrent_rows() -> None:
    """Rows outside the baseline are never scheduled for deletion."""
    existing = {1: (None, {"name": "kept"}), 2: (None, {"name": "concurrent"})}
    diff = plan_feature_diff(
        [{"id": 1, "properties": {"name": "kept"}, "geometry": None}],
        primary_key="id",
        writable_columns=["name"],
        existing_rows=existing,
        pk_is_generated=False,
        insert_explicit_key=True,
        baseline_keys=[1],
        capabilities=None,
        table_label="dbo.t",
    )
    assert diff.deletes == []
