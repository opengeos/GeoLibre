import type * as mapboxgl from "mapbox-gl";

/**
 * The slice of a mapbox-gl `Map` the globe control touches. Structural so a
 * unit test can hand it a fake without loading mapbox-gl.
 */
export interface ProjectionToggleMap {
  getProjection(): { name?: string } | null | undefined;
  setProjection(projection: string): unknown;
  on(event: string, handler: () => void): unknown;
  off(event: string, handler: () => void): unknown;
}

export interface MapboxGlobeControlOptions {
  /** Tooltip while the map is in Mercator (a click switches to the globe). */
  enableLabel?: string;
  /** Tooltip while the map is a globe (a click switches back to Mercator). */
  disableLabel?: string;
}

/**
 * A globe/Mercator toggle for the Mapbox renderer.
 *
 * Mapbox GL JS ships no equivalent of MapLibre's `GlobeControl`, so the Mapbox
 * engine would otherwise have no on-map projection switch. This mirrors that
 * control's DOM (`maplibregl-ctrl-globe` / `maplibregl-ctrl-globe-enabled` on
 * the button, `maplibregl-ctrl-icon` inside it) so three things carry over for
 * free: MapLibre's stylesheet paints the same globe glyph, the app's blue
 * "enabled" icon override in `index.css` applies, and
 * `isGlobeControlToggleClick` recognises the click, which is what persists the
 * projection into project preferences.
 *
 * The button class is swapped from the map's live projection, not from the
 * control's own clicks, so a projection applied from the Settings dialog or a
 * project load (`MapboxEngine.applyMapPreferences`) keeps the icon honest.
 */
export class MapboxGlobeControl implements mapboxgl.IControl {
  private map: ProjectionToggleMap | null = null;
  private container: HTMLDivElement | null = null;
  private button: HTMLButtonElement | null = null;
  private readonly enableLabel: string;
  private readonly disableLabel: string;

  constructor(options: MapboxGlobeControlOptions = {}) {
    this.enableLabel = options.enableLabel ?? "Enable globe";
    this.disableLabel = options.disableLabel ?? "Disable globe";
  }

  private readonly toggle = (): void => {
    if (!this.map) return;
    this.map.setProjection(this.isGlobe() ? "mercator" : "globe");
    this.update();
  };

  private readonly handleStyleChange = (): void => this.update();

  onAdd(map: ProjectionToggleMap): HTMLElement {
    this.map = map;
    const container = document.createElement("div");
    // `mapboxgl-ctrl` gives the corner its native margin/float; the MapLibre
    // classes carry the group chrome and the globe glyph (see class docs).
    container.className = "maplibregl-ctrl maplibregl-ctrl-group mapboxgl-ctrl";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "maplibregl-ctrl-globe";
    const icon = document.createElement("span");
    icon.className = "maplibregl-ctrl-icon";
    icon.setAttribute("aria-hidden", "true");
    button.appendChild(icon);
    button.addEventListener("click", this.toggle);
    container.appendChild(button);
    this.container = container;
    this.button = button;
    map.on("styledata", this.handleStyleChange);
    map.on("style.load", this.handleStyleChange);
    this.update();
    return container;
  }

  onRemove(): void {
    this.button?.removeEventListener("click", this.toggle);
    this.map?.off("styledata", this.handleStyleChange);
    this.map?.off("style.load", this.handleStyleChange);
    this.container?.remove();
    this.container = null;
    this.button = null;
    this.map = null;
  }

  /** Whether the map currently renders as a globe. */
  isGlobe(): boolean {
    return this.map?.getProjection()?.name === "globe";
  }

  /**
   * Re-read the map's projection and repaint the button. The engine calls this
   * after it sets the projection itself, since mapbox-gl does not announce
   * `setProjection` through an event the control could subscribe to.
   */
  update(): void {
    const button = this.button;
    if (!button) return;
    const globe = this.isGlobe();
    button.classList.toggle("maplibregl-ctrl-globe-enabled", globe);
    button.classList.toggle("maplibregl-ctrl-globe", !globe);
    const label = globe ? this.disableLabel : this.enableLabel;
    button.title = label;
    button.setAttribute("aria-label", label);
  }
}
