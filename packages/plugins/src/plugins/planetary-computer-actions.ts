import type {
  ActiveLayer,
  PlanetaryComputerCustomActions,
  ResultsActionContext,
  STACItem,
  TileParams,
} from "maplibre-gl-planetary-computer";
import type { SourceSpec, TimeSliderConfig } from "maplibre-gl-time-slider";
import type { GeoLibreAppAPI } from "../types";
import { showColorbar } from "./components/colorbar";
import {
  getPlanetaryComputerClients,
  planetaryComputerItemDate,
  setPlanetaryComputerCustomActions,
} from "./maplibre-planetary-computer";
import { requestStacCatalogUrl, STAC_PLUGIN_ID } from "./maplibre-stac";
import { applyTimeSliderConfig, registerTimeSliderSourceRehydrator } from "./maplibre-time-slider";
import { PLANETARY_COMPUTER_STAC_URL } from "./planetary-computer-stac";
import { type PixelSeriesStepReader, registerPixelSeriesReader } from "./time-slider-pixel-series";

// The buttons GeoLibre adds to the Planetary Computer panel. Each one hands
// what the panel found to another part of the app: a collection to the STAC
// browser (for the assets the panel's raster tiler cannot draw), a search
// result to the Time Slider as a dated stack, a layer's colormap to the
// Colorbar control, and a clipped scene to the raster pipeline.

/** Translatable strings for the panel's GeoLibre buttons. */
export interface PlanetaryComputerLabels {
  stacBrowser: string;
  stacBrowserTitle: string;
  timeSlider: string;
  timeSliderTitle: string;
  colorbar: string;
  colorbarTitle: string;
  clipToMap: string;
  clipToMapTitle: string;
  /** Name of a clip layer; `{{item}}` is replaced by the STAC item id. */
  clipLayerName: string;
  /** Error shown when the clip area does not overlap the item. */
  clipOutsideItem: string;
  /** Error shown when the scene or the active map cannot take a clip layer. */
  clipUnavailable: string;
  /** Name of the Time Slider layer; `{{collection}}` is replaced by the collection title. */
  timeSeriesLayerName: string;
  /** Error shown when fewer than two results carry a date. */
  timeSliderNeedsDates: string;
  /** Error shown when the Time Slider could not be opened. */
  timeSliderUnavailable: string;
}

const DEFAULT_LABELS: PlanetaryComputerLabels = {
  stacBrowser: "Browse in STAC catalogs",
  stacBrowserTitle:
    "Open this collection in the STAC catalogs panel to add point clouds, GeoParquet, Zarr, and other assets the raster tiler cannot draw",
  timeSlider: "Animate in Time slider",
  timeSliderTitle:
    "Step through these results by date in the Time slider and chart a pixel through time",
  colorbar: "Show colorbar",
  colorbarTitle: "Add a colorbar for this layer's colormap and value range to the map",
  clipToMap: "Add clip to map",
  clipToMapTitle:
    "Clip this scene to the drawn box (or the map view) and add its raw band values as a raster layer for analysis",
  clipLayerName: "{{item}} clip",
  clipOutsideItem:
    "The clip area does not overlap this scene. Draw a box inside its footprint or move the map over it.",
  clipUnavailable: "This scene cannot be added as a clip on this map.",
  timeSeriesLayerName: "{{collection}} time series",
  timeSliderNeedsDates: "At least two results with different dates are needed for a time series.",
  timeSliderUnavailable: "The Time slider is not available on this map.",
};

let labels: PlanetaryComputerLabels = DEFAULT_LABELS;

/**
 * Sets the translated strings for the panel's GeoLibre buttons.
 *
 * The buttons read these when they are drawn, so a language switch shows up the
 * next time the panel renders a view.
 *
 * @param next - The translated labels; missing keys keep their English default.
 */
export function setPlanetaryComputerLabels(next: Partial<PlanetaryComputerLabels>): void {
  labels = { ...DEFAULT_LABELS, ...next };
}

// ----- Time Slider stack -----------------------------------------------------

/** Marker key on a Time Slider source that holds a {@link PlanetaryComputerStack}. */
export const PLANETARY_COMPUTER_STACK_KEY = "planetaryComputerStack";

/** One dated item of a stack. */
export interface PlanetaryComputerStackItem {
  /** STAC item id. */
  id: string;
  /** Acquisition day, `YYYY-MM-DD` (UTC). */
  date: string;
}

