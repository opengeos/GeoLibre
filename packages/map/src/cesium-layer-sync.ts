import type { GeoLibreLayer } from "@geolibre/core";
import type {
  Cesium3DTileset,
  DataSource,
  ImageryLayer,
  Viewer,
} from "cesium";

// Reconciles the store's `GeoLibreLayer[]` onto a Cesium globe, mirroring what
// MapController.syncLayers does for MapLibre. M3 covers the layer kinds where
// Cesium is the natural renderer: GeoJSON (as a draped GeoJsonDataSource), XYZ /
// WMS / WMTS / raster tiles (as ImageryLayers), and 3D Tiles (as a
// Cesium3DTileset). Other kinds are skipped on the globe (they still render in
// the 2D panes); `unsupported()` reports them so the UI can hint at the gap.
//
// The engine is injected (the `Cesium` namespace + a `Viewer`) so this module
// carries only type-only Cesium imports and never pulls the engine into the
// build graph itself.

type CesiumNs = typeof import("cesium");

/** Layer kinds this pass renders on the globe. */
const IMAGERY_TYPES = new Set(["raster", "xyz", "wms", "wmts"]);

type EntryKind = "imagery" | "geojson" | "3dtiles";

interface LayerEntry {
  kind: EntryKind;
  /** The layer as last applied, for change detection. */
  layer: GeoLibreLayer;
  /** The Cesium object, or null while an async create is in flight. */
  handle: ImageryLayer | DataSource | Cesium3DTileset | null;
  /** Set when the entry is removed mid-load so the resolved handle is discarded. */
  cancelled: boolean;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function firstTile(layer: GeoLibreLayer): string | undefined {
  const tiles = layer.source.tiles;
  return Array.isArray(tiles) ? str(tiles[0]) : undefined;
}

function tilesetUrl(layer: GeoLibreLayer): string | undefined {
  return str(layer.source.url) ?? str(layer.sourcePath);
}

/** Whether the globe can render this layer at all (see the module header). */
function isSupported(layer: GeoLibreLayer): boolean {
  if (layer.type === "geojson") {
    return Boolean(layer.geojson?.features?.length);
  }
  if (layer.type === "3d-tiles") return Boolean(tilesetUrl(layer));
  if (IMAGERY_TYPES.has(layer.type)) {
    return Boolean(firstTile(layer) || str(layer.source.url));
  }
  return false;
}

function entryKind(layer: GeoLibreLayer): EntryKind {
  if (layer.type === "geojson") return "geojson";
  if (layer.type === "3d-tiles") return "3dtiles";
  return "imagery";
}

function styleSignature(layer: GeoLibreLayer): string {
  const style = layer.style ?? {};
  return [
    layer.opacity,
    style.fillColor,
    style.fillOpacity,
    style.strokeColor,
    style.strokeWidth,
    style.markerColor,
  ].join("|");
}

/**
 * Whether the Cesium object must be rebuilt (vs. just re-styled) for the change
 * from `prev` to `next`. Live-settable appearance (visibility, imagery alpha) is
 * excluded; only source/data/geometry changes force a rebuild. The GeoJSON
 * FeatureCollection is compared by reference (the store swaps it on edit) and
 * its style/opacity fold into the Cesium colours at load, so both rebuild.
 */
function needsRebuild(prev: GeoLibreLayer, next: GeoLibreLayer): boolean {
  if (prev.type !== next.type) return true;
  switch (entryKind(next)) {
    case "geojson":
      return (
        prev.geojson !== next.geojson ||
        styleSignature(prev) !== styleSignature(next)
      );
    case "imagery":
      return (
        firstTile(prev) !== firstTile(next) ||
        str(prev.source.url) !== str(next.source.url) ||
        str(prev.source.layers) !== str(next.source.layers)
      );
    case "3dtiles":
      return (
        tilesetUrl(prev) !== tilesetUrl(next) ||
        JSON.stringify(prev.source.requestHeaders ?? null) !==
          JSON.stringify(next.source.requestHeaders ?? null) ||
        prev.source.altitudeOffset !== next.source.altitudeOffset
      );
  }
}

export class CesiumLayerSync {
  private readonly entries = new Map<string, LayerEntry>();

  constructor(
    private readonly Cesium: CesiumNs,
    private readonly viewer: Viewer,
  ) {}

  /** Reconcile the globe to `layers` (order preserved for imagery stacking). */
  sync(layers: GeoLibreLayer[]): void {
    const nextIds = new Set(layers.map((l) => l.id));
    for (const [id, entry] of this.entries) {
      if (!nextIds.has(id)) {
        this.destroyEntry(entry);
        this.entries.delete(id);
      }
    }

    for (const layer of layers) {
      if (!isSupported(layer)) {
        // A previously-supported layer that became unrenderable (e.g. its data
        // was cleared) is torn down.
        const stale = this.entries.get(layer.id);
        if (stale) {
          this.destroyEntry(stale);
          this.entries.delete(layer.id);
        }
        continue;
      }

      const existing = this.entries.get(layer.id);
      if (!existing) {
        this.createEntry(layer);
      } else if (needsRebuild(existing.layer, layer)) {
        this.destroyEntry(existing);
        this.entries.delete(layer.id);
        this.createEntry(layer);
      } else {
        existing.layer = layer;
        this.applyAppearance(existing);
      }
    }
  }

  /** Layer ids present but not renderable on the globe (for a UI hint). */
  unsupported(layers: GeoLibreLayer[]): GeoLibreLayer[] {
    return layers.filter((l) => !isSupported(l));
  }

