// ArcgisEngine layer: basemap and story-map layer opacity.
// The ArcgisEngine layer chain is documented in arcgis-engine.ts.

import { planArcgisBasemap, type ArcgisBasemapPlan, sameArcgisBasemapPlan } from "./arcgis-basemap";
import { redactArcgisError, type ArcgisLayer } from "./arcgis-sdk";
import { ArcgisEngineLayers } from "./arcgis-engine-layers";

/**
 * ArcgisEngine layer: the basemap (style, visibility, opacity, blank
 * background) and story-map layer opacity.
 */
export class ArcgisEngineBasemap extends ArcgisEngineLayers {
  private basemapPlan: ArcgisBasemapPlan | null = null;

  private basemapVisible = true;

  private basemapOpacity = 1;

  private blankColor: string | null = null;

  /** Animation frames of the story opacity fades in flight, by layer id. */
  protected storyFades = new Map<string, number>();

  // ------------------------------------------------------------------ basemap

  /**
   * Draw the basemap for the shared project style and the ArcGIS override.
   * The canvas calls this on mount and whenever either preference changes.
   */
  setBasemap(styleUrl: string | undefined, arcgisBasemap: string | undefined): void {
    // The SDK cannot reproject tiled layers, so a map in a projection other
    // than Web Mercator has no basemap: the Blank background shows instead.
    const plan: ArcgisBasemapPlan = this.options.projectOperator
      ? { kind: "none" }
      : planArcgisBasemap(styleUrl, arcgisBasemap, this.options.hasApiKey === true);
    if (this.basemapPlan && sameArcgisBasemapPlan(this.basemapPlan, plan)) return;
    this.basemapPlan = plan;
    const map = this.map;
    if (!map) return;
    this.errors.delete("basemap");
    const previous = map.basemap;
    switch (plan.kind) {
      case "none":
        map.basemap = null;
        break;
      case "esri-style":
        // A string id autocasts to a basemap styles service basemap.
        (map as unknown as { basemap: unknown }).basemap = plan.id;
        break;
      case "tile-service":
        map.basemap = new this.sdk.Basemap({
          baseLayers: [new this.sdk.layers.TileLayer({ url: plan.url })],
        });
        break;
      case "web-tile":
        map.basemap = new this.sdk.Basemap({
          baseLayers: [
            new this.sdk.layers.WebTileLayer({
              urlTemplate: plan.urlTemplate,
              ...(plan.subDomains ? { subDomains: plan.subDomains } : {}),
              copyright: plan.copyright,
            }),
            ...(plan.overlay
              ? [
                  new this.sdk.layers.WebTileLayer({
                    urlTemplate: plan.overlay.urlTemplate,
                    ...(plan.overlay.subDomains ? { subDomains: plan.overlay.subDomains } : {}),
                    copyright: plan.copyright,
                  }),
                ]
              : []),
          ],
        });
        break;
    }
    if (previous && previous !== map.basemap) previous.destroy?.();
    this.applyBasemap();
    // A named Esri style fills its layers asynchronously; re-apply the stored
    // visibility and opacity once they exist, and surface a style that fails
    // to load (a key without the basemaps privilege, say).
    const current = map.basemap;
    if (current && typeof current === "object" && typeof current.when === "function") {
      void current
        .when()
        .then(() => {
          if (this.map?.basemap === current) this.applyBasemap();
        })
        .catch((error: unknown) => {
          if (this.map?.basemap === current)
            this.errors.set(
              "basemap",
              `Basemap: ${redactArcgisError((error as Error)?.message ?? String(error))}`,
            );
        });
    }
  }

  setStyle(url: string): void {
    this.setBasemap(url, undefined);
  }

  getBasemapStyleLayerIds(): string[] {
    return [];
  }

  setBasemapVisible(visible: boolean): void {
    this.basemapVisible = visible;
    this.applyBasemap();
  }

  setBasemapOpacity(opacity: number): void {
    this.basemapOpacity = opacity;
    this.applyBasemap();
  }

  private applyBasemap(): void {
    const basemap = this.map?.basemap;
    if (!basemap || typeof basemap !== "object" || !basemap.baseLayers) return;
    const apply = (layer: ArcgisLayer) => {
      layer.visible = this.basemapVisible;
      layer.opacity = this.basemapOpacity;
    };
    basemap.baseLayers.forEach(apply);
    basemap.referenceLayers?.forEach(apply);
  }

  setBlankBackgroundColor(color: string | null): void {
    this.blankColor = color;
    const view = this.view;
    if (!view) return;
    const fill =
      color ?? (document.documentElement.classList.contains("dark") ? "#262626" : "#ffffff");
    if (view.type === "2d") {
      view.background = { type: "color", color: fill };
      return;
    }
    // A scene has no background behind the map: what shows without a basemap
    // is the ground's surface. A global scene keeps its sky around the globe.
    if (this.map?.ground) this.map.ground.surfaceColor = fill;
    if (view.viewingMode === "local") view.environment.background = { type: "color", color: fill };
  }

  // ---------------------------------------------------------- story rendering

  setStoryLayerOpacity(id: string, opacity: number, durationMs = 0): void {
    const target = Math.min(1, Math.max(0, opacity));
    const from = this.natives.get(id)?.layers[0]?.opacity;
    this.cancelStoryFade(id);
    this.storyOpacities.set(id, target);
    // The sync applies the target (and builds the layer if it is new).
    this.syncLayers(this.layers);
    const natives = this.natives.get(id)?.layers ?? [];
    if (
      durationMs <= 0 ||
      from === undefined ||
      from === target ||
      !natives.length ||
      typeof requestAnimationFrame === "undefined"
    )
      return;
    // Fade from where the layer was, over the chapter's transition, as
    // MapLibre's paint-property transition does.
    const start = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / durationMs);
      for (const native of natives) native.opacity = from + (target - from) * t;
      if (t < 1) this.storyFades.set(id, requestAnimationFrame(step));
      else this.storyFades.delete(id);
    };
    for (const native of natives) native.opacity = from;
    this.storyFades.set(id, requestAnimationFrame(step));
  }

  /** Stop a running story fade, leaving the layer at whatever the sync last applied. */
  protected cancelStoryFade(id: string): void {
    const frame = this.storyFades.get(id);
    if (frame !== undefined) cancelAnimationFrame(frame);
    this.storyFades.delete(id);
  }

  restoreLayerStyles(): void {
    for (const id of [...this.storyFades.keys()]) this.cancelStoryFade(id);
    this.storyOpacities.clear();
    this.syncLayers(this.layers);
  }
}
