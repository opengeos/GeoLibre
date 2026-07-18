import type maplibregl from "maplibre-gl";

/**
 * Bearing/pitch below this magnitude is treated as "north-up and flat", so a
 * float that never settles to exactly 0 after an animated reset does not leave
 * the control stuck in its rotated (active) state.
 */
const NORTH_EPSILON = 0.5;

/**
 * Derive the reset-bearing control's display state from the live camera.
 *
 * Exposed so the threshold/rotation logic can be unit-tested without a DOM.
 *
 * @param bearing Current map bearing in degrees (clockwise positive).
 * @param pitch Current map pitch in degrees.
 * @returns `isNorthUp` (whether the view is north-up and flat, so there is
 *   nothing to reset) and `needleRotation` (degrees to rotate the compass
 *   needle so its north tip keeps pointing to true north).
 */
export function resetBearingState(
  bearing: number,
  pitch: number,
): { isNorthUp: boolean; needleRotation: number } {
  return {
    isNorthUp: Math.abs(bearing) < NORTH_EPSILON && Math.abs(pitch) < NORTH_EPSILON,
    // `+ 0` normalises the -0 produced by negating a 0 bearing to 0.
    needleRotation: -bearing + 0,
  };
}

/**
 * A MapLibre control that resets the map's bearing and pitch back to north-up
 * and flat in a single click, mirroring the "Reset Pitch & Bearing" command.
 *
 * The button is meant to sit directly below the Fullscreen control. It is a
 * passive affordance while the map is north-up and flat (disabled, neutral
 * colour) and turns active — a red, rotating compass needle that tracks the
 * live bearing — the moment the view is rotated or tilted, giving beginners an
 * unmistakable cue that the map is no longer north-up (issue #508).
 */
export class ResetBearingControl implements maplibregl.IControl {
  private map: maplibregl.Map | null = null;
  private container: HTMLDivElement | null = null;
  private button: HTMLButtonElement | null = null;
  private needle: SVGSVGElement | null = null;
  private label = "Reset pitch & bearing";
  private northLabel = "N";

  constructor(options: { label?: string; northLabel?: string } = {}) {
    if (options.label !== undefined) this.label = options.label;
    if (options.northLabel !== undefined) this.northLabel = options.northLabel;
  }

  /** Tracks the live camera so the needle and active state stay in sync. */
  private readonly handleCameraChange = () => this.update();

  onAdd(map: maplibregl.Map): HTMLElement {
    this.map = map;

    const container = document.createElement("div");
    container.className = "maplibregl-ctrl maplibregl-ctrl-group geolibre-reset-bearing-ctrl";

    const button = document.createElement("button");
    button.type = "button";
    button.className = "geolibre-reset-bearing-button";
    button.addEventListener("click", () => {
      // resetNorthPitch animates bearing and pitch back to 0 together while
      // leaving center and zoom untouched, matching the menu command.
      this.map?.resetNorthPitch();
    });

    const needle = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    needle.setAttribute("viewBox", "0 0 24 24");
    needle.setAttribute("aria-hidden", "true");
    needle.classList.add("geolibre-reset-bearing-needle");
    // A classic north arrow: an "N" cap over a single dominant upward needle so
    // the control reads unambiguously as "north" at a glance (issue #537). The
    // solid north needle is what turns red when the view is rotated; the south
    // tail stays light and slim so the arrow keeps one clear destination point
    // instead of two mirrored triangles of equal weight. The apex sits at y=9
    // (just below the "N" baseline at y=8) so the glyph never crowds the tip
    // even on fonts with taller cap metrics.
    needle.innerHTML =
      '<text class="geolibre-reset-bearing-needle-label" x="12" y="8" text-anchor="middle"></text>' +
      '<polygon class="geolibre-reset-bearing-needle-north" points="12,9 9,19 12,16 15,19" />' +
      '<polygon class="geolibre-reset-bearing-needle-south" points="12,22.5 9.6,19 14.4,19" />';
    // Set the cardinal letter via textContent (not interpolated into innerHTML)
    // so a caller-supplied northLabel can't inject markup into the SVG.
    const labelEl = needle.querySelector(".geolibre-reset-bearing-needle-label");
    if (labelEl) labelEl.textContent = this.northLabel;
    button.appendChild(needle);

    container.appendChild(button);
    this.container = container;
    this.button = button;
    this.needle = needle;

    map.on("rotate", this.handleCameraChange);
    map.on("pitch", this.handleCameraChange);
    this.applyLabel();
    this.update();

    return container;
  }

  onRemove(): void {
    if (this.map) {
      this.map.off("rotate", this.handleCameraChange);
      this.map.off("pitch", this.handleCameraChange);
    }
    this.container?.remove();
    this.container = null;
    this.button = null;
    this.needle = null;
    this.map = null;
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

  private update(): void {
    if (!this.map || !this.button || !this.needle) return;
    const { isNorthUp, needleRotation } = resetBearingState(
      this.map.getBearing(),
      this.map.getPitch(),
    );

    // Rotate the needle so north keeps pointing to true north as the map turns.
    this.needle.style.transform = `rotate(${needleRotation}deg)`;
    // Nothing to reset when already north-up and flat: grey the button out and
    // drop the alert colour so it reads as inactive.
    this.button.disabled = isNorthUp;
    this.button.classList.toggle("geolibre-reset-bearing-button--active", !isNorthUp);
  }
}
