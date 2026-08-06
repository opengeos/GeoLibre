"""Entry point for ``python -m geolibre.mcp``."""

from __future__ import annotations

from .server import main

if __name__ == "__main__":
    raise SystemExit(main())
