import { addProtocol, config } from "maplibre-gl";
import { FileSource, PMTiles, Protocol } from "pmtiles";
import { PMTILES_PROTOCOL, remotePMTilesArchive } from "./pmtiles-layer";

// The process-wide `pmtiles://` archive registry.
//
// One `pmtiles` Protocol instance (kept on globalThis so it survives HMR) owns
// every archive the app has opened, remote or in-memory, and is registered
// with `maplibregl.addProtocol`. MapLibre's layer sync draws through it, and
// the renderers without a MapLibre map (the Cesium globe, the ArcGIS SDK) read
// archive headers and tiles from the same instance, so an archive is opened
// once whichever engine asks first.

const PMTILES_PROTOCOL_GLOBAL_KEY = "__geolibrePMTilesProtocol";
const PMTILES_ARCHIVE_KEYS_GLOBAL_KEY = "__geolibrePMTilesArchiveKeys";

/**
 * Registers the shared protocol with MapLibre (again, if `setStyle()` cleared
 * it) and makes sure an archive is available for `url`, opening a remote one
 * when none is registered under its key.
 *
 * @param url A bare `https://…` URL or a `pmtiles://…` URL.
 */
export function ensurePMTilesProtocol(url: string): void {
  const protocol = getSharedPMTilesProtocol();

  // Register the same instance we add archives to so MapLibre routes tile
  // requests through it. isMapLibreProtocolRegistered() reflects MapLibre's
  // live state, so this also re-registers after setStyle() clears protocols.
  if (!isMapLibreProtocolRegistered()) {
    addProtocol(PMTILES_PROTOCOL, protocol.tile);
  }

  // A key may already be backed by an in-memory archive from
  // registerPMTilesArchive(); re-adding would silently replace it with a
  // FetchSource for a URL that does not exist.
  const key = stripPMTilesProtocol(url);
  if (!protocol.tiles.has(key)) {
    protocol.add(remotePMTilesArchive(key));
  }
}

/**
 * Registers an in-memory PMTiles archive (e.g. an offline basemap extract)
 * under a synthetic key so store layers can reference it like any remote
 * archive. Returns the `pmtiles://<key>` URL to use as the layer's
 * `source.url` / `sourcePath`.
 *
 * Re-registering the same key replaces the previous bytes. The archive is
 * freed when its layer is removed (see {@link unregisterPMTilesArchive},
 * invoked from `removeLayerFromMap` in layer-sync), so repeated
 * extract-and-remove cycles don't pin every archive's bytes for the page
 * session.
 */
export function registerPMTilesArchive(key: string, bytes: Uint8Array): string {
  const protocol = getSharedPMTilesProtocol();
  if (!isMapLibreProtocolRegistered()) {
    addProtocol(PMTILES_PROTOCOL, protocol.tile);
  }
  const name = stripPMTilesProtocol(key);
  const file = new File([bytes as BlobPart], name, {
    type: "application/octet-stream",
  });
  // Keyed explicitly (not via protocol.add) so the lookup key is exactly the
  // name embedded in the layer URL, independent of FileSource.getKey().
  protocol.tiles.set(name, new PMTiles(new FileSource(file)));
  getRegisteredPMTilesArchiveKeys().add(name);
  return `${PMTILES_PROTOCOL}://${name}`;
}

/**
 * Frees an in-memory archive registered by {@link registerPMTilesArchive}.
 *
 * Only keys this module registered are removed, so passing a remote
 * `pmtiles://` URL (a lightweight `FetchSource` that may be shared by other
 * layers) is a safe no-op. Returns whether an archive was actually removed.
 */
export function unregisterPMTilesArchive(key: string): boolean {
  const name = stripPMTilesProtocol(key);
  const registered = getRegisteredPMTilesArchiveKeys();
  if (!registered.has(name)) return false;
  registered.delete(name);
  return getSharedPMTilesProtocol().tiles.delete(name);
}

/** Whether an in-memory archive was registered under `key` this session — lets
 * a caller decide between reusing it and reloading its bytes from disk. */
export function hasPMTilesArchive(key: string): boolean {
  return getRegisteredPMTilesArchiveKeys().has(stripPMTilesProtocol(key));
}

/**
 * Ensures the `pmtiles://` protocol is registered with MapLibre and a *remote*
 * archive at `url` is available to it, backed by a lightweight FetchSource over
 * HTTP range requests. Needed when a basemap *style* (not a store layer)
 * references `pmtiles://<remote-url>` — the layer-sync path that normally
 * registers the protocol never runs for a raw style. Idempotent and safe to
 * call before the style is applied; accepts a bare `https://…` URL or a
 * `pmtiles://…` URL.
 */
export function ensureRemotePMTilesArchive(url: string): void {
  ensurePMTilesProtocol(url);
}

/**
 * The `PMTiles` archive registered for `url` (a bare `https://…` or a
 * `pmtiles://…` URL), registering a remote one on first use. The globe's raster
 * PMTiles path reads the header (zoom range, bounds) off it so its imagery
 * provider only requests tiles the archive can answer.
 */
export function getPMTilesArchive(url: string): PMTiles | undefined {
  ensurePMTilesProtocol(url);
  return getSharedPMTilesProtocol().tiles.get(stripPMTilesProtocol(url));
}

// The set of in-memory-archive keys lives on globalThis alongside the shared
// Protocol, so the two share a lifetime across module reloads (HMR) and never
// drift — a stale module-level set could otherwise refuse to free archives the
// live protocol still holds.
function getRegisteredPMTilesArchiveKeys(): Set<string> {
  const globalScope = globalThis as typeof globalThis & {
    [PMTILES_ARCHIVE_KEYS_GLOBAL_KEY]?: Set<string>;
  };
  if (!globalScope[PMTILES_ARCHIVE_KEYS_GLOBAL_KEY]) {
    globalScope[PMTILES_ARCHIVE_KEYS_GLOBAL_KEY] = new Set<string>();
  }
  return globalScope[PMTILES_ARCHIVE_KEYS_GLOBAL_KEY];
}

function getSharedPMTilesProtocol(): Protocol {
  const globalScope = globalThis as typeof globalThis & {
    [PMTILES_PROTOCOL_GLOBAL_KEY]?: Protocol;
  };
  if (!globalScope[PMTILES_PROTOCOL_GLOBAL_KEY]) {
    globalScope[PMTILES_PROTOCOL_GLOBAL_KEY] = new Protocol();
  }
  return globalScope[PMTILES_PROTOCOL_GLOBAL_KEY];
}

function isMapLibreProtocolRegistered(): boolean {
  return Boolean(
    (
      config as {
        REGISTERED_PROTOCOLS?: Record<string, unknown>;
      }
    ).REGISTERED_PROTOCOLS?.[PMTILES_PROTOCOL],
  );
}

function stripPMTilesProtocol(url: string): string {
  return url.startsWith(`${PMTILES_PROTOCOL}://`)
    ? url.slice(`${PMTILES_PROTOCOL}://`.length)
    : url;
}
