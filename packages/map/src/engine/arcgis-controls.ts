import type { BuiltInMapControl, MapControlPosition, MapControlState } from "./types";

export interface ArcGISControlWidget {
  label?: string;
  destroy?(): void;
}

export interface ArcGISControlUI {
  add(component: ArcGISControlWidget, position: MapControlPosition): void;
  move(component: ArcGISControlWidget, position: MapControlPosition): void;
  remove(component: ArcGISControlWidget | string): void;
}

export interface ArcGISControlView {
  readonly ui: ArcGISControlUI;
}

export interface ArcGISControlModules {
  readonly Zoom: new (properties: { readonly view: ArcGISControlView }) => ArcGISControlWidget;
  readonly Compass: new (properties: { readonly view: ArcGISControlView }) => ArcGISControlWidget;
  readonly Fullscreen: new (properties: { readonly view: ArcGISControlView }) => ArcGISControlWidget;
  readonly Locate: new (properties: { readonly view: ArcGISControlView }) => ArcGISControlWidget;
  readonly ScaleBar: new (properties: {
    readonly view: ArcGISControlView;
    readonly unit: "metric";
  }) => ArcGISControlWidget;
}

const defaultVisibility: Readonly<Record<BuiltInMapControl, boolean>> = {
  navigation: false,
  fullscreen: true,
  compass: true,
  geolocate: false,
  globe: false,
  terrain: false,
  scale: true,
  attribution: true,
  logo: false,
  "layer-control": false,
};

const defaultPositions: Readonly<Record<BuiltInMapControl, MapControlPosition>> = {
  navigation: "top-right",
  fullscreen: "top-right",
  compass: "top-right",
  geolocate: "top-right",
  globe: "top-right",
  terrain: "top-right",
  scale: "bottom-left",
  attribution: "bottom-right",
  logo: "bottom-left",
  "layer-control": "top-right",
};

const supportedControls = new Set<BuiltInMapControl>([
  "navigation",
  "fullscreen",
  "compass",
  "geolocate",
  "scale",
]);

/**
 * Adapter-private mapping from GeoLibre controls to documented ArcGIS widgets.
 *
 * It intentionally omits LayerList: allowing it to alter a native layer's
 * visibility would make the SDK, rather than the GeoLibre store, authoritative.
 * ArcGIS attribution remains native and visible; the manager never removes it.
 */
export class ArcGISControls {
  private readonly visibility = { ...defaultVisibility };
  private readonly positions = { ...defaultPositions };
  private readonly widgets = new Map<BuiltInMapControl, ArcGISControlWidget>();
  private view: ArcGISControlView | null = null;
  private modules: ArcGISControlModules | null = null;
  private readonly supportsScale: boolean;

  constructor(options: { readonly supportsScale: boolean }) {
    this.supportsScale = options.supportsScale;
  }

  initialize(view: ArcGISControlView, modules: ArcGISControlModules): void {
    this.destroy();
    this.view = view;
    this.modules = modules;

    // These documented default widget IDs are replaced with adapter-owned
    // instances so visibility and position have one authoritative owner.
    view.ui.remove("zoom");
    view.ui.remove("compass");
    for (const control of supportedControls) this.reconcile(control);
  }

  destroy(): void {
    for (const widget of this.widgets.values()) {
      this.view?.ui.remove(widget);
      widget.destroy?.();
    }
    this.widgets.clear();
    this.view = null;
    this.modules = null;
  }

  getBuiltInState(control: BuiltInMapControl): MapControlState {
    return { visible: this.visibility[control], position: this.positions[control] };
  }

  setBuiltInState(control: BuiltInMapControl, state: Partial<MapControlState>): boolean {
    if (control === "attribution") {
      // Required credits must remain displayed. Its placement is owned by the SDK.
      return state.visible === undefined && state.position === undefined;
    }
    if (!this.isSupported(control)) return false;
    if (typeof state.visible === "boolean") this.visibility[control] = state.visible;
    if (state.position) this.positions[control] = state.position;
    this.reconcile(control);
    return true;
  }

  setLabels(labels: Partial<Record<"compass" | "terrain" | "background", string>>): void {
    const compass = this.widgets.get("compass");
    if (compass && labels.compass) compass.label = labels.compass;
  }

  private isSupported(control: BuiltInMapControl): boolean {
    return supportedControls.has(control) && (control !== "scale" || this.supportsScale);
  }

  private reconcile(control: BuiltInMapControl): void {
    if (!this.isSupported(control) || !this.view || !this.modules) return;
    const existing = this.widgets.get(control);
    if (!this.visibility[control]) {
      if (existing) {
        this.view.ui.remove(existing);
        existing.destroy?.();
        this.widgets.delete(control);
      }
      return;
    }
    const widget = existing ?? this.createWidget(control);
    if (!widget) return;
    if (!existing) {
      this.widgets.set(control, widget);
      this.view.ui.add(widget, this.positions[control]);
    } else {
      this.view.ui.move(widget, this.positions[control]);
    }
  }

  private createWidget(control: BuiltInMapControl): ArcGISControlWidget | null {
    if (!this.view || !this.modules) return null;
    if (control === "navigation") return new this.modules.Zoom({ view: this.view });
    if (control === "fullscreen") return new this.modules.Fullscreen({ view: this.view });
    if (control === "compass") return new this.modules.Compass({ view: this.view });
    if (control === "geolocate") return new this.modules.Locate({ view: this.view });
    if (control === "scale") return new this.modules.ScaleBar({ view: this.view, unit: "metric" });
    return null;
  }
}
