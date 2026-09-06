import {
  availableCesiumBasemap,
  CESIUM_BASEMAPS,
  useAppStore,
  type CesiumBasemapId,
} from "@geolibre/core";
import { buildModuleUrl, type CesiumWidget } from "@cesium/engine";
import { BaseLayerPicker, ProviderViewModel } from "@cesium/widgets";
import type {
  CesiumWidgetControlHandle,
  CesiumWidgetControlLabels,
} from "./cesium-widget-controls";

/**
 * Native Cesium picker chrome with GeoLibre retaining ownership of the scene.
 * Imagery commands return an empty provider array and terrain commands are
 * cancelled through beforeExecute, so BaseLayerPicker only changes its selection.
 * The saved settings drive CesiumCanvas, which preserves background opacity and data-layer order.
 * Programmatic selection updates are guarded so opening a project never dirties it.
 */
export class CesiumBaseLayerPickerControl implements CesiumWidgetControlHandle {
  private container: HTMLDivElement | null = null;
  private picker: BaseLayerPicker | null = null;
  private stopWatching: (() => void) | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private syncing = false;
  private imagery = new Map<CesiumBasemapId, ProviderViewModel>();
  private terrain = new Map<boolean, ProviderViewModel>();

  constructor(
    private readonly viewer: CesiumWidget,
    private labels: CesiumWidgetControlLabels,
    private readonly hasIonToken: boolean,
  ) {}

  onAdd(): HTMLElement {
    const container = document.createElement("div");
    container.className = "maplibregl-ctrl geolibre-cesium-ctrl geolibre-cesium-basemap-picker";
    this.container = container;
    if (this.viewer.isDestroyed()) return container;

    for (const entry of CESIUM_BASEMAPS) {
      if ("assetId" in entry && !this.hasIonToken) continue;
      this.imagery.set(
        entry.id,
        new ProviderViewModel({
          name: entry.name,
          tooltip: entry.name,
          iconUrl: buildModuleUrl(`Widgets/Images/ImageryProviders/${entry.icon}`),
          category: "assetId" in entry ? "Cesium ion" : "GeoLibre",
          creationFunction: () => {
            if (!this.syncing) this.selectImagery(entry.id);
            return [];
          },
        }),
      );
    }
    for (const enabled of [false, true]) {
      if (enabled && !this.hasIonToken) continue;
      const name = enabled ? "Cesium World Terrain" : "WGS84 Ellipsoid";
      const model = new ProviderViewModel({
        name,
        tooltip: name,
        iconUrl: buildModuleUrl(
          `Widgets/Images/TerrainProviders/${enabled ? "CesiumWorldTerrain" : "Ellipsoid"}.png`,
        ),
        category: "",
        creationFunction: () => this.viewer.terrainProvider,
      });
      model.creationCommand.beforeExecute.addEventListener((event) => {
        // A cancelled command returns undefined, telling the picker to leave
        // the provider alone. The engine applies the saved terrain preference.
        event.cancel = true;
        if (!this.syncing) {
          const { preferences, setPreferences } = useAppStore.getState();
          if (preferences.map.terrainEnabled !== enabled) {
            setPreferences({
              ...preferences,
              map: { ...preferences.map, terrainEnabled: enabled },
            });
          }
        }
      });
      this.terrain.set(enabled, model);
    }

    // Start empty: Cesium otherwise executes the first imagery command during
    // construction, which would overwrite a saved selection.
    const picker = new BaseLayerPicker(container, { globe: this.viewer.scene.globe });
    this.picker = picker;
    picker.viewModel.imageryProviderViewModels = [...this.imagery.values()];
    picker.viewModel.terrainProviderViewModels = [...this.terrain.values()];
    this.syncSelection();
    this.setLabels(this.labels);
    this.stopWatching = useAppStore.subscribe((state, previous) => {
      if (
        state.preferences.map.cesiumBasemap !== previous.preferences.map.cesiumBasemap ||
        state.preferences.map.terrainEnabled !== previous.preferences.map.terrainEnabled
      ) {
        // The native setter publishes its observable *after* creationCommand.
        // Synchronize after that setter returns, avoiding reentrant selection.
        queueMicrotask(() => {
          if (this.picker === picker) this.syncSelection();
        });
      }
    });

    const button = container.querySelector("button")!;
    for (const item of container.querySelectorAll<HTMLElement>(".cesium-baseLayerPicker-item")) {
      item.tabIndex = 0;
      item.setAttribute("role", "radio");
    }
    container.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        picker.viewModel.dropDownVisible = false;
        button.focus();
        event.stopPropagation();
      } else if (
        (event.key === "Enter" || event.key === " ") &&
        event.target instanceof HTMLElement &&
        event.target.classList.contains("cesium-baseLayerPicker-item")
      ) {
        event.preventDefault();
        event.stopPropagation();
        event.target.click();
        button.focus();
      }
    });
    const resize = () => {
      const available =
        this.viewer.container.getBoundingClientRect().bottom -
        container.getBoundingClientRect().top -
        12;
      container.style.setProperty("--cesium-picker-height", `${Math.max(80, available)}px`);
    };
    this.resizeObserver = new ResizeObserver(resize);
    this.resizeObserver.observe(this.viewer.container);
    this.updateAccessibility();
    return container;
  }

  private selectImagery(id: CesiumBasemapId): void {
    const { preferences, setPreferences } = useAppStore.getState();
    if ((preferences.map.cesiumBasemap ?? "project") !== id) {
      setPreferences({ ...preferences, map: { ...preferences.map, cesiumBasemap: id } });
    }
  }

  private syncSelection(): void {
    if (!this.picker) return;
    const { map } = useAppStore.getState().preferences;
    this.syncing = true;
    try {
      const vm = this.picker.viewModel;
      const imagery = this.imagery.get(
        availableCesiumBasemap(map.cesiumBasemap, this.hasIonToken),
      )!;
      const terrain = this.terrain.get(map.terrainEnabled && this.hasIonToken)!;
      if (vm.selectedImagery !== imagery) vm.selectedImagery = imagery;
      if (vm.selectedTerrain !== terrain) vm.selectedTerrain = terrain;
    } finally {
      this.syncing = false;
    }
    this.updateAccessibility();
  }

  private updateAccessibility(): void {
    for (const item of this.container?.querySelectorAll(".cesium-baseLayerPicker-item") ?? []) {
      item.setAttribute(
        "aria-checked",
        String(item.classList.contains("cesium-baseLayerPicker-selectedItem")),
      );
    }
  }

  setLabels(labels: CesiumWidgetControlLabels): void {
    this.labels = labels;
    const project = this.imagery.get("project");
    if (project) {
      project.name = labels.projectBasemap ?? "Project basemap";
      project.tooltip = project.name;
    }
    const titles = this.container?.querySelectorAll(".cesium-baseLayerPicker-sectionTitle");
    if (titles?.[0]) titles[0].textContent = labels.imagery ?? "Imagery";
    if (titles?.[1]) titles[1].textContent = labels.terrain ?? "Terrain";
    this.container
      ?.querySelector("button")
      ?.setAttribute("aria-label", labels.basemap ?? "Basemap");
  }

  onRemove(): void {
    this.stopWatching?.();
    this.stopWatching = null;
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    if (this.picker && !this.picker.isDestroyed()) this.picker.destroy();
    this.picker = null;
    this.imagery.clear();
    this.terrain.clear();
    this.container?.remove();
    this.container = null;
  }
}
