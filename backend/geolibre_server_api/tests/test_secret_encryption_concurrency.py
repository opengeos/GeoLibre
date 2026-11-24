"""PostgreSQL regression coverage for secret rotation during provider updates."""

from __future__ import annotations

import threading
import time
from concurrent.futures import ThreadPoolExecutor

import pytest
from conftest import PUBLIC_URL
from fastapi.testclient import TestClient
from geolibre_server_api.enterprise_models import OrganizationIdentityProvider
from geolibre_server_api.secret_crypto import reencrypt_stored_secrets
from helpers import admin_token, configure_idp, create_org
from sqlalchemy import event, select, text, update

pytestmark = pytest.mark.postgres


def test_secret_rotation_does_not_overwrite_concurrent_admin_update(postgres_app):
    """An admin's new credential wins after startup has read the old credential.

    Args:
        postgres_app: The API using an isolated PostgreSQL schema.
    """
    engine = postgres_app.state.engine
    table = OrganizationIdentityProvider.__table__
    with TestClient(postgres_app, base_url=PUBLIC_URL) as client:
        token = admin_token(client)
        org_id = create_org(client, token)
        response = configure_idp(client, token, org_id)
        assert response.status_code == 200, response.text
    with engine.begin() as connection:
        # A legacy plaintext row forces startup to rewrite the secret.
        connection.execute(text("UPDATE organization_identity_providers SET client_secret='old'"))
        row_id = connection.scalar(select(table.c.id))

    read = threading.Event()
    resume = threading.Event()

    def pause_after_secret_read(_conn, _cursor, statement, _params, _context, _many):
        """Hold rotation between its read and write to expose the update race.

        Args:
            _conn: The database connection.
            _cursor: The database cursor.
            statement: The executed SQL.
            _params: Bound SQL parameters.
            _context: The SQLAlchemy execution context.
            _many: Whether the operation executes many statements.
        """
        sql = statement.lower()
        if (
            sql.lstrip().startswith("select")
            and "client_secret" in sql
            and "from organization_identity_providers" in sql
        ):
            read.set()
            assert resume.wait(timeout=15), "rotation was never released"

    def rotate():
        """Run the real startup encryption helper in a database transaction."""
        with engine.begin() as connection:
            return reencrypt_stored_secrets(connection, table, table.c.client_secret)

    def change_secret():
        """Update the same provider row using the admin route's row-lock protocol."""
        with engine.begin() as connection:
            connection.execute(text("SET LOCAL application_name='geolibre-secret-admin-test'"))
            connection.execute(select(table.c.id).where(table.c.id == row_id).with_for_update())
            connection.execute(
                update(table).where(table.c.id == row_id).values(client_secret="new-admin-secret")
            )

    event.listen(engine, "after_cursor_execute", pause_after_secret_read)
    try:
        with ThreadPoolExecutor(max_workers=2) as executor:
            rotation = executor.submit(rotate)
            try:
                assert read.wait(timeout=10), "rotation did not read the provider"
                admin = executor.submit(change_secret)
                blocked = False
                deadline = time.monotonic() + 5
                while time.monotonic() < deadline:
                    with engine.connect() as connection:
                        blocked = connection.scalar(
                            text(
                                "SELECT EXISTS (SELECT 1 FROM pg_stat_activity "
                                "WHERE application_name='geolibre-secret-admin-test' "
                                "AND wait_event_type='Lock')"
                            )
                        )
                    if blocked:
                        break
                    time.sleep(0.01)
                assert blocked, "admin update did not wait for rotation's secret-row lock"
            finally:
                resume.set()
            assert rotation.result(timeout=10) == 1
            admin.result(timeout=10)
    finally:
        resume.set()
        event.remove(engine, "after_cursor_execute", pause_after_secret_read)
    with engine.connect() as connection:
        assert connection.scalar(select(table.c.client_secret)) == "new-admin-secret"
