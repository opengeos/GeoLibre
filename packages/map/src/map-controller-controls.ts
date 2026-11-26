// MapController layer: built-in map controls and the layer control.
// The MapController layer chain is documented in map-controller.ts.

import { BLANK_BASEMAP, DEFAULT_BASEMAP } from "@geolibre/core";
import * as maplibregl from "maplibre-gl";
import { LayerControlHost } from "./layer-control-host";
import { CollapsedAttributionControl } from "./collapsed-attribution-control";
import {
  highlightCircleLayerId,
  highlightFillLayerId,
  highlightLineLayerId,
} from "./geojson-loader";
import { EDGE_LENGTH_LAYER_ID } from "./edge-lengths";
import { PlanetaryScaleControl } from "./planetary-scale-control";
import { BLANK_BACKGROUND_LAYER_ID, isGeoLibreSentinelStyleUrl } from "./basemap-style";
import { ResetBearingControl } from "./reset-bearing-control";
import { MaptoolkitLogoControl } from "./maptoolkit-logo-control";
import type { BuiltInMapControl } from "./map-engine";
import { MapControllerTerrain } from "./map-controller-terrain";

/**
 * GeolocateControl is constructed through this indirection so tests can
 * substitute a fake. Assigning over `maplibregl.GeolocateControl` is not an
 * option: a MapLibre v6 ESM namespace is sealed and rejects assignment
 * (`TypeError: Cannot assign to property 'GeolocateControl' of [object Module]`).
 */
export const geolocateControlFactory = {
  create: (options: maplibregl.GeolocateControlOptions): maplibregl.GeolocateControl =>
    new maplibregl.GeolocateControl(options),
};

const LAYER_CONTROL_EXCLUDED_LAYERS = [
  BLANK_BACKGROUND_LAYER_ID,
  highlightFillLayerId(),
  highlightLineLayerId(),
  highlightCircleLayerId(),
  EDGE_LENGTH_LAYER_ID,
];

/**
 * Window event dispatched when the terrain control is removed (e.g. hidden from
 * the Controls menu), so the React layer closes the exaggeration dialog rather
 * than leaving it open with no terrain to affect.
 */
export const TERRAIN_SETTINGS_CLOSE_EVENT = "geolibre:terrain-settings-close";

/**
 * MapController layer: the built-in map controls (navigation, fullscreen,
 * compass, geolocate, globe, scale, attribution, logos) and the layer control.
 */
export class MapControllerControls extends MapControllerTerrain {
  private navigationControl: maplibregl.NavigationControl | null = null;

  private fullscreenControl: maplibregl.FullscreenControl | null = null;

  private compassControl: ResetBearingControl | null = null;

  private compassLabel = "Reset pitch & bearing";

  private geolocateControl: maplibregl.GeolocateControl | null = null;

  private globeControl: maplibregl.GlobeControl | null = null;

  protected scaleControl: PlanetaryScaleControl | null = null;

  private attributionControl: maplibregl.AttributionControl | null = null;

  private logoControl: maplibregl.LogoControl | null = null;

  private maptoolkitLogoControl: MaptoolkitLogoControl | null = null;

  // The on-map layer control, shared with the Mapbox engine; every callback
  // reads live controller state, so the host is safe to build before init().
  protected layerControlHost = new LayerControlHost({
    getMap: () => this.map,
    addControl: (control, position) => {
      this.map?.addControl(control, position);
    },
    removeControl: (control) => this.removeControl(control),
    getLayers: () => this.syncedLayers,
    getNativeLayerIds: (layer) => this.getNativeLayerIds(layer),
    getCandidateNativeLayerIds: (layer) => this.getCandidateStyleLayers(layer).map(({ id }) => id),
    getSourceIds: (layer) => this.getLayerSourceIds(layer),
    excludedLayerIds: LAYER_CONTROL_EXCLUDED_LAYERS,
    // Planetary, offline, and regional basemaps all use a non-fetchable
    // `geolibre://` sentinel (expanded to an inline style by resolveMapStyle);
    // like the blank basemap they have no URL the control could fetch, so the
    // host seeds it from getBasemapStyleLayerIds instead.
    getBasemapStyleUrl: () =>
      isGeoLibreSentinelStyleUrl(this.basemapStyleUrl) || this.basemapStyleUrl === BLANK_BASEMAP
        ? null
        : this.basemapStyleUrl,
    getBasemapLayerIds: () => this.getBasemapStyleLayerIds(),
    getBasemapState: () => ({ visible: this.basemapVisible, opacity: this.basemapOpacity }),
  });

