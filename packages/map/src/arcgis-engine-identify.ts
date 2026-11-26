// ArcgisEngine layer: identify, picking and highlight.
// The ArcgisEngine layer chain is documented in arcgis-engine.ts.

import { identifyArcgisControls } from "./arcgis-control-adapters";
import { controlLayerMirrors } from "./shadow-style";
import { SEARCH_HIGHLIGHT_COLOR, type IdentifiedFeature } from "./map-engine";
import type { Feature, Geometry, Point, Polygon, Position } from "geojson";
import type { GeoLibreLayer } from "@geolibre/core";
import { ARCGIS_ID_FIELD, featurePassesFilters, geometryContainsPoint } from "./arcgis-layers";
import { featurePickIndex } from "./feature-pick-index";
import type { ArcgisGeometryJson, ArcgisGraphic, ArcgisLayer } from "./arcgis-sdk";
import { ArcgisEngineCamera } from "./arcgis-engine-camera";

const HIGHLIGHT_COLOR = [250, 204, 21, 1];

/** Pixel radius the synchronous identify accepts around points and lines. */
export const HIT_TOLERANCE_PX = 6;

/** Convert GeoJSON geometry to the SDK's geometry JSON (WGS84). */
export function geojsonToArcgisGeometry(geometry: Geometry): ArcgisGeometryJson | null {
  const sr = { wkid: 4326 };
  switch (geometry.type) {
    case "Point":
      return {
        type: "point",
        x: geometry.coordinates[0],
        y: geometry.coordinates[1],
        ...(geometry.coordinates.length > 2 ? { z: geometry.coordinates[2] } : {}),
        spatialReference: sr,
      };
    case "MultiPoint":
      return { type: "multipoint", points: geometry.coordinates, spatialReference: sr };
    case "LineString":
      return { type: "polyline", paths: [geometry.coordinates], spatialReference: sr };
    case "MultiLineString":
      return { type: "polyline", paths: geometry.coordinates, spatialReference: sr };
    case "Polygon":
      return { type: "polygon", rings: geometry.coordinates, spatialReference: sr };
    case "MultiPolygon":
      return { type: "polygon", rings: geometry.coordinates.flat(), spatialReference: sr };
    default:
      return null;
  }
}

/** Drop the compiler's synthetic attributes from a hit graphic's attributes. */
export function stripSyntheticFields(attributes: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(attributes).filter(([key]) => !key.startsWith("gl__") && key !== "__OBJECTID"),
  );
}

/**
 * ArcgisEngine layer: identifying features under a point, native-layer
 * picking, and the selection highlight and search result.
 */
export abstract class ArcgisEngineIdentify extends ArcgisEngineCamera {
  protected highlight: ArcgisLayer | null = null;

  /** Integer zoom the zoom-dependent plans were compiled at. */
  protected compiledZoom!: number;

  /**
   * Geometries of service features the hit test has returned, keyed by
   * `layerId:featureId`: a service layer's features never live in the store,
   * so this is what a selection of one is highlighted from. Bounded.
   */
  protected serviceGeometries = new Map<string, Geometry>();

  /** Results of the latest hit test, served by the synchronous identify. */
  private lastHit: { lngLat: [number, number]; features: IdentifiedFeature[] } | null = null;

  // ------------------------------------------------------------------ picking

