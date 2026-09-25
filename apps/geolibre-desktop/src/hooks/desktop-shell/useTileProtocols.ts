import { useEffect } from "react";
import { registerKmlSuperOverlayProtocol } from "../../lib/kml-super-overlay";
import { registerMbtilesProtocol } from "../../lib/mbtiles";
import { isTauri } from "../../lib/tauri-io";
import { registerXyzTileProtocol } from "../../lib/xyz-url";

/** Registers the app's custom MapLibre tile protocols once. */
export function useTileProtocols(): void {
  useEffect(() => {
    // Registered unconditionally, not on first import: a saved project's KML
    // Super-Overlay tile URLs must resolve in a session that only reopens it,
    // which is exactly when nothing has called registerKmlSuperOverlay yet.
    void registerKmlSuperOverlayProtocol();
    if (isTauri()) {
      registerMbtilesProtocol();
      registerXyzTileProtocol();
    }
  }, []);
}