  protected basemapStyleUrl = DEFAULT_BASEMAP;

  protected basemapVisible = true;

  protected basemapOpacity = 1;

  setBuiltInControlVisible(control: BuiltInMapControl, visible: boolean): boolean {
    this.controlVisibility[control] = visible;

    if (visible) {
      if (control === "navigation") return this.addNavigationControl();
      if (control === "fullscreen") return this.addFullscreenControl();
      if (control === "compass") return this.addCompassControl();
      if (control === "geolocate") return this.addGeolocateControl();
      if (control === "globe") return this.addGlobeControl();
      if (control === "terrain") {
        const added = this.addTerrainControl();
        // Turning the Terrain control on should show 3D relief immediately, so
        // users don't have to click the control button as a second step.
        this.autoEnableTerrain();
        return added;
      }
      if (control === "scale") return this.addScaleControl();
      if (control === "attribution") return this.addAttributionControl();
      if (control === "logo") return this.addLogoControl();
      if (control === "maptoolkit-logo") return this.addMaptoolkitLogoControl();
      return this.addLayerControl();
    }

    if (control === "navigation") this.removeNavigationControl();
    else if (control === "fullscreen") this.removeFullscreenControl();
    else if (control === "compass") this.removeCompassControl();
    else if (control === "geolocate") this.removeGeolocateControl();
    else if (control === "globe") this.removeGlobeControl();
    else if (control === "terrain") {
      this.removeTerrainControl();
      // Terrain is genuinely being hidden here (not repositioned, which goes
      // through removeBuiltInControl), so close the exaggeration dialog — it has
      // no control to act on now.
      window.dispatchEvent(new CustomEvent(TERRAIN_SETTINGS_CLOSE_EVENT));
    } else if (control === "scale") this.removeScaleControl();
    else if (control === "attribution") this.removeAttributionControl();
    else if (control === "logo") this.removeLogoControl();
    else if (control === "maptoolkit-logo") this.removeMaptoolkitLogoControl();
    else this.removeLayerControl();
    return true;
  }

  getBuiltInControlPosition(control: BuiltInMapControl): maplibregl.ControlPosition {
    return this.controlPositions[control];
  }

  setBuiltInControlPosition(
    control: BuiltInMapControl,
    position: maplibregl.ControlPosition,
  ): boolean {
    this.controlPositions[control] = position;
    if (!this.controlVisibility[control]) return true;

    this.removeBuiltInControl(control);
    return this.addBuiltInControl(control);
  }

  protected addLayerControl(): boolean {
    if (!this.map || !this.controlVisibility["layer-control"]) return false;
    return (
      this.layerControlHost.add(this.controlPositions["layer-control"]) ||
      this.layerControlHost.isMounted()
    );
  }

  protected removeLayerControl(): void {
    this.layerControlHost.remove();
  }

  protected refreshLayerControl(): void {
    if (!this.controlVisibility["layer-control"]) return;
    this.layerControlHost.refresh();
  }

  protected syncLayerControlState(): void {
    this.layerControlHost.syncState();
  }

  protected addNavigationControl(): boolean {
    if (!this.map || this.navigationControl || !this.controlVisibility.navigation) {
      return false;
    }
    this.navigationControl = new maplibregl.NavigationControl();
    this.map.addControl(this.navigationControl, this.controlPositions.navigation);
    return true;
  }

  protected removeNavigationControl(): void {
    if (!this.navigationControl) return;
    this.removeControl(this.navigationControl);
    this.navigationControl = null;
  }

  protected addFullscreenControl(): boolean {
    if (!this.map || this.fullscreenControl || !this.controlVisibility.fullscreen) {
      return false;
    }
    // Fullscreen the map container so only the map canvas (and its floating
    // controls) fills the screen. MapLibre defaults to `map.getContainer()`,
    // which is what we want here. The surrounding workspace chrome (toolbar and
    // side panels) is hidden by the app while fullscreen is active: Chromium
    // promotes the fullscreen element to the top layer so the chrome is hidden
    // automatically, but WebKit (the Tauri desktop webview) leaves it painted
    // around the map, so the app hides it via CSS. See opengeos/GeoLibre#611.
    this.fullscreenControl = new maplibregl.FullscreenControl();
    this.map.addControl(this.fullscreenControl, this.controlPositions.fullscreen);
    return true;
  }

