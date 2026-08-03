import time
from unittest.mock import MagicMock, patch

import pytest

from geolibre_server.sedona_ops import SqlTimeout, run_sql


@pytest.fixture
def mock_sedona_db() -> MagicMock:
    with patch("geolibre_server.sedona_ops._import_sedona") as mock_import:
        mock_sedona = MagicMock()
        mock_conn = MagicMock()
        mock_sedona.connect.return_value = mock_conn
        mock_import.return_value = mock_sedona
        yield mock_conn


def test_sql_timeout_graceful_shutdown(
    mock_sedona_db: MagicMock, monkeypatch: pytest.MonkeyPatch
) -> None:
    """
    Test that a SQL query exceeding the timeout raises SqlTimeout,
    but does NOT immediately close the database connection.
    Instead, it should attach a callback to close it when the future finishes.
    """
    # Lower the timeout to 0.1 seconds for the test
    monkeypatch.setattr("geolibre_server.sedona_ops._STATEMENT_TIMEOUT_MS", 100)

    # Mock the execute method to block longer than the timeout
    # We must patch the connection's sql method to block
    def _slow_sql(*_args: object, **_kwargs: object) -> MagicMock:
        time.sleep(0.3)  # Blocks longer than the 0.1s timeout
        mock_df = MagicMock()
        mock_df.limit.return_value.to_pandas.return_value = MagicMock(columns=[])
        return mock_df

    mock_sedona_db.sql = _slow_sql

    with pytest.raises(SqlTimeout, match="timed out"):
        run_sql("SELECT 1")

    # At this exact moment, the TimeoutError was caught and SqlTimeout raised.
    # The background thread is still sleeping (for another 0.2 seconds).
    # We must assert that the connection has NOT been closed yet!
    mock_sedona_db.close.assert_not_called()

    # Wait for the background thread to finish. Poll instead of sleeping a fixed
    # interval: on a loaded CI host the 0.3s sleep can overrun any margin we
    # would pick, which would make the assertion below flaky.
    deadline = time.monotonic() + 5.0
    while time.monotonic() < deadline and not mock_sedona_db.close.called:
        time.sleep(0.01)

    # Now the callback should have fired and closed the connection
    mock_sedona_db.close.assert_called_once()
