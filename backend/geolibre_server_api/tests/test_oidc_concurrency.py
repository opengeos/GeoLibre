"""PostgreSQL concurrency gate for the single sign-on callback.

Runs only under ``python -m pytest -m postgres`` with ``GEOLIBRE_TEST_POSTGRES_URL``
set (see conftest.py): two callbacks racing on one ``state`` must redeem the
provider's code exactly once.
"""

from __future__ import annotations

import threading

import pytest
from conftest import WEB_REDIRECT
from fastapi.testclient import TestClient
from helpers import admin_token, configure_idp, create_org, redirect_params, start_sso

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


def test_concurrent_callbacks_for_one_state_redeem_once(postgres_app, fake_idp_realtime):
    idp = fake_idp_realtime
    with TestClient(postgres_app, base_url=BASE_URL) as browser:
        token = admin_token(browser)
        org_id = create_org(browser, token)
        configured = configure_idp(browser, token, org_id)
        assert configured.status_code == 200, configured.text
        _, params, _ = start_sso(browser, "acme")
        idp.issue("c-race", idp.base_claims("u1", nonce=params["nonce"]), params["code_challenge"])

        # Both requests carry the consent browser's binding cookie.
        clients = [TestClient(postgres_app, base_url=BASE_URL) for _ in range(2)]
        for client in clients:
            client.cookies.update(browser.cookies)
        query = {"code": "c-race", "state": params["state"]}

        def callback(client):
            return lambda: client.get("/oauth/sso/callback", params=query, follow_redirects=False)

        try:
            results, errors = _run_concurrently([callback(client) for client in clients])
        finally:
            for client in clients:
                client.close()

    assert errors == []
    assert sorted(result.status_code for result in results) == [303, 400]
    winner = next(result for result in results if result.status_code == 303)
    assert winner.headers["location"].startswith(f"{WEB_REDIRECT}?")
    assert "code" in redirect_params(winner)
    loser = next(result for result in results if result.status_code == 400)
    assert "single sign-on response rejected" in loser.text
