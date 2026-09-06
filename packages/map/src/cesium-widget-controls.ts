import type * as maplibregl from "maplibre-gl";
import type { CesiumWidget } from "@cesium/engine";

// Cesium's own toolbar widgets, mounted on GeoLibre's map as regular map
// controls (issue #2270).
//
// `CesiumCanvas` builds a bare `CesiumWidget` rather than a `Viewer`, precisely
// so it does not inherit the toolbar Cesium's full app wrapper constructs —
// base-layer picker, geocoder, home button, scene-mode picker, help button,
// timeline, animation dial, info box — most of which duplicate something
// GeoLibre already owns. Three of them do not: nothing else in the app returns
// the camera to a whole-Earth view, nothing at all reaches Cesium's 2D and
// Columbus scene modes, and MapLibre's fullscreen control is bound to a
// `maplibregl.Map` the globe does not have.
//
// Each widget is constructible on its own against a container element, so none
// needs `Viewer`. They are wrapped as `maplibregl.IControl`s so
// `CesiumControlHost` positions and tears them down exactly like every other
// control on the map.
//
// This module is reached only through a dynamic import inside `CesiumCanvas`'s
// mount effect: `@cesium/widgets` is a static import below, and a static import
// from `CesiumCanvas` would pull the widget chrome (and Knockout) onto the 2D
// boot path instead of leaving it in the lazily fetched `cesium` chunk.

import { FullscreenButton, HomeButton, SceneModePicker } from "@cesium/widgets";

/**
 * Marks the wrapper GeoLibre's stylesheet themes the Cesium chrome through.
 *
 * The widgets carry Cesium's own dark-blue toolbar look, which sits oddly beside
 * GeoLibre's map controls in either theme. `index.css` restyles them under this
 * class — scoped, so nothing else Cesium renders (its credit display, the
 * render-error panel) is caught by the same rules.
 */
const CONTROL_CLASS = "geolibre-cesium-ctrl";

/**
 * Tooltips for the widgets, supplied by the app so they follow the UI language.
 *
 * The widgets hardcode English (`"View Home"`, `"2D"`, `"3D"`,
 * `"Columbus View"`) and live outside React, so — like `MapController`'s compass
 * and terrain labels — the translated strings are pushed in from the component
 * that owns them rather than read from a hook here.
 */
export interface CesiumWidgetControlLabels {
  /** Tooltip for the home button. */
  home: string;
  /** Tooltip for the 3D globe scene mode. */
  sceneMode3D: string;
  /** Tooltip for the flat 2D map scene mode. */
  sceneMode2D: string;
  /** Tooltip for Columbus view (the 2.5D projected map). */
  sceneModeColumbus: string;
  /** Tooltip for the fullscreen button while the map is windowed. */
  fullscreenEnter: string;
  /** Tooltip for the fullscreen button while the map fills the screen. */
  fullscreenExit: string;
  /** Tooltip for the fullscreen button when the browser forbids fullscreen. */
  fullscreenUnavailable: string;
}

/** English fallbacks, used until the app pushes translated labels in. */
export const DEFAULT_CESIUM_WIDGET_CONTROL_LABELS: CesiumWidgetControlLabels = Object.freeze({
  home: "Reset view",
  sceneMode3D: "3D globe",
  sceneMode2D: "2D map",
  sceneModeColumbus: "Columbus view",
  fullscreenEnter: "Enter fullscreen",
  fullscreenExit: "Exit fullscreen",
  fullscreenUnavailable: "Fullscreen unavailable",
});

/** The subset of a Cesium widget's lifecycle these wrappers depend on. */
interface DestroyableWidget {
  destroy: () => void;
  isDestroyed: () => boolean;
}

/**
 * A `maplibregl.IControl` wrapping one Cesium widget.
 *
 * The widget is built in `onAdd` rather than in the constructor because that is
 * when a container element exists to build into, and destroyed in `onRemove`
 * because Cesium widgets hold Knockout bindings that leak if the element is
 * merely detached. Both halves tolerate a destroyed viewer:
 * `CesiumControlHost.destroy()` runs during teardown and the order in which the
 * host and the viewer die is not guaranteed.
 */
abstract class CesiumWidgetControl<T extends DestroyableWidget> implements maplibregl.IControl {
  protected labels: CesiumWidgetControlLabels;
  private container: HTMLDivElement | null = null;
  private widget: T | null = null;

