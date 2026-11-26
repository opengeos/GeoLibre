// ArcgisEngine layer: layer sync and native layer construction.
// The ArcgisEngine layer chain is documented in arcgis-engine.ts.

import { ArcgisControlHost } from "./arcgis-control-host";
import { createArcgisZarrLayer } from "./arcgis-zarr";
import { createArcgisArchiveLayer } from "./arcgis-tile-archives";
import { createArcgisTemplateTileLayer } from "./arcgis-template-tiles";
import { attachArcgisSprite } from "./arcgis-sprite";
import { createArcgisCogLayer, loadCogTiler } from "./arcgis-cog-imagery";
import { cachingCogTiler, cogSourceUrl } from "./cog-imagery";
import { renderFillPatternCanvas } from "./fill-patterns";
import type { FeatureCollection, Position } from "geojson";
import {
  compileLayerFilters,
  portableWmsTileUrl,
  ruleBasedVisibilityFilter,
  type GeoLibreLayer,
} from "@geolibre/core";
import {
  ARCGIS_BASE_FIELD,
  ARCGIS_HEIGHT_FIELD,
  ARCGIS_ID_FIELD,
  ARCGIS_LABEL_CLASS_FIELD,
  ARCGIS_LABEL_FIELD,
  arcgisBlendMode,
  isArcgisRasterPlan,
  ARCGIS_SYMBOL_FIELD,
  ARCGIS_WEIGHT_FIELD,
  compileArcgisLayer,
  isArcgisPluginLayer,
  isMarkerPlaceholder,
  type ArcgisGeoJsonPart,
  type ArcgisLayerPlan,
  type ArcgisMarkerPlaceholder,
  type ArcgisRendererJson,
  type ArcgisSymbolJson,
} from "./arcgis-layers";
import { renderMarkerCanvas } from "./markers";
import { parseLabelOverride } from "./label-style";
import { redactArcgisError, type ArcgisGraphic, type ArcgisLayer } from "./arcgis-sdk";
import {
  ArcgisEngineIdentify,
  layersChangeHits,
  stripSyntheticFields,
} from "./arcgis-engine-identify";

/** Pages of a service's features `getLayerGeoJson` reads before stopping. */
const SERVICE_GEOJSON_MAX_PAGES = 50;

/**
 * The schema of the compiler's GeoJSON: only the three synthetic fields (the
 * SDK adds its object id). Declared widths keep long labels intact.
 */
const ARCGIS_GEOJSON_FIELDS = [
  { name: ARCGIS_ID_FIELD, type: "string", length: 255 },
  { name: ARCGIS_SYMBOL_FIELD, type: "string", length: 32 },
  { name: ARCGIS_LABEL_FIELD, type: "string", length: 4000 },
  { name: ARCGIS_LABEL_CLASS_FIELD, type: "string", length: 16 },
  { name: ARCGIS_HEIGHT_FIELD, type: "double" },
  { name: ARCGIS_BASE_FIELD, type: "double" },
  { name: ARCGIS_WEIGHT_FIELD, type: "double" },
];

/**
 * A renderer the SDK can take now: marker placeholders swapped for the circle
 * each stands in for. `bakeMarkers` replaces them with picture symbols later.
 */
function rendererWithFallbackMarkers(renderer: ArcgisRendererJson): ArcgisRendererJson {
  const fallback = (symbol: ArcgisSymbolJson | unknown): ArcgisSymbolJson =>
    isMarkerPlaceholder(symbol)
      ? (symbol as ArcgisMarkerPlaceholder).fallback
      : (symbol as ArcgisSymbolJson);
  return mapRendererSymbols(renderer, fallback);
}

/** A renderer with every symbol mapped, its visual variables kept. */
function mapRendererSymbols(
  renderer: ArcgisRendererJson,
  map: (symbol: ArcgisSymbolJson | unknown) => ArcgisSymbolJson,
): ArcgisRendererJson {
  if (renderer.type === "heatmap") return renderer;
  const visualVariables = renderer.visualVariables
    ? { visualVariables: renderer.visualVariables }
    : {};
  return renderer.type === "simple"
    ? { type: "simple", symbol: map(renderer.symbol), ...visualVariables }
    : {
        type: "unique-value",
        field: renderer.field,
        uniqueValueInfos: renderer.uniqueValueInfos.map((info) => ({
          value: info.value,
          symbol: map(info.symbol),
        })),
        ...visualVariables,
      };
}

function sameBakedProperties(
  a: Record<string, unknown> | null | undefined,
  b: Record<string, unknown> | null | undefined,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  for (const key of keysA) {
    if (!Object.prototype.hasOwnProperty.call(b, key) || a[key] !== b[key]) {
      return false;
    }
  }
  return true;
}

