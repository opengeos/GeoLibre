import type * as maplibregl from "maplibre-gl";
import type { CesiumWidget } from "@cesium/engine";

// Cesium's own toolbar widgets, mounted on GeoLibre's map as regular map
// controls (issue #2270).
//
// `CesiumCanvas` builds a bare `CesiumWidget` rather than a `Viewer`, precisely
// so it does not inherit the toolbar Cesium's full app wrapper constructs —
// base-layer picker, geocoder, home button, scene-mode picker, help button,
// timeline, animation dial, info box — most of which duplicate something
// GeoLibre already owns. Two of them do not: nothing else in the app returns the
// camera to a whole-Earth view, and nothing at all reaches Cesium's 2D and
// Columbus scene modes.
//
// Each widget is constructible on its own against a container element, so
// neither needs `Viewer`. They are wrapped as `maplibregl.IControl`s so
// `CesiumControlHost` positions and tears them down exactly like every other
// control on the map.
//
// This module is reached only through a dynamic import inside `CesiumCanvas`'s
// mount effect: `@cesium/widgets` is a static import below, and a static import
// from `CesiumCanvas` would pull the widget chrome (and Knockout) onto the 2D
// boot path instead of leaving it in the lazily fetched `cesium` chunk.

import { HomeButton, SceneModePicker } from "@cesium/widgets";

/**
 * Scene-morph duration, in seconds. Cesium defaults to 2 s, which reads as a
 * stall on a map the rest of the app animates in well under one; this matches
 * `MapController.flyTo`'s 800 ms, the longest camera animation GeoLibre runs.
 */
const MORPH_SECONDS = 0.8;

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
}

/** English fallbacks, used until the app pushes translated labels in. */
export const DEFAULT_CESIUM_WIDGET_CONTROL_LABELS: CesiumWidgetControlLabels = Object.freeze({
  home: "Reset view",
  sceneMode3D: "3D globe",
  sceneMode2D: "2D map",
  sceneModeColumbus: "Columbus view",
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

  onAdd(): HTMLElement {
    const container = document.createElement("div");
    // `maplibregl-ctrl` supplies the corner stacking and margins every control
    // in the container shares. `maplibregl-ctrl-group` is deliberately absent:
    // it draws MapLibre's own white button chrome, which would show as a frame
    // around the Cesium button sitting inside it.
    container.className = `maplibregl-ctrl ${CONTROL_CLASS}`;
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
 * re-applies the stored view on `morphComplete`.
 */
class CesiumSceneModeControl extends CesiumWidgetControl<SceneModePicker> {
  protected create(container: HTMLElement): SceneModePicker {
    return new SceneModePicker(container, this.viewer.scene, MORPH_SECONDS);
  }

  protected applyLabels(widget: SceneModePicker): void {
    widget.viewModel.tooltip3D = this.labels.sceneMode3D;
    widget.viewModel.tooltip2D = this.labels.sceneMode2D;
    widget.viewModel.tooltipColumbusView = this.labels.sceneModeColumbus;
  }
}

/** A control built by {@link createCesiumWidgetControls}. */
export type CesiumWidgetControlHandle = maplibregl.IControl & {
  setLabels(labels: CesiumWidgetControlLabels): void;
};

/**
 * Build the Cesium toolbar controls for a globe.
 *
 * Returned rather than mounted so the caller decides placement and keeps the
 * handles it needs to retranslate and remove them; `CesiumCanvas` adds them to
 * the primary globe's control host and drops them on unmount.
 */
export function createCesiumWidgetControls(
  viewer: CesiumWidget,
  labels: CesiumWidgetControlLabels = DEFAULT_CESIUM_WIDGET_CONTROL_LABELS,
): CesiumWidgetControlHandle[] {
  return [new CesiumHomeControl(viewer, labels), new CesiumSceneModeControl(viewer, labels)];
}
