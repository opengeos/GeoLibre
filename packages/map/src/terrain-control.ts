import type maplibregl from "maplibre-gl";

/**
 * Clicks landing within this window of the previous one are treated as a
 * double-click (open the exaggeration dialog) rather than two toggles.
 */
const DOUBLE_CLICK_MS = 250;

/**
 * Fallback exaggeration when none (or an invalid value) is supplied. Exported as
 * the single source of truth: MapController seeds its cache from it and re-exports
 * it for the settings dialog, so the control's fallback and the UI default can't
 * drift apart.
 */
export const DEFAULT_TERRAIN_EXAGGERATION = 1;

export interface TerrainControlOptions {
  /** The raster-DEM source id used to drive terrain. */
  source: string;
  /** Initial vertical exaggeration applied when terrain is enabled. */
  exaggeration?: number;
  /** Tooltip/aria label for the button. */
  label?: string;
  /**
   * Invoked when the user double-clicks the button. Terrain is enabled first,
   * so the caller can open a settings dialog whose exaggeration edits are
   * immediately visible on the map.
   */
  onOpenSettings?: () => void;
}

/**
 * A MapLibre control that toggles hillshaded 3D terrain, mirroring the built-in
 * `maplibregl.TerrainControl` (it reuses the same icon classes) but adding a
 * double-click gesture that opens a vertical-exaggeration dialog.
 *
 * A single click toggles terrain on/off; a double-click opens the exaggeration
 * settings. Clicks are debounced by {@link DOUBLE_CLICK_MS} so a double-click
 * never flickers terrain on and back off before the dialog appears.
 */