/**
 * The serializable description of a Planetary Computer dated stack.
 *
 * It rides on the Time Slider source spec, so it is saved with the project;
 * the source's tile URL is a function of the date (one STAC item per date) and
 * is rebuilt from this description when the project is reopened.
 */
export interface PlanetaryComputerStack {
  /** STAC collection id. */
  collection: string;
  /** The items, oldest first, one per date. */
  items: PlanetaryComputerStackItem[];
  /** Data API render parameters shared by every date. */
  renderParams: TileParams;
}

/**
 * The area two `[west, south, east, north]` boxes share, in square degrees.
 *
 * @param a - First box.
 * @param b - Second box (a 3D STAC bbox is accepted).
 * @returns The overlap area, or 0 when they do not overlap.
 */
function overlapArea(a: [number, number, number, number], b: number[] | undefined): number {
  const box = b?.length === 6 ? [b[0], b[1], b[3], b[4]] : b?.length === 4 ? b : null;
  if (!box) return 0;
  const width = Math.min(a[2], box[2]) - Math.max(a[0], box[0]);
  const height = Math.min(a[3], box[3]) - Math.max(a[1], box[1]);
  return width > 0 && height > 0 ? width * height : 0;
}

/**
 * Reduces search results to one item per calendar day, oldest first.
 *
 * A search area usually spans several tiles of the collection's grid, so a
 * single day returns several items. With a `focus` box the item covering the
 * most of it is kept for each day, and days whose items all miss it are
 * dropped, so the stack shows the area that was searched rather than whichever
 * neighboring tile happened to sort first. Without one (or on a tie) the first
 * item seen wins: results arrive in the order the search sorted them, so that
 * is the one the user's sort preferred.
 *
 * @param items - STAC search results.
 * @param focus - `[west, south, east, north]` the stack should cover, typically the search bbox.
 * @returns The dated items, ascending by date.
 */
export function planetaryComputerStackItems(
  items: STACItem[],
  focus?: [number, number, number, number],
): PlanetaryComputerStackItem[] {
  const byDate = new Map<string, { id: string; score: number }>();
  for (const item of items) {
    const datetime = planetaryComputerItemDate(item);
    const time = datetime ? Date.parse(datetime) : Number.NaN;
    if (!Number.isFinite(time)) continue;
    const score = focus ? overlapArea(focus, item.bbox) : 1;
    if (score <= 0) continue;
    const date = new Date(time).toISOString().slice(0, 10);
    const current = byDate.get(date);
    if (!current || score > current.score) byDate.set(date, { id: item.id, score });
  }
  return [...byDate.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, { id }]) => ({ id, date }));
}

/**
 * Validates a stack description read back from a saved project.
 *
 * @param value - The untyped value from the source spec.
 * @returns The stack, or null when it is malformed.
 */
export function parsePlanetaryComputerStack(value: unknown): PlanetaryComputerStack | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<PlanetaryComputerStack>;
  if (typeof candidate.collection !== "string" || !candidate.collection) return null;
  if (!Array.isArray(candidate.items)) return null;
  const items = candidate.items.filter(
    (item): item is PlanetaryComputerStackItem =>
      !!item &&
      typeof item.id === "string" &&
      item.id !== "" &&
      typeof item.date === "string" &&
      /^\d{4}-\d{2}-\d{2}$/.test(item.date),
  );
  if (items.length === 0) return null;
  const renderParams =
    candidate.renderParams && typeof candidate.renderParams === "object"
      ? (candidate.renderParams as TileParams)
      : {};
  return { collection: candidate.collection, items, renderParams };
}

/**
 * The stack item shown at a timeline date: the item of that day, else the
 * latest one on or before it, else the first.
 *
 * @param stack - The dated stack.
 * @param date - The timeline date.
 * @returns The item to draw.
 */
export function planetaryComputerStackItemAt(
  stack: PlanetaryComputerStack,
  date: Date,
): PlanetaryComputerStackItem {
  const day = date.toISOString().slice(0, 10);
  let chosen = stack.items[0];
  for (const item of stack.items) {
    if (item.date > day) break;
    chosen = item;
  }
  return chosen;
}

function stackOf(spec: SourceSpec): PlanetaryComputerStack | null {
  return parsePlanetaryComputerStack(
    (spec as unknown as Record<string, unknown>)[PLANETARY_COMPUTER_STACK_KEY],
  );
}

