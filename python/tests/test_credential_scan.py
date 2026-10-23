"""Tests for the credential scan that gates wheel and sdist packaging.

The scanner in ``hatch_build`` is the only guard covering the path where staged
assets already exist and no JavaScript runs, so it needs coverage of its own
rather than relying on ``tests/credential-scan.test.ts`` exercising the JS twin.
The last test pins the two implementations to the same results.

Every fixture here is a synthetic value shaped like a real token -- never a live
credential.
"""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import pytest
from hatch_build import PATTERNS_FILE, scan_for_credentials

REPO_ROOT = Path(__file__).resolve().parents[2]
JS_SCANNER = REPO_ROOT / "scripts" / "scan-credentials.mjs"

GOOGLE_KEY = "AIza" + "A" * 35
GOOGLE_KEY_TRAILING_DASH = "AIza" + "A" * 34 + "-"


def write(tmp_path: Path, files: dict[str, str]) -> Path:
    """Writes files into a directory and returns it.

    Args:
        tmp_path: Directory to populate.
        files: Mapping of relative path to file contents.

    Returns:
        The populated directory.
    """
    for name, content in files.items():
        target = tmp_path / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8")
    return tmp_path


def test_clean_bundle_reports_nothing(tmp_path: Path) -> None:
    """A bundle with no credentials produces no findings."""
    assert scan_for_credentials(write(tmp_path, {"assets/app.js": "const a=1;"})) == []


def test_catches_inlined_env_object(tmp_path: Path) -> None:
    """The whole-object env shape Vite inlines is caught by name."""
    bundle = (
        f'{{PROD:!0,VITE_GOOGLE_MAPS_API_KEY:"{GOOGLE_KEY}",'
        'VITE_PROTOMAPS_API_KEY:"52c129d45874742d"}}'
    )
    findings = scan_for_credentials(write(tmp_path, {"assets/ClerkGate-abc.js": bundle}))
    assert any("VITE_GOOGLE_MAPS_API_KEY" in f for f in findings)
    # A value matching no token shape must still be caught by its name.
    assert any("VITE_PROTOMAPS_API_KEY" in f for f in findings)


def test_catches_google_key_ending_in_dash(tmp_path: Path) -> None:
    """A trailing `-` must not let a Google key slip past the anchor.

    A `\\b` here would fail: `-` is not a word character, so no boundary exists
    between it and a following quote.
    """
    findings = scan_for_credentials(write(tmp_path, {"a.js": f'k="{GOOGLE_KEY_TRAILING_DASH}"'}))
    assert len(findings) == 1, findings


def test_masks_values(tmp_path: Path) -> None:
    """Findings identify a secret without reprinting it."""
    findings = scan_for_credentials(write(tmp_path, {"a.js": f'k="{GOOGLE_KEY}"'}))
    assert len(findings) == 1
    assert GOOGLE_KEY not in findings[0]
    assert "(39 chars)" in findings[0]


def test_empty_value_does_not_fire(tmp_path: Path) -> None:
    """`""` is what a correctly stripped build emits and must not trip."""
    bundle = 'const e={VITE_CESIUM_TOKEN:"",VITE_MAPBOX_ACCESS_TOKEN:""}'
    assert scan_for_credentials(write(tmp_path, {"a.js": bundle})) == []


def test_ignores_non_scannable_files(tmp_path: Path) -> None:
    """Binary asset types are skipped."""
    assert scan_for_credentials(write(tmp_path, {"assets/x.wasm": GOOGLE_KEY})) == []


def test_missing_patterns_file_fails_closed(tmp_path: Path, monkeypatch) -> None:
    """A missing definitions file must raise, not report a clean scan."""
    missing = tmp_path / "nope.json"
    monkeypatch.setattr("hatch_build.PATTERNS_FILE", missing)
    monkeypatch.setattr("hatch_build.VENDORED_PATTERNS_FILE", missing)
    with pytest.raises(RuntimeError, match="credential-pattern definitions"):
        scan_for_credentials(write(tmp_path, {"a.js": "const a=1;"}))


def test_allowlisted_vendor_token_is_not_reported(tmp_path: Path) -> None:
    """A hash-allowlisted vendor token must not fire.

    Without this, CesiumJS's built-in Ion token would be reported on every
    release and the guard would end up switched off.
    """
    config = json.loads(PATTERNS_FILE.read_text(encoding="utf-8"))
    cesium = REPO_ROOT / "node_modules" / "cesium" / "Build" / "Cesium" / "Cesium.js"
    if not config.get("allowedValueHashes") or not cesium.is_file():
        pytest.skip("cesium not installed")
    import re

    match = re.search(r"\beyJhbGciOi[A-Za-z0-9._-]{30,}", cesium.read_text(errors="ignore"))
    assert match, "expected CesiumJS to still ship a default Ion token"
    assert scan_for_credentials(write(tmp_path, {"assets/c.js": f'var t="{match[0]}"'})) == []


@pytest.mark.skipif(shutil.which("node") is None, reason="node not available")
def test_matches_the_javascript_scanner(tmp_path: Path) -> None:
    """Both scanners must report identically for the same input.

    They read the same definitions file; this pins the two implementations of
    those definitions together so a regex that behaves differently under Python
    `re` and JavaScript `RegExp` cannot pass unnoticed.
    """
    bundle = (
        f'{{VITE_GOOGLE_MAPS_API_KEY:"{GOOGLE_KEY}",'
        f'VITE_CESIUM_TOKEN:"",VITE_STADIA_API_KEY:"stadia-abcdef0123456789"}}'
        f'\nvar d="{GOOGLE_KEY_TRAILING_DASH}";'
    )
    target = write(tmp_path, {"assets/app.js": bundle, "assets/skip.wasm": GOOGLE_KEY})

    python_findings = scan_for_credentials(target)
    result = subprocess.run(
        ["node", str(JS_SCANNER), str(target)],
        capture_output=True,
        text=True,
        check=False,
    )
    js_findings = sorted(
        line.strip()[2:] for line in result.stderr.splitlines() if line.startswith("  - ")
    )

    assert python_findings, "fixture should produce findings"
    assert python_findings == js_findings, (
        f"scanners disagree\npython: {python_findings}\njs:     {js_findings}"
    )
