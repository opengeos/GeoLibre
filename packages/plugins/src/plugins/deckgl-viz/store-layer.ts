import { DEFAULT_LAYER_STYLE, type GeoLibreLayer } from "@geolibre/core";
import type { FeatureCollection } from "geojson";
import {
  DEFAULT_DECK_VIZ_SCENEGRAPH,
  DEFAULT_DECK_VIZ_STYLE,
  type DeckVizConfig,
  type DeckVizFieldMapping,
  type DeckVizScenegraphConfig,
  type DeckVizStyle,
  getDeckVizLayerDef,
} from "./registry";

/** Marks store layers owned by the Deck.gl Layer builder. */
export const DECK_VIZ_SOURCE_KIND = "deckgl-viz";

/**
 * Detects a store layer rendered through the deck.gl visualization overlay.
 *
 * @param layer - A store layer.
 * @returns True when the layer was created by the Deck.gl Layer builder.
 */
export function isDeckVizLayer(layer: GeoLibreLayer): boolean {
  return layer.type === "deckgl-viz" && layer.metadata.sourceKind === DECK_VIZ_SOURCE_KIND;
}

/** Inputs for {@link createDeckVizStoreLayer}. */
export interface CreateDeckVizLayerParams {
  /** Layer id; a uuid is generated when omitted. */
  id?: string;
  name: string;
  config: DeckVizConfig;
  /** Parsed rows/tuples/objects for non-GeoJSON layers (stored inline). */
  rows?: ReadonlyArray<unknown>;
  /** Parsed FeatureCollection for GeoJSON layers (stored inline). */
  geojson?: FeatureCollection;
  /** Origin URL or file name, shown in the layer panel. */
  sourcePath?: string;
  /** `[west, south, east, north]` extent, so "Zoom to layer" works. */
  bounds?: [number, number, number, number];
}

/**
 * Seeds the standard LayerStyle from the viz config so the Style panel opens on
 * the values chosen in the dialog (and editing them flows back into rendering,
 * since the overlay reads these fields).
 */
function deckVizLayerStyle(config: DeckVizConfig) {
  return {
    ...DEFAULT_LAYER_STYLE,
    fillColor: config.style.color,
    strokeColor: config.style.color,
    circleRadius: config.style.radius,
    strokeWidth: config.style.lineWidth,
    fillOpacity: 1,
  };
}

/**
 * Row count above which the inline data noticeably bloats the saved project
 * file. Surfaced as a warning, not a hard cap, so large datasets still work.
 */
const DECK_VIZ_ROW_WARN_COUNT = 50_000;

/**
 * Builds the store layer for a deck.gl visualization.
 *
 * The deck.gl layer renders through the plugin's shared overlay, so the record
 * registers as an external custom layer: layer-sync skips paint/source sync
 * (`externalDeckLayer` + `customLayerType`), and the overlay manager applies
 * visibility/opacity from the store. All data and configuration is inlined so a
 * saved project re-renders without re-fetching.
 *
 * @param params - Layer name, viz config, and inline data.
 * @returns The corresponding GeoLibre store layer.
 */
export function createDeckVizStoreLayer(params: CreateDeckVizLayerParams): GeoLibreLayer {
  const id = params.id ?? crypto.randomUUID();
  const rowCount = params.rows?.length ?? params.geojson?.features.length ?? 0;
  if (rowCount > DECK_VIZ_ROW_WARN_COUNT) {
    console.warn(
      "[GeoLibre] deck-viz: storing",
      rowCount,
      "rows inline; this will enlarge the saved project file",
    );
  }
  return {
    id,
    name: params.name,
    type: "deckgl-viz",
    source: {
      type: "deckgl-viz",
      ...(params.rows ? { data: params.rows } : {}),
    },
    visible: true,
    opacity: 1,
    style: deckVizLayerStyle(params.config),
    metadata: {
      sourceKind: DECK_VIZ_SOURCE_KIND,
      // The picker/identify code keys off customLayerType for deck overlays;
      // identify is disabled because there is no MapLibre source to query.
      customLayerType: params.config.layerKind,
      externalDeckLayer: true,
      identifiable: false,
      vizConfig: params.config,
      ...(params.bounds ? { bounds: params.bounds } : {}),
    },
    geojson: params.geojson,
    sourcePath: params.sourcePath,
  };
}

