// The Image control: pictures (from URLs) docked to map corners, each with a
// collapsible header, saved with the project. The editing UI is a dialog in the
// desktop app; this module owns the map controls and their state.

import type { IControl, Map as MapLibreMap } from "maplibre-gl";
import type { GeoLibreAppAPI } from "../../types";
import {
  type ComponentImageState,
  DEFAULT_IMAGE_STATE,
  MAX_IMAGE_CONTROLS,
  imageLayout,
  normalizeImageState,
} from "./image-model";

/** One image on the map: a header bar (title + fold toggle) over the picture. */
class ImageControl implements IControl {
  private container: HTMLDivElement | null = null;
  private image: HTMLImageElement | null = null;
  private titleEl: HTMLSpanElement | null = null;
  private chevron: HTMLSpanElement | null = null;
  private toggle: HTMLButtonElement | null = null;
  private state: ComponentImageState;

  constructor(
    state: ComponentImageState,
    private readonly onCollapsedChange: () => void,
  ) {
    this.state = state;
  }

  onAdd(_map: MapLibreMap): HTMLElement {
    const container = document.createElement("div");
    container.className = "maplibregl-ctrl geolibre-image-control";
    container.style.width = "fit-content";
    container.style.maxWidth = "100%";

    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.style.cssText = [
      "display:flex",
      "align-items:center",
      "gap:6px",
      "box-sizing:border-box",
      "width:100%",
      "min-width:120px",
      "padding:4px 8px",
      "font:600 12px/1.4 system-ui,sans-serif",
      "text-align:start",
      "cursor:pointer",
      "background:hsl(var(--popover))",
      "color:hsl(var(--popover-foreground))",
      "border:1px solid hsl(var(--border))",
    ].join(";");
    const chevron = document.createElement("span");
    chevron.textContent = "▾";
    chevron.setAttribute("aria-hidden", "true");
    chevron.style.display = "inline-block";
    chevron.style.transition = "transform 120ms";
    const titleEl = document.createElement("span");
    titleEl.style.overflow = "hidden";
    titleEl.style.textOverflow = "ellipsis";
    titleEl.style.whiteSpace = "nowrap";
    toggle.append(chevron, titleEl);
    toggle.addEventListener("click", () => {
      this.state = { ...this.state, collapsed: !this.state.collapsed };
      this.render();
      this.onCollapsedChange();
    });

    const image = document.createElement("img");
    image.draggable = false;
    image.referrerPolicy = "no-referrer";
    image.alt = "";
    image.style.display = "block";
    image.style.maxWidth = "none";
    // The picture is decoration over the map: let drags through to the map.
    image.style.pointerEvents = "none";
    image.addEventListener("error", () => this.showError(true));
    image.addEventListener("load", () => this.showError(false));

    container.append(toggle, image);
    this.container = container;
    this.toggle = toggle;
    this.chevron = chevron;
    this.titleEl = titleEl;
    this.image = image;
    this.render();
    return container;
  }

  onRemove(): void {
    this.container?.remove();
    this.container = null;
    this.image = null;
    this.toggle = null;
    this.chevron = null;
    this.titleEl = null;
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
    // A broken image collapses to nothing; keep a visible dashed box so the
    // user can see the control is there but the URL did not load.
    this.image.style.outline = failed ? "1px dashed hsl(var(--border))" : "";
    this.image.style.background = failed ? "hsl(var(--popover) / 0.8)" : "";
  }

  private render(): void {
    const { image, toggle, chevron, titleEl } = this;
    if (!image || !toggle || !chevron || !titleEl) return;
    const { collapsed, title, url } = this.state;
    titleEl.textContent = title || "Image";
    toggle.setAttribute("aria-expanded", String(!collapsed));
    toggle.title = collapsed ? "Expand" : "Collapse";
    toggle.style.borderRadius = collapsed ? "6px" : "6px 6px 0 0";
    chevron.style.transform = collapsed ? "rotate(-90deg)" : "";
    const layout = imageLayout(this.state);
    image.style.width = layout.width;
    image.style.height = layout.height;
    image.style.objectFit = layout.objectFit;
    image.style.display = collapsed ? "none" : "block";
    if (image.getAttribute("src") !== url) image.src = url;
  }
}

const controls = new Map<string, ImageControl>();
// Replaced (never mutated) on every change so `useSyncExternalStore` can compare
// by reference.
let snapshot: readonly ComponentImageState[] = [];
const listeners = new Set<() => void>();
let idCounter = 0;

function refreshSnapshot(): void {
  snapshot = Array.from(controls.values(), (control) => control.getState());
  for (const listener of listeners) listener();
}

function newImageId(): string {
  idCounter += 1;
  return `image-${Date.now().toString(36)}-${idCounter}`;
}

/** The images on the map, in the order they were added. Stable between changes. */
export function getImageControlStates(): readonly ComponentImageState[] {
  return snapshot;
}

/** Whether at least one image is on the map. */
export function isImagePanelVisible(): boolean {
  return snapshot.length > 0;
}

export function subscribeImagePanel(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Project-state snapshot for the Components plugin. @internal */
export function imageProjectState(): ComponentImageState[] | undefined {
  return snapshot.length > 0 ? [...snapshot] : undefined;
}

/**
 * Adds an image to the map, or updates the one with the same `id`.
 *
 * @param app - The live app API used to mount the control.
 * @param input - The image's state; invalid fields fall back to the defaults.
 *   An entry without a usable URL is rejected.
 * @returns The image's id, or null when it was not added.
 */
export function setImageControl(
  app: GeoLibreAppAPI,
  input: Partial<ComponentImageState>,
): string | null {
  const existing = input.id ? controls.get(input.id) : undefined;
  if (!existing && controls.size >= MAX_IMAGE_CONTROLS) return null;
  const id = existing ? input.id! : input.id || newImageId();
  const state = normalizeImageState({ ...DEFAULT_IMAGE_STATE, ...input, id }, id);
  if (!state?.url) return null;
  // A new corner needs a fresh mount: MapLibre places a control once.
  if (existing && existing.getState().position !== state.position) {
    app.removeMapControl(existing);
    controls.delete(id);
  }
  const current = controls.get(id);
  if (current) {
    current.setState(state);
  } else {
    const control = new ImageControl(state, refreshSnapshot);
    if (!app.addMapControl(control, state.position)) return null;
    controls.set(id, control);
  }
  refreshSnapshot();
  return id;
}

/** Removes one image from the map. */
export function removeImageControl(app: GeoLibreAppAPI, id: string): void {
  const control = controls.get(id);
  if (!control) return;
  app.removeMapControl(control);
  controls.delete(id);
  refreshSnapshot();
}

/** Removes every image from the map. */
export function closeImagePanel(app: GeoLibreAppAPI): void {
  teardownImageControl(app);
}

export function teardownImageControl(app: GeoLibreAppAPI): void {
  if (controls.size === 0) return;
  for (const control of controls.values()) app.removeMapControl(control);
  controls.clear();
  refreshSnapshot();
}

/** Replaces the images on the map with a saved project's. */
export function restoreImagePanels(
  app: GeoLibreAppAPI,
  states: readonly ComponentImageState[],
): void {
  teardownImageControl(app);
  for (const state of states) setImageControl(app, state);
}
