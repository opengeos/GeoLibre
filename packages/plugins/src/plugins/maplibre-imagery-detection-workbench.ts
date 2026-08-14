import { DEFAULT_LAYER_STYLE, useAppStore, type GeoLibreLayer } from "@geolibre/core";
import type { Map as MapLibreMap, MapMouseEvent, Point } from "maplibre-gl";
import { fromBlob } from "geotiff";
import {
  extractCogSubset,
  createSegmentEverythingSessions,
  readRasterData,
  segmentEverything,
  type RasterData,
} from "@geolibre/processing";
import type { GeoLibreAppAPI, GeoLibrePlugin } from "../types";
import {
  ANNOTATION_SOURCE_KIND,
  IMAGERY_DETECTION_WORKBENCH_ID,
  VESSEL_CLASSES,
  classifyDetection,
  createDetectionFeature,
  exportAnnotationsCsv,
  exportCoco,
  exportManifestCsv,
  exportYoloObb,
  featureCollection,
  createCoverageGrid,
  imageryMetadataFromLayer,
  maskPolygonToOrientedCorners,
  sentinel2SclAllowsCandidate,
  skipDetection,
  vesselClassForKey,
  type DetectionFeature,
  type ImageBounds,
  type ImageryMetadata,
  type LngLatPoint,
  type CoverageChip,
} from "./imagery-detection-workbench";

const PANEL_ID = IMAGERY_DETECTION_WORKBENCH_ID;
const ANNOTATION_LAYER_NAME = "Imagery vessel annotations";
const RASTER_TYPES = new Set(["raster", "wms", "wmts", "xyz", "cog", "image"]);

let appRef: GeoLibreAppAPI | null = null;
let annotationLayerId: string | null = null;
let selectedImageryId: string | null = null;
let selectedDetectionId: string | null = null;
let imageryDraft: ImageryMetadata | null = null;
let drawing = false;
let dragStart: Point | null = null;
let boundMap: MapLibreMap | null = null;
let panelContainer: HTMLElement | null = null;
let unregisterPanel: (() => void) | null = null;
let unsubscribeStore: (() => void) | null = null;
let undoStack: DetectionFeature[][] = [];
let coverage: CoverageChip[] = [];
let coverageIndex = 0;
let segmenting = false;
let segmentProgress = "";
let useSceneMask = true;
let sceneMask: { raster: RasterData; bounds: ImageBounds } | null = null;

const SLIMSAM_BASE =
  "https://huggingface.co/Xenova/slimsam-77-uniform/resolve/5850ab45f587c112167512ffef949107115e26a0/onnx";
const SLIMSAM_ENCODER_URL = `${SLIMSAM_BASE}/vision_encoder.onnx`;
const SLIMSAM_DECODER_URL = `${SLIMSAM_BASE}/prompt_encoder_mask_decoder.onnx`;

async function fetchSegmentModel(url: string): Promise<ArrayBuffer> {
  const cache =
    typeof caches === "undefined"
      ? null
      : await caches.open("geolibre-segment-models").catch(() => null);
  const cached = await cache?.match(url).catch(() => undefined);
  if (cached) return cached.arrayBuffer();
  const response = await fetch(url, { mode: "cors" });
  if (!response.ok) throw new Error(`Failed to download SlimSAM (HTTP ${response.status}).`);
  await cache?.put(url, response.clone()).catch(() => {});
  return response.arrayBuffer();
}

async function segmentSourceBytes(bytes: ArrayBuffer, sceneBounds: ImageBounds): Promise<void> {
  await segmentRaster(await readRasterData(bytes), sceneBounds);
}

async function segmentRaster(raster: RasterData, sceneBounds: ImageBounds): Promise<void> {
  if (!imageryDraft?.bounds || segmenting) return;
  segmenting = true;
  segmentProgress = "Reading source imagery…";
  renderPanel();
  try {
    const [encoder, decoder] = await Promise.all([
      fetchSegmentModel(SLIMSAM_ENCODER_URL),
      fetchSegmentModel(SLIMSAM_DECODER_URL),
    ]);
    const sessions = await createSegmentEverythingSessions(encoder, decoder);
    const tiles = rasterTiles(raster, sceneBounds);
    const proposals: DetectionFeature[] = [];
    try {
      for (let tileIndex = 0; tileIndex < tiles.length; tileIndex += 1) {
        const tile = tiles[tileIndex];
        const masks = await segmentEverything(tile.raster, encoder, decoder, {
          sessions,
          pointsPerSide: 24,
          predIouThreshold: 0.8,
          stabilityScoreThreshold: 0.86,
          minAreaFraction: 0.00001,
          onProgress: (done, total) => {
            segmentProgress = `Tile ${tileIndex + 1} / ${tiles.length} · SAM ${done} / ${total}`;
            renderPanel();
          },
        });
        for (const mask of masks) {
          const corners = maskPolygonToOrientedCorners(
            mask.polygon,
            tile.raster.width,
            tile.raster.height,
            tile.bounds,
          );
          if (!corners || !candidatePassesSceneMask(corners)) continue;
          proposals.push(
            createDetectionFeature(corners, imageryDraft!, {
              geometrySource: "model",
              modelScore: Number(mask.score.toFixed(4)),
            }),
          );
        }
      }
    } finally {
      await sessions.release();
    }
    const deduplicated = deduplicateProposals(proposals);
    pushUndo();
    writeDetections([...detections(), ...deduplicated]);
    selectedDetectionId = deduplicated[0]?.properties.detection_id ?? selectedDetectionId;
    if (deduplicated.length) selectAt(detections().length - deduplicated.length);
    segmentProgress = deduplicated.length
      ? `${deduplicated.length} SAM candidates added from ${tiles.length} overlapping tiles${
          sceneMask && useSceneMask ? " after Sentinel-2 scene masking" : ""
        }.`
      : "SAM found no candidate objects with the current thresholds.";
  } catch (error) {
    segmentProgress = error instanceof Error ? error.message : String(error);
  } finally {
    segmenting = false;
    renderPanel();
  }
}

