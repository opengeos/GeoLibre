// Base layer of CesiumLayerSync: engine handles, dependencies and entry state.
// The class is split across modules as an inheritance chain (base, selection,
// appearance, imagery, entries, then CesiumLayerSync); see cesium-layer-sync.ts.

import type { GeoLibreLayer } from "@geolibre/core";
import type { FeatureCollection } from "geojson";
import { readMapViewFromCamera } from "./cesium-camera";
import type { CogTilerModule } from "./cesium-cog-imagery";
import { MapLibreDrape } from "./cesium-drape";
import type { ZarrCesiumModule } from "./cesium-zarr-imagery";
import type { OpenCopcOptions, LoadEptOptions, LoadLasOptions } from "./cesium-point-cloud";
import { renderFillPatternCanvas } from "./fill-patterns";
import type { ImageryTileFailure } from "./cesium-imagery-tile-health";
import { renderMarkerCanvas } from "./markers";
import type { Header as PMTilesHeader } from "pmtiles";
import type { CesiumWidget } from "@cesium/engine";
import type { LayerEntry } from "./cesium-layer-entry";

type CesiumNs = typeof import("@cesium/engine");

/** The slice of a PMTiles header the raster branch reads. */
export type PMTilesRasterHeader = Pick<
  PMTilesHeader,
  "minZoom" | "maxZoom" | "minLon" | "minLat" | "maxLon" | "maxLat"
>;

/** Injection points for `CesiumLayerSync` (tests, and hosts with their own sources). */
export interface CesiumLayerSyncDeps {
  /** The Cesium Ion token asset layers load with; defaults to the runtime environment's. */
  ionToken?: () => string | undefined;
  /** Loads the COG tiler module; defaults to `import("cog-tiler-wasm")`. */
  loadCogTiler?: () => Promise<CogTilerModule>;
  /** Loads the Zarr imagery module; defaults to `import("zarr-cesium")`. */
  loadZarrCesium?: () => Promise<ZarrCesiumModule>;
  /**
   * Reads a raster PMTiles archive's header; defaults to the shared
   * `pmtiles://` protocol's archive (a range request over HTTP).
   */
  readPMTilesHeader?: (url: string) => Promise<PMTilesRasterHeader | undefined>;
  /**
   * Builds the hidden MapLibre map that drapes tile-backed vector layers
   * (issue #2284); defaults to a real one. `null` means draping is unavailable
   * (no WebGL context to spare), and those layers are reported as errors.
   */
  createDrape?: () => MapLibreDrape | null;
  /** Rasterises one marker sprite; defaults to the 2D map's marker renderer. */
  renderMarker?: typeof renderMarkerCanvas;
  /** Rasterises the fill-pattern tile; defaults to the 2D map's renderer. */
  renderFillPattern?: typeof renderFillPatternCanvas;
  /** Overrides for the COPC reader (the module, the projector, the LAZ decoder). */
  copcOptions?: Omit<OpenCopcOptions, "signal">;
  /** Overrides for the plain LAS/LAZ decoder (the module, the download, the projector). */
  lasOptions?: Omit<LoadLasOptions, "signal" | "fallbackWkt">;
  /** Overrides for the EPT decoder (the module, the fetchers, the projector). */
  eptOptions?: Omit<LoadEptOptions, "signal">;
  /** Materialize a DuckDB query layer's rows into GeoJSON; defaults to the global DuckDB bridge. */
  getDuckDBGeoJson?: (layerId: string) => FeatureCollection | null;
  /** Create an HTMLVideoElement for draped `video` layers; defaults to `document.createElement("video")`. */
  createVideoElement?: () => HTMLVideoElement | null;
  /**
   * Publishes the attribute names read off a tileset's first rendered tile
   * (issue #2290). A 3D Tiles layer has no `layer.geojson` for the Style panel
   * to read property keys from, so the panel's attribute dropdowns stay empty
   * until the names arrive from the tiles themselves. Defaults to writing
   * `metadata.fields`, the same channel `vector-layer-sync` uses for
   * control-managed vector layers; omitted, the discovery is skipped.
   */
  onTilesetFields?: (layerId: string, fields: string[]) => void;
  /**
   * Called when {@link CesiumLayerSync.zoomToLayer} actually starts a flight,
   * which for a layer still loading is later than the request. The engine uses
   * it to stop its terrain correction pulling the flight back (#2878), and only
   * once the camera is really leaving its placement.
   */
  onFlyTo?: () => void;
  /** Called when a flight started by `onFlyTo` completes (not when cancelled). */
  onFlyToComplete?: () => void;
  /**
   * Reports a layer that failed to load, so the app can show it the way the 2D
   * renderers show theirs (the Diagnostics panel). Without this a failure is
   * invisible: the record stays in the Layers panel and the globe simply draws
   * nothing — the shape an Ion asset takes when the account cannot stream it.
   */
  onLayerError?: (error: { layerId: string; layerName: string; message: string }) => void;
  /**
   * Reports one failed imagery tile with the layer's tile tallies so far, so
   * the app can tell a broken URL or a rejected key (every tile fails) from a
   * sparse tile set (some tiles are simply absent). Capped per layer; see
   * `cesium-imagery-tile-health.ts`.
   */
  onTileFailure?: (failure: ImageryTileFailure & { layerId: string; layerName: string }) => void;
}

/**
 * The engine handles, injected dependencies and per-layer entry state shared by
 * every layer of {@link CesiumLayerSync}.
 */
export class CesiumLayerSyncBase {
  protected readonly entries = new Map<string, LayerEntry>();

  /** Active layer list from the current/latest sync pass. */
  protected currentLayers: GeoLibreLayer[] = [];

  /**
   * @param readZoom Supplies the camera's MapLibre zoom for `["zoom"]` filters;
   *   defaults to reading the live camera and is injectable for tests.
   */
  constructor(
    protected readonly Cesium: CesiumNs,
    protected readonly viewer: CesiumWidget,
    private readonly readZoom: () => number = () => readMapViewFromCamera(Cesium, viewer).zoom,
    protected readonly deps: CesiumLayerSyncDeps = {},
  ) {}

  protected destroyed = false;

  /** The camera's integer MapLibre zoom, as `["zoom"]` filters evaluate at integer levels. */
  protected cameraZoom(): number {
    try {
      const zoom = this.readZoom();
      return Number.isFinite(zoom) ? Math.floor(zoom) : 0;
    } catch {
      return 0;
    }
  }

  /** Whether the globe draws a terrain surface rather than the bare ellipsoid. */
  protected globeHasTerrain(): boolean {
    const Ellipsoid = this.Cesium.EllipsoidTerrainProvider;
    return !Ellipsoid || !(this.viewer.terrainProvider instanceof Ellipsoid);
  }

  protected readonly storyOpacities = new Map<
    string,
    { originalOpacity: number; currentOpacity: number }
  >();

  protected effectiveOpacity(entry: LayerEntry): number {
    const override = this.storyOpacities.get(entry.layer.id);
    return override !== undefined ? override.currentOpacity : entry.layer.opacity;
  }
}
