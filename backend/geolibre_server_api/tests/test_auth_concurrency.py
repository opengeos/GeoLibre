"""PostgreSQL concurrency proof for legacy PAT policy backfill."""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor

import pytest
from fastapi.testclient import TestClient
from geolibre_server_api.auth import backfill_policy, now, token_digest
from helpers import ensure_account
from sqlalchemy.orm import Session

pytestmark = pytest.mark.postgres


def test_concurrent_legacy_policy_backfill_is_conflict_safe(postgres_app):
    app = postgres_app
    digest = token_digest("legacy-concurrent-token")
    with TestClient(app, base_url="https://share.example") as client:
        ensure_account(client)
        with app.state.engine.begin() as connection:
            account_id = connection.exec_driver_sql(
                "select id from accounts where username = 'ada'"
            ).scalar_one()
            connection.exec_driver_sql(
                "insert into tokens (digest, account_id, created_at) values (%s, %s, %s)",
                (digest, account_id, now()),
            )

        def insert_policy():
            with Session(app.state.engine) as session:
                return backfill_policy(session, digest).id

        with ThreadPoolExecutor(max_workers=2) as executor:
            results = list(executor.map(lambda _index: insert_policy(), range(2)))

        assert len(set(results)) == 1
        with app.state.engine.connect() as connection:
            count = connection.exec_driver_sql(
                "select count(*) from personal_token_policies where token_digest = %s",
                (digest,),
            ).scalar_one()
        assert count == 1
