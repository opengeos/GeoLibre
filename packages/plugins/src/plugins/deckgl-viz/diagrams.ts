import {
  MAX_DIAGRAM_FEATURES,
  collectDiagramData,
  diagramPixelSize,
  diagramsSuppressedByPointRenderer,
  isDiagramStyleEnabled,
  styleValue,
  type DiagramData,
  type GeoLibreLayer,
} from "@geolibre/core";
import type { Layer } from "@deck.gl/core";
import type { FeatureCollection } from "geojson";
import type { GeoLibreDeckGL } from "../../types";

/**
 * Diagram symbology (per-feature pie/donut/bar charts) for ordinary vector
 * layers, rendered through the shared deck.gl overlay on top of the layer's
 * normal MapLibre symbology. Every configured feature's chart is rasterized
 * once into a single icon atlas canvas (cached per FeatureCollection + style
 * signature) and drawn with one IconLayer, so pan/zoom and the per-frame
 * overlay rebuilds stay cheap. The pure data extraction lives in
 * `@geolibre/core`'s diagram.ts; this module owns the canvas drawing and the
 * deck.gl layer.
 */

// Draw at 2x for crisp icons on high-DPI displays.
const DPR = 2;
// Transparent gutter around each atlas cell so texture sampling never bleeds
// between neighboring icons.
const CELL_PAD = 2 * DPR;
const ATLAS_WIDTH = 2048;
/**
 * Hard cap on the atlas canvas height. Without it, many features at a large
 * diagram size could demand a canvas past browser per-axis limits (Firefox:
 * 32,767px) and hundreds of MB of pixels; diagrams that do not fit are
 * dropped (largest layers hit MAX_DIAGRAM_FEATURES first anyway).
 */
export const MAX_ATLAS_HEIGHT = 8192;
// Donut hole radius as a fraction of the outer radius.
const DONUT_INNER_RATIO = 0.5;
// Stacked bars are columns: narrower than the square pie/bar box.
const STACKED_BAR_WIDTH_RATIO = 0.45;

/**
 * Whether a store layer has diagrams to render: an in-memory GeoJSON vector
 * layer (not a deck-viz dataset layer, which has its own renderer) whose style
 * enables diagram symbology. Point layers rendered as heatmap/cluster don't
 * draw diagrams — the Style Panel hides the diagram controls there, so
 * rendering them would leave charts with no UI path to turn them off.
 *
 * @param layer - The store layer to test.
 */
export function isDiagramLayer(layer: GeoLibreLayer): boolean {
  return (
    !!layer.geojson &&
    // Deck-viz dataset layers have their own renderer (this also covers
    // isDeckVizLayer, which requires this type).
    layer.type !== "deckgl-viz" &&
    // Layers rendered by an external deck path (e.g. DuckDB custom layers)
    // don't get diagrams — the Style Panel hides the controls for them.
    layer.metadata.externalDeckLayer !== true &&
    !diagramsSuppressedByPointRenderer(layer.geojson, layer.style) &&
    isDiagramStyleEnabled(layer.style)
  );
}

interface AtlasEntry {
  /** Icon id in the atlas mapping. */
  icon: string;
  /** Rendered (CSS pixel) height deck should draw this icon at. */
  height: number;
  /** Rendered (CSS pixel) width, for declutter box tests. */
  width: number;
  position: [number, number];
  sizeValue: number;
}

interface IconMappingEntry {
  x: number;
  y: number;
  width: number;
  height: number;
  anchorX: number;
  anchorY: number;
}

interface DiagramAtlas {
  /** The packed atlas as a PNG data URL (deck's iconAtlas accepts a string). */
  atlasUrl: string;
  mapping: Record<string, IconMappingEntry>;
  entries: AtlasEntry[];
}

interface DiagramCacheValue {
  signature: string;
  atlas: DiagramAtlas | null;
  /** Diagram-loss counts of this build, for change-gated console notes. */
  truncated: boolean;
  dropped: number;
}

// One cache entry per source FeatureCollection; rebuilt only when the diagram
// style signature changes, not on unrelated overlay rebuilds (opacity toggles,
// other layers, animation frames).
const atlasCache = new WeakMap<FeatureCollection, DiagramCacheValue>();