/**
 * Builds the Time Slider source for a stack: an XYZ source whose tile URL is
 * resolved per date to the Data API tiles of that date's item.
 *
 * @param id - Source id (also the id of the mirrored store layer).
 * @param name - Layer name.
 * @param stack - The dated stack.
 * @returns The source spec, carrying the stack under {@link PLANETARY_COMPUTER_STACK_KEY}.
 */
export function planetaryComputerStackSource(
  id: string,
  name: string,
  stack: PlanetaryComputerStack,
): SourceSpec {
  return {
    id,
    name,
    type: "xyz",
    tileSize: 256,
    attribution: "Microsoft Planetary Computer",
    tiles: async (date: Date) => {
      const { tiler } = await getPlanetaryComputerClients();
      const item = planetaryComputerStackItemAt(stack, date);
      return tiler.getItemTileUrl(stack.collection, item.id, stack.renderParams);
    },
    [PLANETARY_COMPUTER_STACK_KEY]: stack,
    // The tile URL is a function, so name the collection as the layer's stable
    // remote reference: the Time Slider mirrors it onto the store layer, and
    // sharing then treats the stack as the hosted, reloadable layer it is.
    referenceUrl: `${PLANETARY_COMPUTER_STAC_URL}/collections/${encodeURIComponent(stack.collection)}`,
  } as SourceSpec;
}

/**
 * Reads a stack's source values at a point for one timeline date through the
 * Data API, for the Time Slider's pixel time-series chart.
 *
 * Only a date that has its own item is read: a date between acquisitions shows
 * the previous image on the map, but charting that value again would invent a
 * measurement.
 *
 * @param stack - The dated stack.
 * @returns The per-step reader.
 */
export function planetaryComputerStackReader(stack: PlanetaryComputerStack): PixelSeriesStepReader {
  return async (date, lngLat, signal) => {
    const day = date.toISOString().slice(0, 10);
    const item = stack.items.find((candidate) => candidate.date === day);
    if (!item) return null;
    const { tiler } = await getPlanetaryComputerClients();
    if (signal?.aborted) return null;
    const data = await tiler.getItemPoint(
      stack.collection,
      item.id,
      lngLat[0],
      lngLat[1],
      stack.renderParams,
    );
    const values = Array.isArray(data.values) ? data.values : [];
    return {
      url: tiler.getItemTileJSONUrl(stack.collection, item.id, stack.renderParams),
      bands: values.map((value, index) => {
        const numeric = typeof value === "number" && Number.isFinite(value);
        return {
          index: index + 1,
          name: data.band_names?.[index] ?? null,
          value: numeric ? (value as number) : Number.NaN,
          isNodata: !numeric,
        };
      }),
    };
  };
}

registerTimeSliderSourceRehydrator((spec) => {
  const record = spec as unknown as Record<string, unknown>;
  if (!(PLANETARY_COMPUTER_STACK_KEY in record)) return undefined;
  const stack = parsePlanetaryComputerStack(record[PLANETARY_COMPUTER_STACK_KEY]);
  // A stack whose description did not survive cannot be drawn: its tile URL was
  // a function. Drop it rather than hand the dock a source with no tiles.
  if (!stack || typeof spec.id !== "string") return null;
  return {
    ...spec,
    ...planetaryComputerStackSource(spec.id, spec.name ?? spec.id, stack),
  } as SourceSpec;
});

registerPixelSeriesReader((spec) => {
  const stack = stackOf(spec);
  return stack ? planetaryComputerStackReader(stack) : null;
});

