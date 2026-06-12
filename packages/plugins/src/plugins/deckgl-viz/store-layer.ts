import {
  DEFAULT_LAYER_STYLE,
  type GeoLibreLayer,
} from "@geolibre/core";
import type { FeatureCollection } from "geojson";
import {
  DEFAULT_DECK_VIZ_STYLE,
  type DeckVizConfig,
  type DeckVizFieldMapping,
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
  return (
    layer.type === "deckgl-viz" &&
    layer.metadata.sourceKind === DECK_VIZ_SOURCE_KIND
  );
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
}

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
export function createDeckVizStoreLayer(
  params: CreateDeckVizLayerParams,
): GeoLibreLayer {
  const id = params.id ?? crypto.randomUUID();
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
    style: { ...DEFAULT_LAYER_STYLE },
    metadata: {
      sourceKind: DECK_VIZ_SOURCE_KIND,
      // The picker/identify code keys off customLayerType for deck overlays;
      // identify is disabled because there is no MapLibre source to query.
      customLayerType: params.config.layerKind,
      externalDeckLayer: true,
      identifiable: false,
      vizConfig: params.config,
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
      const value = fieldMapping[role.key];
      return value === undefined || value === "";
    })
  ) {
    return null;
  }
  const style: DeckVizStyle = {
    ...DEFAULT_DECK_VIZ_STYLE,
    ...(candidate.style ?? {}),
  };
  return {
    layerKind: candidate.layerKind,
    format: candidate.format ?? "csv-rows",
    fieldMapping,
    style,
  };
}
