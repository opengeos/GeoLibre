// MapController layer: terrain source, COG DEM terrain and the terrain control.
// MapController is split by concern across an inheritance chain, one layer per
// module: base <- terrain <- controls <- style <- layers <- highlight <-
// MapController; see map-controller.ts.

import * as maplibregl from "maplibre-gl";
import { TerrainControl, DEFAULT_TERRAIN_EXAGGERATION } from "./terrain-control";
import {
  registerCogDemSource,
  type CogDemFallback,
  type CogDemSourceRegistration,
} from "./cog-dem-source";
import { createTerrariumFallback } from "./terrarium-fallback";
import { MapControllerBase } from "./map-controller-base";

const TERRAIN_SOURCE_ID = "geolibre-terrain-dem";

const DEFAULT_TERRAIN_SOURCE: maplibregl.RasterDEMSourceSpecification = {
  type: "raster-dem",
  tiles: ["https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"],
  tileSize: 256,
  maxzoom: 15,
  encoding: "terrarium",
  attribution:
    'Elevation tiles by <a href="https://registry.opendata.aws/terrain-tiles/">AWS Open Data Terrain Tiles</a>',
};

/**
 * Window event dispatched when the terrain control is double-clicked, so the
 * React layer can open the vertical-exaggeration dialog. The controller lives
 * outside React, so it signals through a window event rather than a callback.
 *
 * These terrain events are dispatched on `window` (not scoped to a controller
 * instance), so they assume a single terrain-enabled map: only the primary pane
 * enables the terrain control today (secondary panes never override the default
 * `terrain: false`), and one dialog — bound to the primary controller — listens.
 * A future secondary-pane terrain control would need the event scoped to its
 * originating controller.
 */
export const TERRAIN_SETTINGS_EVENT = "geolibre:terrain-settings-open";

/**
 * MapController layer: the terrain source and control, COG DEM terrain, the
 * fill-outside fallback and exaggeration.
 */
export class MapControllerTerrain extends MapControllerBase {
  private terrainControl: TerrainControl | null = null;

  private terrainSource: maplibregl.RasterDEMSourceSpecification = DEFAULT_TERRAIN_SOURCE;

  protected cogDemRegistration: CogDemSourceRegistration | null = null;

  private cogDemUrl: string | null = null;

  protected cogDemGeneration = 0;

  /** Fill outside a custom COG DEM from the global terrain; see setTerrainFillOutside. */
  private terrainFillOutside = false;

  /** Bumped by each explicit fill change; see setTerrainCogSource. */
  private terrainFillGeneration = 0;

  private terrainFallback: CogDemFallback | null = null;

  // Seam for tests: opening a COG needs a real GeoTIFF over the network, which
  // the generation-guard tests in setTerrainCogSource have no use for.
  private openCogDem: typeof registerCogDemSource = registerCogDemSource;

  private terrainExaggeration = DEFAULT_TERRAIN_EXAGGERATION;

  // Undefined until the React layer supplies a translated label; the control
  // falls back to its own default in the meantime (single source for the string).
  private terrainLabel: string | undefined;

  // Set when the Terrain control is switched on before the basemap style is
  // ready (no DEM source yet, so setEnabled would have nothing to point at).
  // handleStyleReady reconciles it once the source lands so the toggle isn't
  // silently dropped; cleared whenever terrain is turned off.
  protected terrainEnablePending = false;

  protected addTerrainSource(): boolean {
    // Terrain tiles are Web Mercator, and a custom CRS map is flat.
    if (!this.map || !this.isStyleReady() || this.activeCrs) {
      return false;
    }
    if (this.map.getSource(TERRAIN_SOURCE_ID)) return true;
    this.map.addSource(TERRAIN_SOURCE_ID, this.terrainSource);
    return true;
  }

  protected addTerrainControl(): boolean {
    if (!this.map || this.terrainControl || !this.controlVisibility.terrain) {
      return false;
    }
    this.addTerrainSource();
    this.terrainControl = new TerrainControl({
      source: TERRAIN_SOURCE_ID,
      exaggeration: this.terrainExaggeration,
      label: this.terrainLabel,
      // Double-clicking the button asks the React layer to open the
      // vertical-exaggeration dialog (see TERRAIN_SETTINGS_EVENT).
      onOpenSettings: () => {
        window.dispatchEvent(new CustomEvent(TERRAIN_SETTINGS_EVENT));
      },
    });
    this.map.addControl(this.terrainControl, this.controlPositions.terrain);
    return true;
  }