function rasterTiles(
  raster: RasterData,
  bounds: ImageBounds,
  tileSize = 896,
  overlap = 128,
): Array<{ raster: RasterData; bounds: ImageBounds }> {
  const step = tileSize - overlap;
  const xStarts: number[] = [];
  const yStarts: number[] = [];
  for (let x = 0; x < raster.width; x += step)
    xStarts.push(Math.min(x, Math.max(0, raster.width - tileSize)));
  for (let y = 0; y < raster.height; y += step)
    yStarts.push(Math.min(y, Math.max(0, raster.height - tileSize)));
  const uniqueX = [...new Set(xStarts)];
  const uniqueY = [...new Set(yStarts)];
  const [west, south, east, north] = bounds;
  return uniqueY.flatMap((y0) =>
    uniqueX.map((x0) => {
      const x1 = Math.min(raster.width, x0 + tileSize);
      const y1 = Math.min(raster.height, y0 + tileSize);
      const width = x1 - x0;
      const height = y1 - y0;
      const bands = raster.bands.map((source) => {
        const target = new Float32Array(width * height);
        for (let row = 0; row < height; row += 1)
          target.set(
            source.subarray((y0 + row) * raster.width + x0, (y0 + row) * raster.width + x1),
            row * width,
          );
        return target;
      });
      const tileBounds: ImageBounds = [
        west + (x0 / raster.width) * (east - west),
        north - (y1 / raster.height) * (north - south),
        west + (x1 / raster.width) * (east - west),
        north - (y0 / raster.height) * (north - south),
      ];
      return {
        raster: {
          ...raster,
          bands,
          width,
          height,
          originX: tileBounds[0],
          originY: tileBounds[3],
        },
        bounds: tileBounds,
      };
    }),
  );
}

