"""PostgreSQL race gates for shared-project transfer state transitions."""

from __future__ import annotations

import threading

import pytest
from fastapi.testclient import TestClient
from geolibre_server_api.project_models import ProjectTransfer
from helpers import account, auth, create_project
from sqlalchemy import event

pytestmark = pytest.mark.postgres


def test_accept_and_cancel_cannot_both_resolve_one_offer(postgres_app):
    app = postgres_app
    with TestClient(app, base_url="https://share.example") as setup:
        ada = account(setup, "ada")
        bob = account(setup, "bob")
        project, _ = create_project(setup, ada)
        offered = setup.post(
            f"/api/projects/{project['id']}/transfers",
            headers=auth(ada),
            json={"username": "bob"},
        )
        assert offered.status_code == 201, offered.text
        transfer_id = offered.json()["transfer"]["id"]

    both_read = threading.Barrier(2)
    first_two = threading.Semaphore(2)

    def synchronize_offer_reads(_conn, _cursor, statement, _params, _context, _many):
        sql = statement.lower()
        if (
            sql.lstrip().startswith("select")
            and "from project_transfers" in sql
            and "project_transfers.id" in sql
            and first_two.acquire(blocking=False)
        ):
            both_read.wait(timeout=10)

    event.listen(app.state.engine, "after_cursor_execute", synchronize_offer_reads)
    recipient = TestClient(app, base_url="https://share.example")
    initiator = TestClient(app, base_url="https://share.example")
    results: dict[str, object] = {}
    errors: list[Exception] = []

    def run(name, operation):
        try:
            results[name] = operation()
        except Exception as exc:  # noqa: BLE001 - report thread failure in the test
            errors.append(exc)

    try:
        accept = threading.Thread(
            target=run,
            args=(
                "accept",
                lambda: recipient.post(f"/api/transfers/{transfer_id}/accept", headers=auth(bob)),
            ),
        )
        cancel = threading.Thread(
            target=run,
            args=(
                "cancel",
                lambda: initiator.delete(f"/api/transfers/{transfer_id}", headers=auth(ada)),
            ),
        )
        accept.start()
        cancel.start()
        accept.join(timeout=30)
        cancel.join(timeout=30)
        assert not accept.is_alive() and not cancel.is_alive()
        assert not errors, errors
        statuses = (results["accept"].status_code, results["cancel"].status_code)
        assert statuses in {(200, 404), (409, 204)}

    finally:
        event.remove(app.state.engine, "after_cursor_execute", synchronize_offer_reads)
        recipient.close()
        initiator.close()

    with app.state.session_factory() as session:
        resolved = session.get(ProjectTransfer, transfer_id)
        assert resolved.status == ("accepted" if statuses[0] == 200 else "cancelled")
    with TestClient(app, base_url="https://share.example") as check:
        current = check.get(f"/api/projects/{project['id']}").json()["project"]
        assert current["username"] == ("bob" if statuses[0] == 200 else "ada")