  /**
   * Turn 3D terrain on for the current control, deferring until the DEM source
   * exists when the style is still loading. Called when the Terrain control is
   * switched on so relief appears without a second click; the pending flag is
   * reconciled by handleStyleReady once the source lands.
   */
  protected autoEnableTerrain(): void {
    if (!this.terrainControl) return;
    if (this.map?.getSource(TERRAIN_SOURCE_ID)) {
      this.terrainControl.setEnabled(true);
      this.terrainEnablePending = false;
    } else {
      this.terrainEnablePending = true;
    }
  }

  /** Whether GeoLibre's built-in 3D terrain is currently active. */
  isTerrainEnabled(): boolean {
    return this.map?.getTerrain()?.source === TERRAIN_SOURCE_ID;
  }

  /** The custom HTTP COG DEM URL, or null for a local file / built-in terrain. */
  getTerrainCogSource(): string | null {
    return this.cogDemUrl;
  }

  /** Whether terrain is backed by either a local or HTTP COG DEM. */
  hasCustomTerrainSource(): boolean {
    return this.cogDemRegistration !== null;
  }

  /**
   * Replace the built-in global terrain with a DEM read directly from a COG.
   * Passing null restores the default AWS Terrarium source. The COG is opened
   * and validated before the active terrain is disturbed, so a bad URL leaves
   * the currently working source in place.
   *
   * Resolves true once the source is applied, and false when a later call has
   * already superseded this one — including when that later call failed, since
   * the source the user asked for most recently is the one that decides what
   * happens, and quietly loading an earlier pick behind a visible error would
   * be the greater surprise. Concurrent callers can tell the two apart.
   */
  async setTerrainCogSource(
    source: string | Blob | null,
    band = 1,
    options: { fillOutside?: boolean } = {},
  ): Promise<boolean> {
    const normalizedSource = typeof source === "string" ? source.trim() || null : source;
    const generation = ++this.cogDemGeneration;
    const fillGeneration = this.terrainFillGeneration;
    let registration: CogDemSourceRegistration | null = null;
    try {
      registration = normalizedSource ? await this.openCogDem(normalizedSource, band) : null;
    } catch (error) {
      // A superseded request's failure is as stale as its success would be:
      // reporting it would let an older pick put an error over the source the
      // user actually chose last.
      if (generation === this.cogDemGeneration) throw error;
      return false;
    }
    // A slower, older request must not replace a source selected after it.
    if (generation !== this.cogDemGeneration) {
      registration?.dispose();
      return false;
    }

    const wasEnabled = this.isTerrainEnabled();
    if (wasEnabled) {
      if (this.terrainControl) this.terrainControl.setEnabled(false);
      else this.map?.setTerrain(null);
    }
    if (this.map?.getSource(TERRAIN_SOURCE_ID)) this.map.removeSource(TERRAIN_SOURCE_ID);

    // Only now that the DEM has opened: a failed open leaves the working DEM
    // and its fill exactly as they were.
    // A fill set explicitly while the DEM was opening is newer than this one.
    if (options.fillOutside !== undefined && fillGeneration === this.terrainFillGeneration) {
      this.terrainFillOutside = options.fillOutside;
    }
    const previous = this.cogDemRegistration;
    this.cogDemRegistration = registration;
    this.cogDemUrl = typeof normalizedSource === "string" ? normalizedSource : null;
    registration?.setFallback?.(this.terrainFillOutside ? this.globalTerrainFallback() : null);
    this.terrainSource = this.cogTerrainSourceSpec(registration);
    previous?.dispose();

    if (this.map && this.isStyleReady()) this.addTerrainSource();
    // A style reload that started while the COG was opening leaves both calls
    // bailing on their own style guard, which would drop terrain until the user
    // toggled it again. Defer to handleStyleReady the way autoEnableTerrain
    // does so it comes back on its own.
    if (wasEnabled && !this.setTerrainEnabled(true) && this.terrainControl) {
      this.terrainEnablePending = true;
    }
    return true;
  }

  /** Whether a custom COG DEM is surrounded by the global terrain. */
  getTerrainFillOutside(): boolean {
    return this.terrainFillOutside;
  }