  protected removeFullscreenControl(): void {
    if (!this.fullscreenControl) return;
    this.removeControl(this.fullscreenControl);
    this.fullscreenControl = null;
  }

  protected addCompassControl(): boolean {
    if (!this.map || this.compassControl || !this.controlVisibility.compass) {
      return false;
    }
    this.compassControl = new ResetBearingControl({
      label: this.compassLabel,
    });
    this.map.addControl(this.compassControl, this.controlPositions.compass);
    return true;
  }

  protected removeCompassControl(): void {
    if (!this.compassControl) return;
    this.removeControl(this.compassControl);
    this.compassControl = null;
  }

  /**
   * Update the compass control's tooltip/aria label, e.g. after a UI language
   * change. The label is cached so a control re-added after a full map
   * reinitialisation picks up the latest translation without an extra call.
   */
  setCompassLabel(label: string): void {
    this.compassLabel = label;
    this.compassControl?.setLabel(label);
  }

  /**
   * Update the label used for the grouped base layer (e.g. after a UI language
   * change). It is published through the layer-display-name bridge so the
   * Layer Swipe panel, which lives outside React, shows the same translated
   * base-layer label as the main layer manager.
   */
  setBackgroundLabel(label: string): void {
    this.backgroundLabel = label;
    this.publishLayerDisplayNames(this.syncedLayers);
  }

  protected addGeolocateControl(): boolean {
    if (!this.map || this.geolocateControl || !this.controlVisibility.geolocate) {
      return false;
    }
    const control = geolocateControlFactory.create({
      positionOptions: {
        enableHighAccuracy: true,
      },
      trackUserLocation: true,
    });
    // MapLibre permanently disables the GeolocateControl button on a
    // PERMISSION_DENIED error (code 1). Browsers report code 1 both for a real
    // denial and when the user simply dismisses the permission prompt without
    // choosing, which leaves the button stuck in a blocked state with no way to
    // retry (issue #839). Re-create the control whenever the permission was not
    // actually denied so the button returns to a neutral, clickable state.
    control.on("error", this.handleGeolocateError);
    this.geolocateControl = control;
    this.map.addControl(control, this.controlPositions.geolocate);
    return true;
  }

  private handleGeolocateError = (event: { code?: number }): void => {
    // Only react to PERMISSION_DENIED; other errors (timeout, position
    // unavailable) leave the button usable, so MapLibre's own handling is fine.
    if (!this.map || !this.geolocateControl || event?.code !== 1) return;

    // Snapshot the control that errored. The reset always runs in a later
    // microtask (the Permissions API query's `.then`, or `queueMicrotask`), so
    // we never tear down the control mid error-dispatch. It also means the
    // control could be torn down or replaced in between (e.g. the user toggles
    // it off then on), so recreate() bails unless this exact instance is still
    // mounted and never disturbs a healthy replacement.
    const controlAtError = this.geolocateControl;

    const recreate = (): void => {
      if (!this.map || !this.controlVisibility.geolocate) return;
      if (this.geolocateControl !== controlAtError) return;
      // Re-create the control to clear MapLibre's permanently-disabled button.
      this.removeGeolocateControl();
      this.addGeolocateControl();
    };

    const permissions = typeof navigator !== "undefined" ? navigator.permissions : undefined;
    if (!permissions?.query) {
      // No Permissions API: assume a dismissal so the user is never stuck.
      queueMicrotask(recreate);
      return;
    }
    try {
      permissions
        .query({ name: "geolocation" as PermissionName })
        .then((status) => {
          // Only a pending "prompt" means the dialog was dismissed, so reset to
          // allow a retry. "denied" keeps MapLibre's disabled state, and
          // "granted" (a contradictory code-1) is left alone rather than reset.
          if (status.state === "prompt") recreate();
        })
        .catch(() => recreate());
    } catch {
      // Some Permissions API implementations throw synchronously (partial
      // support, CSP, private browsing). Fall back to a deferred reset so the
      // user is never stuck.
      queueMicrotask(recreate);
    }
  };