async function sendResultsToTimeSlider(
  app: GeoLibreAppAPI,
  context: ResultsActionContext,
): Promise<void> {
  const collectionId = context.collection?.id ?? context.items[0]?.collection;
  const items = planetaryComputerStackItems(context.items, context.searchParams.bbox);
  if (!collectionId || items.length < 2) throw new Error(labels.timeSliderNeedsDates);

  const stack: PlanetaryComputerStack = {
    collection: collectionId,
    items,
    renderParams: context.renderParams,
  };
  const name = labels.timeSeriesLayerName.replace(
    "{{collection}}",
    context.collection?.title || collectionId,
  );
  // The timeline's dates become this stack's dates, so it holds one Planetary
  // Computer stack at a time: a stack from an earlier search, of this or any
  // other collection, is replaced rather than left animating over dates it has
  // no scenes for.
  const id = `planetary-computer-stack-${collectionId}`;
  const dates = items.map((item) => item.date);

  const applied = await applyTimeSliderConfig(app, (current): TimeSliderConfig => {
    const isStack = (source: SourceSpec) =>
      PLANETARY_COMPUTER_STACK_KEY in (source as unknown as Record<string, unknown>);
    const otherSources = (current?.sources ?? []).filter((source) => !isStack(source));
    // Replacing this collection's stack keeps what the user set on it in the
    // Layers panel; a fresh source would come back visible at full opacity
    // while the panel still showed the old state.
    const previous = (current?.sources ?? []).find((source) => source.id === id);
    const display = {
      ...(previous?.visible !== undefined ? { visible: previous.visible } : {}),
      ...(previous?.opacity !== undefined ? { opacity: previous.opacity } : {}),
    };
    return {
      speed: 1000,
      loop: true,
      ...current,
      startDate: dates[0],
      endDate: dates[dates.length - 1],
      dates,
      datesUrl: undefined,
      interval: 1,
      granularity: "day",
      currentDate: dates[dates.length - 1],
      collapsed: false,
      sources: [
        ...otherSources,
        { ...planetaryComputerStackSource(id, name, stack), ...display } as SourceSpec,
      ],
    };
  });
  if (!applied) throw new Error(labels.timeSliderUnavailable);
}

// ----- STAC browser ----------------------------------------------------------

async function openCollectionInStacBrowser(
  app: GeoLibreAppAPI,
  collectionId: string,
): Promise<void> {
  // The STAC browser connects to the API of a collection URL and searches that
  // collection, and it signs Planetary Computer assets itself, so every asset
  // type it can add (COPC, GeoParquet, Zarr, PMTiles, COG) works from there.
  requestStacCatalogUrl(
    `${PLANETARY_COMPUTER_STAC_URL}/collections/${encodeURIComponent(collectionId)}`,
  );
  await app.activatePlugin?.(STAC_PLUGIN_ID);
  app.openRightPanel?.(STAC_PLUGIN_ID);
}

// ----- Colorbar --------------------------------------------------------------

/** Planetary Computer colormap names the Colorbar control knows under its own name. */
const COLORBAR_NAMED: Record<string, string> = {
  viridis: "viridis",
  plasma: "plasma",
  inferno: "inferno",
  magma: "magma",
  cividis: "cividis",
  coolwarm: "coolwarm",
  spectral: "spectral",
  rainbow: "rainbow",
  terrain: "terrain",
  gray: "gray",
  rdylgn: "RdYlGn",
  rdylbu: "RdYlBu",
};

/** Ramps (low to high) for the colormaps the Colorbar control has no name for. */
const COLORBAR_CUSTOM: Record<string, string[]> = {
  rdylbu_r: ["#313695", "#74add1", "#e0f3f8", "#ffffbf", "#fee090", "#f46d43", "#a50026"],
  blues: ["#f7fbff", "#deebf7", "#9ecae1", "#4292c6", "#084594"],
  greens: ["#f7fcf5", "#c7e9c0", "#74c476", "#238b45", "#00441b"],
  reds: ["#fff5f0", "#fcbba1", "#fb6a4a", "#cb181d", "#67000d"],
  greys: ["#ffffff", "#d9d9d9", "#969696", "#525252", "#000000"],
  ylgnbu: ["#ffffd9", "#c7e9b4", "#41b6c4", "#2c7fb8", "#081d58"],
};

/**
 * The colorbar that describes a layer's render: its colormap over its rescale range.
 *
 * @param layer - A Planetary Computer panel layer.
 * @returns The colorbar request, or null when the layer has no colormap or no numeric range.
 */
export function planetaryComputerColorbar(
  layer: Pick<ActiveLayer, "renderParams" | "presetName" | "item" | "collection">,
): { colormap: string | string[]; vmin: number; vmax: number; label: string } | null {
  const { colormap_name: name, rescale, expression } = layer.renderParams;
  if (!name || !rescale) return null;
  const [vmin, vmax] = rescale.split(",").map(Number);
  if (!Number.isFinite(vmin) || !Number.isFinite(vmax) || vmin === vmax) return null;
  // Own-property lookups: the name comes from a form or a saved project, and a
  // plain index would resolve "constructor" to an inherited function.
  const colormap = Object.hasOwn(COLORBAR_NAMED, name)
    ? COLORBAR_NAMED[name]
    : Object.hasOwn(COLORBAR_CUSTOM, name)
      ? COLORBAR_CUSTOM[name]
      : undefined;
  if (!colormap) return null;
  const label =
    layer.presetName?.toUpperCase() ||
    expression ||
    layer.renderParams.assets?.join(", ") ||
    layer.item?.id ||
    layer.collection?.title ||
    name;
  return { colormap, vmin, vmax, label };
}