function diagramSignature(layer: GeoLibreLayer): string {
  const style = layer.style;
  return JSON.stringify([
    styleValue(style, "diagramType"),
    styleValue(style, "diagramFields"),
    styleValue(style, "diagramSizeMode"),
    styleValue(style, "diagramSize"),
    styleValue(style, "diagramSizeProperty"),
  ]);
}

function drawPie(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  radius: number,
  values: number[],
  total: number,
  colors: string[],
  donut: boolean,
): void {
  let angle = -Math.PI / 2;
  for (let i = 0; i < values.length; i += 1) {
    if (values[i] <= 0) continue;
    const sweep = (values[i] / total) * Math.PI * 2;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, radius, angle, angle + sweep);
    ctx.closePath();
    ctx.fillStyle = colors[i];
    ctx.fill();
    ctx.strokeStyle = "rgba(255,255,255,0.9)";
    ctx.lineWidth = DPR;
    ctx.stroke();
    angle += sweep;
  }
  if (donut) {
    ctx.save();
    ctx.globalCompositeOperation = "destination-out";
    ctx.beginPath();
    ctx.arc(cx, cy, radius * DONUT_INNER_RATIO, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
}

function drawBars(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  values: number[],
  maxFieldValue: number,
  colors: string[],
): void {
  if (maxFieldValue <= 0 || values.length === 0) return;
  // Gaps are capped to a fraction of the box so bars always fit inside their
  // own atlas cell (a forced minimum bar width would spill into neighbors).
  const gap = values.length > 1 ? Math.min(DPR, (width * 0.2) / (values.length - 1)) : 0;
  const barWidth = (width - gap * (values.length - 1)) / values.length;
  ctx.lineWidth = Math.max(1, DPR / 2);
  ctx.strokeStyle = "rgba(255,255,255,0.9)";
  for (let i = 0; i < values.length; i += 1) {
    const barHeight = (values[i] / maxFieldValue) * height;
    if (barHeight <= 0) continue;
    const barX = x + i * (barWidth + gap);
    ctx.fillStyle = colors[i];
    ctx.fillRect(barX, y + height - barHeight, barWidth, barHeight);
    ctx.strokeRect(barX, y + height - barHeight, barWidth, barHeight);
  }
}

function drawStackedBar(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  values: number[],
  total: number,
  colors: string[],
): void {
  let top = y + height;
  ctx.lineWidth = Math.max(1, DPR / 2);
  ctx.strokeStyle = "rgba(255,255,255,0.9)";
  for (let i = 0; i < values.length; i += 1) {
    if (values[i] <= 0) continue;
    const segment = (values[i] / total) * height;
    top -= segment;
    ctx.fillStyle = colors[i];
    ctx.fillRect(x, top, width, segment);
    ctx.strokeRect(x, top, width, segment);
  }
}

/** One packed atlas cell: content box position/size plus its source datum. */
export interface DiagramCell {
  x: number;
  y: number;
  width: number;
  height: number;
  datumIndex: number;
}

/**
 * Shelf-pack content boxes into the atlas: cells flow left-to-right in rows of
 * the tallest cell's height, wrapping at {@link ATLAS_WIDTH} and stopping at
 * {@link MAX_ATLAS_HEIGHT}. Pure so the arithmetic is unit-testable without a
 * canvas.
 *
 * @param sizes - Content box sizes in atlas pixels, in datum order.
 * @param maxHeight - Atlas height bound; callers pass the device texture
 *   limit when it is lower than {@link MAX_ATLAS_HEIGHT}.
 * @returns The packed cells (positions exclude the per-cell padding gutter),
 *   the resulting atlas height, and how many boxes were dropped for space.
 */
export function packDiagramCells(
  sizes: ReadonlyArray<{ width: number; height: number }>,
  maxHeight: number = MAX_ATLAS_HEIGHT,
): { cells: DiagramCell[]; atlasHeight: number; dropped: number } {
  const cells: DiagramCell[] = [];
  let cursorX = 0;
  let cursorY = 0;
  let rowHeight = 0;
  let dropped = 0;
  for (let i = 0; i < sizes.length; i += 1) {
    const { width, height } = sizes[i];
    const cellWidth = width + CELL_PAD * 2;
    const cellHeight = height + CELL_PAD * 2;
    if (cursorX + cellWidth > ATLAS_WIDTH && cursorX > 0) {
      cursorX = 0;
      cursorY += rowHeight;
      rowHeight = 0;
    }
    if (cursorY + cellHeight > maxHeight) {
      dropped = sizes.length - i;
      break;
    }
    cells.push({ x: cursorX, y: cursorY, width, height, datumIndex: i });
    cursorX += cellWidth;
    if (cellHeight > rowHeight) rowHeight = cellHeight;
  }
  return { cells, atlasHeight: cursorY + rowHeight, dropped };
}

// The device's maximum texture dimension, probed once from a throwaway WebGL
// context (the same GPU the shared deck overlay renders with). The atlas is
// uploaded as a texture, so packing past this limit would silently fail to
// render on lower-end devices where MAX_ATLAS_HEIGHT is not supported.
let cachedMaxTextureSize: number | null = null;
function deviceMaxTextureSize(): number {
  if (cachedMaxTextureSize !== null) return cachedMaxTextureSize;
  // Conservative floor supported by effectively every WebGL device.
  let size = 4096;
  try {
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
    if (gl) {
      const reported = gl.getParameter(gl.MAX_TEXTURE_SIZE);
      if (typeof reported === "number" && reported > 0) size = reported;
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    }
  } catch {
    // Keep the floor.
  }
  cachedMaxTextureSize = size;
  return size;
}

/** Atlas-pixel content box sizes for every datum, in datum order. */
function diagramCellSizes(
  diagramData: DiagramData,
  style: GeoLibreLayer["style"],
): { width: number; height: number }[] {
  const type = styleValue(style, "diagramType");
  return diagramData.data.map((datum) => {
    const size = Math.round(diagramPixelSize(datum, style, diagramData.maxSizeValue) * DPR);
    const width =
      type === "stacked-bar" ? Math.max(4 * DPR, Math.round(size * STACKED_BAR_WIDTH_RATIO)) : size;
    return { width, height: size };
  });
}

/**
 * Predicted number of a layer's drawable diagrams that the icon atlas cannot
 * fit (0 when everything fits). Runs the same packing arithmetic as the
 * renderer without touching a canvas, so the Style Panel can warn about
 * silently dropped diagrams (e.g. a large diagram size on many features).
 *
 * @param layer - The layer's GeoJSON and style.
 * @param diagramData - Optional precomputed dataset, so a caller that already
 *   ran {@link collectDiagramData} does not scan the features twice.
 */
export function countAtlasDroppedDiagrams(
  layer: Pick<GeoLibreLayer, "geojson" | "style">,
  diagramData?: DiagramData,
): number {
  if (!layer.geojson) return 0;
  const data = diagramData ?? collectDiagramData(layer.geojson, layer.style);
  if (data.data.length === 0) return 0;
  return packDiagramCells(
    diagramCellSizes(data, layer.style),
    Math.min(MAX_ATLAS_HEIGHT, deviceMaxTextureSize()),
  ).dropped;
}

/**
 * Rasterize every feature diagram into one atlas canvas with shelf packing
 * (cells laid out left-to-right in rows). Returns null when no feature has
 * drawable data.
 */
function buildAtlas(layer: GeoLibreLayer, diagramData: DiagramData): DiagramAtlas | null {
  if (diagramData.data.length === 0) return null;
  if (typeof document === "undefined") return null;
  const style = layer.style;
  const colors = styleValue(style, "diagramFields")
    .filter((field) => field.property !== "")
    .map((field) => field.color);
  const type = styleValue(style, "diagramType");

  // Lay out cells first so the canvas can be allocated at its final size.
  const { cells, atlasHeight } = packDiagramCells(
    diagramCellSizes(diagramData, style),
    Math.min(MAX_ATLAS_HEIGHT, deviceMaxTextureSize()),
  );
  if (cells.length === 0) return null;

  const canvas = document.createElement("canvas");
  canvas.width = ATLAS_WIDTH;
  canvas.height = atlasHeight;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  const mapping: Record<string, IconMappingEntry> = {};
  const entries: AtlasEntry[] = [];
  for (const cell of cells) {
    const datum = diagramData.data[cell.datumIndex];
    const x = cell.x + CELL_PAD;
    const y = cell.y + CELL_PAD;
    if (type === "bar") {
      drawBars(ctx, x, y, cell.width, cell.height, datum.values, diagramData.maxFieldValue, colors);
    } else if (type === "stacked-bar") {
      drawStackedBar(ctx, x, y, cell.width, cell.height, datum.values, datum.total, colors);
    } else {
      drawPie(
        ctx,
        x + cell.width / 2,
        y + cell.height / 2,
        cell.width / 2 - DPR / 2,
        datum.values,
        datum.total,
        colors,
        type === "donut",
      );
    }
    const icon = `d${cell.datumIndex}`;
    mapping[icon] = {
      x,
      y,
      width: cell.width,
      height: cell.height,
      anchorX: cell.width / 2,
      anchorY: cell.height / 2,
    };
    entries.push({
      icon,
      height: cell.height / DPR,
      width: cell.width / DPR,
      position: datum.position,
      sizeValue: datum.sizeValue,
    });
  }
  return { atlasUrl: canvas.toDataURL("image/png"), mapping, entries };
}

function getAtlas(layer: GeoLibreLayer): DiagramAtlas | null {
  const geojson = layer.geojson as FeatureCollection;
  const signature = diagramSignature(layer);
  const cached = atlasCache.get(geojson);
  if (cached && cached.signature === signature) return cached.atlas;

  const diagramData = collectDiagramData(geojson, layer.style);
  const atlas = buildAtlas(layer, diagramData);
  // Derived from the packing arithmetic (not the built atlas) so the count is
  // right even when nothing fit and buildAtlas returned null.
  const dropped = countAtlasDroppedDiagrams({ geojson, style: layer.style }, diagramData);
  // Console notes are gated on a change in the loss counts, so per-keystroke
  // style edits (each of which rebuilds the atlas) don't spam the console.
  if (diagramData.truncated && !cached?.truncated) {
    console.info(
      `[GeoLibre] diagrams: layer exceeds ${MAX_DIAGRAM_FEATURES} features; ` +
        `only the first ${MAX_DIAGRAM_FEATURES} are charted`,
    );
  }
  if (dropped > 0 && dropped !== cached?.dropped) {
    console.info(
      `[GeoLibre] diagrams: atlas full, dropped ${dropped} of ` +
        `${diagramData.data.length} feature diagrams (reduce the diagram size ` +
        `to fit more)`,
    );
  }
  atlasCache.set(geojson, {
    signature,
    atlas,
    truncated: diagramData.truncated,
    dropped,
  });
  return atlas;
}

/**
 * Greedy screen-space decluttering: keep the largest diagrams and drop any
 * whose screen box overlaps one already kept. A coarse spatial hash keeps the
 * overlap test linear-ish for dense layers. Pure (exported for tests).
 *
 * @param entries - Diagram entries with screen-pixel width/height.
 * @param project - Maps a lng/lat position to screen coordinates.
 */
export function declutterEntries<
  T extends { width: number; height: number; position: [number, number] },
>(entries: T[], project: (position: [number, number]) => { x: number; y: number }): T[] {
  interface Placed {
    x: number;
    y: number;
    halfW: number;
    halfH: number;
  }
  const ordered = entries
    .map((entry) => {
      const point = project(entry.position);
      return { entry, x: point.x, y: point.y };
    })
    .sort((a, b) => b.entry.height - a.entry.height);
  const cellSize = 64;
  const grid = new Map<string, Placed[]>();
  const kept: T[] = [];
  for (const candidate of ordered) {
    const halfW = candidate.entry.width / 2;
    const halfH = candidate.entry.height / 2;
    const minCellX = Math.floor((candidate.x - halfW) / cellSize);
    const maxCellX = Math.floor((candidate.x + halfW) / cellSize);
    const minCellY = Math.floor((candidate.y - halfH) / cellSize);
    const maxCellY = Math.floor((candidate.y + halfH) / cellSize);
    let overlaps = false;
    outer: for (let cx = minCellX; cx <= maxCellX; cx += 1) {
      for (let cy = minCellY; cy <= maxCellY; cy += 1) {
        for (const placed of grid.get(`${cx}:${cy}`) ?? []) {
          if (
            Math.abs(candidate.x - placed.x) < halfW + placed.halfW &&
            Math.abs(candidate.y - placed.y) < halfH + placed.halfH
          ) {
            overlaps = true;
            break outer;
          }
        }
      }
    }
    if (overlaps) continue;
    kept.push(candidate.entry);
    const placed: Placed = { x: candidate.x, y: candidate.y, halfW, halfH };
    for (let cx = minCellX; cx <= maxCellX; cx += 1) {
      for (let cy = minCellY; cy <= maxCellY; cy += 1) {
        const key = `${cx}:${cy}`;
        const bucket = grid.get(key);
        if (bucket) bucket.push(placed);
        else grid.set(key, [placed]);
      }
    }
  }
  return kept;
}

/**
 * Build the deck.gl IconLayer rendering a layer's feature diagrams, or an
 * empty list below the configured minimum zoom / when nothing is drawable.
 *
 * @param deckGL - The host's deck.gl module bundle.
 * @param layer - The store layer (must satisfy {@link isDiagramLayer}).
 * @param options - The current map zoom (for the min-zoom gate) and a
 *   screen-space projector (for optional decluttering); either may be missing
 *   when the map is not available, disabling that behavior.
 */
// Declutter results cached per atlas entry list + view signature, so the
// per-frame overlay rebuilds driven by an animated layer's rAF loop don't
// redo the sort/overlap sweep while the view is unchanged; the overlay's
// zoomend/moveend listeners produce a new signature once the view settles.
const declutterCache = new WeakMap<object, { viewKey: string; result: AtlasEntry[] }>();

/**
 * A signature of the current view derived from two projected reference
 * points, capturing pan, zoom, and rotation without needing the map object.
 */
function viewSignature(project: (position: [number, number]) => { x: number; y: number }): string {
  const a = project([0, 0]);
  const b = project([90, 45]);
  return `${a.x.toFixed(1)},${a.y.toFixed(1)},${b.x.toFixed(1)},${b.y.toFixed(1)}`;
}

export function buildDiagramLayers(
  deckGL: GeoLibreDeckGL,
  layer: GeoLibreLayer,
  options: {
    zoom?: number;
    project?: ((position: [number, number]) => { x: number; y: number }) | null;
  } = {},
): Layer[] {
  const style = layer.style;
  const minZoom = styleValue(style, "diagramMinZoom");
  if (minZoom > 0 && typeof options.zoom === "number" && options.zoom < minZoom) {
    return [];
  }
  const atlas = getAtlas(layer);
  if (!atlas) return [];
  let entries = atlas.entries;
  if (styleValue(style, "diagramDeclutter") && options.project) {
    const viewKey = viewSignature(options.project);
    const cached = declutterCache.get(atlas.entries);
    if (cached && cached.viewKey === viewKey) {
      entries = cached.result;
    } else {
      entries = declutterEntries(atlas.entries, options.project);
      declutterCache.set(atlas.entries, { viewKey, result: entries });
    }
  }
  if (entries.length === 0) return [];
  return [
    new deckGL.layers.IconLayer<AtlasEntry>({
      id: `${layer.id}-diagrams`,
      data: entries,
      iconAtlas: atlas.atlasUrl,
      iconMapping: atlas.mapping,
      getIcon: (entry: AtlasEntry) => entry.icon,
      getPosition: (entry: AtlasEntry) => entry.position,
      getSize: (entry: AtlasEntry) => entry.height,
      sizeUnits: "pixels",
      billboard: true,
      opacity: layer.opacity,
      // Clicks pass through to the underlying MapLibre feature (identify).
      pickable: false,
    }),
  ];
}