  constructor(
    protected readonly viewer: CesiumWidget,
    labels: CesiumWidgetControlLabels,
  ) {
    this.labels = labels;
  }

  /** Build the widget into `container`. */
  protected abstract create(container: HTMLElement): T;

  /** Push {@link labels} onto an existing widget's view model. */
  protected abstract applyLabels(widget: T): void;

  /** An extra class on the wrapper, for a control `index.css` treats specially. */
  protected extraClass(): string {
    return "";
  }

  onAdd(): HTMLElement {
    const container = document.createElement("div");
    // `maplibregl-ctrl` supplies the corner stacking and margins every control
    // in the container shares. `maplibregl-ctrl-group` is deliberately absent:
    // it draws MapLibre's own white button chrome, which would show as a frame
    // around the Cesium button sitting inside it.
    container.className = `maplibregl-ctrl ${CONTROL_CLASS} ${this.extraClass()}`.trim();
    this.container = container;
    if (!this.viewer.isDestroyed()) {
      this.widget = this.create(container);
      this.applyLabels(this.widget);
    }
    return container;
  }

  onRemove(): void {
    if (this.widget && !this.widget.isDestroyed()) this.widget.destroy();
    this.widget = null;
    this.container?.remove();
    this.container = null;
  }

  /**
   * Retranslate the tooltips in place.
   *
   * Cheaper and less disruptive than rebuilding the control on every language
   * change: the widgets expose their tooltips as observables, so writing them
   * updates the live DOM without touching the scene or the camera.
   */
  setLabels(labels: CesiumWidgetControlLabels): void {
    this.labels = labels;
    if (this.widget && !this.widget.isDestroyed()) this.applyLabels(this.widget);
  }
}

/**
 * Cesium's home button: fly back to a view of the whole Earth.
 *
 * The flight is Cesium's own (`camera.flyHome`), not one of the engine's
 * animated moves, and that is deliberate — this is the "I am lost, show me
 * everything" button, so it targets `Camera.DEFAULT_VIEW_RECTANGLE` rather than
 * any project camera. The resulting move still reaches the store: it ends in a
 * `moveEnd` like any other, which `CesiumEngine`'s camera publisher mirrors into
 * `mapView` without marking the project dirty (no user input flagged it).
 */
class CesiumHomeControl extends CesiumWidgetControl<HomeButton> {
  protected create(container: HTMLElement): HomeButton {
    // No duration argument, so the flight keeps Cesium's own distance-derived
    // one rather than the 0.8 s the rest of the app animates in (#2270 review).
    // That is the right default here and not an oversight: this button always
    // travels from wherever the user is to the whole Earth, and forcing a
    // street-level-to-orbit flight into 0.8 s reads as a jump cut. Cesium scales
    // the duration with the distance and caps it at 3 s.
    return new HomeButton(container, this.viewer.scene);
  }

  protected applyLabels(widget: HomeButton): void {
    widget.viewModel.tooltip = this.labels.home;
  }
}

/**
 * Cesium's scene-mode picker: switch between the 3D globe, a flat 2D map, and
 * Columbus view.
 *
 * This is the one control here with no GeoLibre counterpart at all. View →
 * Rendering engine swaps *renderers* (MapLibre or Cesium draws the project);
 * this swaps how the Cesium scene itself is projected, and 2D and Columbus view
 * are reachable no other way.
 *
 * The morph is animated, and Cesium refuses camera reads and writes while one
 * runs, so `CesiumEngine` stands its camera sync down for the duration and
 * publishes the native final view on `morphComplete`.
 */
class CesiumSceneModeControl extends CesiumWidgetControl<SceneModePicker> {
  private stopWatching: (() => void) | null = null;

  /** Keep the sideways picker above adjacent map controls. */
  protected extraClass(): string {
    return "geolibre-cesium-ctrl-expands";
  }

  protected create(container: HTMLElement): SceneModePicker {
    // Use Cesium's default duration and easing, just like Viewer/Sandcastle.
    const widget = new SceneModePicker(container, this.viewer.scene);
    const start = () => container.setAttribute("aria-busy", "true");
    const complete = () => container.setAttribute("aria-busy", "false");
    complete();
    const scene = this.viewer.scene;
    scene.morphStart.addEventListener(start);
    scene.morphComplete.addEventListener(complete);
    this.stopWatching = () => {
      scene.morphStart.removeEventListener(start);
      scene.morphComplete.removeEventListener(complete);
    };
    return widget;
  }

