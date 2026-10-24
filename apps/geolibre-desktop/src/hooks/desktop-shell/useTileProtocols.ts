import { useAppStore } from "@geolibre/core";
import { useEffect } from "react";
import { registerKmlSuperOverlayProtocol } from "../../lib/kml-super-overlay";
import { registerMbtilesProtocol } from "../../lib/mbtiles";
import {
  registerPostgisTilesProtocol,
  releasePostgisTilesConnections,
} from "../../lib/postgis-tiles";
import { postgisTilesConnectionLabels } from "../../lib/postgis-tiles-url";
import { registerTilePackageProtocol } from "../../lib/tilepackage";
import { isTauri } from "../../lib/tauri-io";
import { registerXyzTileProtocol } from "../../lib/xyz-url";

/** Registers the app's custom MapLibre tile protocols once. */
export function useTileProtocols(): void {
  useEffect(() => {
    // Registered unconditionally, not on first import: a saved project's KML
    // Super-Overlay tile URLs must resolve in a session that only reopens it,
    // which is exactly when nothing has called registerKmlSuperOverlay yet.
    void registerKmlSuperOverlayProtocol();
    // MBTiles also run in the browser (sql.js), so its protocol is not
    // desktop-gated; a reopened project then gets a clear "add it again" tile
    // error instead of an unknown-protocol failure.
    registerMbtilesProtocol();
    // A reopened project's VTPK/TPKX layers read through the same protocol, so
    // it is registered up front too. Its reader is a lazy chunk, fetched here
    // long before a project can finish opening; a failed load only means the
    // tile packages are skipped until the next Add Data attempt retries it.
    registerTilePackageProtocol().catch((error: unknown) => {
      console.warn("Could not load the tile package reader", error);
    });
    if (!isTauri()) return;
    // A reopened project's PostGIS tile layers resolve their connection from
    // the saved list, so the protocol must exist before any Add Data visit.
    registerPostgisTilesProtocol();
    registerXyzTileProtocol();

    // Close a database's tile pool once its last layer is gone.
    let inUse = postgisTilesConnectionLabels(useAppStore.getState().layers);
    return useAppStore.subscribe((state, previous) => {
      if (state.layers === previous.layers) return;
      const next = postgisTilesConnectionLabels(state.layers);
      releasePostgisTilesConnections([...inUse].filter((label) => !next.has(label)));
      inUse = next;
    });
  }, []);
}
