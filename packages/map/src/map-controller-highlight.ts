// MapController layer: identify, highlight and edge length labels.
// The MapController layer chain is documented in map-controller.ts.

import { updateGeoJsonSourceData } from "./geojson-source-data";
import { antimeridianAwareBbox, type GeoLibreLayer } from "@geolibre/core";
import type { Feature, FeatureCollection, Geometry } from "geojson";
import * as maplibregl from "maplibre-gl";
import {
  highlightCircleLayerId,
  highlightFillLayerId,
  highlightLineLayerId,
  highlightSourceId,
} from "./geojson-loader";
import { invalidateTextFontForMapStyle, textFontForMapStyle } from "./layer-sync";
import {
  EDGE_LENGTH_LAYER_ID,
  EDGE_LENGTH_SOURCE_ID,
  edgeLengthLayer,
  edgeLengthLines,
} from "./edge-lengths";
import { MapControllerLayers } from "./map-controller-layers";

const EMPTY_HIGHLIGHT: FeatureCollection = {
  type: "FeatureCollection",
  features: [],
};

/**
 * Resolve a stable feature id for an identify hit. Prefers the feature's own id;
 * for a GeoJSON layer without one, matches the rendered feature back to a source
 * feature by property equality and returns its id (or array index). Mirrors the
 * in-app Identify behaviour so the scripting API reports consistent ids.
 */
function featureIdForLayer(
  layer: GeoLibreLayer,
  feature: maplibregl.MapGeoJSONFeature,
): string | null {
  if (feature.id != null) return String(feature.id);
  if (!layer.geojson) return null;
  const properties = feature.properties ?? {};
  const propertyKeys = Object.keys(properties);
  // With no properties there is nothing to match on, so any "match" would be a
  // fake id (the array index) that breaks if features are reordered — bail out.
  if (propertyKeys.length === 0) return null;
  // Match by full property-set equality (same keys and values), and only accept
  // an UNAMBIGUOUS hit; a non-unique match returns null (no stable id), like the
  // feature.id guard above. MapLibre re-parses object/array property values into
  // fresh references each query, so compare those by JSON rather than identity.
  const valuesEqual = (a: unknown, b: unknown): boolean => {
    if (a === b) return true;
    if (a && b && typeof a === "object" && typeof b === "object") {
      return JSON.stringify(a) === JSON.stringify(b);
    }
    return false;
  };
  const matches = layer.geojson.features
    .map((candidate, index) => ({ candidate, index }))
    .filter(({ candidate }) => {
      const candidateProperties = candidate.properties ?? {};
      if (Object.keys(candidateProperties).length !== propertyKeys.length) {
        return false;
      }
      return propertyKeys.every((key) => valuesEqual(candidateProperties[key], properties[key]));
    });
  if (matches.length !== 1) return null;
  const { candidate, index } = matches[0];
  return String(candidate.id ?? index);
}

/**
 * MapController layer: feature identification, selection highlight and edge
 * length labels.
 */
export class MapControllerHighlight extends MapControllerLayers {
  /** Whether the sides of highlighted polygons are labeled with their lengths. */
  protected edgeLengthsEnabled = false;

  /** The features the highlight shows now, so the side labels can be redrawn. */
  protected highlightedFeatures: Feature[] = [];

  /**
   * Query rendered features at a geographic point, for the scripting API's
   * "identify" command. Mirrors the in-app Identify tool: it queries the same
   * candidate style layers MapLibre renders for each layer
   * (`getCandidateStyleLayers`) and falls back to property matching when a
   * feature carries no stable id, so a Python caller gets the same hit a click
   * would.
   *
   * @param lngLat Geographic point as `[lng, lat]`.
   * @param layerId Optional store layer id to restrict the query to; omit to
   *   query every layer at the point.
   * @returns One entry per matched feature, topmost first.
   */
  identifyFeatures(
    lngLat: [number, number],
    layerId?: string,
  ): Array<{
    layerId: string;
    featureId: string | null;
    properties: Record<string, unknown>;
    geometry: Geometry | null;
  }> {
    if (!this.map) return [];
    const point = this.map.project(lngLat);
    const targets = layerId
      ? this.syncedLayers.filter((layer) => layer.id === layerId)
      : this.syncedLayers;
    const results: Array<{
      layerId: string;
      featureId: string | null;
      properties: Record<string, unknown>;
      geometry: Geometry | null;
    }> = [];
    for (const layer of targets) {
      const styleIds = this.getNativeLayerIds(layer);
      if (styleIds.length === 0) continue;
      const features = this.map.queryRenderedFeatures(point, {
        layers: styleIds,
      });
      for (const feature of features) {
        results.push({
          layerId: layer.id,
          featureId: featureIdForLayer(layer, feature),
          properties: (feature.properties ?? {}) as Record<string, unknown>,
          geometry: feature.geometry ?? null,
        });
      }
    }
    return results;
  }

  highlightFeature(
    layer: GeoLibreLayer | undefined,
    featureId: string | string[] | null,
    options: { fit?: boolean } = {},
  ): void {
    const ids = (Array.isArray(featureId) ? featureId : featureId ? [featureId] : []).filter(
      (id) => id != null,
    );

    if (!layer?.geojson || ids.length === 0) {
      this.syncHighlight(EMPTY_HIGHLIGHT);
      this.setHighlightedFeatures([]);
      return;
    }

    // Index by id once (O(n)) then look each id up in O(1); a Shift-range of
    // thousands of rows on a large layer would otherwise be O(selected × total)
    // per highlight update, on the main thread, on every selection change.
    const featureById = new Map<string, Feature>(
      layer.geojson.features.map((feature, index) => [String(feature.id ?? index), feature]),
    );
    const features = ids
      .map((id) => featureById.get(id))
      .filter((feature): feature is Feature => feature?.geometry != null);
    if (features.length === 0) {
      this.syncHighlight(EMPTY_HIGHLIGHT);
      this.setHighlightedFeatures([]);
      return;
    }

    const featureCollection: FeatureCollection = {
      type: "FeatureCollection",
      features: features as Feature<Geometry>[],
    };
    this.syncHighlight(featureCollection);
    this.setHighlightedFeatures(features);

    if (options.fit && this.isStyleReady()) {
      this.fitFeature(featureCollection);
    }
  }