function candidateBounds(feature: DetectionFeature): ImageBounds {
  const ring = feature.geometry.coordinates[0];
  const xs = ring.map((point) => point[0]);
  const ys = ring.map((point) => point[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

function bboxIou(a: ImageBounds, b: ImageBounds): number {
  const width = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
  const height = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  const intersection = width * height;
  const areaA = (a[2] - a[0]) * (a[3] - a[1]);
  const areaB = (b[2] - b[0]) * (b[3] - b[1]);
  return intersection / Math.max(Number.EPSILON, areaA + areaB - intersection);
}

function deduplicateProposals(features: DetectionFeature[]): DetectionFeature[] {
  const sorted = [...features].sort(
    (a, b) => (b.properties.model_score ?? 0) - (a.properties.model_score ?? 0),
  );
  const kept: DetectionFeature[] = [];
  for (const feature of sorted) {
    const bounds = candidateBounds(feature);
    if (!kept.some((candidate) => bboxIou(bounds, candidateBounds(candidate)) > 0.45))
      kept.push(feature);
  }
  return kept;
}

function candidatePassesSceneMask(
  corners: [LngLatPoint, LngLatPoint, LngLatPoint, LngLatPoint],
): boolean {
  if (!useSceneMask || !sceneMask) return true;
  const longitude = corners.reduce((sum, point) => sum + point[0], 0) / 4;
  const latitude = corners.reduce((sum, point) => sum + point[1], 0) / 4;
  const [west, south, east, north] = sceneMask.bounds;
  const x = ((longitude - west) / (east - west)) * sceneMask.raster.width;
  const y = ((north - latitude) / (north - south)) * sceneMask.raster.height;
  return sentinel2SclAllowsCandidate(
    sceneMask.raster.bands[0],
    sceneMask.raster.width,
    sceneMask.raster.height,
    x,
    y,
    5,
  );
}

async function readVisibleRasterFile(
  file: File,
  fullBounds: ImageBounds,
  visibleBounds: ImageBounds,
): Promise<RasterData> {
  const tiff = await fromBlob(file);
  const image = await tiff.getImage();
  const width = image.getWidth();
  const height = image.getHeight();
  const [west, south, east, north] = fullBounds;
  const [clipWest, clipSouth, clipEast, clipNorth] = visibleBounds;
  const x0 = Math.max(0, Math.floor(((clipWest - west) / (east - west)) * width));
  const x1 = Math.min(width, Math.ceil(((clipEast - west) / (east - west)) * width));
  const y0 = Math.max(0, Math.floor(((north - clipNorth) / (north - south)) * height));
  const y1 = Math.min(height, Math.ceil(((north - clipSouth) / (north - south)) * height));
  if (x1 <= x0 || y1 <= y0) throw new Error("The visible map area does not overlap this raster.");
  const sourceWidth = x1 - x0;
  const sourceHeight = y1 - y0;
  const scale = Math.min(1, 2048 / Math.max(sourceWidth, sourceHeight));
  const outputWidth = Math.max(1, Math.round(sourceWidth * scale));
  const outputHeight = Math.max(1, Math.round(sourceHeight * scale));
  const sampleCount = image.getSamplesPerPixel();
  const samples = Array.from({ length: Math.min(3, sampleCount) }, (_, index) => index);
  const result = await image.readRasters({
    window: [x0, y0, x1, y1],
    width: outputWidth,
    height: outputHeight,
    samples,
    resampleMethod: "bilinear",
  });
  const rawBands = (Array.isArray(result) ? result : [result]) as ArrayLike<number>[];
  const noData = image.getGDALNoData();
  return {
    bands: rawBands.map((band) => Float32Array.from(band)),
    width: outputWidth,
    height: outputHeight,
    originX: clipWest,
    originY: clipNorth,
    resX: (clipEast - clipWest) / outputWidth,
    resY: (clipNorth - clipSouth) / outputHeight,
    nodata: noData != null && Number.isFinite(noData) ? noData : null,
    geoKeys: (image.getGeoKeys() as Record<string, unknown>) ?? {},
  };
}

function currentAnalysisBounds(): ImageBounds | null {
  if (!imageryDraft?.bounds) return null;
  const mapBounds = boundMap?.getBounds();
  if (!mapBounds) return imageryDraft.bounds;
  const [west, south, east, north] = imageryDraft.bounds;
  const clipped: ImageBounds = [
    Math.max(west, mapBounds.getWest()),
    Math.max(south, mapBounds.getSouth()),
    Math.min(east, mapBounds.getEast()),
    Math.min(north, mapBounds.getNorth()),
  ];
  return clipped[0] < clipped[2] && clipped[1] < clipped[3] ? clipped : imageryDraft.bounds;
}

async function planetaryComputerSignedUrl(url: string): Promise<string> {
  if (!/\.blob\.core\.windows\.net\//i.test(url)) return url;
  const response = await fetch(
    `https://planetarycomputer.microsoft.com/api/sas/v1/sign?href=${encodeURIComponent(url)}`,
  );
  if (!response.ok)
    throw new Error(`Could not authorize the Planetary Computer asset (HTTP ${response.status}).`);
  const result = (await response.json()) as { href?: string };
  return result.href ?? url;
}

async function selectedSourceUrl(): Promise<string> {
  if (imageryDraft?.sourceUri && /^(https?:|blob:|data:)/i.test(imageryDraft.sourceUri))
    return imageryDraft.sourceUri;
  const layer = rasterLayers().find((candidate) => candidate.id === selectedImageryId);
  const collection = layer?.metadata.stacCollectionId;
  const itemId = layer?.metadata.stacItemId;
  if (typeof collection === "string" && typeof itemId === "string") {
    const endpoint = `https://planetarycomputer.microsoft.com/api/stac/v1/collections/${encodeURIComponent(
      collection,
    )}/items/${encodeURIComponent(itemId)}`;
    const response = await fetch(endpoint);
    if (!response.ok)
      throw new Error(`Could not retrieve the STAC item (HTTP ${response.status}).`);
    const item = (await response.json()) as {
      assets?: Record<string, { href?: string }>;
    };
    const assets = item.assets ?? {};
    const preferred = ["visual", "rendered_preview", ...Object.keys(assets)]
      .map((key) => assets[key]?.href)
      .find((href): href is string => typeof href === "string" && /\.tiff?(?:\?|$)/i.test(href));
    if (preferred) return preferred;
  }
  throw new Error("The selected layer does not expose a fetchable COG asset.");
}

async function selectedStacAssets(): Promise<Record<string, string>> {
  const layer = rasterLayers().find((candidate) => candidate.id === selectedImageryId);
  const stored = layer?.metadata.assetHrefs;
  if (stored && typeof stored === "object")
    return Object.fromEntries(
      Object.entries(stored).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
  const collection = layer?.metadata.stacCollectionId;
  const itemId = layer?.metadata.stacItemId;
  if (typeof collection !== "string" || typeof itemId !== "string") return {};
  const endpoint = `https://planetarycomputer.microsoft.com/api/stac/v1/collections/${encodeURIComponent(
    collection,
  )}/items/${encodeURIComponent(itemId)}`;
  const response = await fetch(endpoint);
  if (!response.ok) return {};
  const item = (await response.json()) as {
    assets?: Record<string, { href?: string }>;
  };
  return Object.fromEntries(
    Object.entries(item.assets ?? {})
      .filter((entry): entry is [string, { href: string }] => Boolean(entry[1]?.href))
      .map(([key, asset]) => [key, asset.href]),
  );
}

async function loadSentinel2SceneMask(
  bounds: ImageBounds,
): Promise<{ raster: RasterData; bounds: ImageBounds } | null> {
  if (!useSceneMask || !/sentinel-2/i.test(imageryDraft?.sensor ?? "")) return null;
  try {
    const assets = await selectedStacAssets();
    const key = Object.keys(assets).find((candidate) => /^scl$/i.test(candidate));
    if (!key) return null;
    const source = await planetaryComputerSignedUrl(assets[key]);
    const subset = await extractCogSubset(source, {
      bbox: bounds,
      bboxCrs: 4326,
      outputCrs: 4326,
      resolution: 20 / 111_320,
    });
    const bytes = subset.buffer.slice(
      subset.byteOffset,
      subset.byteOffset + subset.byteLength,
    ) as ArrayBuffer;
    return { raster: await readRasterData(bytes), bounds };
  } catch (error) {
    console.warn("Imagery Detection Workbench: SCL mask unavailable", error);
    return null;
  }
}

async function segmentSelectedImagery(): Promise<void> {
  if (!imageryDraft?.bounds || segmenting) return;
  segmenting = true;
  segmentProgress = "Retrieving pixels for the visible image area…";
  renderPanel();
  try {
    const bounds = currentAnalysisBounds()!;
    sceneMask = await loadSentinel2SceneMask(bounds);
    const source = await planetaryComputerSignedUrl(await selectedSourceUrl());
    const nativeResolution = (imageryDraft.resolutionM ?? 10) / 111_320;
    const boundedResolution = Math.max(
      nativeResolution,
      (bounds[2] - bounds[0]) / 2048,
      (bounds[3] - bounds[1]) / 2048,
    );
    const subset = await extractCogSubset(source, {
      bbox: bounds,
      bboxCrs: 4326,
      outputCrs: 4326,
      resolution: boundedResolution,
    });
    segmenting = false;
    const bytes = subset.buffer.slice(
      subset.byteOffset,
      subset.byteOffset + subset.byteLength,
    ) as ArrayBuffer;
    await segmentSourceBytes(bytes, bounds);
  } catch (error) {
    segmentProgress = `${
      error instanceof Error ? error.message : String(error)
    } Use “Choose local GeoTIFF” as a fallback.`;
    segmenting = false;
    renderPanel();
  }
}

function chooseSourceForSegmentation(): void {
  const picker = document.createElement("input");
  picker.type = "file";
  picker.accept = ".tif,.tiff";
  picker.addEventListener("change", () => {
    const file = picker.files?.[0];
    if (file && imageryDraft?.bounds) {
      const fullBounds = imageryDraft.bounds;
      const visibleBounds = currentAnalysisBounds() ?? fullBounds;
      segmentProgress = "Reading the visible area from the local GeoTIFF…";
      renderPanel();
      void readVisibleRasterFile(file, fullBounds, visibleBounds)
        .then((raster) => segmentRaster(raster, visibleBounds))
        .catch((error) => {
          segmentProgress = error instanceof Error ? error.message : String(error);
          renderPanel();
        });
    }
  });
  picker.click();
}

const CSS = {
  panel:
    "display:flex;flex-direction:column;gap:10px;padding:10px;font-size:12px;height:100%;box-sizing:border-box;color:hsl(var(--foreground));overflow:auto;",
  section:
    "display:flex;flex-direction:column;gap:6px;padding:8px;border:1px solid hsl(var(--border));border-radius:7px;",
  heading: "font-weight:600;font-size:12px;",
  muted: "font-size:11px;line-height:1.4;color:hsl(var(--muted-foreground));",
  input:
    "width:100%;box-sizing:border-box;padding:5px 7px;border:1px solid hsl(var(--border));border-radius:5px;background:hsl(var(--background));color:hsl(var(--foreground));",
  row: "display:flex;gap:5px;align-items:center;",
  button:
    "padding:5px 8px;border:1px solid hsl(var(--border));border-radius:5px;background:hsl(var(--background));color:hsl(var(--foreground));cursor:pointer;",
  primary:
    "padding:6px 9px;border:1px solid hsl(var(--primary));border-radius:5px;background:hsl(var(--primary));color:hsl(var(--primary-foreground));cursor:pointer;",
  key: "display:inline-flex;min-width:20px;height:20px;align-items:center;justify-content:center;border:1px solid hsl(var(--border));border-radius:4px;background:hsl(var(--muted));font-family:monospace;font-weight:700;",
} as const;

function rasterLayers(): GeoLibreLayer[] {
  return useAppStore.getState().layers.filter((layer) => RASTER_TYPES.has(layer.type));
}

function imageryFromLayer(layer: GeoLibreLayer): ImageryMetadata {
  return imageryMetadataFromLayer(layer);
}

function showCoverage(index: number): void {
  if (!coverage.length) return;
  coverageIndex = (index + coverage.length) % coverage.length;
  appRef?.fitBounds?.(coverage[coverageIndex]!.bounds);
  renderPanel();
}

function finishCoverage(status: "reviewed" | "skipped"): void {
  if (!coverage.length) return;
  coverage[coverageIndex] = { ...coverage[coverageIndex]!, status };
  showCoverage(coverageIndex + 1);
}

function detections(): DetectionFeature[] {
  const layer = annotationLayerId
    ? useAppStore.getState().layers.find((candidate) => candidate.id === annotationLayerId)
    : useAppStore
        .getState()
        .layers.find((candidate) => candidate.metadata.sourceKind === ANNOTATION_SOURCE_KIND);
  if (!layer) return [];
  annotationLayerId = layer.id;
  return (layer.geojson?.features ?? []).filter(
    (feature): feature is DetectionFeature => feature.geometry?.type === "Polygon",
  );
}

function writeDetections(next: DetectionFeature[]): void {
  if (!appRef) return;
  if (
    !annotationLayerId ||
    !useAppStore.getState().layers.some((layer) => layer.id === annotationLayerId)
  ) {
    annotationLayerId = appRef.addGeoJsonLayer(ANNOTATION_LAYER_NAME, featureCollection(next));
    useAppStore.getState().updateLayer(annotationLayerId, {
      style: {
        ...DEFAULT_LAYER_STYLE,
        fillColor: "#f59e0b",
        fillOpacity: 0.22,
        strokeColor: "#f59e0b",
        strokeWidth: 2,
      },
      metadata: {
        sourceKind: ANNOTATION_SOURCE_KIND,
        workbenchVersion: 1,
      },
    });
    return;
  }
  useAppStore.getState().updateLayer(annotationLayerId, { geojson: featureCollection(next) });
}

function pushUndo(): void {
  undoStack.push(structuredClone(detections()));
  if (undoStack.length > 50) undoStack.shift();
}

function currentIndex(items = detections()): number {
  const index = items.findIndex(
    (feature) => feature.properties.detection_id === selectedDetectionId,
  );
  return index >= 0 ? index : items.length ? 0 : -1;
}

function selectAt(index: number): void {
  const items = detections();
  if (!items.length) selectedDetectionId = null;
  else {
    const selected = items[(index + items.length) % items.length];
    selectedDetectionId = selected.properties.detection_id;
    const ring = selected.geometry.coordinates[0];
    if (ring?.length) {
      const xs = ring.map((point) => point[0]);
      const ys = ring.map((point) => point[1]);
      appRef?.fitBounds?.([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]);
    }
  }
  renderPanel();
}

function advance(): void {
  const items = detections();
  if (!items.length) return selectAt(-1);
  const index = currentIndex(items);
  const nextUnreviewed = items.findIndex(
    (feature, candidate) => candidate > index && feature.properties.review_status === "unreviewed",
  );
  selectAt(nextUnreviewed >= 0 ? nextUnreviewed : index + 1);
}

function updateSelected(
  transform: (feature: DetectionFeature) => DetectionFeature,
  advanceAfter = false,
): void {
  const items = detections();
  const index = currentIndex(items);
  if (index < 0) return;
  pushUndo();
  const next = [...items];
  next[index] = transform(next[index]);
  writeDetections(next);
  selectedDetectionId = next[index].properties.detection_id;
  if (advanceAfter) advance();
  else renderPanel();
}

function screenBoxCorners(
  map: MapLibreMap,
  start: Point,
  end: Point,
): [LngLatPoint, LngLatPoint, LngLatPoint, LngLatPoint] | null {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const length = Math.hypot(dx, dy);
  if (length < 4) return null;
  const halfWidth = Math.max(4, Math.min(18, length * 0.16));
  const px = (-dy / length) * halfWidth;
  const py = (dx / length) * halfWidth;
  const points = [
    [start.x + px, start.y + py],
    [end.x + px, end.y + py],
    [end.x - px, end.y - py],
    [start.x - px, start.y - py],
  ];
  return points.map(([x, y]) => {
    const lngLat = map.unproject([x, y]);
    return [lngLat.lng, lngLat.lat] as LngLatPoint;
  }) as [LngLatPoint, LngLatPoint, LngLatPoint, LngLatPoint];
}

function stopDrawing(): void {
  drawing = false;
  dragStart = null;
  if (boundMap) {
    boundMap.dragPan.enable();
    boundMap.getCanvas().style.cursor = "";
  }
}

function startDrawing(): void {
  if (!boundMap || !imageryDraft) return;
  drawing = true;
  boundMap.dragPan.disable();
  boundMap.getCanvas().style.cursor = "crosshair";
  renderPanel();
}

function onMouseDown(event: MapMouseEvent): void {
  if (!drawing) return;
  event.preventDefault();
  dragStart = event.point;
}

function onMouseUp(event: MapMouseEvent): void {
  if (!drawing || !dragStart || !imageryDraft) return;
  const corners = screenBoxCorners(event.target, dragStart, event.point);
  dragStart = null;
  if (!corners) return;
  pushUndo();
  const feature = createDetectionFeature(corners, imageryDraft);
  writeDetections([...detections(), feature]);
  selectedDetectionId = feature.properties.detection_id;
  stopDrawing();
  renderPanel();
}

function bindMap(map: MapLibreMap | null): void {
  if (boundMap === map) return;
  if (boundMap) {
    boundMap.off("mousedown", onMouseDown);
    boundMap.off("mouseup", onMouseUp);
  }
  boundMap = map;
  if (map) {
    map.on("mousedown", onMouseDown);
    map.on("mouseup", onMouseUp);
  }
}

function isTyping(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLSelectElement ||
    target instanceof HTMLTextAreaElement
  );
}

function onKeyDown(event: KeyboardEvent): void {
  if (
    appRef?.getActiveRightPanel?.() !== PANEL_ID ||
    isTyping(event.target) ||
    event.metaKey ||
    event.ctrlKey
  )
    return;
  const vesselClass = vesselClassForKey(event.key);
  if (vesselClass) {
    event.preventDefault();
    updateSelected((feature) => classifyDetection(feature, vesselClass.id), !event.shiftKey);
    return;
  }
  if (event.key.toLowerCase() === "b") startDrawing();
  else if (event.key.toLowerCase() === "q")
    coverage.length ? showCoverage(coverageIndex - 1) : selectAt(currentIndex() - 1);
  else if (event.key.toLowerCase() === "e")
    coverage.length ? showCoverage(coverageIndex + 1) : selectAt(currentIndex() + 1);
  else if (event.key === " " && coverage.length) finishCoverage("reviewed");
  else if (event.key.toLowerCase() === "w")
    coverage.length ? finishCoverage("skipped") : updateSelected(skipDetection, true);
  else if (event.key.toLowerCase() === "z" && undoStack.length) {
    writeDetections(undoStack.pop()!);
    renderPanel();
  } else if (event.key === "Escape") stopDrawing();
}

function input(
  label: string,
  value: string,
  onChange: (value: string) => void,
  type = "text",
): HTMLElement {
  const wrapper = document.createElement("label");
  wrapper.style.cssText = "display:flex;flex-direction:column;gap:3px;font-size:11px;";
  const caption = document.createElement("span");
  caption.textContent = label;
  const field = document.createElement("input");
  field.type = type;
  field.value = value;
  field.style.cssText = CSS.input;
  field.addEventListener("change", () => onChange(field.value));
  wrapper.append(caption, field);
  return wrapper;
}

function action(label: string, handler: () => void, primary = false): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.style.cssText = primary ? CSS.primary : CSS.button;
  button.addEventListener("click", handler);
  return button;
}

function saveText(name: string, text: string, extensions: string[], mimeType: string): void {
  appRef?.exportTextFile?.(name, text, {
    description: "Training dataset",
    extensions,
    mimeType,
  });
}

function renderPanel(): void {
  const container = panelContainer;
  if (!container) return;
  container.replaceChildren();
  const root = document.createElement("div");
  root.style.cssText = CSS.panel;

  const intro = document.createElement("div");
  intro.style.cssText = CSS.muted;
  intro.textContent =
    "Create reviewed, sensor-aware vessel annotations from any raster layer. Drag along a vessel to make an oriented box, then classify it from the home row.";
  root.append(intro);

  const sourceSection = document.createElement("section");
  sourceSection.style.cssText = CSS.section;
  const heading = document.createElement("div");
  heading.style.cssText = CSS.heading;
  heading.textContent = "1. Imagery source";
  const select = document.createElement("select");
  select.style.cssText = CSS.input;
  const layers = rasterLayers();
  const blank = document.createElement("option");
  blank.value = "";
  blank.textContent = layers.length ? "Choose a raster layer…" : "No raster layers loaded";
  select.append(blank);
  for (const layer of layers) {
    const option = document.createElement("option");
    option.value = layer.id;
    option.textContent = layer.name;
    option.selected = layer.id === selectedImageryId;
    select.append(option);
  }
  select.addEventListener("change", () => {
    selectedImageryId = select.value || null;
    const layer = layers.find((candidate) => candidate.id === selectedImageryId);
    imageryDraft = layer ? imageryFromLayer(layer) : null;
    sceneMask = null;
    coverage = [];
    coverageIndex = 0;
    renderPanel();
  });
  sourceSection.append(heading, select);
  if (imageryDraft) {
    const set = <K extends keyof ImageryMetadata>(key: K, value: ImageryMetadata[K]) => {
      imageryDraft = { ...imageryDraft!, [key]: value };
    };
    sourceSection.append(
      input("Sensor", imageryDraft.sensor, (value) => set("sensor", value || "Unknown")),
      input("Modality", imageryDraft.modality, (value) => set("modality", value || "unknown")),
      input("Acquisition time", imageryDraft.acquiredAt ?? "", (value) =>
        set("acquiredAt", value || undefined),
      ),
      input(
        "Resolution (m)",
        imageryDraft.resolutionM?.toString() ?? "",
        (value) => set("resolutionM", value ? Number(value) : undefined),
        "number",
      ),
      input("Bands / render recipe", imageryDraft.bands ?? "", (value) =>
        set("bands", value || undefined),
      ),
      input(
        "Image width (px)",
        imageryDraft.widthPx?.toString() ?? "",
        (value) => set("widthPx", value ? Number(value) : undefined),
        "number",
      ),
      input(
        "Image height (px)",
        imageryDraft.heightPx?.toString() ?? "",
        (value) => set("heightPx", value ? Number(value) : undefined),
        "number",
      ),
    );
    const sourceNote = document.createElement("div");
    sourceNote.style.cssText = CSS.muted;
    sourceNote.textContent = imageryDraft.bounds
      ? `Bounds detected: ${imageryDraft.bounds.map((value) => value.toFixed(4)).join(", ")}`
      : "No geographic bounds found. GeoJSON export works, but COCO/YOLO pixel export requires bounds.";
    sourceSection.append(sourceNote);
  }
  root.append(sourceSection);

  const discover = document.createElement("section");
  discover.style.cssText = CSS.section;
  const discoverHeading = document.createElement("div");
  discoverHeading.style.cssText = CSS.heading;
  discoverHeading.textContent = "2. Discover candidates with SAM";
  discover.append(discoverHeading);
  const discoverActions = document.createElement("div");
  discoverActions.style.cssText = CSS.row;
  const selectedLayer = layers.find((layer) => layer.id === selectedImageryId);
  const remoteSource = Boolean(
    (imageryDraft?.sourceUri && /^(https?:|blob:|data:)/i.test(imageryDraft.sourceUri)) ||
    (selectedLayer?.metadata.stacCollectionId && selectedLayer.metadata.stacItemId),
  );
  if (remoteSource) {
    discoverActions.append(
      action(
        segmenting ? "SAM is running…" : "Analyze visible imagery",
        () => void segmentSelectedImagery(),
        true,
      ),
    );
  }
  discoverActions.append(
    action("Choose local GeoTIFF", chooseSourceForSegmentation, !remoteSource),
  );
  discover.append(discoverActions);
  const discoverNote = document.createElement("div");
  discoverNote.style.cssText = CSS.muted;
  discoverNote.textContent =
    segmentProgress ||
    (imageryDraft?.bounds
      ? remoteSource
        ? "The visible map area is fetched automatically from the selected COG/STAC asset. Zoom to the area you want analyzed, then run SAM."
        : "This layer does not expose source pixels. Choose its source GeoTIFF as a fallback."
      : "Choose imagery with known bounds before running SAM.");
  discover.append(discoverNote);
  if (/sentinel-2/i.test(imageryDraft?.sensor ?? "")) {
    const maskLabel = document.createElement("label");
    maskLabel.style.cssText = "display:flex;gap:6px;align-items:flex-start;font-size:11px;";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = useSceneMask;
    checkbox.addEventListener("change", () => {
      useSceneMask = checkbox.checked;
      if (!useSceneMask) sceneMask = null;
    });
    const caption = document.createElement("span");
    caption.textContent =
      "Use Sentinel-2 SCL water/coastal mask when available (keeps a ~100 m coastal margin; rejects confident land, cloud, shadow, and snow).";
    maskLabel.append(checkbox, caption);
    discover.append(maskLabel);
  }
  root.append(discover);

  const coverageSection = document.createElement("section");
  coverageSection.style.cssText = CSS.section;
  const coverageHeading = document.createElement("div");
  coverageHeading.style.cssText = CSS.heading;
  coverageHeading.textContent = "3. Review coverage";
  coverageSection.append(coverageHeading);
  if (imageryDraft?.bounds) {
    if (!coverage.length) {
      coverageSection.append(
        action(
          "Create 6 × 6 review grid",
          () => {
            coverage = createCoverageGrid(imageryDraft!.bounds!, 6, 6);
            showCoverage(0);
          },
          true,
        ),
      );
    } else {
      const reviewed = coverage.filter((chip) => chip.status !== "unreviewed").length;
      const status = document.createElement("div");
      status.style.cssText = CSS.muted;
      status.textContent = `Chip ${coverageIndex + 1} / ${
        coverage.length
      } · ${reviewed} reviewed · current: ${coverage[coverageIndex]!.status}`;
      const row = document.createElement("div");
      row.style.cssText = CSS.row;
      row.append(
        action("Q  Previous", () => showCoverage(coverageIndex - 1)),
        action("Space  Reviewed + next", () => finishCoverage("reviewed"), true),
        action("E  Next", () => showCoverage(coverageIndex + 1)),
      );
      coverageSection.append(status, row);
    }
  } else {
    const note = document.createElement("div");
    note.style.cssText = CSS.muted;
    note.textContent =
      "This source has no geographic bounds, so a coverage grid cannot be generated.";
    coverageSection.append(note);
  }
  root.append(coverageSection);

  const annotate = document.createElement("section");
  annotate.style.cssText = CSS.section;
  const items = detections();
  const index = currentIndex(items);
  const selected = index >= 0 ? items[index] : null;
  const annotateHeading = document.createElement("div");
  annotateHeading.style.cssText = CSS.heading;
  annotateHeading.textContent = `4. Annotate (${
    items.length ? `${index + 1} / ${items.length}` : "empty"
  })`;
  const drawRow = document.createElement("div");
  drawRow.style.cssText = CSS.row;
  drawRow.append(
    action(drawing ? "Drag on map…" : "B  Draw vessel box", startDrawing, true),
    action("Q  Previous", () => selectAt(index - 1)),
    action("E  Next", () => selectAt(index + 1)),
  );
  annotate.append(annotateHeading, drawRow);
  if (selected) {
    const status = document.createElement("div");
    status.style.cssText = CSS.muted;
    status.textContent = `${selected.properties.review_status} · ${
      selected.properties.vessel_class?.replaceAll("_", " ") ?? "unclassified"
    } · ${selected.properties.geometry_source}${
      selected.properties.model_score !== undefined
        ? ` ${selected.properties.model_score.toFixed(2)}`
        : ""
    } · ${selected.properties.detection_id.slice(0, 8)}`;
    annotate.append(status);
  }
  const keyGrid = document.createElement("div");
  keyGrid.style.cssText = "display:grid;grid-template-columns:1fr 1fr;gap:4px;";
  for (const entry of VESSEL_CLASSES) {
    const button = action(`${entry.key.toUpperCase()}  ${entry.label}`, () => {
      updateSelected((feature) => classifyDetection(feature, entry.id), true);
    });
    button.style.textAlign = "start";
    keyGrid.append(button);
  }
  annotate.append(keyGrid);
  const help = document.createElement("div");
  help.style.cssText = CSS.muted;
  help.textContent =
    "Shift + class keeps the current detection open. W skips. Z undoes. Esc cancels drawing. Work is autosaved in the project annotation layer.";
  annotate.append(help);
  root.append(annotate);

  const exports = document.createElement("section");
  exports.style.cssText = CSS.section;
  const exportHeading = document.createElement("div");
  exportHeading.style.cssText = CSS.heading;
  exportHeading.textContent = "5. Export dataset";
  exports.append(exportHeading);
  if (imageryDraft) {
    const exportButtons = document.createElement("div");
    exportButtons.style.cssText = "display:flex;gap:5px;flex-wrap:wrap;";
    exportButtons.append(
      action("GeoJSON", () =>
        saveText(
          "vessel-annotations.geojson",
          JSON.stringify(featureCollection(items), null, 2),
          ["geojson", "json"],
          "application/geo+json",
        ),
      ),
      action("Manifest CSV", () =>
        saveText(
          "imagery-manifest.csv",
          exportManifestCsv(imageryDraft!, items),
          ["csv"],
          "text/csv",
        ),
      ),
      action("Annotations CSV", () =>
        saveText("vessel-annotations.csv", exportAnnotationsCsv(items), ["csv"], "text/csv"),
      ),
      action("COCO", () => {
        try {
          saveText(
            "vessel-annotations.coco.json",
            JSON.stringify(exportCoco(imageryDraft!, items), null, 2),
            ["json"],
            "application/json",
          );
        } catch (error) {
          window.alert(error instanceof Error ? error.message : String(error));
        }
      }),
      action("YOLO OBB", () => {
        try {
          saveText(
            "vessel-annotations.txt",
            exportYoloObb(imageryDraft!, items),
            ["txt"],
            "text/plain",
          );
        } catch (error) {
          window.alert(error instanceof Error ? error.message : String(error));
        }
      }),
    );
    exports.append(exportButtons);
    const exportNote = document.createElement("div");
    exportNote.style.cssText = CSS.muted;
    exportNote.textContent =
      imageryDraft.widthPx && imageryDraft.heightPx && imageryDraft.bounds
        ? "Pixel export is enabled. Coordinates assume this source is north-up within the recorded geographic bounds."
        : "Enter source pixel dimensions and use imagery with known bounds to enable COCO and YOLO OBB export.";
    exports.append(exportNote);
  } else {
    const note = document.createElement("div");
    note.style.cssText = CSS.muted;
    note.textContent = "Choose an imagery source before exporting.";
    exports.append(note);
  }
  root.append(exports);
  container.append(root);
}

export const maplibreImageryDetectionWorkbenchPlugin: GeoLibrePlugin = {
  id: IMAGERY_DETECTION_WORKBENCH_ID,
  name: "Imagery Detection Workbench",
  version: "0.1.0",
  activate: (app) => {
    appRef = app;
    annotationLayerId =
      useAppStore
        .getState()
        .layers.find((layer) => layer.metadata.sourceKind === ANNOTATION_SOURCE_KIND)?.id ?? null;
    bindMap(app.getMap?.() ?? null);
    document.addEventListener("keydown", onKeyDown);
    unsubscribeStore = useAppStore.subscribe(() => {
      if (panelContainer) renderPanel();
    });
    unregisterPanel =
      app.registerRightPanel?.({
        id: PANEL_ID,
        title: "Imagery Detection Workbench",
        dock: "left-of-style",
        defaultWidth: 390,
        render: (container) => {
          panelContainer = container;
          renderPanel();
          return () => {
            if (panelContainer === container) panelContainer = null;
          };
        },
        onOpen: () => bindMap(app.getMap?.() ?? null),
        onClose: stopDrawing,
      }) ?? null;
    if (!unregisterPanel) return false;
    app.openRightPanel?.(PANEL_ID);
  },
  deactivate: (app) => {
    stopDrawing();
    bindMap(null);
    document.removeEventListener("keydown", onKeyDown);
    unsubscribeStore?.();
    unsubscribeStore = null;
    app.closeRightPanel?.(PANEL_ID);
    unregisterPanel?.();
    unregisterPanel = null;
    panelContainer = null;
    appRef = null;
  },
};