/** Reads the inline row data from a deck-viz store layer. */
export function deckVizRows(layer: GeoLibreLayer): ReadonlyArray<unknown> {
  const data = (layer.source as { data?: unknown }).data;
  return Array.isArray(data) ? data : [];
}

/**
 * Reads and normalises the persisted viz config from a store layer, tolerating
 * partial/hand-edited style so older or malformed projects still render.
 *
 * @param layer - A deck-viz store layer.
 * @returns The viz config, or null when it is missing/invalid.
 */
export function readDeckVizConfig(layer: GeoLibreLayer): DeckVizConfig | null {
  const raw = layer.metadata.vizConfig;
  if (!raw || typeof raw !== "object") return null;
  const candidate = raw as Partial<DeckVizConfig>;
  if (typeof candidate.layerKind !== "string") return null;
  if (!candidate.fieldMapping || typeof candidate.fieldMapping !== "object") {
    return null;
  }
  const fieldMapping = candidate.fieldMapping as DeckVizFieldMapping;
  // Reject a corrupt/hand-edited config missing a required role mapping rather
  // than letting an accessor silently read `undefined` and render at [0, 0].
  const def = getDeckVizLayerDef(candidate.layerKind);
  if (
    def &&
    def.roles.some((role) => {
      if (!role.required) return false;
      // Typed string | number, but a hand-edited JSON file may carry null.
      const value: unknown = fieldMapping[role.key];
      return value === undefined || value === null || value === "";
    })
  ) {
    return null;
  }
  const style: DeckVizStyle = {
    ...DEFAULT_DECK_VIZ_STYLE,
    ...(candidate.style ?? {}),
  };
  const scenegraph = readScenegraphConfig(candidate.scenegraph);
  return {
    layerKind: candidate.layerKind,
    format: candidate.format ?? "csv-rows",
    fieldMapping,
    style,
    ...(scenegraph ? { scenegraph } : {}),
  };
}

/**
 * Normalises the persisted scenegraph (glTF model) config, filling defaults so
 * a hand-edited or older project still renders. Returns null when absent.
 */
function readScenegraphConfig(raw: unknown): DeckVizScenegraphConfig | null {
  if (!raw || typeof raw !== "object") return null;
  const candidate = raw as Partial<DeckVizScenegraphConfig>;
  return {
    modelUrl: typeof candidate.modelUrl === "string" ? candidate.modelUrl : "",
    sizeScale: Number.isFinite(candidate.sizeScale)
      ? (candidate.sizeScale as number)
      : DEFAULT_DECK_VIZ_SCENEGRAPH.sizeScale,
    sizeMinPixels: Number.isFinite(candidate.sizeMinPixels)
      ? (candidate.sizeMinPixels as number)
      : DEFAULT_DECK_VIZ_SCENEGRAPH.sizeMinPixels,
    bearing: Number.isFinite(candidate.bearing)
      ? (candidate.bearing as number)
      : DEFAULT_DECK_VIZ_SCENEGRAPH.bearing,
    orientationRoll: Number.isFinite(candidate.orientationRoll)
      ? (candidate.orientationRoll as number)
      : DEFAULT_DECK_VIZ_SCENEGRAPH.orientationRoll,
    translation: readScenegraphTranslation(candidate.translation),
    altitude: Number.isFinite(candidate.altitude)
      ? (candidate.altitude as number)
      : DEFAULT_DECK_VIZ_SCENEGRAPH.altitude,
  };
}

function readScenegraphTranslation(raw: unknown): [number, number, number] {
  if (!Array.isArray(raw) || raw.length !== 3) {
    return DEFAULT_DECK_VIZ_SCENEGRAPH.translation ?? [0, 0, 0];
  }
  const values = raw.map((value) => Number(value));
  return values.every((value) => Number.isFinite(value))
    ? (values as [number, number, number])
    : (DEFAULT_DECK_VIZ_SCENEGRAPH.translation ?? [0, 0, 0]);
}
