"""PostgreSQL concurrency gate for the failed-login counter.

Runs only under ``python -m pytest -m postgres`` with ``GEOLIBRE_TEST_POSTGRES_URL``
set (see conftest.py): concurrent wrong passwords must each be counted exactly
once, and the lazily created ``account_security`` row must not race into a 500.
"""

from __future__ import annotations

import threading

import pytest
from fastapi.testclient import TestClient
from geolibre_server_api.auth_models import Account
from geolibre_server_api.enterprise_models import AccountSecurity
from helpers import add_member, admin_token, create_org, set_policy
from sqlalchemy import delete, select
from sqlalchemy.orm import Session

pytestmark = pytest.mark.postgres

BASE_URL = "https://share.example"


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


def test_concurrent_failed_logins_are_each_counted(postgres_app):
    with TestClient(postgres_app, base_url=BASE_URL) as setup:
        token = admin_token(setup)
        org_id = create_org(setup, token)
        response = set_policy(setup, token, org_id, lockoutThreshold=5, lockoutSeconds=60)
        assert response.status_code == 200, response.text
        add_member(setup, token, org_id, "bob")

    # Accounts that predate the policy tables have no security row; make the
    # racing requests create it lazily.
    with Session(postgres_app.state.engine) as session:
        bob_id = session.scalar(select(Account.id).where(Account.username == "bob"))
        session.execute(delete(AccountSecurity).where(AccountSecurity.account_id == bob_id))
        session.commit()

    clients = [TestClient(postgres_app, base_url=BASE_URL) for _ in range(4)]

    def attempt(client):
        return lambda: client.post(
            "/api/auth/token", json={"username": "bob", "password": "wrong password"}
        )

    results, errors = _run_concurrently([attempt(client) for client in clients])
    assert errors == []
    assert [result.status_code for result in results] == [401] * 4

    with Session(postgres_app.state.engine) as session:
        bob_security = session.get(AccountSecurity, bob_id)
        assert bob_security.failed_login_count == 4