  clearFeatureHighlight(): void {
    this.syncHighlight(EMPTY_HIGHLIGHT);
    this.setHighlightedFeatures([]);
  }

  setEdgeLengthLabels(enabled: boolean): void {
    if (enabled === this.edgeLengthsEnabled) return;
    this.edgeLengthsEnabled = enabled;
    this.syncEdgeLengths();
  }

  /**
   * Redraw the selection highlight and its side labels after the style was
   * replaced. A basemap switch replays the selection from the store, but a
   * custom CRS switch replaces the style too and nothing else redraws them.
   */
  protected restoreHighlight(): void {
    // Persistent listeners run before the font cache's one-time listener.
    // Resolve the incoming style's font before rebuilding helper labels.
    if (this.map) invalidateTextFontForMapStyle(this.map);
    if (this.highlightedFeatures.length === 0) return;
    this.syncHighlight({
      type: "FeatureCollection",
      features: this.highlightedFeatures as Feature<Geometry>[],
    });
    this.syncEdgeLengths();
  }

  private setHighlightedFeatures(features: Feature[]): void {
    this.highlightedFeatures = features;
    this.syncEdgeLengths();
  }

  /**
   * Draw the side labels of the highlighted polygons, or clear them when the
   * labels are off or nothing is highlighted. Called after the highlight
   * itself, so the label layer lands above the highlight outline.
   */
  protected syncEdgeLengths(): void {
    if (!this.isStyleReady() || !this.map) return;
    const map = this.map;
    const data =
      this.edgeLengthsEnabled && this.highlightedFeatures.length > 0
        ? edgeLengthLines(this.highlightedFeatures, { unit: this.mapPreferences.scaleUnit })
        : EMPTY_HIGHLIGHT;
    if (data.features.length === 0) {
      // Off, nothing selected, or over the cap: take the layer out rather
      // than keep re-adding an empty one on every selection change.
      if (map.getLayer(EDGE_LENGTH_LAYER_ID)) map.removeLayer(EDGE_LENGTH_LAYER_ID);
      if (map.getSource(EDGE_LENGTH_SOURCE_ID)) map.removeSource(EDGE_LENGTH_SOURCE_ID);
      return;
    }
    const source = map.getSource(EDGE_LENGTH_SOURCE_ID);
    if (source) {
      updateGeoJsonSourceData(source as maplibregl.GeoJSONSource, data);
    } else {
      map.addSource(EDGE_LENGTH_SOURCE_ID, { type: "geojson", data });
    }
    this.ensureHighlightLayer(
      edgeLengthLayer(textFontForMapStyle(map)) as maplibregl.AddLayerObject,
    );
  }

  private fitFeature(featureCollection: FeatureCollection): void {
    if (!this.map || featureCollection.features.length === 0) return;
    // Short way round the antimeridian, so a selection on both sides of it
    // frames the band across it rather than the whole globe (GeoLibre#3469).
    const box = antimeridianAwareBbox(featureCollection);
    // fitBounds validates the box and handles point-sized boxes.
    if (box) this.fitBounds(box);
  }

  private syncHighlight(featureCollection: FeatureCollection): void {
    if (!this.isStyleReady() || !this.map) return;
    const map = this.map;

    const source = map.getSource(highlightSourceId());
    if (source) {
      updateGeoJsonSourceData(source as maplibregl.GeoJSONSource, featureCollection);
    } else {
      map.addSource(highlightSourceId(), {
        type: "geojson",
        data: featureCollection,
      });
    }

    this.ensureHighlightLayer({
      id: highlightFillLayerId(),
      type: "fill",
      source: highlightSourceId(),
      filter: ["match", ["geometry-type"], ["Polygon", "MultiPolygon"], true, false],
      paint: {
        "fill-color": "#facc15",
        "fill-opacity": 0.32,
        "fill-outline-color": "#111827",
      },
    });

    this.ensureHighlightLayer({
      id: highlightLineLayerId(),
      type: "line",
      source: highlightSourceId(),
      filter: [
        "match",
        ["geometry-type"],
        ["LineString", "MultiLineString", "Polygon", "MultiPolygon"],
        true,
        false,
      ],
      paint: {
        "line-color": "#facc15",
        "line-width": 5,
        "line-opacity": 0.9,
      },
    });

    this.ensureHighlightLayer({
      id: highlightCircleLayerId(),
      type: "circle",
      source: highlightSourceId(),
      filter: ["match", ["geometry-type"], ["Point", "MultiPoint"], true, false],
      paint: {
        "circle-color": "#facc15",
        "circle-radius": 9,
        "circle-opacity": 0.95,
        "circle-stroke-color": "#111827",
        "circle-stroke-width": 3,
      },
    });
  }

  private ensureHighlightLayer(spec: maplibregl.AddLayerObject): void {
    if (!this.map) return;
    if (!this.map.getLayer(spec.id)) {
      this.map.addLayer(spec);
      return;
    }
    try {
      this.map.moveLayer(spec.id);
    } catch {
      // Style reloads can remove layers while selection is syncing.
    }
  }
}
