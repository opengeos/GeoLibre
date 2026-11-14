import type { GeoLibreLayer } from "@geolibre/core";
import type { MapEngine } from "@geolibre/map";
import type { Feature } from "geojson";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type RefObject,
} from "react";
import { getColumnSettings } from "../lib/attribute-columns";
import {
  QUICK_FILTER_PROFILE_LIMIT,
  type QuickFilterFieldProfile,
} from "../lib/quick-filter-profile";
import {
  ensureQuickFilterProfiles,
  hasQuickFilterProfiles,
  readQuickFilterProfileCache,
} from "../lib/quick-filter-profile-cache";
import {
  isVectorTileLayer,
  loadedVectorTileFeatures,
  vectorTileMap,
} from "./useVectorTileGeometryBackfill";

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
 *
 * Profiling is lazy (issue #3426): only the fields the layer has a quick filter
 * on are profiled, off the render path and in slices, and a field picked from
 * the "Add a filter" menu is profiled when it is picked. Until a profile
 * arrives its field is listed in {@link QuickFilterProfiles.loadingFields}.
 */
export interface QuickFilterProfiles {
  /**
   * Field names a filter can be added on, sorted, minus the fields the layer
   * hides from its attribute table. Empty unless the hook was asked to list
   * fields, and until the listing pass has finished.
   */
  fields: string[];
  /** The field list was asked for and is still being read. */
  fieldsLoading: boolean;
  /** Profiles of the fields the layer has a quick filter on, as they arrive. */
  byField: Map<string, QuickFilterFieldProfile>;
  /** Filtered fields whose profile is still being computed. */
  loadingFields: ReadonlySet<string>;
  /**
   * Profile one field on demand, for the moment a field is picked from the
   * menu and its suggested control is needed.
   */
  profileField: (field: string) => Promise<QuickFilterFieldProfile | undefined>;
  /** The profiles describe the loaded tiles, not the whole dataset. */
  sampledFromViewport: boolean;
  /**
   * Set when a layer has more local features than the profile reads, so the
   * value counts and extents describe only the first `inspected` of `total`.
   */
  partialSample?: { inspected: number; total: number };
  /**
   * Nothing to filter on: no local features and no tiles decoded, or (when
   * fields are listed) records that carry no attributes at all.
   */
  empty: boolean;
}

export interface UseQuickFilterProfilesOptions {
  /**
   * Also list the layer's field names, for the "Add a filter" menu. Off by
   * default: the viewer only renders the filters a project already has.
   */
  listFields?: boolean;
}

const NO_FIELDS: string[] = [];

/** Joins field names into one string a hook dependency can compare by value. */
const KEY_SEPARATOR = "\u0000";

function splitKey(key: string): string[] {
  return key === "" ? [] : key.split(KEY_SEPARATOR);
}

type PropertiesOf = (record: unknown) => Record<string, unknown> | null | undefined;

/** Local features are scanned in place rather than mapped to property bags first. */
const featureProperties: PropertiesOf = (feature) =>
  (feature as Feature).properties as Record<string, unknown> | null;

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
 * @param options - Whether to list the layer's field names as well.
 * @returns The field profiles and where they came from.
 */
export function useQuickFilterProfiles(
  layer: GeoLibreLayer | null | undefined,
  mapControllerRef: RefObject<MapEngine | null>,
  mapReadyGeneration = 0,
  { listFields = false }: UseQuickFilterProfilesOptions = {},
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
    const engine = mapControllerRef.current;
    const map = vectorTileMap(engine);
    if (!map) return;

    const sample = (): void => {
      const current = layerRef.current;
      if (!current) return;
      const sampled = loadedVectorTileFeatures(map, current, engine?.kind);
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
  // uninteresting; do not offer to add a filter on it either. Reduced to a
  // string key for the same reason as `layerRef` above: the settings object is
  // rebuilt on every layer patch.
  const hiddenKey = (getColumnSettings(layer).hidden ?? []).join(KEY_SEPARATOR);

  // Likewise the filtered fields: `quickFilters` is a new array on every edit
  // of a filter's values, but which fields need a profile only changes when a
  // filter is added or removed.
  const wantedKey = [...new Set((layer?.quickFilters ?? []).map((filter) => filter.field))]
    .sort()
    .join(KEY_SEPARATOR);

  // The record array is both what gets scanned and the cache key, so a layer
  // whose features have not changed is never scanned twice.
  const source: readonly unknown[] | null = !layerId
    ? null
    : hasLocalFeatures
      ? (features ?? null)
      : tileRecords.length > 0
        ? tileRecords
        : null;
  // Sampled tile records are already property bags; local features are not.
  const properties = hasLocalFeatures ? featureProperties : undefined;
  // What the committed render scans, for the callbacks below. Written in a
  // layout effect rather than during render so a discarded render cannot leave
  // them pointing at a source that was never committed.
  const sourceRef = useRef({ source, properties });
  // Whether the committed render is still waiting on the cache.
  const pendingRef = useRef(false);

  // Bumped when a scan lands in the cache, to re-read it.
  const [cacheVersion, bumpCacheVersion] = useReducer((version: number) => version + 1, 0);

  const profileField = useCallback(
    (field: string): Promise<QuickFilterFieldProfile | undefined> =>
      new Promise((resolve) => {
        const attempt = (): void => {
          const { source: current, properties: propertiesOf } = sourceRef.current;
          if (!current) {
            resolve(undefined);
            return;
          }
          ensureQuickFilterProfiles(
            current,
            { fields: [field] },
            {
              properties: propertiesOf,
              onDone: () => {
                // The features were replaced while a sliced scan was running:
                // the profile describes data the layer no longer has, so read
                // the field again from what it has now.
                if (sourceRef.current.source !== current) attempt();
                else
                  resolve(readQuickFilterProfileCache(current)?.profiles.get(field) ?? undefined);
              },
            },
          );
        };
        attempt();
      }),
    [],
  );

  const result = useMemo(() => {
    // Not read, but the cache it stands for is: a scan landing bumps it.
    void cacheVersion;
    const cached = source ? readQuickFilterProfileCache(source) : undefined;
    const wanted = splitKey(wantedKey);
    const byField = new Map<string, QuickFilterFieldProfile>();
    const loadingFields = new Set<string>();
    for (const field of wanted) {
      const profile = cached?.profiles.get(field);
      if (profile) byField.set(field, profile);
      else if (source && profile === undefined) loadingFields.add(field);
    }

    const hidden = new Set(splitKey(hiddenKey));
    const names = listFields ? cached?.names : undefined;
    const fields = names
      ? names
          .filter((name) => !hidden.has(name))
          .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }))
      : NO_FIELDS;
    const fieldsLoading = listFields && !!source && !names;

    return {
      fields,
      fieldsLoading,
      byField,
      loadingFields,
      profileField,
      sampledFromViewport: tileBacked,
      partialSample:
        hasLocalFeatures && source && source.length > QUICK_FILTER_PROFILE_LIMIT
          ? { inspected: QUICK_FILTER_PROFILE_LIMIT, total: source.length }
          : undefined,
      empty: !source || (listFields && !!names && fields.length === 0),
    };
  }, [
    cacheVersion,
    hasLocalFeatures,
    hiddenKey,
    listFields,
    profileField,
    source,
    tileBacked,
    wantedKey,
  ]);

  // Layout effects run in declaration order, so this one keeps the refs in
  // step with the committed render before the scanning effect below reads them.
  const pending = result.fieldsLoading || result.loadingFields.size > 0;
  useLayoutEffect(() => {
    sourceRef.current = { source, properties };
    pendingRef.current = pending;
  });

  // A layout effect so the scan's first slice — which is the whole scan for an
  // ordinary layer — lands before the browser paints, and the controls never
  // flash a loading state they do not need.
  useLayoutEffect(() => {
    if (!source) return;
    const request = { fields: splitKey(wantedKey), names: listFields };
    // Already answerable (a reselected layer, a reopened panel): there is
    // nothing to scan. This render normally read the answer too; it has not
    // only when another instance of this hook filled the cache from its own
    // layout effect in this same commit, after this one rendered.
    if (hasQuickFilterProfiles(source, request)) {
      if (pendingRef.current) bumpCacheVersion();
      return;
    }
    return ensureQuickFilterProfiles(source, request, {
      properties,
      onDone: bumpCacheVersion,
    });
  }, [listFields, properties, source, wantedKey]);

  return result;
}