  /**
   * Hit-test the map at a screen point. The SDK's picking is asynchronous, so
   * the canvas awaits this on click and the synchronous {@link identifyFeatures}
   * answers from the same result for callers that pass the clicked location.
   */
  async identifyFeaturesAt(
    screenPoint: { x: number; y: number },
    layerId?: string,
  ): Promise<IdentifiedFeature[]> {
    const view = this.view;
    if (!view) return [];
    const external = identifyArcgisControls(view, screenPoint, layerId);
    const include = [...this.natives]
      .filter(([id]) => !layerId || id === layerId)
      .flatMap(([, entry]) => entry.layers.filter((native) => !this.companions.has(native)));
    if (!include.length) return external;
    let hit;
    try {
      hit = await view.hitTest(screenPoint, { include });
    } catch {
      return external;
    }
    // The engine may have been destroyed (a renderer swap, an unmounted pane)
    // while the hit test was in flight; the captured view is gone with it.
    if (this.view !== view) return external;
    const seen = new Set<string>();
    const features: IdentifiedFeature[] = [...external];
    for (const result of hit.results) {
      if (result.type !== "graphic" || !result.graphic) continue;
      // A cluster is a summary graphic whose object id names no feature.
      if (result.graphic.isAggregate) continue;
      const native = result.graphic.layer ?? result.layer ?? null;
      const storeId = native ? this.storeIdFor(native) : undefined;
      if (!storeId) continue;
      const attributes = result.graphic.attributes ?? {};
      const storeLayer = this.layers.find((l) => l.id === storeId);
      const rawId = attributes[ARCGIS_ID_FIELD];
      // A service layer's features never live in the store; their object id
      // is the identity the SDK offers.
      // The service names its own object id field (`objectid`, `FID`, ...).
      const oidField = (native as { objectIdField?: string } | null)?.objectIdField;
      const oid =
        (oidField ? attributes[oidField] : undefined) ??
        attributes.OBJECTID ??
        attributes.__OBJECTID;
      const featureId = rawId != null ? String(rawId) : oid != null ? String(oid) : null;
      const feature =
        rawId != null
          ? storeLayer?.geojson?.features.find((f, i) => String(f.id ?? i) === featureId)
          : undefined;
      const key = `${storeId}:${featureId ?? JSON.stringify(attributes)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const hitGeometry =
        feature?.geometry ?? this.graphicGeometryToGeoJson(result.graphic.geometry);
      if (!feature && featureId !== null && hitGeometry) {
        this.serviceGeometries.delete(`${storeId}:${featureId}`);
        this.serviceGeometries.set(`${storeId}:${featureId}`, hitGeometry);
        if (this.serviceGeometries.size > 500)
          this.serviceGeometries.delete(this.serviceGeometries.keys().next().value!);
      }
      features.push({
        layerId: storeId,
        featureId,
        properties: feature?.properties ?? stripSyntheticFields(attributes),
        // The store's geometry when the feature is there; otherwise the one
        // the hit test found (a service layer's), converted from the view.
        geometry: hitGeometry,
      });
    }
    try {
      const lngLat = this.lngLatOf(view.toMap(screenPoint));
      if (lngLat) this.lastHit = { lngLat, features };
    } catch {
      // A view torn down between the hit test and the conversion has no
      // location to remember; the features are still the answer.
    }
    return features;
  }

  /**
   * Hits on the store layers that mirror a plugin control's native layer, by
   * the ids the control registered (`nativeLayerIds`) or the source it reads.
   * The control's own layer is only recorded on this renderer (its facade's
   * shadow style), so its mirror is what the user sees and clicks.
   */
  protected pickNativeLayer(
    lngLat: [number, number],
    nativeLayerId: string,
    sourceId: string | undefined,
  ): IdentifiedFeature[] {
    return this.mirrorsOf(nativeLayerId, sourceId).flatMap((layer) =>
      this.identifyFeatures(lngLat, layer.id),
    );
  }

  /** The store layers that mirror a control's native layer or source. */
  protected mirrorsOf(nativeLayerId: string, sourceId: string | undefined): GeoLibreLayer[] {
    return controlLayerMirrors(this.layers, nativeLayerId, sourceId);
  }

  /**
   * Features under `lngLat`, answered synchronously. The SDK's own hit test is
   * asynchronous, so the click flow goes through {@link identifyFeaturesAt} and
   * its result is served here for the same location; any other location (the
   * scripting, notebook and command bridges) is answered by testing the
   * store's GeoJSON geometry directly, with a few pixels of tolerance for
   * points and lines. Service layers, whose features live on the server, are
   * only reachable through the asynchronous path.
   */
  identifyFeatures(lngLat: [number, number], layerId?: string): IdentifiedFeature[] {
    const hit = this.lastHit;
    if (
      hit &&
      Math.abs(hit.lngLat[0] - lngLat[0]) <= 1e-6 &&
      Math.abs(hit.lngLat[1] - lngLat[1]) <= 1e-6
    )
      return layerId ? hit.features.filter((f) => f.layerId === layerId) : hit.features;
    const tolerance = this.degreesPerPixel(lngLat[1]) * HIT_TOLERANCE_PX;
    const zoom = this.compiledZoom;
    const features: IdentifiedFeature[] = [];
    // A click reports the topmost layer first; store order is bottom to top.
    for (const layer of [...this.layers].reverse()) {
      if (layerId && layer.id !== layerId) continue;
      if (!layer.visible || !layer.geojson || !this.natives.has(layer.id)) continue;
      // The pick runs per pointer frame for hover tips, so only the features
      // whose bounds are near the point get the exact geometry test (#2629).
      const collection = layer.geojson;
      for (const index of featurePickIndex(collection).candidates(lngLat, tolerance)) {
        const feature = collection.features[index];
        if (!feature.geometry || !geometryContainsPoint(feature.geometry, lngLat, tolerance))
          continue;
        if (!featurePassesFilters(layer, feature, zoom)) continue;
        features.push({
          layerId: layer.id,
          featureId: String(feature.id ?? index),
          properties: feature.properties ?? {},
          geometry: feature.geometry,
        });
      }
    }
    return features;
  }

  /** An SDK geometry (in the view's spatial reference) as WGS84 GeoJSON, or null. */
  protected graphicGeometryToGeoJson(geometry: ArcgisGraphic["geometry"]): Geometry | null {
    if (!geometry) return null;
    let source: ArcgisGraphic["geometry"] = geometry;
    try {
      const sr = (geometry as { spatialReference?: { isWebMercator?: boolean; wkid?: number } })
        .spatialReference;
      if (sr?.isWebMercator || sr?.wkid === 3857 || sr?.wkid === 102100)
        source = this.sdk.webMercatorUtils.webMercatorToGeographic(geometry);
    } catch {
      return null;
    }
    const g = source as unknown as {
      type: string;
      x?: number;
      y?: number;
      points?: Position[];
      paths?: Position[][];
      rings?: Position[][];
      xmin?: number;
      ymin?: number;
      xmax?: number;
      ymax?: number;
    };
    switch (g.type) {
      case "point":
        return typeof g.x === "number" && typeof g.y === "number"
          ? { type: "Point", coordinates: [g.x, g.y] }
          : null;
      case "multipoint":
        return g.points ? { type: "MultiPoint", coordinates: g.points } : null;
      case "polyline":
        return !g.paths
          ? null
          : g.paths.length === 1
            ? { type: "LineString", coordinates: g.paths[0] }
            : { type: "MultiLineString", coordinates: g.paths };
      case "polygon":
        // The SDK's rings carry no outer/hole grouping; a single polygon whose
        // first ring is the exterior is the best faithful reading.
        return g.rings ? { type: "Polygon", coordinates: g.rings } : null;
      case "extent":
        return [g.xmin, g.ymin, g.xmax, g.ymax].every((v) => typeof v === "number")
          ? {
              type: "Polygon",
              coordinates: [
                [
                  [g.xmin!, g.ymin!],
                  [g.xmax!, g.ymin!],
                  [g.xmax!, g.ymax!],
                  [g.xmin!, g.ymax!],
                  [g.xmin!, g.ymin!],
                ],
              ],
            }
          : null;
      default:
        return null;
    }
  }

  /** Degrees of longitude per screen pixel at `latitude`, from the view's resolution. */
  protected degreesPerPixel(latitude: number): number {
    const view = this.view;
    const metersPerPixel =
      view?.type === "2d" && Number.isFinite(view.resolution) && view.resolution > 0
        ? view.resolution
        : // Web Mercator ground resolution at the compiled zoom.
          156543.03392804097 / 2 ** this.compiledZoom;
    const cos = Math.max(0.01, Math.cos((latitude * Math.PI) / 180));
    return metersPerPixel / (111320 * cos);
  }

  highlightFeature(
    layer: GeoLibreLayer | undefined,
    featureId: string | string[] | null,
    options?: { fit?: boolean },
  ): void {
    this.clearFeatureHighlight();
    const map = this.map;
    if (!map || !layer || featureId === null) return;
    const ids = new Set(Array.isArray(featureId) ? featureId : [featureId]);
    // A service layer's features are on the server; the ones identify hit
    // left their geometry behind for this.
    const selected: Feature[] = layer.geojson
      ? layer.geojson.features.filter((f, i) => ids.has(String(f.id ?? i)))
      : [...ids].flatMap((id) => {
          const geometry = this.serviceGeometries.get(`${layer.id}:${id}`);
          return geometry ? [{ type: "Feature" as const, id, properties: {}, geometry }] : [];
        });
    if (!selected.length) return;
    const plan = this.natives.get(layer.id)?.plan;
    const elevated = plan?.kind === "geojson" && plan.parts.some((part) => part.hasZ);
    const geometries =
      elevated && plan.kind === "geojson"
        ? plan.parts.flatMap(
            (part) =>
              part.features?.features
                .filter((feature) => ids.has(String(feature.properties?.[ARCGIS_ID_FIELD])))
                .map((feature) => feature.geometry) ?? [],
          )
        : selected.map((feature) => feature.geometry);
    const graphics: ArcgisGraphic[] = [];
    for (const sourceGeometry of geometries) {
      if (!sourceGeometry) continue;
      const geometry = geojsonToArcgisGeometry(sourceGeometry);
      if (!geometry) continue;
      if (elevated) geometry.hasZ = true;
      const isPoint = geometry.type === "point" || geometry.type === "multipoint";
      graphics.push(
        new this.sdk.Graphic({
          geometry,
          symbol: isPoint
            ? {
                type: "simple-marker",
                style: "circle",
                color: [250, 204, 21, 0.6],
                size: "20px",
                outline: { color: HIGHLIGHT_COLOR, width: "2px" },
              }
            : geometry.type === "polygon"
              ? {
                  type: "simple-fill",
                  style: "none",
                  outline: { color: HIGHLIGHT_COLOR, width: "4px" },
                }
              : { type: "simple-line", color: HIGHLIGHT_COLOR, width: "4px" },
        }),
      );
    }
    this.highlight = new this.sdk.layers.GraphicsLayer({
      title: "Selection",
      listMode: "hide",
      // Raw GeoJSON can carry Z even when its elevation style is disabled.
      elevationInfo: { mode: elevated ? "absolute-height" : "on-the-ground" },
      graphics,
    });
    map.add(this.highlight);
    if (options?.fit)
      this.fitLayer({ ...layer, geojson: { type: "FeatureCollection", features: selected } });
  }

  clearFeatureHighlight(): void {
    if (!this.highlight) return;
    if (this.map?.layers.includes(this.highlight)) this.map.remove(this.highlight);
    this.highlight.destroy();
    this.highlight = null;
  }

  // ------------------------------------------------------------------ drawing

  showSearchResult(geometry: Point | Polygon): () => void {
    const map = this.map;
    if (!map) return () => {};
    const layer = new this.sdk.layers.GraphicsLayer({
      listMode: "hide",
      elevationInfo: { mode: "on-the-ground" },
      graphics: [
        new this.sdk.Graphic({
          geometry: geojsonToArcgisGeometry(geometry)!,
          symbol:
            geometry.type === "Point"
              ? {
                  type: "simple-marker",
                  style: "circle",
                  color: SEARCH_HIGHLIGHT_COLOR,
                  size: "12px",
                  outline: { color: "white", width: "2px" },
                }
              : {
                  type: "simple-fill",
                  color: [239, 68, 68, 0.15],
                  outline: { color: SEARCH_HIGHLIGHT_COLOR, width: "2px" },
                },
        }),
      ],
    });
    map.add(layer);
    const dispose = () => {
      if (!this.disposers.delete(dispose)) return;
      if (map.layers.includes(layer)) map.remove(layer);
      layer.destroy();
    };
    this.disposers.add(dispose);
    return dispose;
  }
}
