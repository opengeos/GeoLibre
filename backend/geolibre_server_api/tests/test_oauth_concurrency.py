"""PostgreSQL concurrency gate for OAuth mutation races.

These tests run only under ``python -m pytest -m postgres`` with
``GEOLIBRE_TEST_POSTGRES_URL`` set (see conftest.py): real row-level locking is
required proof that exactly one code exchange wins, that refresh reuse revokes
the family, and that revocation cannot race rotation into a valid token. The
default SQLite suite deselects them via ``addopts = -m 'not postgres'``.
"""

from __future__ import annotations

import threading

import pytest
from fastapi.testclient import TestClient
from geolibre_server_api.auth_models import OAUTH_INDEXES
from geolibre_server_api.main import FileStorage, create_app
from helpers import (
    approve,
    exchange_code,
    redirect_params,
    refresh,
    sign_in,
    start_authorize,
)
from sqlalchemy import event, inspect

pytestmark = pytest.mark.postgres


def test_existing_postgres_oauth_tables_gain_indexes(postgres_app, tmp_path):
    app = postgres_app
    with TestClient(app, base_url="https://share.example") as client:
        tokens = sign_in(client)
    for index in OAUTH_INDEXES:
        index.drop(app.state.engine)

    upgraded = create_app(
        app.state.engine.url.render_as_string(hide_password=False),
        public_url="https://share.example",
        storage=FileStorage(str(tmp_path / "objects")),
    )
    try:
        with TestClient(upgraded, base_url="https://share.example") as client:
            response = client.get(
                "/api/users/me", headers={"Authorization": f"Bearer {tokens['access_token']}"}
            )
            assert response.status_code == 200
            for index in OAUTH_INDEXES:
                assert index.name in {
                    item["name"]
                    for item in inspect(upgraded.state.engine).get_indexes(index.table.name)
                }
    finally:
        upgraded.state.engine.dispose()


def _two_clients(app):
    """Independent TestClients on the same app: real concurrent connections."""
    return TestClient(app, base_url="https://share.example"), TestClient(
        app, base_url="https://share.example"
    )


def _run_concurrently(fns):
    """Run *fns* on threads, returning (results, errors)."""
    results: list = [None] * len(fns)
    errors: list = []
    barrier = threading.Barrier(len(fns))

    def runner(index, fn):
        try:
            barrier.wait(timeout=10)
            results[index] = fn()
        except Exception as exc:  # noqa: BLE001 - record for assertion
            errors.append(exc)

    threads = [threading.Thread(target=runner, args=(i, fn)) for i, fn in enumerate(fns)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=30)
    return results, errors


def _authorize_once(client):
    """Create the consent code once so the raced exchange shares one code."""
    from helpers import ensure_account

    ensure_account(client)
    response, verifier, interaction, csrf = start_authorize(client)
    assert response.status_code == 200
    approved = approve(client, interaction, csrf)
    assert approved.status_code == 303
    return redirect_params(approved)["code"], verifier


def test_exactly_one_code_exchange_wins(postgres_app):
    app = postgres_app
    first, second = _two_clients(app)
    try:
        code, verifier = _authorize_once(first)
        response = exchange_code(first, code, verifier=verifier)
        assert response.status_code == 200, response.text
    finally:
        first.close()

    # A second concurrent exchange of the same code must not mint a family.
    code2, verifier2 = _authorize_once(second)
    read_barrier = threading.Barrier(2)
    read_slots = threading.Semaphore(2)

    def synchronize_code_reads(_conn, _cursor, statement, _params, _context, _many):
        lowered = statement.lower()
        matches_code_lookup = (
            "from oauth_authorization_codes" in lowered
            and "oauth_authorization_codes.code_digest" in lowered
        )
        if matches_code_lookup and read_slots.acquire(blocking=False):
            # Both transactions have executed the unconsumed-code SELECT before
            # either can proceed to its conditional consume.
            read_barrier.wait(timeout=10)

    event.listen(app.state.engine, "after_cursor_execute", synchronize_code_reads)
    client_a, client_b = _two_clients(app)
    try:
        results, errors = _run_concurrently(
            [
                lambda: exchange_code(client_a, code2, verifier=verifier2),
                lambda: exchange_code(client_b, code2, verifier=verifier2),
            ]
        )
        assert not errors, errors
        statuses = sorted(response.status_code for response in results)
        # One winner; the loser reports invalid_grant after the winner commits.
        assert statuses == [200, 400]
        winner = next(response for response in results if response.status_code == 200)
        loser_json = next(response.json() for response in results if response.status_code == 400)
        assert loser_json["error"] == "invalid_grant"
        # The winner's tokens are immediately invalid: the replay revoked the
        # family.
        assert (
            client_a.get(
                "/api/users/me",
                headers={"Authorization": f"Bearer {winner.json()['access_token']}"},
            ).status_code
            == 401
        )
    finally:
        event.remove(app.state.engine, "after_cursor_execute", synchronize_code_reads)
        second.close()
        client_a.close()
        client_b.close()


