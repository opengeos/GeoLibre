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
    isNorthUp:
      Math.abs(bearing) < NORTH_EPSILON && Math.abs(pitch) < NORTH_EPSILON,
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

  constructor(options: { label?: string } = {}) {
    if (options.label) this.label = options.label;
  }

  /** Tracks the live camera so the needle and active state stay in sync. */
  private readonly handleCameraChange = () => this.update();

  onAdd(map: maplibregl.Map): HTMLElement {
    this.map = map;

    const container = document.createElement("div");
    container.className =
      "maplibregl-ctrl maplibregl-ctrl-group geolibre-reset-bearing-ctrl";

    const button = document.createElement("button");
    button.type = "button";
    button.className = "geolibre-reset-bearing-button";
    button.addEventListener("click", () => {
      // resetNorthPitch animates bearing and pitch back to 0 together while
      // leaving center and zoom untouched, matching the menu command.
      this.map?.resetNorthPitch();
    });

    const needle = document.createElementNS(
      "http://www.w3.org/2000/svg",
      "svg",
    );
    needle.setAttribute("viewBox", "0 0 24 24");
    needle.setAttribute("aria-hidden", "true");
    needle.classList.add("geolibre-reset-bearing-needle");
    // The north half is what turns red when the view is rotated; the south half
    // stays muted so the needle reads as a compass rather than a solid arrow.
    needle.innerHTML =
      '<polygon class="geolibre-reset-bearing-needle-north" points="12,2 6.5,14 12,11.5 17.5,14" />' +
      '<polygon class="geolibre-reset-bearing-needle-south" points="12,22 6.5,10 12,12.5 17.5,10" />';
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
    this.button.classList.toggle(
      "geolibre-reset-bearing-button--active",
      !isNorthUp,
    );
  }
}
