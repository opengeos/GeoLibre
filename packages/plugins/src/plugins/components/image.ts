// The Image control: a picture (from a URL) docked to a map corner, saved with
// the project. The editing UI is a dialog in the desktop app; this module owns
// the map control and its state.

import type { IControl, Map as MapLibreMap } from "maplibre-gl";
import type { GeoLibreAppAPI, GeoLibreMapControlPosition } from "../../types";
import {
  type ComponentImageState,
  DEFAULT_IMAGE_STATE,
  imageLayout,
  normalizeImageState,
  normalizeImageUrl,
} from "./image-model";

/** Map control that draws one image; restyled in place by {@link ImageControl.setState}. */
class ImageControl implements IControl {
  private container: HTMLDivElement | null = null;
  private image: HTMLImageElement | null = null;
  private state: ComponentImageState;

  constructor(state: ComponentImageState) {
    this.state = state;
  }

  onAdd(_map: MapLibreMap): HTMLElement {
    const container = document.createElement("div");
    container.className = "maplibregl-ctrl geolibre-image-control";
    // The control sits over the map, so it must not swallow map drags that
    // start on a transparent corner of the image only; the image itself is
    // draggable-off and inert.
    container.style.pointerEvents = "none";
    container.style.lineHeight = "0";
    const image = document.createElement("img");
    image.draggable = false;
    image.referrerPolicy = "no-referrer";
    image.style.display = "block";
    image.style.maxWidth = "none";
    image.addEventListener("error", () => this.showError(true));
    image.addEventListener("load", () => this.showError(false));
    container.appendChild(image);
    this.container = container;
    this.image = image;
    this.render();
    return container;
  }

  onRemove(): void {
    this.container?.remove();
    this.container = null;
    this.image = null;
  }

  getState(): ComponentImageState {
    return this.state;
  }

  setState(state: ComponentImageState): void {
    this.state = state;
    this.render();
  }

  private showError(failed: boolean): void {
    if (!this.image) return;
    // A broken image collapses to its alt text; keep a visible dashed box so
    // the user can see the control is there but the URL did not load.
    this.image.style.outline = failed ? "1px dashed hsl(var(--border))" : "";
    this.image.style.background = failed ? "hsl(var(--popover) / 0.8)" : "";
  }

  private render(): void {
    const { image, container } = this;
    if (!image || !container) return;
    const layout = imageLayout(this.state);
    image.style.width = layout.width;
    image.style.height = layout.height;
    image.style.objectFit = layout.objectFit;
    image.alt = "Image";
    if (image.getAttribute("src") !== this.state.url) {
      if (this.state.url) image.src = this.state.url;
      else image.removeAttribute("src");
    }
    container.style.display = this.state.url ? "" : "none";
  }
}

let imageControl: ImageControl | null = null;
let mountedPosition: GeoLibreMapControlPosition | null = null;
let imagePanelVisible = false;
const imagePanelListeners = new Set<() => void>();

/** Live Image control state, or null when no image is on the map. @internal */
export function getImageControlState(): ComponentImageState | null {
  return imagePanelVisible && imageControl ? imageControl.getState() : null;
}

/** Project-state snapshot for the Components plugin. @internal */
export function imageProjectState(): ComponentImageState | undefined {
  return getImageControlState() ?? undefined;
}

export function isImagePanelVisible(): boolean {
  return imagePanelVisible;
}

export function subscribeImagePanel(listener: () => void): () => void {
  imagePanelListeners.add(listener);
  return () => imagePanelListeners.delete(listener);
}

function setImagePanelVisible(visible: boolean): void {
  if (imagePanelVisible === visible) return;
  imagePanelVisible = visible;
  for (const listener of imagePanelListeners) listener();
}

/**
 * Puts an image on the map, or updates the one already there.
 *
 * @param app - The live app API used to mount the control.
 * @param input - The new state; invalid fields fall back to the defaults. A
 *   state without a usable URL removes the control instead.
 * @returns Whether an image is on the map afterwards.
 */
export function setImageControl(app: GeoLibreAppAPI, input: Partial<ComponentImageState>): boolean {
  const state = normalizeImageState({ ...DEFAULT_IMAGE_STATE, ...input, visible: true });
  if (!state || !normalizeImageUrl(state.url)) {
    teardownImageControl(app);
    return false;
  }
  // A new corner needs a fresh mount: MapLibre places a control once.
  if (imageControl && mountedPosition !== state.position) {
    app.removeMapControl(imageControl);
    imageControl = null;
    mountedPosition = null;
  }
  if (!imageControl) {
    const control = new ImageControl(state);
    if (!app.addMapControl(control, state.position)) {
      setImagePanelVisible(false);
      return false;
    }
    imageControl = control;
    mountedPosition = state.position;
  } else {
    imageControl.setState(state);
  }
  setImagePanelVisible(true);
  return true;
}

/** Removes the image from the map. */
export function closeImagePanel(app: GeoLibreAppAPI): void {
  teardownImageControl(app);
}

export function teardownImageControl(app: GeoLibreAppAPI): void {
  if (imageControl) app.removeMapControl(imageControl);
  imageControl = null;
  mountedPosition = null;
  setImagePanelVisible(false);
}

/** Re-creates the control from a saved project state. */
export function restoreImagePanel(app: GeoLibreAppAPI, state: ComponentImageState): void {
  if (!state.visible) {
    teardownImageControl(app);
    return;
  }
  setImageControl(app, state);
}