function sameBakedFeatures(
  previous: FeatureCollection | undefined,
  next: FeatureCollection | undefined,
): boolean {
  if (previous === next) return true;
  if (!previous || !next) return false;
  if (previous.features.length !== next.features.length) return false;
  for (let i = 0; i < previous.features.length; i += 1) {
    const a = previous.features[i];
    const b = next.features[i];
    if (a.id !== b.id || !sameBakedProperties(a.properties, b.properties)) {
      return false;
    }
    if (a.geometry !== b.geometry) {
      if (JSON.stringify(a.geometry) !== JSON.stringify(b.geometry)) {
        return false;
      }
    }
  }
  return true;
}

/**
 * True when only simple GeoJSON renderers changed (with identical baked
 * features and no companion/label/elevation changes), so native renderers can
 * be swapped in place without rebuilding the GeoJSONLayer or Blob URLs.
 */
function canUpdateGeoJsonRenderersInPlace(
  previous: ArcgisLayerPlan,
  next: ArcgisLayerPlan,
  nativeLayerCount: number,
): next is Extract<ArcgisLayerPlan, { kind: "geojson" }> {
  if (previous.kind !== "geojson" || next.kind !== "geojson") return false;
  if (previous.parts.length !== next.parts.length || nativeLayerCount !== next.parts.length) {
    return false;
  }
  for (let i = 0; i < next.parts.length; i += 1) {
    const prevPart = previous.parts[i];
    const nextPart = next.parts[i];
    if (
      prevPart.geometryType !== nextPart.geometryType ||
      prevPart.url !== nextPart.url ||
      prevPart.interactive === false ||
      nextPart.interactive === false ||
      prevPart.hasZ ||
      nextPart.hasZ ||
      prevPart.renderer.type !== "simple" ||
      nextPart.renderer.type !== "simple" ||
      prevPart.markerStyle ||
      nextPart.markerStyle ||
      prevPart.patternStyle ||
      nextPart.patternStyle ||
      prevPart.labelingInfo ||
      nextPart.labelingInfo ||
      prevPart.elevationInfo ||
      nextPart.elevationInfo ||
      !sameBakedFeatures(prevPart.features, nextPart.features) ||
      JSON.stringify(prevPart.featureReduction ?? null) !==
        JSON.stringify(nextPart.featureReduction ?? null)
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Everything about a plan that requires rebuilding the native layers when it
 * changes: the kind, the source, the symbology. Visibility, opacity and the
 * scale range are applied in place, so they are left out. For GeoJSON plans
 * the features themselves are replaced by their count and the store record's
 * identity, so a visibility toggle skips rebuilding while renderer-only edits
 * can be updated in place when {@link canUpdateGeoJsonRenderersInPlace} holds.
 */
function planSignature(plan: ArcgisLayerPlan, layer: GeoLibreLayer): string {
  const {
    title: _t,
    visible: _v,
    opacity: _o,
    minScale: _mn,
    maxScale: _mx,
    effect: _e,
    blendMode: _b,
    ...rest
  } = plan;
  if (rest.kind === "cog" || rest.kind === "zarr") {
    const { source: _source, ...signature } = rest;
    return JSON.stringify(signature);
  }
  if (rest.kind === "geojson") {
    return JSON.stringify({
      ...rest,
      parts: rest.parts.map((part) => ({
        ...part,
        features: part.features ? part.features.features.length : undefined,
      })),
      // The blend mode is applied in place, so a change to it alone does not rebuild.
      style: { ...layer.style, blendMode: undefined },
      filters: [layer.timeFilter, layer.embedFilter, compileLayerFilters(layer)],
    });
  }
  return JSON.stringify(rest);
}

/**
 * What a GeoJSON layer's compiled plan depends on apart from its features
 * (compared by identity) and the display fields applied in place: the style,
 * filters, source and metadata.
 */
function geojsonCompileKey(layer: GeoLibreLayer): string {
  const { geojson: _g, name: _n, visible: _v, opacity, ...rest } = layer;
  // A label opacity override is baked against the layer opacity it replaces,
  // so only then does an opacity change recompile the layer.
  const labels = layer.style?.labels;
  const labelOpacity =
    labels?.enabled &&
    (labels.field || labels.expression?.trim()) &&
    parseLabelOverride(labels.opacityExpression, "number")
      ? opacity
      : undefined;
  // The blend mode is applied in place, like opacity.
  return JSON.stringify({ ...rest, labelOpacity, style: { ...rest.style, blendMode: undefined } });
}

/**
 * ArcgisEngine layer: reconciling store layers into native ArcGIS layers
 * (instantiate, update, remove), baked markers and patterns, and reading
 * layer data back.
 */
export abstract class ArcgisEngineLayers extends ArcgisEngineIdentify {
  protected controlHost: ArcgisControlHost | null = null;

  /** Store ids last seen as plugin layers, whose `layer:` error means "unsupported". */
  protected pluginLayerIds = new Set<string>();

  protected storyOpacities = new Map<string, number>();

  protected cogTiler: Promise<ReturnType<typeof cachingCogTiler>> | null = null;

  protected cogUrls = new Set<string>();

  private loadCachedCogTiler(): Promise<ReturnType<typeof cachingCogTiler>> {
    return (this.cogTiler ??= loadCogTiler()
      .then(cachingCogTiler)
      .catch((error) => {
        this.cogTiler = null;
        throw error;
      }));
  }

  // ------------------------------------------------------------------- layers

  syncLayers(layers: GeoLibreLayer[]): void {
    if (layersChangeHits(this.layers, layers)) this.invalidateHitCache();
    this.layers = layers;
    const map = this.map;
    if (!map) return;
    const ids = new Set(layers.map((layer) => layer.id));
    const previousCogUrls = this.cogUrls;
    this.cogUrls = new Set(
      layers
        .filter((layer) => layer.type === "cog")
        .map(cogSourceUrl)
        .filter((url): url is string => !!url),
    );
    void this.cogTiler
      ?.then((tiler) => {
        for (const url of previousCogUrls) if (!this.cogUrls.has(url)) tiler.forget(url);
      })
      .catch(() => {});
    for (const id of [...this.natives.keys()]) if (!ids.has(id)) this.removeLayer(id);
    for (const key of [...this.errors.keys()])
      if (key.startsWith("layer:") && !ids.has(key.slice(6))) this.errors.delete(key);
    // Store order is bottom to top (the last layer is the topmost, as the
    // Layers panel lists it and MapLibre's sync stacks it), which is also the
    // SDK's: it draws index 0 at the bottom.
    const ordered: ArcgisLayer[] = [];
    for (const original of layers) {
      const opacity = this.storyOpacities.get(original.id);
      const layer = opacity === undefined ? original : { ...original, opacity };
      if (isArcgisPluginLayer(original)) {
        this.pluginLayerIds.add(original.id);
        this.removeLayer(original.id);
        // The layer panels badge it too; the banner says why it is missing.
        if (original.visible)
          this.errors.set(`layer:${original.id}`, this.messages.pluginLayer(original.name));
        continue;
      }
      this.pluginLayerIds.delete(original.id);
      try {
        let entry = this.natives.get(layer.id);
        const compileKey = layer.geojson ? geojsonCompileKey(layer) : undefined;
        // Baking a GeoJSON layer's symbols walks every feature; an opacity
        // tick, a visibility toggle or a rename leaves them as they were, so
        // the plan is reused with only its display fields replaced.
        const reusable =
          entry?.plan.kind === "geojson" &&
          compileKey !== undefined &&
          entry.compileKey === compileKey &&
          entry.geojson === layer.geojson &&
          (!entry.plan.zoomDependent || entry.compiledZoom === this.compiledZoom);
        const plan: ArcgisLayerPlan =
          reusable && entry
            ? {
                ...entry.plan,
                title: layer.name,
                visible: layer.visible,
                opacity: Math.min(1, Math.max(0, layer.opacity)),
                blendMode: arcgisBlendMode(layer.style),
              }
            : compileArcgisLayer(layer, {
                zoom: this.compiledZoom,
                scene: this.view?.type === "3d",
                deckOverlay: this.capabilities.deckOverlay,
              });
        const signature = reusable && entry ? entry.signature : planSignature(plan, layer);
        const filterSignature =
          plan.kind === "geojson"
            ? JSON.stringify([
                layer.timeFilter,
                layer.embedFilter,
                compileLayerFilters(layer),
                ruleBasedVisibilityFilter(layer.style),
                layer.metadata.sourceKind === "annotation",
              ])
            : undefined;
        if (entry && (entry.signature !== signature || entry.geojson !== layer.geojson)) {
          // For simple single-symbol GeoJSON style edits (color, stroke, radius,
          // fillOpacity) where features, filters, labels, and companions are
          // unchanged, update `native.renderer` in place instead of revoking and
          // recreating the Blob URL and GeoJSONLayer.
          if (
            entry.geojson === layer.geojson &&
            entry.filterSignature === filterSignature &&
            canUpdateGeoJsonRenderersInPlace(entry.plan, plan, entry.layers.length)
          ) {
            for (let i = 0; i < plan.parts.length; i += 1) {
              const native = entry.layers[i];
              if (native) {
                native.renderer = rendererWithFallbackMarkers(plan.parts[i].renderer);
              }
            }
            entry.signature = signature;
          } else {
            // Anything else changed (filter, labels, markers, features, geometry):
            // rebuild the native layers.
            this.removeLayer(layer.id);
            entry = undefined;
          }
        }
        if (!entry) {
          entry = {
            plan,
            signature,
            filterSignature,
            layers: [],
            urls: [],
            disposers: [],
            geojson: layer.geojson,
          };
          this.natives.set(layer.id, entry);
          // Every part is recorded on the entry before any is added, so a
          // map.add failing part way leaves nothing the catch below
          // (removeLayer) cannot find and destroy.
          entry.layers.push(...this.instantiate(plan, entry.urls, entry.disposers));
          entry.layers.forEach((native, index) => {
            // A mixed-geometry GeoJSON record has several native layers but
            // one shared visibility toggle. Service sublayers stay managed by
            // their source record rather than exposing unsaved native changes.
            native.listMode = index ? "hide" : "hide-children";
          });
          for (const native of entry.layers) map.add(native);
          const first = entry.layers[0];
          if (first && this.options.onLayerVisibilityChange) {
            entry.visibilityHandle = this.sdk.reactiveUtils.watch(
              () => first.visible,
              () => {
                const current = this.natives.get(layer.id);
                if (current?.layers[0] !== first || first.visible === current.plan.visible) return;
                this.options.onLayerVisibilityChange?.(layer.id, first.visible);
              },
              // Commit native toggles before another store sync can overwrite them.
              { sync: true },
            );
          }
        }
        entry.plan = plan;
        entry.compileKey = compileKey;
        entry.compiledZoom = this.compiledZoom;
        if (plan.kind === "feature-service" && plan.filterUnsupported)
          this.errors.set(`filter:${layer.id}`, this.messages.filterNoSql(layer.name));
        else this.errors.delete(`filter:${layer.id}`);
        for (const native of entry.layers) {
          if (plan.kind === "zarr") {
            const zarr = native as import("./arcgis-zarr").ArcgisZarrLayer;
            zarr.setSelector((plan.source.source.selector ?? {}) as Record<string, unknown>);
            zarr.setStyle(plan.source.source);
          }
          native.title = plan.title;
          native.visible = plan.visible;
          native.opacity = plan.opacity;
          native.blendMode = plan.blendMode;
          native.effect = isArcgisRasterPlan(plan) ? plan.effect : null;
          native.minScale = plan.minScale;
          native.maxScale = plan.maxScale;
        }
        ordered.push(...entry.layers);
        this.errors.delete(`layer:${layer.id}`);
      } catch (error) {
        this.removeLayer(original.id);
        if (original.visible)
          this.errors.set(
            `layer:${original.id}`,
            `${original.name}: ${redactArcgisError(String((error as Error).message ?? error))}`,
          );
      }
    }
    ordered.forEach((native, index) => {
      if (map.layers.indexOf(native) !== index) map.layers.reorder(native, index);
    });
    if (this.highlight && map.layers.indexOf(this.highlight) !== map.layers.length - 1)
      map.layers.reorder(this.highlight, map.layers.length - 1);
    // A record registered or dropped changes which control layers the store
    // mirrors, and so what the controls' own overlay has to draw.
    this.controlHost?.refreshOverlay();
  }

  /** Build the SDK layers for a plan, recording blob URLs to revoke on removal. */
  private instantiate(
    plan: ArcgisLayerPlan,
    urls: string[],
    disposers: (() => void)[],
  ): ArcgisLayer[] {
    const { layers, media } = this.sdk;
    const common = {
      title: plan.title,
      visible: plan.visible,
      opacity: plan.opacity,
      minScale: plan.minScale,
      maxScale: plan.maxScale,
    };
    const fullExtent = plan.bounds
      ? {
          fullExtent: new this.sdk.Extent({
            xmin: plan.bounds[0],
            ymin: plan.bounds[1],
            xmax: plan.bounds[2],
            ymax: plan.bounds[3],
            spatialReference: { wkid: 4326 },
          }),
        }
      : {};
    switch (plan.kind) {
      case "zarr": {
        const bridge = createArcgisZarrLayer(this.sdk, plan.source, common);
        disposers.push(bridge.dispose);
        return [bridge.layer];
      }
      case "archive": {
        const bridge = createArcgisArchiveLayer(this.sdk, plan, common);
        disposers.push(bridge.dispose);
        return [bridge.layer];
      }
      case "external-deck":
        return [];
      case "cog":
        return [
          createArcgisCogLayer(
            this.sdk,
            plan.source,
            common,
            () => this.loadCachedCogTiler(),
            // A projected map warps the tiles into its projection (issue #2708).
            this.options.projectOperator && this.view
              ? {
                  operator: this.options.projectOperator,
                  spatialReference: this.view.spatialReference,
                }
              : undefined,
          ),
        ];
      case "geojson": {
        // A part failing to construct must not strand the parts built before
        // it: the caller only learns of the layers this returns.
        const built: ArcgisLayer[] = [];
        try {
          for (const part of plan.parts)
            built.push(this.instantiateGeoJsonPart(part, common, urls));
        } catch (error) {
          for (const native of built) {
            this.companions.delete(native);
            try {
              native.destroy();
            } catch {
              // Keep destroying the rest; the construction error is what to report.
            }
          }
          throw error;
        }
        return built;
      }
      case "web-tile":
        return [
          new layers.WebTileLayer({
            ...common,
            ...fullExtent,
            urlTemplate: plan.urlTemplate,
            ...(plan.subDomains ? { subDomains: plan.subDomains } : {}),
            ...(plan.copyright ? { copyright: plan.copyright } : {}),
          }),
        ];
      case "template-tile":
        return [
          createArcgisTemplateTileLayer(this.sdk, plan, {
            ...common,
            ...(plan.copyright ? { copyright: plan.copyright } : {}),
          }),
        ];
      case "wms":
        return [
          new layers.WMSLayer({
            ...common,
            ...fullExtent,
            url: plan.url,
            sublayers: plan.sublayers,
            ...(plan.version ? { version: plan.version } : {}),
            ...(plan.imageFormat ? { imageFormat: plan.imageFormat } : {}),
            imageTransparency: plan.imageTransparency,
            ...(plan.customParameters ? { customParameters: plan.customParameters } : {}),
          }),
        ];
      case "vector-tile": {
        // `fullExtent` is read-only on a VectorTileLayer (it comes from the style).
        const sprite = attachArcgisSprite(this.sdk, plan.style);
        disposers.push(sprite.dispose);
        return [new layers.VectorTileLayer({ ...common, style: sprite.style })];
      }
      case "feature-service": {
        const native = new layers.FeatureLayer({
          ...common,
          url: plan.url,
          popupEnabled: false,
          outFields: ["*"],
          ...(plan.definitionExpression ? { definitionExpression: plan.definitionExpression } : {}),
        });
        // The service's geometry type is known only once it has loaded.
        const symbols = plan.symbols;
        if (symbols)
          void native
            .when()
            .then(() => {
              // A restyle or removal may have replaced the layer meanwhile.
              if (native.destroyed) return;
              const type = (native as { geometryType?: string }).geometryType;
              const kind = type === "multipoint" ? "point" : type;
              if (kind === "point" || kind === "polyline" || kind === "polygon")
                native.renderer = { type: "simple", symbol: symbols[kind] };
            })
            .catch(() => {});
        return [native];
      }
      case "tile-service":
        return [new layers.TileLayer({ ...common, url: plan.url })];
      case "map-image":
        return [new layers.MapImageLayer({ ...common, url: plan.url })];
      case "imagery":
        return [new layers.ImageryLayer({ ...common, url: plan.url })];
      case "scene-layer": {
        const SceneLayer = this.options.scene?.SceneLayer;
        if (!SceneLayer) throw new Error("SceneLayer requires an ArcGIS 3D SceneView");
        return [new SceneLayer({ ...common, url: plan.url })];
      }
      case "integrated-mesh-3d-tiles": {
        const IntegratedMesh3DTilesLayer = this.options.scene?.IntegratedMesh3DTilesLayer;
        if (!IntegratedMesh3DTilesLayer)
          throw new Error("IntegratedMesh3DTilesLayer requires an ArcGIS 3D SceneView");
        return [new IntegratedMesh3DTilesLayer({ ...common, url: plan.url })];
      }
      case "point-cloud-layer": {
        const PointCloudLayer = this.options.scene?.PointCloudLayer;
        if (!PointCloudLayer) throw new Error("PointCloudLayer requires an ArcGIS 3D SceneView");
        return [new PointCloudLayer({ ...common, url: plan.url })];
      }
      case "imagery-tile":
        return [
          new layers.ImageryTileLayer({
            ...common,
            url: plan.url,
            // ImageryTileLayer has no `apiKey` (SDK 5.1 omits APIKeyMixin);
            // custom parameters ride on every request it makes, the raster
            // tile fetches included.
            ...(plan.token ? { customParameters: { token: plan.token } } : {}),
          }),
        ];
      case "media-image": {
        // The four corners are an arbitrary quad (the georeferencer fits an
        // affine transform), which only a control-point georeference can
        // express; it needs the image's pixel size, so the element is added
        // once the image has loaded. Without a DOM `Image` (the tests) the
        // layer stays empty.
        const layer = new layers.MediaLayer({ ...common, source: [] });
        if (typeof Image !== "undefined") {
          const image = new Image();
          image.crossOrigin = "anonymous";
          image.onload = () => {
            if (layer.destroyed) return;
            const toMap = (p: Position) =>
              this.sdk.webMercatorUtils.geographicToWebMercator(
                new this.sdk.Point({
                  longitude: p[0],
                  latitude: p[1],
                  spatialReference: { wkid: 4326 },
                }),
              );
            const [tl, tr, br, bl] = plan.corners;
            const { naturalWidth: width, naturalHeight: height } = image;
            (layer as unknown as { source: unknown }).source = [
              new media.ImageElement({
                image,
                georeference: new media.ControlPointsGeoreference({
                  width,
                  height,
                  controlPoints: [
                    { sourcePoint: { x: 0, y: 0 }, mapPoint: toMap(tl) },
                    { sourcePoint: { x: width, y: 0 }, mapPoint: toMap(tr) },
                    { sourcePoint: { x: width, y: height }, mapPoint: toMap(br) },
                    { sourcePoint: { x: 0, y: height }, mapPoint: toMap(bl) },
                  ],
                }),
              }),
            ];
          };
          image.onerror = () => {
            if (layer.destroyed) return;
            this.errors.set(`layer:${plan.id}`, this.messages.imageFailed(plan.title));
          };
          image.src = plan.url;
        }
        return [layer];
      }
    }
  }

  /**
   * Build the GeoJSONLayer for one part of a GeoJSON plan.
   *
   * @param part The compiled part (one geometry type of the record).
   * @param common The display properties every part of the record shares.
   * @param urls Receives the blob URL created for inline features.
   * @returns The constructed SDK layer.
   */
  private instantiateGeoJsonPart(
    part: ArcgisGeoJsonPart,
    common: Record<string, unknown>,
    urls: string[],
  ): ArcgisLayer {
    let url = part.url;
    if (!url) {
      url = URL.createObjectURL(
        new Blob([JSON.stringify(part.features ?? { type: "FeatureCollection", features: [] })], {
          type: "application/geo+json",
        }),
      );
      urls.push(url);
    }
    const native = new this.sdk.layers.GeoJSONLayer({
      ...common,
      url,
      geometryType: part.geometryType,
      renderer: rendererWithFallbackMarkers(part.renderer),
      // Hit-test graphics only carry the fields the renderer and labels
      // read unless every field is requested; identify needs the
      // compiler's identity field.
      outFields: ["*"],
      // Declared rather than inferred: the SDK sizes an inferred string
      // field from sampled features and truncates longer values later,
      // which would clip labels (and once clipped the symbol key).
      fields: part.url ? undefined : ARCGIS_GEOJSON_FIELDS,
      ...(part.labelingInfo ? { labelingInfo: part.labelingInfo, labelsVisible: true } : {}),
      ...(part.elevationInfo ? { elevationInfo: part.elevationInfo } : {}),
      ...(part.hasZ ? { hasZ: true } : {}),
      ...(part.featureReduction ? { featureReduction: part.featureReduction } : {}),
      // The SDK's popup is not used; identify goes through hitTest.
      popupEnabled: false,
      legendEnabled: false,
    });
    if (part.interactive === false) this.companions.add(native);
    if (part.markerStyle) void this.bakeMarkers(native, part);
    if (part.patternStyle) void this.bakePattern(native, part);
    return native;
  }

  protected removeLayer(id: string): void {
    const entry = this.natives.get(id);
    if (entry) {
      entry.visibilityHandle?.remove();
      for (const native of entry.layers) {
        if (this.map?.layers.includes(native)) this.map.remove(native);
        native.destroy();
      }
      for (const dispose of entry.disposers) dispose();
      for (const url of entry.urls) URL.revokeObjectURL(url);
    }
    this.natives.delete(id);
    this.errors.delete(`layer:${id}`);
    this.errors.delete(`filter:${id}`);
    for (const key of [...this.serviceGeometries.keys()])
      if (key.startsWith(`${id}:`)) this.serviceGeometries.delete(key);
  }

  waitAndSyncLayers(layers: GeoLibreLayer[]): void {
    this.syncLayers(layers);
  }

  async getLayerGeoJson(id: string): Promise<FeatureCollection | null> {
    const layer = this.layers.find((l) => l.id === id);
    if (layer?.geojson) return layer.geojson;
    // A service layer's features live on the server: page through them the
    // way the service allows (its maxRecordCount per request), up to a cap.
    const entry = this.natives.get(id);
    const native = entry?.plan.kind === "feature-service" ? entry.layers[0] : undefined;
    if (!native?.queryFeatures) return null;
    const graphics: ArcgisGraphic[] = [];
    let oidField: string | undefined;
    const toCollection = (): FeatureCollection => ({
      type: "FeatureCollection",
      features: graphics.flatMap((graphic) => {
        const geometry = this.graphicGeometryToGeoJson(graphic.geometry);
        // The service's object id is the feature's identity, as identify
        // reports it.
        const oid = oidField ? graphic.attributes?.[oidField] : undefined;
        return geometry
          ? [
              {
                type: "Feature" as const,
                ...(typeof oid === "string" || typeof oid === "number" ? { id: oid } : {}),
                properties: stripSyntheticFields(graphic.attributes ?? {}),
                geometry,
              },
            ]
          : [];
      }),
    });
    try {
      // The service's metadata (object id field, capabilities) is read from
      // the loaded layer.
      await native.when();
      // A stable order, so offset pages neither overlap nor skip rows — where
      // the service supports ORDER BY at all.
      oidField = (native as { objectIdField?: string }).objectIdField;
      const orderBy =
        (native as { capabilities?: { query?: { supportsOrderBy?: boolean } } }).capabilities?.query
          ?.supportsOrderBy === true;
      let firstOfPreviousPage: string | undefined;
      const seenOids = new Set<unknown>();
      let offset = 0;
      // The SDK's query asks for 10 rows once `start` is set unless told
      // otherwise; later pages ask for as many as the first page returned
      // (the service's per-request limit).
      let pageSize = 0;
      for (let page = 0; page < SERVICE_GEOJSON_MAX_PAGES; page++) {
        const result = await native.queryFeatures({
          where: "1=1",
          outFields: ["*"],
          returnGeometry: true,
          outSpatialReference: { wkid: 4326 },
          ...(oidField && orderBy ? { orderByFields: [oidField] } : {}),
          // The offset counts rows the service returned, duplicates included.
          ...(offset ? { start: offset, num: pageSize } : {}),
        });
        if (page === 0) pageSize = result.features.length;
        offset += result.features.length;
        // A service that ignores the offset returns its first page again;
        // stop rather than repeat it. With an object id field that is a page
        // adding no new row (an overlapping page that adds one still counts);
        // without one, a repeated first row is the only signal.
        const first = JSON.stringify(result.features[0]?.attributes ?? null);
        if (!oidField && page > 0 && first === firstOfPreviousPage) break;
        firstOfPreviousPage = first;
        const keptBefore = graphics.length;
        // Without a stable order (no ORDER BY support, or a service that
        // ignores it) offset pages can overlap; the object id says which rows
        // were already read.
        for (const graphic of result.features) {
          const oid = oidField ? graphic.attributes?.[oidField] : undefined;
          if (oid != null) {
            if (seenOids.has(oid)) continue;
            seenOids.add(oid);
          }
          graphics.push(graphic);
        }
        if (oidField && page > 0 && graphics.length === keptBefore) break;
        if (!result.exceededTransferLimit || !result.features.length) break;
      }
      return toCollection();
    } catch {
      // A page failing part way still returns what was read before it.
      return graphics.length ? toCollection() : null;
    }
  }

  /**
   * The store record's tile templates as plain HTTP(S) URLs, as a story export
   * rebuilds them in a MapLibre page with none of the app's protocols: the
   * desktop's `geolibre-wms://tile?url=` wrapper is unwrapped, and any other
   * protocol template is left out.
   */
  private storeTiles(id: string): string[] | null {
    const tiles = this.layers.find((l) => l.id === id)?.source.tiles;
    if (!Array.isArray(tiles)) return null;
    const http = tiles
      .filter((tile): tile is string => typeof tile === "string")
      // A malformed wrapper (a hand-edited project) stays wrapped and is
      // left out below.
      .map((tile) => portableWmsTileUrl(tile) as string)
      .filter((tile) => /^https?:\/\//i.test(tile));
    return http.length ? http : null;
  }

  getLayerRasterSource(id: string): Record<string, unknown> | null {
    const plan = this.natives.get(id)?.plan;
    if (!plan) return null;
    if (plan.kind === "template-tile")
      return {
        type: "raster",
        // The store's templates: the plan's are dev-proxied for WMS records.
        tiles: this.storeTiles(id) ?? plan.templates,
        scheme: plan.scheme,
        tileSize: plan.tileSize,
        minzoom: plan.minzoom,
        maxzoom: plan.maxzoom,
        ...(plan.copyright ? { attribution: plan.copyright } : {}),
      };
    if (plan.kind === "web-tile") {
      // The plan holds the SDK's `{level}/{col}/{row}` form; exports want the
      // store's MapLibre template.
      return {
        type: "raster",
        tiles: this.storeTiles(id) ?? [plan.urlTemplate],
        ...(plan.copyright ? { attribution: plan.copyright } : {}),
      };
    }
    if (plan.kind === "media-image") return { type: "image", url: plan.url };
    if (plan.kind === "wms" || plan.kind === "archive") {
      const tiles = this.storeTiles(id);
      return tiles ? { type: "raster", tiles, tileSize: 256 } : null;
    }
    // A service record names only the service; MapLibre draws its cache or
    // its export endpoint as a tile template.
    const path =
      (plan.kind === "tile-service" || plan.kind === "map-image" || plan.kind === "imagery") &&
      plan.url.replace(/[?#].*$/, "").replace(/\/+$/, "");
    if (!path) return null;
    // `/tile` and `/export` live on the service root; a sublayer the record
    // names is drawn alone through `layers=show:`.
    const sublayer = plan.kind === "map-image" ? /\/(\d+)$/.exec(path)?.[1] : undefined;
    const service = sublayer ? path.replace(/\/\d+$/, "") : path;
    const exportParams = `bbox={bbox-epsg-3857}&bboxSR=3857&imageSR=3857&size=256,256&format=png32&transparent=true${
      sublayer ? `&layers=show:${sublayer}` : ""
    }&f=image`;
    return {
      type: "raster",
      tileSize: 256,
      tiles: [
        plan.kind === "tile-service"
          ? `${service}/tile/{z}/{y}/{x}`
          : `${service}/${plan.kind === "imagery" ? "exportImage" : "export"}?${exportParams}`,
      ],
    };
  }

  /**
   * Rasterize the shared pattern tile into native picture fills. Until the
   * image resolves, the layer draws its ordinary solid polygon symbols.
   */
  private async bakePattern(native: ArcgisLayer, part: ArcgisGeoJsonPart): Promise<void> {
    if (!part.patternStyle || typeof document === "undefined") return;
    try {
      const tile = await renderFillPatternCanvas(part.patternStyle);
      if (!tile || native.destroyed) return;
      // PictureFillSymbol ignores its color property, including alpha. Bake
      // each class's fill opacity into the image; keep its outline independent.
      const urls = new Map<number, string>();
      native.renderer = mapRendererSymbols(part.renderer, (symbol) => {
        const fill = symbol as ArcgisSymbolJson;
        if (fill.type !== "simple-fill") return fill;
        const alpha = Array.isArray(fill.color) ? Number(fill.color[3] ?? 1) : 1;
        let url = urls.get(alpha);
        if (!url) {
          const canvas = document.createElement("canvas");
          canvas.width = tile.canvas.width;
          canvas.height = tile.canvas.height;
          const context = canvas.getContext("2d");
          if (!context) return fill;
          context.globalAlpha = Math.max(0, Math.min(1, alpha));
          context.drawImage(tile.canvas, 0, 0);
          url = canvas.toDataURL("image/png");
          urls.set(alpha, url);
        }
        return {
          type: "picture-fill",
          url,
          width: `${tile.canvas.width / tile.pixelRatio}px`,
          height: `${tile.canvas.height / tile.pixelRatio}px`,
          outline: fill.outline,
        };
      });
    } catch {
      // Invalid/unrenderable SVG retains the ordinary fill, as on the globe.
    }
  }

  /** Replace marker placeholders with the shared shape/SVG sprites. */
  private async bakeMarkers(native: ArcgisLayer, part: ArcgisGeoJsonPart): Promise<void> {
    const style = part.markerStyle;
    if (!style || part.renderer.type === "heatmap" || typeof document === "undefined") return;
    const symbols =
      part.renderer.type === "simple"
        ? [part.renderer.symbol]
        : part.renderer.uniqueValueInfos.map((info) => info.symbol);
    const colors = [
      ...new Set(
        symbols.flatMap((symbol) =>
          isMarkerPlaceholder(symbol) ? [(symbol as ArcgisMarkerPlaceholder).color] : [],
        ),
      ),
    ];
    const sprites = new Map<string, { url: string; size: number }>();
    await Promise.all(
      colors.map(async (color) => {
        try {
          const baked = await renderMarkerCanvas(style, color);
          if (baked)
            sprites.set(color, {
              url: baked.canvas.toDataURL("image/png"),
              size: baked.canvas.width / baked.pixelRatio,
            });
        } catch {
          // A sprite that fails to rasterize keeps its circle fallback.
        }
      }),
    );
    if (native.destroyed || !sprites.size) return;
    const resolve = (symbol: ArcgisSymbolJson | unknown): ArcgisSymbolJson => {
      if (!isMarkerPlaceholder(symbol)) return symbol as ArcgisSymbolJson;
      const marker = symbol as ArcgisMarkerPlaceholder;
      const sprite = sprites.get(marker.color);
      if (!sprite) return marker.fallback;
      const size = `${Math.max(1, sprite.size * marker.scale)}px`;
      return { type: "picture-marker", url: sprite.url, width: size, height: size };
    };
    native.renderer = mapRendererSymbols(part.renderer, resolve);
  }
}
