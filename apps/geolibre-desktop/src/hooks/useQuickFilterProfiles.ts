import type { GeoLibreLayer } from "@geolibre/core";
import type { MapController } from "@geolibre/map";
import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { getColumnSettings } from "../lib/attribute-columns";
import {
  profileQuickFilterFields,
  type QuickFilterFieldProfile,
} from "../lib/quick-filter-profile";
import { isVectorTileLayer, loadedVectorTileFeatures } from "./useVectorTileGeometryBackfill";

/**
 * Field profiles backing a layer's quick filters, from whichever features the
 * app can actually see.
 *
 * A layer with local features (GeoJSON, and the tile/service layers that keep a
 * copy for the attribute table) profiles its whole dataset. A tile-backed layer
 * has no local copy, so it profiles the features currently decoded — the same
 * compromise the Style panel's vector-tile classification makes — and reports
 * that through {@link QuickFilterProfiles.sampledFromViewport} so the UI can
 * say where the value list came from instead of implying it is complete.
 */
export interface QuickFilterProfiles {
  /** One profile per field, sorted by field name. */
  profiles: QuickFilterFieldProfile[];
  byField: Map<string, QuickFilterFieldProfile>;
  /** The profiles describe the loaded tiles, not the whole dataset. */
  sampledFromViewport: boolean;
  /** Nothing to profile yet: no local features and no tiles decoded. */
  empty: boolean;
}

const EMPTY_PROFILES: QuickFilterProfiles = {
  profiles: [],
  byField: new Map(),
  sampledFromViewport: false,
  empty: true,
};

/**
 * Profile a layer's fields for the quick-filter controls.
 *
 * @param layer - The layer to profile, or `null`/`undefined` when none is
 *   selected.
 * @param mapControllerRef - The live map, needed to sample a tile-backed
 *   layer's loaded features.
 * @param mapReadyGeneration - Bumped by the shell each time the map
 *   (re)initializes. A dependency because `mapControllerRef` is a stable ref
 *   object: without it, a hook that mounted before the map existed would return
 *   before attaching its `idle` listener and never retry, leaving a tile-backed
 *   layer stuck on "no features loaded". Mirrors
 *   {@link useVectorTileGeometryBackfill}, which closes the same race.
 * @returns The field profiles and where they came from.
 */
export function useQuickFilterProfiles(
  layer: GeoLibreLayer | null | undefined,
  mapControllerRef: RefObject<MapController | null>,
  mapReadyGeneration = 0,
): QuickFilterProfiles {
  const features = layer?.geojson?.features;
  const hasLocalFeatures = (features?.length ?? 0) > 0;
  const tileBacked = !hasLocalFeatures && !!layer && isVectorTileLayer(layer);

  const [tileRecords, setTileRecords] = useState<Record<string, unknown>[]>([]);
  // The sampled records are compared by a cheap signature (count plus field
  // names) so re-sampling on every `idle` does not rebuild the profiles — and
  // so does not reset a half-made selection — while the tiles are unchanged.
  const tileSignature = useRef("");

  // `updateLayer` hands back a new `layer` object for every patch, including
  // the paint edits a colour or opacity drag fires many times a second, none of
  // which change what there is to profile. The sampler therefore reads the
  // layer through a ref and the effect keys only on what decides *which* source
  // it subscribes to, so dragging a slider no longer tears down and rebuilds
  // the tile subscription on every tick.
  const layerRef = useRef(layer);
  layerRef.current = layer;
  const layerId = layer?.id;

  useEffect(() => {
    tileSignature.current = "";
    setTileRecords([]);
    if (!tileBacked || !layerId) return;
    const map = mapControllerRef.current?.getMap();
    if (!map) return;

    const sample = (): void => {
      const current = layerRef.current;
      if (!current) return;
      const sampled = loadedVectorTileFeatures(map, current);
      const records = sampled.map((feature) => feature.properties ?? {});
      const signature = `${records.length}:${[
        ...new Set(records.flatMap((record) => Object.keys(record))),
      ]
        .sort()
        .join(",")}`;
      if (signature === tileSignature.current) return;
      tileSignature.current = signature;
      setTileRecords(records);
    };

    sample();
    map.on("idle", sample);
    return () => {
      map.off("idle", sample);
    };
  }, [layerId, mapControllerRef, mapReadyGeneration, tileBacked]);

  // A field the layer hides from its attribute table has been declared
  // uninteresting; do not offer a filter control for it either. Read outside
  // the memo and reduced to a string key for the same reason as `layerRef`
  // above: the settings object is rebuilt on every layer patch, so depending on
  // it directly would re-profile up to 5,000 records per paint tick.
  const hiddenKey = (getColumnSettings(layer).hidden ?? []).join("\u0000");

  return useMemo(() => {
    if (!layerId) return EMPTY_PROFILES;
    const records = hasLocalFeatures
      ? (features ?? []).map((feature) => feature.properties ?? {})
      : tileRecords;
    if (records.length === 0) {
      return { ...EMPTY_PROFILES, sampledFromViewport: tileBacked };
    }
    const profiles = profileQuickFilterFields(records, {
      exclude: hiddenKey === "" ? [] : hiddenKey.split("\u0000"),
    }).sort((a, b) =>
      a.field.localeCompare(b.field, undefined, {
        numeric: true,
        sensitivity: "base",
      }),
    );
    return {
      profiles,
      byField: new Map(profiles.map((profile) => [profile.field, profile])),
      sampledFromViewport: tileBacked,
      empty: profiles.length === 0,
    };
  }, [features, hasLocalFeatures, hiddenKey, layerId, tileBacked, tileRecords]);
}