  onRemove(): void {
    this.stopWatching?.();
    this.stopWatching = null;
    super.onRemove();
  }

  protected applyLabels(widget: SceneModePicker): void {
    widget.viewModel.tooltip3D = this.labels.sceneMode3D;
    widget.viewModel.tooltip2D = this.labels.sceneMode2D;
    widget.viewModel.tooltipColumbusView = this.labels.sceneModeColumbus;
  }
}

/**
 * Cesium's fullscreen button, taking the globe's own container full-screen.
 *
 * The 2D map's fullscreen control is MapLibre's, and it cannot be reused here:
 * it reads `map.getContainer()`, `map.cooperativeGestures` and
 * `map._getUIString()` off a real `maplibregl.Map`, and `CesiumControlHost`'s
 * facade is not one. Cesium's widget needs nothing but a container and the
 * element to expand, so it stands alone.
 *
 * Its tooltip is the one this module cannot set through a view model: Cesium
 * derives it from the fullscreen state as a read-only computed. It is instead
 * written onto the button after every state change — see {@link applyLabels}.
 */
class CesiumFullscreenControl extends CesiumWidgetControl<FullscreenButton> {
  /** Removes the `fullscreenchange` listener the label shim installs. */
  private stopWatching: (() => void) | null = null;

  constructor(
    viewer: CesiumWidget,
    labels: CesiumWidgetControlLabels,
    /** The element to expand — the globe's container, not the whole page. */
    private readonly fullscreenElement: HTMLElement,
  ) {
    super(viewer, labels);
  }

  protected create(container: HTMLElement): FullscreenButton {
    return new FullscreenButton(container, this.fullscreenElement);
  }

  protected applyLabels(widget: FullscreenButton): void {
    const element = widget.container.querySelector("button");
    if (!element) return;
    const retitle = () => {
      element.title = !widget.viewModel.isFullscreenEnabled
        ? this.labels.fullscreenUnavailable
        : widget.viewModel.isFullscreen
          ? this.labels.fullscreenExit
          : this.labels.fullscreenEnter;
    };
    retitle();
    // Cesium binds `title` to a computed it recomputes when the document enters
    // or leaves fullscreen, which would put the English string back. Listening
    // for the same event and rewriting afterwards is enough: DOM listeners fire
    // in registration order and the widget registered its own at construction,
    // so this one always runs second. Re-registered on every label change, with
    // the previous listener dropped, so a language switch cannot stack them.
    this.stopWatching?.();
    document.addEventListener("fullscreenchange", retitle);
    this.stopWatching = () => document.removeEventListener("fullscreenchange", retitle);
  }

  onRemove(): void {
    this.stopWatching?.();
    this.stopWatching = null;
    super.onRemove();
  }
}

/** A control built by {@link createCesiumWidgetControls}. */
export type CesiumWidgetControlHandle = maplibregl.IControl & {
  setLabels(labels: CesiumWidgetControlLabels): void;
};

/**
 * The Cesium toolbar controls for one globe, in the order they are stacked.
 *
 * `fullscreen` is named separately because it is the one the app already has a
 * toggle for — Controls → Fullscreen — so `CesiumEngine` needs a handle on it
 * to answer `setBuiltInControlVisible`. The other two have no such counterpart
 * and are simply always present.
 */
export interface CesiumWidgetControls {
  /** Every control, in stacking order. */
  all: CesiumWidgetControlHandle[];
  fullscreen: CesiumWidgetControlHandle;
}

/**
 * Build the Cesium toolbar controls for a globe.
 *
 * Returned rather than mounted so the caller decides placement and keeps the
 * handles it needs to retranslate and remove them; `CesiumCanvas` adds them to
 * the primary globe's control host and drops them on unmount.
 *
 * @param viewer - The globe the controls act on.
 * @param fullscreenElement - The element the fullscreen button expands.
 * @param labels - Translated tooltips; English defaults when omitted.
 */
export function createCesiumWidgetControls(
  viewer: CesiumWidget,
  fullscreenElement: HTMLElement,
  labels: CesiumWidgetControlLabels = DEFAULT_CESIUM_WIDGET_CONTROL_LABELS,
): CesiumWidgetControls {
  const fullscreen = new CesiumFullscreenControl(viewer, labels, fullscreenElement);
  return {
    all: [
      new CesiumHomeControl(viewer, labels),
      new CesiumSceneModeControl(viewer, labels),
      fullscreen,
    ],
    fullscreen,
  };
}
