"""Hatchling build hook that bundles the GeoLibre web app into the wheel.

The Python package serves the built GeoLibre single-page app from
``geolibre/static/app``. That directory is produced by the JavaScript build
(``npm run build:embed``) and is intentionally git-ignored, so it must be
materialized at build time. This hook runs the embed build when the assets are
missing (or ``GEOLIBRE_FORCE_JS_BUILD=1`` is set) and the JavaScript sources are
available next to the package (i.e. building from a checkout of the monorepo).
"""

from __future__ import annotations

import os
import subprocess
from pathlib import Path

from hatchling.builders.hooks.plugin.interface import BuildHookInterface

PACKAGE_ROOT = Path(__file__).parent
STATIC_APP = PACKAGE_ROOT / "src" / "geolibre" / "static" / "app"
# The Python package lives at <repo>/python, so the monorepo root is one level up.
REPO_ROOT = PACKAGE_ROOT.parent
BUILD_SCRIPT = REPO_ROOT / "scripts" / "build-embed.mjs"


class CustomBuildHook(BuildHookInterface):
    """Build the embedded web app before packaging the wheel/sdist."""

    def initialize(self, version: str, build_data: dict) -> None:
        force = os.environ.get("GEOLIBRE_FORCE_JS_BUILD") == "1"
        have_assets = (STATIC_APP / "index.html").is_file()

        if have_assets and not force:
            return

        if not BUILD_SCRIPT.is_file():
            if have_assets:
                return
            raise RuntimeError(
                "GeoLibre web assets are missing and the JavaScript build "
                f"script was not found at {BUILD_SCRIPT}. Build the wheel from "
                "a full checkout of the GeoLibre monorepo, or run "
                "`npm run build:embed` first."
            )

        self.app.display_info(
            "Building embedded GeoLibre web app (npm run build:embed)..."
        )
        try:
            subprocess.run(
                ["npm", "run", "build:embed"],
                cwd=REPO_ROOT,
                check=True,
                timeout=600,  # 10 minutes; fail loudly rather than hang pip forever
            )
        except FileNotFoundError as exc:
            raise RuntimeError(
                "npm was not found. Install Node.js and run `npm ci` from the "
                "repository root before building the wheel."
            ) from exc

        if not (STATIC_APP / "index.html").is_file():
            raise RuntimeError(
                "The embed build completed but produced no index.html at "
                f"{STATIC_APP}."
            )