  destroy(): void {
    for (const entry of this.entries.values()) this.destroyEntry(entry);
    this.entries.clear();
  }

  private createEntry(layer: GeoLibreLayer): void {
    const kind = entryKind(layer);
    const entry: LayerEntry = { kind, layer, handle: null, cancelled: false };
    this.entries.set(layer.id, entry);
    if (kind === "imagery") this.createImagery(entry);
    else if (kind === "geojson") void this.createGeoJson(entry);
    else void this.createTileset(entry);
  }

  private createImagery(entry: LayerEntry): void {
    const { Cesium, viewer } = this;
    const layer = entry.layer;
    let provider;
    if (layer.type === "wms" && str(layer.source.url)) {
      provider = new Cesium.WebMapServiceImageryProvider({
        url: String(layer.source.url),
        layers: String(layer.source.layers ?? ""),
        parameters: { transparent: true, format: "image/png" },
      });
    } else {
      const url = firstTile(layer);
      if (!url) return;
      const maxLevel = Number(layer.source.maxzoom);
      provider = new Cesium.UrlTemplateImageryProvider({
        url,
        maximumLevel: Number.isFinite(maxLevel) ? maxLevel : undefined,
      });
    }
    // addImageryProvider appends above the base imagery (and earlier store
    // layers), so store order maps to Cesium's bottom-to-top stacking.
    const imageryLayer = viewer.imageryLayers.addImageryProvider(provider);
    entry.handle = imageryLayer;
    this.applyAppearance(entry);
  }

  private async createGeoJson(entry: LayerEntry): Promise<void> {
    const { Cesium, viewer } = this;
    const layer = entry.layer;
    if (!layer.geojson) return;
    const style = layer.style ?? {};
    const fill = Cesium.Color.fromCssColorString(style.fillColor ?? "#3b82f6");
    const stroke = Cesium.Color.fromCssColorString(
      style.strokeColor ?? "#1e40af",
    );
    try {
      const dataSource = await Cesium.GeoJsonDataSource.load(layer.geojson, {
        stroke,
        strokeWidth: style.strokeWidth ?? 2,
        // Fold the layer + fill opacity into the fill colour (a GeoJsonDataSource
        // has no global alpha); an opacity change rebuilds via identity().
        fill: fill.withAlpha((style.fillOpacity ?? 0.6) * layer.opacity),
        markerColor: Cesium.Color.fromCssColorString(
          style.markerColor ?? "#3b82f6",
        ),
        clampToGround: true,
      });
      if (entry.cancelled) return;
      await viewer.dataSources.add(dataSource);
      if (entry.cancelled) {
        viewer.dataSources.remove(dataSource, true);
        return;
      }
      entry.handle = dataSource;
      this.applyAppearance(entry);
    } catch {
      // A malformed FeatureCollection should not break the whole sync.
    }
  }

  private async createTileset(entry: LayerEntry): Promise<void> {
    const { Cesium, viewer } = this;
    const layer = entry.layer;
    const url = tilesetUrl(layer);
    if (!url) return;
    const headers = layer.source.requestHeaders as
      | Record<string, string>
      | undefined;
    const resource =
      headers && Object.keys(headers).length
        ? new Cesium.Resource({ url, headers })
        : url;
    try {
      const tileset = await Cesium.Cesium3DTileset.fromUrl(resource, {});
      if (entry.cancelled) {
        tileset.destroy();
        return;
      }
      viewer.scene.primitives.add(tileset);
      this.applyTilesetAltitude(tileset, Number(layer.source.altitudeOffset));
      entry.handle = tileset;
      this.applyAppearance(entry);
    } catch {
      // A tileset that fails to load should not break the whole sync.
    }
  }

  /** Raise/lower a tileset by an altitude offset (metres) at its centre. */
  private applyTilesetAltitude(tileset: Cesium3DTileset, offset: number): void {
    if (!Number.isFinite(offset) || offset === 0) return;
    const { Cesium } = this;
    const carto = Cesium.Cartographic.fromCartesian(
      tileset.boundingSphere.center,
    );
    const surface = Cesium.Cartesian3.fromRadians(
      carto.longitude,
      carto.latitude,
      0,
    );
    const target = Cesium.Cartesian3.fromRadians(
      carto.longitude,
      carto.latitude,
      offset,
    );
    const translation = Cesium.Cartesian3.subtract(
      target,
      surface,
      new Cesium.Cartesian3(),
    );
    tileset.modelMatrix = Cesium.Matrix4.fromTranslation(translation);
  }

  private applyAppearance(entry: LayerEntry): void {
    const { handle, layer } = entry;
    if (!handle) return;
    if (entry.kind === "imagery") {
      const imagery = handle as ImageryLayer;
      imagery.show = layer.visible;
      imagery.alpha = layer.opacity;
    } else if (entry.kind === "geojson") {
      (handle as DataSource).show = layer.visible;
    } else {
      (handle as Cesium3DTileset).show = layer.visible;
    }
  }

  private destroyEntry(entry: LayerEntry): void {
    entry.cancelled = true;
    const { handle } = entry;
    if (!handle) return;
    if (entry.kind === "imagery") {
      this.viewer.imageryLayers.remove(handle as ImageryLayer, true);
    } else if (entry.kind === "geojson") {
      this.viewer.dataSources.remove(handle as DataSource, true);
    } else {
      this.viewer.scene.primitives.remove(handle as Cesium3DTileset);
    }
  }
}
