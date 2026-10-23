"""PostgreSQL concurrency gate for SCIM user provisioning.

Runs only under ``python -m pytest -m postgres`` with ``GEOLIBRE_TEST_POSTGRES_URL``
set (see conftest.py): two identity-provider requests creating the same
``userName`` must provision exactly one account.
"""

from __future__ import annotations

import json
import threading

import pytest
from fastapi.testclient import TestClient
from helpers import admin_token, auth, create_org

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


def test_concurrent_creates_of_one_user_name_provision_once(postgres_app):
    with TestClient(postgres_app, base_url=BASE_URL) as admin:
        token = admin_token(admin)
        org_id = create_org(admin, token)
        minted = admin.post(
            f"/api/organizations/{org_id}/scim-tokens", json={"label": "Entra"}, headers=auth(token)
        )
        assert minted.status_code == 201, minted.text
        scim_token = minted.json()["token"]

    headers = {"Authorization": f"Bearer {scim_token}", "Content-Type": "application/scim+json"}
    body = json.dumps({"userName": "grace@example.org"})
    clients = [TestClient(postgres_app, base_url=BASE_URL) for _ in range(2)]

    def create(client):
        return lambda: client.post(f"/scim/v2/{org_id}/Users", content=body, headers=headers)

    try:
        results, errors = _run_concurrently([create(client) for client in clients])
        listed = clients[0].get(f"/scim/v2/{org_id}/Users", headers=headers)
    finally:
        for client in clients:
            client.close()

    assert errors == []
    assert sorted(result.status_code for result in results) == [201, 409]
    loser = next(result for result in results if result.status_code == 409)
    assert loser.json()["scimType"] == "uniqueness"
    assert listed.json()["totalResults"] == 1