def test_cancel_losing_approval_race_cannot_claim_denial(postgres_app):
    app = postgres_app
    initiator = TestClient(app, base_url="https://share.example")
    approver, canceller = _two_clients(app)
    approved = threading.Event()
    paused_cancel = threading.Event()

    def pause_cancel_update(_conn, _cursor, statement, _params, _context, _many):
        if statement.lower().startswith("update oauth_authorization_codes set consumed_at"):
            paused_cancel.set()
            assert approved.wait(timeout=10)

    event.listen(app.state.engine, "before_cursor_execute", pause_cancel_update)
    try:
        from helpers import ensure_account

        ensure_account(initiator)
        page, verifier, interaction, csrf = start_authorize(initiator)
        assert page.status_code == 200
        approver.cookies.update(initiator.cookies)
        canceller.cookies.update(initiator.cookies)

        def allow():
            try:
                return approve(approver, interaction, csrf)
            finally:
                approved.set()

        results, errors = _run_concurrently(
            [allow, lambda: approve(canceller, interaction, csrf, decision="cancel")]
        )
        assert not errors, errors
        assert paused_cancel.is_set()
        allowed, cancelled = results
        assert allowed.status_code == 303
        assert cancelled.status_code == 400
        assert "location" not in cancelled.headers
        assert (
            exchange_code(
                initiator, redirect_params(allowed)["code"], verifier=verifier
            ).status_code
            == 200
        )
    finally:
        event.remove(app.state.engine, "before_cursor_execute", pause_cancel_update)
        initiator.close()
        approver.close()
        canceller.close()


def test_concurrent_refresh_reuse_revokes_the_family(postgres_app):
    app = postgres_app
    client = TestClient(app, base_url="https://share.example")
    try:
        tokens = sign_in(client)
        client_a, client_b = _two_clients(app)
        try:
            results, errors = _run_concurrently(
                [
                    lambda: refresh(client_a, tokens["refresh_token"]),
                    lambda: refresh(client_b, tokens["refresh_token"]),
                ]
            )
            assert not errors, errors
            statuses = sorted(response.status_code for response in results)
            # Refresh tokens are one-use: a concurrent duplicate is reuse, so
            # exactly one succeeds, the other triggers family revocation, and
            # the "winner's" tokens die with it.
            assert statuses == [200, 400]
            winner = next(response for response in results if response.status_code == 200)

            assert (
                client_a.get(
                    "/api/users/me",
                    headers={"Authorization": f"Bearer {winner.json()['access_token']}"},
                ).status_code
                == 401
            )
        finally:
            client_a.close()
            client_b.close()
    finally:
        client.close()


def test_revoke_cannot_race_rotation_into_a_valid_token(postgres_app):
    app = postgres_app
    client = TestClient(app, base_url="https://share.example")
    try:
        tokens = sign_in(client)
        client_a, client_b = _two_clients(app)
        try:
            results, errors = _run_concurrently(
                [
                    lambda: refresh(client_a, tokens["refresh_token"]),
                    lambda: client_b.post(
                        "/oauth/revoke",
                        data={"client_id": "geolibre-web", "token": tokens["access_token"]},
                        headers={"Content-Type": "application/x-www-form-urlencoded"},
                    ),
                ]
            )
            assert not errors, errors
            refresh_response = results[0]

            if refresh_response.status_code == 200:
                # Rotation won the race: revocation landed right after, so the
                # freshly minted access token is already dead.
                assert (
                    client_a.get(
                        "/api/users/me",
                        headers={
                            "Authorization": f"Bearer {refresh_response.json()['access_token']}"
                        },
                    ).status_code
                    == 401
                )
                assert (
                    refresh(client_a, refresh_response.json()["refresh_token"]).status_code == 400
                )
            else:
                assert refresh_response.status_code == 400
        finally:
            client_a.close()
            client_b.close()
    finally:
        client.close()


def test_revoke_others_serializes_with_refresh(postgres_app):
    from helpers import auth

    app = postgres_app
    with TestClient(app, base_url="https://share.example") as initial:
        current = sign_in(initial)
        kept = initial.get("/api/users/me", headers=auth(current["access_token"]))
        current_id = kept.json()["sessionId"]
        other = sign_in(initial)
        manager = sign_in(initial, scope="manage:sessions")
        refresher, revoker = _two_clients(app)
        try:
            results, errors = _run_concurrently(
                [
                    lambda: refresh(refresher, other["refresh_token"]),
                    lambda: revoker.post(
                        "/api/auth/sessions/revoke-others",
                        headers=auth(manager["access_token"]),
                        json={"currentSessionId": current_id},
                    ),
                ]
            )
            assert not errors, errors
            assert results[1].status_code == 204, results[1].text
            assert (
                initial.get("/api/users/me", headers=auth(current["access_token"])).status_code
                == 200
            )
            assert (
                initial.get("/api/users/me", headers=auth(manager["access_token"])).status_code
                == 200
            )
            assert (
                initial.get("/api/users/me", headers=auth(other["access_token"])).status_code == 401
            )
            assert refresh(initial, other["refresh_token"]).status_code == 400
            if results[0].status_code == 200:
                rotated = results[0].json()
                assert (
                    initial.get("/api/users/me", headers=auth(rotated["access_token"])).status_code
                    == 401
                )
                assert refresh(initial, rotated["refresh_token"]).status_code == 400
            else:
                assert results[0].status_code == 400
        finally:
            refresher.close()
            revoker.close()


def test_account_deletion_cascades_oauth_rows(postgres_app):
    app = postgres_app
    client = TestClient(app, base_url="https://share.example")
    try:
        sign_in(client)
        from helpers import pat

        pat(client)  # a personal token policy to cascade too
        with app.state.engine.connect() as connection:
            account_id = connection.exec_driver_sql(
                "select account_id from oauth_sessions limit 1"
            ).scalar()
            connection.exec_driver_sql("delete from accounts where id = %s", (account_id,))
            connection.commit()
        for table in (
            "oauth_sessions",
            "oauth_access_tokens",
            "oauth_refresh_tokens",
            "oauth_authorization_codes",
            "personal_token_policies",
            "tokens",
        ):
            with app.state.engine.connect() as connection:
                remaining = connection.exec_driver_sql(f"select count(*) from {table}").scalar()
            assert remaining == 0, f"{table} still has rows after account deletion"
    finally:
        client.close()
