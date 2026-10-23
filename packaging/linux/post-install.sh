#!/bin/sh
# Refresh the shared-mime-info and desktop caches so the .geolibre association
# resolves without a session restart. Both are best effort: a minimal image may
# ship neither tool, and neither is worth failing an install over.
set -e

if command -v update-mime-database >/dev/null 2>&1; then
    update-mime-database /usr/share/mime || true
fi

if command -v update-desktop-database >/dev/null 2>&1; then
    update-desktop-database /usr/share/applications || true
fi

exit 0
