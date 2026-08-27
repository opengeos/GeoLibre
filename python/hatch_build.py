"""Hatchling build hook that bundles the GeoLibre web app into the wheel.

The Python package serves the built GeoLibre single-page app from
``geolibre/static/app``. That directory is produced by the JavaScript build
(``npm run build:embed``) and is intentionally git-ignored, so it must be
materialized at build time. This hook runs the embed build when the assets are
missing (or ``GEOLIBRE_FORCE_JS_BUILD=1`` is set) and the JavaScript sources are
available next to the package (i.e. building from a checkout of the monorepo).

It then scans the staged assets for credentials before packaging. That scan is
the load-bearing one, because of the early-return path below: when the assets are
already present and ``GEOLIBRE_FORCE_JS_BUILD`` is unset, a ``python -m build``
packages whatever ``static/app`` an earlier local ``npm run build:embed`` left
behind. No JavaScript runs at all on that path, so a guard living only in
``scripts/build-embed.mjs`` would never fire. This one runs on every build, fresh
or stale, and needs no Node.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
from pathlib import Path

try:
    from hatchling.builders.hooks.plugin.interface import BuildHookInterface
except ModuleNotFoundError:  # pragma: no cover - always present during a build
    # Only the build backend needs hatchling. Degrading here keeps the credential
    # scanner below importable on its own, so python/tests can exercise it
    # against the same fixtures as tests/credential-scan.test.ts.
    BuildHookInterface = object  # type: ignore[assignment, misc]

PACKAGE_ROOT = Path(__file__).parent
STATIC_APP = PACKAGE_ROOT / "src" / "geolibre" / "static" / "app"
# The Python package lives at <repo>/python, so the monorepo root is one level up.
REPO_ROOT = PACKAGE_ROOT.parent
BUILD_SCRIPT = REPO_ROOT / "scripts" / "build-embed.mjs"
# Shared with scripts/scan-credentials.mjs so the JS and Python scanners cannot
# drift. Ships inside the sdist (see [tool.hatch.build.targets.sdist] force-include)
# so an sdist -> wheel build is gated too.
PATTERNS_FILE = REPO_ROOT / "scripts" / "credential-patterns.json"
VENDORED_PATTERNS_FILE = PACKAGE_ROOT / "credential-patterns.json"


def _mask(value: str) -> str:
    """Masks a secret so build logs identify it without republishing it.

    Args:
        value: The matched secret.

    Returns:
        A redacted but recognizable form of the secret.
    """
    if len(value) <= 12:
        return f"{value[:2]}***"
    return f"{value[:6]}...{value[-4:]} ({len(value)} chars)"


def _load_patterns() -> dict:
    """Loads the shared credential-pattern definitions.

    Returns:
        The parsed definitions.

    Raises:
        RuntimeError: If neither copy of the definitions can be found. This is
            deliberately fatal: returning "no patterns" would make the scan pass
            silently, which is indistinguishable in the build log from a genuine
            clean scan and is the opposite of the fail-closed intent.
    """
    for candidate in (PATTERNS_FILE, VENDORED_PATTERNS_FILE):
        if candidate.is_file():
            return json.loads(candidate.read_text(encoding="utf-8"))
    raise RuntimeError(
        "The credential-pattern definitions were not found at "
        f"{PATTERNS_FILE} or {VENDORED_PATTERNS_FILE}, so the bundled app cannot "
        "be checked before packaging. Build from a full checkout of the GeoLibre "
        "monorepo, or restore the sdist's vendored copy (see "
        "[tool.hatch.build.targets.sdist.force-include] in pyproject.toml)."
    )


def scan_for_credentials(directory: Path) -> list[str]:
    """Scans built assets for credentials that must not be redistributed.

    Mirrors ``scanForCredentials`` in scripts/scan-credentials.mjs, reading the
    same pattern definitions so the two cannot diverge.

    Args:
        directory: The staged asset directory to scan.

    Returns:
        Sorted, unique, masked findings; empty when the directory is clean.
    """
    config = _load_patterns()

    scannable = set(config["scannableExtensions"])
    allowed = set(config.get("allowedValueHashes", {}))

    def is_allowed(value: str) -> bool:
        """Whether a match is a known public vendor token rather than ours."""
        return hashlib.sha256(value.encode("utf-8")).hexdigest() in allowed

    patterns = [(p["name"], re.compile(p["regex"])) for p in config["patterns"]]
    # `VITE_FOO:"value"` / `VITE_FOO="value"` with a non-empty value. An empty
    # string is what a correctly stripped build emits and must not trip this.
    assigned = re.compile(
        r"\b(" + "|".join(config["credentialEnvNames"]) + r")\b\s*[:=]\s*[\"'`]([^\"'`]+)[\"'`]"
    )

    findings: set[str] = set()
    for path in sorted(directory.rglob("*")):
        if not path.is_file() or path.suffix not in scannable:
            continue
        text = path.read_text(encoding="utf-8", errors="ignore")
        rel = path.relative_to(directory)
        for name, pattern in patterns:
            for match in pattern.finditer(text):
                if is_allowed(match.group(0)):
                    continue
                findings.add(f"{rel}: {name} {_mask(match.group(0))}")
        for match in assigned.finditer(text):
            if is_allowed(match.group(2)):
                continue
            findings.add(f"{rel}: {match.group(1)} = {_mask(match.group(2))}")
    return sorted(findings)


class CustomBuildHook(BuildHookInterface):
    """Build the embedded web app before packaging the wheel/sdist."""

    def initialize(self, version: str, build_data: dict) -> None:
        self._materialize_assets()
        self._assert_no_credentials()

    def _assert_no_credentials(self) -> None:
        """Refuses to package assets carrying a redistributable credential.

        Runs on every build, including the early-return path where the staged
        assets came from an earlier local build and no JavaScript ran -- the path
        a JS-side guard cannot cover.

        Raises:
            RuntimeError: If any credential is found in the staged assets.
        """
        if not STATIC_APP.is_dir():
            return
        findings = scan_for_credentials(STATIC_APP)
        if not findings:
            self.app.display_info("Credential scan clean.")
            return
        listed = "\n".join(f"  - {f}" for f in findings)
        raise RuntimeError(
            f"Refusing to package: {len(findings)} credential(s) found in {STATIC_APP}.\n"
            f"{listed}\n\n"
            "The wheel is redistributed, so it must not carry your keys. This is\n"
            "usually a stale static/app from an earlier local `npm run build:embed`\n"
            "that absorbed your shell's GOOGLE_MAPS_API_KEY / MAPBOX_TOKEN /\n"
            "CESIUM_TOKEN exports. Rebuild with GEOLIBRE_FORCE_JS_BUILD=1, or\n"
            "delete the directory and rerun. Wheel users supply their own tokens at\n"
            "runtime via Settings -> Environment variables."
        )

    def _materialize_assets(self) -> None:
        """Builds the embedded web app when the staged assets are missing or stale.

        Raises:
            RuntimeError: If the assets cannot be produced.
        """
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

        self.app.display_info("Building embedded GeoLibre web app (npm run build:embed)...")
        try:
            subprocess.run(
                ["npm", "run", "build:embed"],
                cwd=REPO_ROOT,
                check=True,
                shell=os.name == "nt",
                timeout=600,  # 10 minutes; fail loudly rather than hang pip forever
            )
        except FileNotFoundError as exc:
            raise RuntimeError(
                "npm was not found. Install Node.js and run `npm ci` from the "
                "repository root before building the wheel."
            ) from exc

        if not (STATIC_APP / "index.html").is_file():
            raise RuntimeError(
                f"The embed build completed but produced no index.html at {STATIC_APP}."
            )
