"""Container-only capability enforcement for the normalized sidecar URI."""

import json
import os
import sys
from pathlib import Path

# Any one owning capability grants the entire route prefix. Conversion is also
# polled by raster jobs and used when adding data, so both owners must work.
ROUTE_CAPABILITIES = {
    "whitebox": frozenset({"processing:run"}),
    "raster": frozenset({"processing:run"}),
    "vector": frozenset({"processing:run"}),
    "pointcloud": frozenset({"processing:run"}),
    "ml": frozenset({"processing:run"}),
    "sql": frozenset({"processing:run"}),
    "postgis": frozenset({"data:add"}),
    "mssql": frozenset({"data:add"}),
    "conversion": frozenset({"processing:run", "data:add"}),
}

# Explicit exceptions checked against FastAPI's routes by the backend suite.
# These retain their existing behavior whenever the sidecar is running.
UNGUARDED_PREFIXES = frozenset(
    {
        "health",
        "algorithms",
        "shutdown",
        "run",
        "docs",
        "redoc",
        "openapi.json",
    }
)

_DENY = (
    "    default_type application/json;\n"
    '    return 403 \'{"detail":"Sidecar disabled by deployment policy"}\';\n'
    "    types {}\n"
)


def generate_snippets(policy, disabled=False):
    """Return (prefix guards, whole-sidecar off directives, should start)."""
    capabilities = policy.get("capabilities")
    # Omitted means unrestricted; [] is an explicit empty grant.
    granted = (
        frozenset().union(*ROUTE_CAPABILITIES.values())
        if capabilities is None
        else frozenset(capabilities)
    )
    start = not disabled and any(granted & required for required in ROUTE_CAPABILITIES.values())
    guards = "# Generated sidecar capability guards.\n"
    for prefix, required in ROUTE_CAPABILITIES.items():
        if not granted & required:
            # nginx matches its normalized URI (percent decoding and slash
            # merging), not $request_uri. ^~ also defeats static-asset regexes.
            guards += f"location ^~ /sidecar/{prefix} {{\n{_DENY}}}\n"
    off = "# Generated whole-sidecar switch.\n" + ("" if start else _DENY)
    return guards, off, start


def main(argv):
    if len(argv) != 2:
        print("usage: sidecar_policy.py <deployment-policy-path>", file=sys.stderr)
        return 2
    with open(argv[1], encoding="utf-8") as source:
        policy = json.load(source)
    guards, off, start = generate_snippets(
        policy, disabled=os.environ.get("GEOLIBRE_DISABLE_SIDECAR") == "1"
    )
    directory = Path("/etc/nginx")
    (directory / "geolibre-sidecar-guards.conf").write_text(guards, encoding="utf-8")
    (directory / "geolibre-sidecar-off.conf").write_text(off, encoding="utf-8")
    print(f"SIDECAR_START={int(start)}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