export class TerrainControl implements maplibregl.IControl {
  private map: maplibregl.Map | null = null;
  private container: HTMLDivElement | null = null;
  private button: HTMLButtonElement | null = null;
  private readonly source: string;
  private exaggeration: number;
  private label: string;
  private readonly onOpenSettings?: () => void;
  private clickTimer: ReturnType<typeof setTimeout> | null = null;
  // Set briefly after a double-click opens the dialog so a 3rd+ rapid click
  // can't re-arm a single-click toggle and flatten terrain under the open dialog.
  private clicksSuppressed = false;
  private suppressTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: TerrainControlOptions) {
    this.source = options.source;
    // Clamp like setExaggeration so every write path validates identically: a
    // caller (e.g. a corrupted cached value) can't seed an invalid exaggeration.
    const requested = options.exaggeration ?? DEFAULT_TERRAIN_EXAGGERATION;
    this.exaggeration = Number.isFinite(requested)
      ? Math.max(0, requested)
      : DEFAULT_TERRAIN_EXAGGERATION;
    // English fallback for when no translated label is supplied. The map package
    // is i18n-agnostic, so this necessarily duplicates the `terrainSettings.
    // controlLabel` string in the app's en.json — keep the two in sync.
    this.label = options.label ?? "Toggle terrain (double-click for exaggeration)";
    this.onOpenSettings = options.onOpenSettings;
  }

  /** Keep the active (enabled) styling in sync when terrain changes elsewhere. */
  private readonly handleTerrainChange = () => this.updateActiveState();

  onAdd(map: maplibregl.Map): HTMLElement {
    this.map = map;

    const container = document.createElement("div");
    container.className = "maplibregl-ctrl maplibregl-ctrl-group geolibre-terrain-ctrl";

    const button = document.createElement("button");
    button.type = "button";
    // Reuse MapLibre's own class so the built-in terrain (mountain) icon and its
    // enabled-state styling apply without shipping a duplicate icon.
    button.className = "maplibregl-ctrl-terrain";
    const icon = document.createElement("span");
    icon.className = "maplibregl-ctrl-icon";
    icon.setAttribute("aria-hidden", "true");
    button.appendChild(icon);
    button.addEventListener("click", this.handleClick);

    container.appendChild(button);
    this.container = container;
    this.button = button;

    map.on("terrain", this.handleTerrainChange);
    this.applyLabel();
    this.updateActiveState();

    return container;
  }

  onRemove(): void {
    if (this.clickTimer !== null) {
      clearTimeout(this.clickTimer);
      this.clickTimer = null;
    }
    if (this.suppressTimer !== null) {
      clearTimeout(this.suppressTimer);
      this.suppressTimer = null;
    }
    this.clicksSuppressed = false;
    this.map?.off("terrain", this.handleTerrainChange);
    this.container?.remove();
    this.container = null;
    this.button = null;
    this.map = null;
  }

  private readonly handleClick = () => {
    // Ignore trailing clicks right after a double-click opened the dialog, so a
    // 3rd+ rapid click can't schedule a fresh single-click toggle that fires
    // (and flattens terrain) while the dialog is still open.
    if (this.clicksSuppressed) return;
    // A second click within the double-click window opens the exaggeration
    // dialog; a lone click toggles terrain once the window elapses. Debouncing
    // (rather than toggling on every click) keeps a double-click from flickering
    // terrain on and back off before the dialog appears.
    if (this.clickTimer !== null) {
      clearTimeout(this.clickTimer);
      this.clickTimer = null;
      this.openSettings();
      return;
    }
    this.clickTimer = setTimeout(() => {
      this.clickTimer = null;
      this.setEnabled(!this.isEnabled());
    }, DOUBLE_CLICK_MS);
  };

  private openSettings(): void {
    // Enable terrain first so exaggeration edits are visible live in the dialog.
    this.setEnabled(true);
    this.onOpenSettings?.();
    // Swallow further clicks for one more window (see handleClick).
    this.clicksSuppressed = true;
    if (this.suppressTimer !== null) clearTimeout(this.suppressTimer);
    this.suppressTimer = setTimeout(() => {
      this.clicksSuppressed = false;
      this.suppressTimer = null;
    }, DOUBLE_CLICK_MS);
  }

  /** Whether 3D terrain backed by this control's DEM source is active. */
  isEnabled(): boolean {
    return this.map?.getTerrain()?.source === this.source;
  }

  setEnabled(enabled: boolean): void {
    if (!this.map) return;
    if (enabled) {
      if (!this.isEnabled()) {
        // Unclamp the map center from the terrain surface before enabling
        // terrain. With the default (clamped) behavior MapLibre re-solves the
        // zoom every frame to hold the camera at a constant height above the
        // terrain elevation *under the center*; over steep terrain that sampled
        // elevation jumps as higher-resolution DEM tiles stream in, so a
        // cursor-anchored scroll-zoom snaps backward by up to ~2 zoom levels
        // (zoom-in gestures fail to accumulate) and the camera can dip toward
        // the surface, producing flicker / black flashes over high, steep relief
        // (e.g. zooming into a mountain-summit track). Anchoring the center at
        // sea level removes the per-frame zoom recomputation so zoom accumulates
        // smoothly, and keeps the camera above ground at steep pitch (per
        // MapLibre's own guidance for setCenterClampedToGround).
        this.map.setCenterClampedToGround(false);
        this.map.setTerrain({
          source: this.source,
          exaggeration: this.exaggeration,
        });
      }
    } else if (this.isEnabled()) {
      this.map.setTerrain(null);
      // Restore MapLibre's default center clamping now that terrain is off.
      this.map.setCenterClampedToGround(true);
    }
  }

  getExaggeration(): number {
    return this.exaggeration;
  }

  /**
   * Update the vertical exaggeration, applying it live when terrain is on.
   * Defensively guards invalid input so validation isn't solely the caller's
   * job: non-finite values are ignored and negatives clamp to 0 (flat). No
   * upper bound — large exaggerations are valid; the dialog enforces its own
   * display range.
   */
  setExaggeration(exaggeration: number): void {
    if (!Number.isFinite(exaggeration)) return;
    const safe = Math.max(0, exaggeration);
    this.exaggeration = safe;
    if (this.map && this.isEnabled()) {
      this.map.setTerrain({ source: this.source, exaggeration: safe });
    }
  }

  /** Update the tooltip/aria label, e.g. after a UI language change. */
  setLabel(label: string): void {
    this.label = label;
    this.applyLabel();
  }

  private applyLabel(): void {
    if (!this.button) return;
    this.button.title = this.label;
    this.button.setAttribute("aria-label", this.label);
  }

  private updateActiveState(): void {
    if (!this.button) return;
    const enabled = this.isEnabled();
    this.button.classList.toggle("maplibregl-ctrl-terrain-enabled", enabled);
    // Expose the on/off state to assistive tech, not just via the CSS class.
    this.button.setAttribute("aria-pressed", String(enabled));
  }
}