// ----- Clip to map -----------------------------------------------------------

/** Render parameters that only affect the picture, not the values read. */
const DISPLAY_ONLY_PARAMS = [
  "rescale",
  "colormap_name",
  "colormap",
  "color_formula",
  "tile_format",
  "tile_scale",
  "minzoom",
  "maxzoom",
] as const;

/**
 * The part of a clip box that lies inside an item's footprint.
 *
 * @param box - Requested `[west, south, east, north]`.
 * @param itemBbox - The item's STAC bbox (2D or 3D).
 * @returns The overlap, or null when the two do not overlap.
 */
export function clampClipBounds(
  box: [number, number, number, number],
  itemBbox: number[] | undefined,
): [number, number, number, number] | null {
  let [west, south, east, north] = box;
  const item =
    itemBbox?.length === 6
      ? [itemBbox[0], itemBbox[1], itemBbox[3], itemBbox[4]]
      : itemBbox?.length === 4
        ? itemBbox
        : null;
  if (item) {
    west = Math.max(west, item[0]);
    south = Math.max(south, item[1]);
    east = Math.min(east, item[2]);
    north = Math.min(north, item[3]);
  }
  return west < east && south < north ? [west, south, east, north] : null;
}

async function addItemClipToMap(
  app: GeoLibreAppAPI,
  context: {
    item: STACItem;
    renderParams: TileParams;
    bbox: [number, number, number, number] | null;
  },
): Promise<void> {
  const { item } = context;
  const requested = context.bbox ?? app.getViewBounds?.() ?? null;
  const bounds = requested ? clampClipBounds(requested, item.bbox) : null;
  if (!item.collection || !app.addCogLayer) throw new Error(labels.clipUnavailable);
  if (!bounds) throw new Error(labels.clipOutsideItem);

  // The clip is for analysis, so it carries the band values rather than a
  // rendered picture: drop the stretch and colormap, keep the band selection.
  const dataParams: TileParams = { ...context.renderParams };
  for (const key of DISPLAY_ONLY_PARAMS) delete dataParams[key];

  const { tiler } = await getPlanetaryComputerClients();
  const url = tiler.getItemCropUrl(item.collection, item.id, bounds, dataParams, {
    format: "tif",
    maxSize: 2048,
  });
  await app.addCogLayer(labels.clipLayerName.replace("{{item}}", item.id), url, {});
}

// ----- Registration ----------------------------------------------------------

/**
 * Builds the panel's GeoLibre buttons for a host app.
 *
 * Labels are getters so a language switch is picked up the next time the panel
 * draws the view, without rebuilding the control.
 *
 * @param app - The GeoLibre app API.
 * @returns The custom actions for the Planetary Computer control.
 */
export function createPlanetaryComputerCustomActions(
  app: GeoLibreAppAPI,
): PlanetaryComputerCustomActions {
  return {
    search: [
      {
        id: "geolibre-stac-browser",
        get label() {
          return labels.stacBrowser;
        },
        get title() {
          return labels.stacBrowserTitle;
        },
        onClick: ({ collection }) => openCollectionInStacBrowser(app, collection.id),
      },
    ],
    results: [
      {
        id: "geolibre-time-slider",
        get label() {
          return labels.timeSlider;
        },
        get title() {
          return labels.timeSliderTitle;
        },
        isAvailable: ({ items, searchParams }) =>
          planetaryComputerStackItems(items, searchParams.bbox).length >= 2,
        onClick: (context) => sendResultsToTimeSlider(app, context),
      },
    ],
    item: [
      {
        id: "geolibre-clip-to-map",
        get label() {
          return labels.clipToMap;
        },
        get title() {
          return labels.clipToMapTitle;
        },
        onClick: (context) => addItemClipToMap(app, context),
      },
    ],
    layer: [
      {
        id: "geolibre-colorbar",
        get label() {
          return labels.colorbar;
        },
        get title() {
          return labels.colorbarTitle;
        },
        isAvailable: ({ layer }) => planetaryComputerColorbar(layer) !== null,
        onClick: async ({ layer }) => {
          const colorbar = planetaryComputerColorbar(layer);
          if (colorbar) await showColorbar(app, colorbar);
        },
      },
    ],
  };
}

setPlanetaryComputerCustomActions(createPlanetaryComputerCustomActions);