  protected removeGeolocateControl(): void {
    if (!this.geolocateControl) return;
    this.geolocateControl.off("error", this.handleGeolocateError);
    this.removeControl(this.geolocateControl);
    this.geolocateControl = null;
  }

  protected addGlobeControl(): boolean {
    if (!this.map || this.globeControl || !this.controlVisibility.globe || this.activeCrs) {
      return false;
    }
    this.globeControl = new maplibregl.GlobeControl();
    this.map.addControl(this.globeControl, this.controlPositions.globe);
    return true;
  }

  protected removeGlobeControl(): void {
    if (!this.globeControl) return;
    this.removeControl(this.globeControl);
    this.globeControl = null;
  }

  protected addScaleControl(): boolean {
    if (!this.map || this.scaleControl || !this.controlVisibility.scale) {
      return false;
    }
    // A body-aware scale bar (MapLibre's built-in ScaleControl assumes Earth's
    // radius, so it is wrong on Moon/Mars/Mercury/etc.). The unit system follows
    // the project's map preference (metric / imperial / nautical).
    this.scaleControl = new PlanetaryScaleControl({
      maxWidth: 120,
      unit: this.mapPreferences.scaleUnit,
    });
    this.map.addControl(this.scaleControl, this.controlPositions.scale);
    return true;
  }

  protected removeScaleControl(): void {
    if (!this.scaleControl) return;
    this.removeControl(this.scaleControl);
    this.scaleControl = null;
  }

  protected addAttributionControl(): boolean {
    if (!this.map || this.attributionControl || !this.controlVisibility.attribution) {
      return false;
    }
    this.attributionControl = new CollapsedAttributionControl();
    this.map.addControl(this.attributionControl, this.controlPositions.attribution);
    return true;
  }

  protected removeAttributionControl(): void {
    if (!this.attributionControl) return;
    this.removeControl(this.attributionControl);
    this.attributionControl = null;
  }

  protected addLogoControl(): boolean {
    if (!this.map || this.logoControl || !this.controlVisibility.logo) {
      return false;
    }
    this.logoControl = new maplibregl.LogoControl();
    this.map.addControl(this.logoControl, this.controlPositions.logo);
    return true;
  }

  protected removeLogoControl(): void {
    if (!this.logoControl) return;
    this.removeControl(this.logoControl);
    this.logoControl = null;
  }

  protected addMaptoolkitLogoControl(): boolean {
    if (!this.map || this.maptoolkitLogoControl || !this.controlVisibility["maptoolkit-logo"]) {
      return false;
    }
    this.maptoolkitLogoControl = new MaptoolkitLogoControl();
    this.map.addControl(this.maptoolkitLogoControl, this.controlPositions["maptoolkit-logo"]);
    return true;
  }

  protected removeMaptoolkitLogoControl(): void {
    if (!this.maptoolkitLogoControl) return;
    this.removeControl(this.maptoolkitLogoControl);
    this.maptoolkitLogoControl = null;
  }

  private addBuiltInControl(control: BuiltInMapControl): boolean {
    if (control === "navigation") return this.addNavigationControl();
    if (control === "fullscreen") return this.addFullscreenControl();
    if (control === "compass") return this.addCompassControl();
    if (control === "geolocate") return this.addGeolocateControl();
    if (control === "globe") return this.addGlobeControl();
    if (control === "terrain") return this.addTerrainControl();
    if (control === "scale") return this.addScaleControl();
    if (control === "attribution") return this.addAttributionControl();
    if (control === "logo") return this.addLogoControl();
    if (control === "maptoolkit-logo") return this.addMaptoolkitLogoControl();
    return this.addLayerControl();
  }

  private removeBuiltInControl(control: BuiltInMapControl): void {
    if (control === "navigation") this.removeNavigationControl();
    else if (control === "fullscreen") this.removeFullscreenControl();
    else if (control === "compass") this.removeCompassControl();
    else if (control === "geolocate") this.removeGeolocateControl();
    else if (control === "globe") this.removeGlobeControl();
    else if (control === "terrain") this.removeTerrainControl();
    else if (control === "scale") this.removeScaleControl();
    else if (control === "attribution") this.removeAttributionControl();
    else if (control === "logo") this.removeLogoControl();
    else if (control === "maptoolkit-logo") this.removeMaptoolkitLogoControl();
    else this.removeLayerControl();
  }
}