  /**
   * Fill the area outside a custom COG DEM, and its nodata, with the global
   * terrain, so the DEM does not stand as a raised block with vertical walls
   * (#3470). Off, the DEM is drawn alone over a flat 0 m surface, with no
   * requests to the global tiles. Applies to the current DEM at once and is
   * remembered for the next one.
   *
   * @param fill - Whether to fill outside the DEM.
   */
  setTerrainFillOutside(fill: boolean): void {
    this.terrainFillGeneration += 1;
    if (fill === this.terrainFillOutside) return;
    this.terrainFillOutside = fill;
    const registration = this.cogDemRegistration;
    if (!registration) return;
    registration.setFallback?.(fill ? this.globalTerrainFallback() : null);
    // The source spec changes (bounds come and go) and cached tiles were drawn
    // without or with the fill, so the source is rebuilt the way a new DEM is.
    const wasEnabled = this.isTerrainEnabled();
    if (wasEnabled) {
      if (this.terrainControl) this.terrainControl.setEnabled(false);
      else this.map?.setTerrain(null);
    }
    if (this.map?.getSource(TERRAIN_SOURCE_ID)) this.map.removeSource(TERRAIN_SOURCE_ID);
    this.terrainSource = this.cogTerrainSourceSpec(registration);
    if (this.map && this.isStyleReady()) this.addTerrainSource();
    if (wasEnabled && !this.setTerrainEnabled(true) && this.terrainControl) {
      this.terrainEnablePending = true;
    }
  }

  /** The global Terrarium tiles as a COG DEM fallback, created once. */
  private globalTerrainFallback(): CogDemFallback {
    this.terrainFallback ??= createTerrariumFallback({
      template: DEFAULT_TERRAIN_SOURCE.tiles![0],
      maxzoom: DEFAULT_TERRAIN_SOURCE.maxzoom ?? 15,
    });
    return this.terrainFallback;
  }

  /**
   * The raster-dem source for a COG DEM registration, or the global source
   * when there is none. Bounds limit tile requests to the DEM, so they are
   * dropped while filling outside it: the tiles beyond carry the global
   * terrain.
   */
  private cogTerrainSourceSpec(
    registration: CogDemSourceRegistration | null,
  ): maplibregl.RasterDEMSourceSpecification {
    if (!registration) return DEFAULT_TERRAIN_SOURCE;
    const filled = this.terrainFillOutside;
    return {
      type: "raster-dem",
      tiles: registration.tiles,
      tileSize: 256,
      maxzoom: 22,
      encoding: "terrarium",
      ...(registration.bounds && !filled ? { bounds: registration.bounds } : {}),
      attribution: filled
        ? `Elevation from user-provided Cloud Optimized GeoTIFF; ${DEFAULT_TERRAIN_SOURCE.attribution}`
        : "Elevation from user-provided Cloud Optimized GeoTIFF",
    };
  }

  /**
   * Enable or disable GeoLibre's built-in 3D terrain independently of whether
   * its map button is visible. Plugins such as Flight Simulator use this to
   * guarantee relief while active without changing the user's control layout.
   */
  setTerrainEnabled(enabled: boolean): boolean {
    if (!this.map) return false;
    if (enabled) {
      if (!this.addTerrainSource()) return false;
      if (this.terrainControl) {
        this.terrainControl.setEnabled(true);
      } else if (!this.isTerrainEnabled()) {
        this.map.setTerrain({
          source: TERRAIN_SOURCE_ID,
          exaggeration: this.terrainExaggeration,
        });
      }
      return this.isTerrainEnabled();
    }
    if (this.isTerrainEnabled()) {
      if (this.terrainControl) {
        this.terrainControl.setEnabled(false);
      } else {
        this.map.setTerrain(null);
      }
    }
    return !this.isTerrainEnabled();
  }

  protected removeTerrainControl(): void {
    // Any deferred auto-enable is void once terrain is being turned off, so a
    // late style load can't re-enable a control the user just hid.
    this.terrainEnablePending = false;
    if (this.map?.getTerrain()?.source === TERRAIN_SOURCE_ID) {
      this.map.setTerrain(null);
    }
    if (!this.terrainControl) return;
    this.removeControl(this.terrainControl);
    this.terrainControl = null;
  }

  /** The current terrain vertical exaggeration. */
  getTerrainExaggeration(): number {
    return this.terrainExaggeration;
  }

  /**
   * Set the terrain vertical exaggeration. Cached so it survives the control
   * being re-added (Controls menu toggle, style reload) and applied live when
   * terrain is already enabled.
   */
  setTerrainExaggeration(exaggeration: number): void {
    // Clamp before caching so the cached value (which seeds the next control
    // built on a Controls-menu toggle / style reload) can't drift from what the
    // live control actually applies, and so the public API is safe regardless of
    // whether the caller pre-validated. Mirrors TerrainControl.setExaggeration.
    const safe = Number.isFinite(exaggeration)
      ? Math.max(0, exaggeration)
      : this.terrainExaggeration;
    this.terrainExaggeration = safe;
    this.terrainControl?.setExaggeration(safe);
  }

  /**
   * Update the terrain control's tooltip/aria label, e.g. after a UI language
   * change. Cached so a re-added control picks up the latest translation.
   */
  setTerrainLabel(label: string): void {
    this.terrainLabel = label;
    this.terrainControl?.setLabel(label);
  }
}
