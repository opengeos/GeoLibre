"""GeoLibre Python processing sidecar."""

# Kept equal to ``version`` in pyproject.toml (tests/test_security.py checks it).
# Read from here rather than package metadata because the desktop app runs the
# sidecar from its bundled source tree, which is never pip-installed.
__version__ = "1.0.0"
