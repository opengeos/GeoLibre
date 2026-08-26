import {
  type ReactElement,
  type RefObject,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import * as maplibregl from "maplibre-gl";
import {
  type GeocodeMatch,
  geocodeForward,
  geocoderMinIntervalMs,
  resolveGeocoderConfig,
  useAppStore,
} from "@geolibre/core";
import type { MapController } from "@geolibre/map";
import { Input } from "@geolibre/ui";
import { Hexagon, Loader2, LocateFixed, MapPin, Search, Table2, X } from "lucide-react";
import { formatLatLon, parseLatLon } from "../../lib/coordinates";
import { type H3CellMatch, parseH3Cell } from "../../lib/h3-search";
import {
  type FeatureSearchGroup,
  type FeatureSearchMatch,
  holdsOwnedSelection,
  MIN_FEATURE_QUERY_LENGTH,
  type OwnedSelection,
  searchLayerFeatures,
} from "../../lib/feature-search";

interface LayerPanelPlaceSearchProps {
  mapControllerRef: RefObject<MapController | null>;
}

/** Fast-UI minimum debounce before firing a forward-geocode while typing. */
const DEBOUNCE_MS = 500;
/**
 * Debounce for the local attribute scan. Much shorter than the geocoder's,
 * because the work is local and capped: data results land while the network
 * call is still in flight, which is the point of running the two separately.
 */
const FEATURE_DEBOUNCE_MS = 120;
/** Cap the result list so the dropdown stays compact at the panel foot. */
const MAX_RESULTS = 6;
/**
 * Don't forward-geocode until the query is at least this many characters. The
 * local scan has its own minimum, `MIN_FEATURE_QUERY_LENGTH`, which
 * `searchLayerFeatures` enforces itself.
 */
const MIN_QUERY_LENGTH = 2;
/** Ephemeral map ids for the outline drawn around a searched H3 cell. */
const H3_SOURCE_ID = "geolibre-h3-search-cell";
const H3_FILL_LAYER_ID = "geolibre-h3-search-cell-fill";
const H3_LINE_LAYER_ID = "geolibre-h3-search-cell-line";
/** Highlight color for the H3 cell, matching the place-search marker. */
const H3_HIGHLIGHT_COLOR = "#ef4444";

type SearchStatus = "idle" | "loading" | "error" | "empty";

/**
 * One selectable row of the dropdown. Place, coordinate, and H3 rows come from
 * the geocoder half; feature rows come from the loaded layers. Keeping them in
 * one flat list is what lets the arrow keys walk the whole dropdown while the
 * two halves still render as visually separate groups.
 */
type SearchRow =
  | { kind: "place"; match: GeocodeMatch }
  | { kind: "coordinate"; match: GeocodeMatch }
  | { kind: "h3"; match: GeocodeMatch; cell: H3CellMatch }
  | { kind: "feature"; match: FeatureSearchMatch };

/**
 * A compact "Search places" geocoder input pinned to the bottom of the Layers
 * panel. It searches two things at once, independently:
 *
 * - **The data on the map.** The typed query is matched against the attributes
 *   of the loaded vector layers (`feature-search.ts`), grouped by layer at the
 *   top of the dropdown. This is local and capped, so it answers immediately,
 *   before the geocoder does. Selecting a feature selects it in the store and
 *   flies to it with the same highlight the attribute table uses.
 * - **Places.** The query is forward-geocoded through the configured provider
 *   and the matches are listed below the data groups; selecting one flies the
 *   map to the place and drops a marker.
 *
 * Two query forms bypass the geocoder entirely and resolve locally: a lat/lon
 * coordinate (see `coordinates.ts`) and an H3 cell index in either spelling
 * (see `h3-search.ts`), the latter fitting the view to the cell and outlining
 * it on the map.
 */
export function LayerPanelPlaceSearch({
  mapControllerRef,
}: LayerPanelPlaceSearchProps): ReactElement {
  const { t } = useTranslation();
  // Per-instance id so multiple mounts never collide on the aria-controls link.
  const resultsId = `${useId()}-results`;
  const geocodingPrefs = useAppStore((s) => s.preferences.geocoding);
  const layers = useAppStore((s) => s.layers);
  const layerGroups = useAppStore((s) => s.layerGroups);
  const [query, setQuery] = useState("");
  const [placeRows, setPlaceRows] = useState<SearchRow[]>([]);
  const [featureGroups, setFeatureGroups] = useState<FeatureSearchGroup[]>([]);
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<SearchStatus>("idle");
  const [activeIndex, setActiveIndex] = useState(-1);
  const abortRef = useRef<AbortController | null>(null);
  const markerRef = useRef<maplibregl.Marker | null>(null);
  const blurTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // `open` read by the local scan's gate. It is a ref rather than a dependency
  // because the scan is also what opens the dropdown: as a dependency, the
  // first match would re-run the effect and schedule a second, identical scan.
  const openRef = useRef(false);
  // The query text a selection wrote into the input, so neither debounce effect
  // searches for the name it just filled in. It holds the text rather than a
  // "skip once" flag because both effects read it and neither would be the one
  // to clear it: the input's own onChange does that, which keeps the two halves
  // from depending on the order React happens to run them in.
  const settledQuery = useRef<string | null>(null);
  // The feature a search row selected, if one did. Selecting a feature row
  // writes the app-wide selection that the attribute table and the map's own
  // click-select share, so the identity is kept rather than a "this box did it"
  // flag: whatever selection is live by the time the box is cleared may no
  // longer be the one it made.
  const ownedSelection = useRef<OwnedSelection | null>(null);

  // Honor the provider's request-spacing policy: the public Nominatim host
  // requires >=1.1s between requests, so the debounce never drops below that
  // for throttled endpoints (keyed/self-hosted endpoints keep the fast UI
  // default). resolveGeocoderConfig is cheap and pure, so memoizing on prefs
  // keeps this off the typing hot path.
  const debounceMs = useMemo(() => {
    const endpoint = resolveGeocoderConfig(geocodingPrefs).forwardEndpoint;
    return Math.max(DEBOUNCE_MS, geocoderMinIntervalMs(endpoint));
  }, [geocodingPrefs]);

  /**
   * Remove the H3 cell outline from the map, if one is currently drawn. Safe to
   * call when the map is gone or was never given the highlight (style reloads
   * drop it), so callers never have to track whether it exists.
   */
  const clearH3Highlight = useCallback(() => {
    const map = mapControllerRef.current?.getMap();
    if (!map) return;
    for (const layerId of [H3_FILL_LAYER_ID, H3_LINE_LAYER_ID]) {
      if (map.getLayer(layerId)) map.removeLayer(layerId);
    }
    if (map.getSource(H3_SOURCE_ID)) map.removeSource(H3_SOURCE_ID);
  }, [mapControllerRef]);

  useEffect(
    () => () => {
      abortRef.current?.abort();
      markerRef.current?.remove();
      clearH3Highlight();
      if (blurTimerRef.current) clearTimeout(blurTimerRef.current);
    },
    [clearH3Highlight],
  );

  const runSearch = useCallback(
    async (text: string) => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      setStatus("loading");
      setOpen(true);
      try {
        const config = resolveGeocoderConfig(geocodingPrefs);
        const matches = await geocodeForward(text, {
          signal: controller.signal,
          config,
          limit: MAX_RESULTS,
        });
        if (controller.signal.aborted) return;
        setPlaceRows(matches.map((match) => ({ kind: "place", match })));
        setStatus(matches.length ? "idle" : "empty");
      } catch {
        if (controller.signal.aborted) return;
        setPlaceRows([]);
        setStatus("error");
      }
    },
    [geocodingPrefs],
  );

  // The local half: match the query against the loaded layers' attributes. It
  // runs on its own short debounce, independent of the geocoder above, so the
  // data groups appear while the network call is still outstanding.
  useEffect(() => {
    openRef.current = open;
  }, [open]);

  useEffect(() => {
    if (settledQuery.current !== null) return;
    // Nothing reads the groups while the box is idle, and a layers change
    // re-runs this effect: without this gate every layer mutation (a refresh, a
    // time filter, a visibility toggle) would pay for a scan nobody sees.
    if (!openRef.current && document.activeElement !== inputRef.current) return;
    const trimmed = query.trim();
    if (trimmed.length < MIN_FEATURE_QUERY_LENGTH) {
      setFeatureGroups([]);
      setActiveIndex(-1);
      return;
    }
    const handle = setTimeout(() => {
      // Re-check: a selection whose label matches the text already in the input
      // makes `setQuery` a no-op, so this effect never re-runs and its cleanup
      // never cancels this timer.
      if (settledQuery.current !== null) return;
      const groups = searchLayerFeatures(layers, trimmed, { groups: layerGroups });
      setFeatureGroups(groups);
      // A layers change re-runs this effect without touching `query`, so the
      // query-change effect below never gets to reset the highlight: rebuilding
      // the rows under a stale index could leave it past the end of the list.
      setActiveIndex(-1);
      // Only pop the dropdown open while the user is actually typing here: a
      // later layer change re-runs this effect, and reopening then would be a
      // dropdown appearing out of nowhere.
      if (groups.length > 0 && document.activeElement === inputRef.current) setOpen(true);
    }, FEATURE_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [query, layers, layerGroups]);

  useEffect(() => {
    if (settledQuery.current !== null) return;
    const trimmed = query.trim();
    if (trimmed.length < MIN_QUERY_LENGTH) {
      abortRef.current?.abort();
      setPlaceRows([]);
      setActiveIndex(-1);
      setStatus("idle");
      setOpen(false);
      return;
    }
    setActiveIndex(-1);
    // H3 short-circuit: a query that parses as an H3 cell index (hexadecimal or
    // unsigned 64-bit integer) resolves locally to that cell's center, so the
    // exact cell is used rather than whatever the geocoder makes of the digits.
    const cell = parseH3Cell(trimmed);
    if (cell) {
      abortRef.current?.abort();
      setPlaceRows([
        {
          kind: "h3",
          cell,
          match: { lat: cell.lat, lon: cell.lon, displayName: cell.cell, score: null },
        },
      ]);
      setStatus("idle");
      setOpen(true);
      return;
    }
    // Coordinate short-circuit: a query that parses as lat/lon (DD, DMS, or DDM)
    // becomes a direct "go to coordinate" jump, resolved instantly with no
    // geocoder round-trip so the exact point (not the nearest named place) is
    // used. Cancel any in-flight forward-geocode from a previous keystroke.
    const coord = parseLatLon(trimmed);
    if (coord) {
      abortRef.current?.abort();
      setPlaceRows([
        {
          kind: "coordinate",
          match: { lat: coord.lat, lon: coord.lon, displayName: formatLatLon(coord), score: null },
        },
      ]);
      setStatus("idle");
      setOpen(true);
      return;
    }
    // Enter the loading state now rather than when the timer fires. The local
    // scan can open the dropdown within FEATURE_DEBOUNCE_MS, long before the
    // geocoder's own (>=500ms) debounce, and until then the places half would
    // otherwise show a heading over nothing, or over the previous query's rows.
    abortRef.current?.abort();
    setPlaceRows([]);
    setStatus("loading");
    const handle = setTimeout(() => {
      // Same re-check as the local scan: a settled input must not be searched,
      // and a no-op `setQuery` leaves this timer for the cleanup to miss.
      if (settledQuery.current !== null) return;
      void runSearch(trimmed);
    }, debounceMs);
    return () => clearTimeout(handle);
  }, [query, debounceMs, runSearch]);

  // The place half is a plain list only when the geocoder is idle; otherwise it
  // renders its own status line, which never hides the data groups above it.
  const showPlaceRows = status === "idle" && placeRows.length > 0;
  // The heading labels the places half, so it appears only when that half has
  // something under it — a list, a spinner, or a message. Keeping it tied to
  // what renders rather than to the two minimum-length constants agreeing means
  // a query short enough for one half but not the other cannot strand it.
  const showPlaceHeading = featureGroups.length > 0 && (showPlaceRows || status !== "idle");

  /**
   * Every selectable row, data groups first, in the order they render. Place
   * rows join only when they are actually on screen: a row the keyboard can
   * reach but the user cannot see would move the active highlight into nothing
   * and point `aria-activedescendant` at an id with no element.
   */
  const rows = useMemo<SearchRow[]>(
    () => [
      ...featureGroups.flatMap((group) =>
        group.matches.map((match): SearchRow => ({ kind: "feature", match })),
      ),
      ...(showPlaceRows ? placeRows : []),
    ],
    [featureGroups, placeRows, showPlaceRows],
  );

  /** Reset the input and dropdown after a row has been acted on. */
  const settle = useCallback((label: string) => {
    // Abort the outstanding forward-geocode: the local scan answers on a much
    // shorter debounce, so a row can be picked while the network call is still
    // in flight, and letting it resolve would repopulate the dropdown with
    // results for a query the user has already moved on from.
    abortRef.current?.abort();
    settledQuery.current = label;
    setQuery(label);
    setPlaceRows([]);
    setFeatureGroups([]);
    setActiveIndex(-1);
    setStatus("idle");
    setOpen(false);
  }, []);

  const handleSelect = useCallback(
    (row: SearchRow) => {
      const map = mapControllerRef.current?.getMap();
      // Drop the previous marker and cell outline unconditionally so neither is
      // ever orphaned when the map is briefly unavailable (mount/teardown/
      // headless) or when the next result is of a different kind.
      markerRef.current?.remove();
      markerRef.current = null;
      clearH3Highlight();

      // A place, a coordinate, or a cell takes the box's attention off the
      // feature it had selected, so release that selection the way clearing the
      // box does — otherwise the map flies away while the old feature stays
      // selected and its highlight renders off-screen. A feature row replaces
      // the selection instead, so it keeps its own branch below.
      if (row.kind !== "feature") {
        const store = useAppStore.getState();
        if (holdsOwnedSelection(ownedSelection.current, store)) store.selectFeature(null);
        ownedSelection.current = null;
      }

      if (row.kind === "feature") {
        // Reuse the attribute table's path: make the feature the live selection
        // on its layer, then let the shared highlight overlay frame it. The
        // explicit fit is what the row promises ("fly to it"), regardless of the
        // "zoom to selected feature" preference the map effect honors.
        const store = useAppStore.getState();
        // The row comes from a debounced scan, so the layer can have been
        // removed since. Bail rather than point `selectedLayerId` at an id that
        // no longer resolves — `removeLayer` is careful to null that out.
        const layer = store.layers.find((item) => item.id === row.match.layerId);
        if (layer) {
          store.selectLayer(row.match.layerId);
          store.selectFeature(row.match.featureId);
          ownedSelection.current = {
            layerId: row.match.layerId,
            featureId: row.match.featureId,
          };
          mapControllerRef.current?.highlightFeature(layer, row.match.featureId, { fit: true });
        }
        settle(row.match.value);
        return;
      }

      if (map && row.kind === "h3") {
        // An H3 cell spans anything from a continent (resolution 0) to under a
        // square meter (resolution 15), so frame the cell itself rather than
        // flying to a fixed zoom, and outline it so the match is visible.
        map.addSource(H3_SOURCE_ID, {
          type: "geojson",
          data: {
            type: "Feature",
            properties: { h3: row.cell.cell, resolution: row.cell.resolution },
            geometry: { type: "Polygon", coordinates: [row.cell.boundary] },
          },
        });
        map.addLayer({
          id: H3_FILL_LAYER_ID,
          type: "fill",
          source: H3_SOURCE_ID,
          paint: { "fill-color": H3_HIGHLIGHT_COLOR, "fill-opacity": 0.15 },
        });
        map.addLayer({
          id: H3_LINE_LAYER_ID,
          type: "line",
          source: H3_SOURCE_ID,
          paint: { "line-color": H3_HIGHLIGHT_COLOR, "line-width": 2 },
        });
        const bounds = new maplibregl.LngLatBounds();
        for (const position of row.cell.boundary) bounds.extend(position);
        map.fitBounds(bounds, { padding: 60 });
      } else if (map) {
        map.flyTo({
          center: [row.match.lon, row.match.lat],
          zoom: Math.max(map.getZoom(), 12),
        });
        markerRef.current = new maplibregl.Marker({ color: H3_HIGHLIGHT_COLOR })
          .setLngLat([row.match.lon, row.match.lat])
          .addTo(map);
      }
      settle(row.match.displayName);
    },
    [clearH3Highlight, mapControllerRef, settle],
  );

  const handleClear = useCallback(() => {
    abortRef.current?.abort();
    markerRef.current?.remove();
    markerRef.current = null;
    clearH3Highlight();
    // Clearing the box clears what the box put on the map, and a picked feature
    // row leaves a live selection behind. Dropping it here takes the highlight
    // overlay with it, through the store rather than by touching MapLibre. Only
    // this box's own pick is dropped: Escape runs this handler too, and a
    // selection made in the attribute table or by clicking the map is not the
    // search box's to discard.
    const store = useAppStore.getState();
    if (holdsOwnedSelection(ownedSelection.current, store)) store.selectFeature(null);
    ownedSelection.current = null;
    settledQuery.current = null;
    setQuery("");
    setPlaceRows([]);
    setFeatureGroups([]);
    setActiveIndex(-1);
    setStatus("idle");
    setOpen(false);
  }, [clearH3Highlight]);

  const hasRows = rows.length > 0;

  /**
   * Render one selectable row. `index` is the row's position in the flat
   * `rows` list, which is what the keyboard navigation and `aria-activedescendant`
   * address.
   */
  const renderRow = (row: SearchRow, index: number): ReactElement => (
    <button
      key={`${row.kind}-${index}`}
      type="button"
      role="option"
      aria-selected={index === activeIndex}
      id={`${resultsId}-option-${index}`}
      className={`flex w-full items-start gap-2 px-3 py-1.5 text-start text-xs hover:bg-muted ${
        index === activeIndex ? "bg-muted" : ""
      }`}
      // Use mousedown so the selection runs before the input's blur handler
      // closes the dropdown.
      onMouseDown={(event) => {
        event.preventDefault();
        handleSelect(row);
      }}
      onMouseEnter={() => setActiveIndex(index)}
    >
      {row.kind === "feature" ? (
        <Table2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      ) : row.kind === "h3" ? (
        <Hexagon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      ) : row.kind === "coordinate" ? (
        <LocateFixed className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      ) : (
        <MapPin className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      )}
      {row.kind === "feature" ? (
        <span className="min-w-0 flex-1">
          <span className="line-clamp-2 block">{row.match.value}</span>
          <span className="block truncate text-[10px] text-muted-foreground">
            {row.match.field}
          </span>
        </span>
      ) : (
        <span className="line-clamp-2">
          {row.kind === "h3"
            ? t("layers.searchPlacesGoToH3Cell", {
                cell: row.cell.cell,
                resolution: row.cell.resolution,
              })
            : row.kind === "coordinate"
              ? t("layers.searchPlacesGoToCoordinate", {
                  coordinate: row.match.displayName,
                })
              : row.match.displayName}
        </span>
      )}
    </button>
  );

  // Flat row index each group starts at: the groups render in order and every
  // group's rows are contiguous, so a running total is all it takes to keep the
  // grouped markup addressing the one flat index space the keyboard walks.
  const groupOffsets = featureGroups.reduce<number[]>((offsets, _group, index) => {
    offsets.push(index === 0 ? 0 : offsets[index - 1] + featureGroups[index - 1].matches.length);
    return offsets;
  }, []);
  /** Row index of the first place row: every feature row precedes them. */
  const placeOffset = rows.length - placeRows.length;

  return (
    <div className="relative p-2">
      {open ? (
        <div className="absolute bottom-full left-2 right-2 z-20 mb-1 overflow-hidden rounded-md border bg-popover text-popover-foreground shadow-md">
          <div
            id={resultsId}
            role="listbox"
            aria-label={t("layers.searchPlaces")}
            className="max-h-60 overflow-auto"
          >
            {featureGroups.map((group, groupIndex) => (
              <div key={group.layerId} role="group" aria-label={group.layerName}>
                <div className="flex items-baseline gap-1 border-b bg-muted/50 px-3 py-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                  <span className="truncate">{group.layerName}</span>
                  {group.truncated ? (
                    <span className="shrink-0 normal-case tracking-normal opacity-80">
                      {t("layers.searchFeaturesPartial")}
                    </span>
                  ) : null}
                </div>
                <div className="py-1">
                  {group.matches.map((match, offset) =>
                    renderRow({ kind: "feature", match }, groupOffsets[groupIndex] + offset),
                  )}
                </div>
              </div>
            ))}
            {/* The places half keeps its own heading only when data groups sit
                above it, so a query with no data match looks exactly as before. */}
            {showPlaceHeading ? (
              <div className="border-b border-t bg-muted/50 px-3 py-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                {t("layers.searchPlacesGroup")}
              </div>
            ) : null}
            {status === "loading" ? (
              <div className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                {t("layers.searchPlacesSearching")}
              </div>
            ) : status === "error" ? (
              <div className="px-3 py-2 text-xs text-destructive">
                {t("layers.searchPlacesError")}
              </div>
            ) : status === "empty" ? (
              <div className="px-3 py-2 text-xs text-muted-foreground">
                {t("layers.searchPlacesNoResults")}
              </div>
            ) : showPlaceRows ? (
              <div className="py-1">
                {placeRows.map((row, offset) => renderRow(row, placeOffset + offset))}
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
      <div className="relative">
        <Search className="pointer-events-none absolute start-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          ref={inputRef}
          type="text"
          role="combobox"
          aria-expanded={open}
          aria-autocomplete="list"
          aria-controls={hasRows ? resultsId : undefined}
          aria-activedescendant={
            hasRows && activeIndex >= 0 ? `${resultsId}-option-${activeIndex}` : undefined
          }
          value={query}
          placeholder={t("layers.searchPlacesPlaceholder")}
          aria-label={t("layers.searchPlaces")}
          className="h-8 ps-7 pe-7 text-xs"
          onChange={(event) => {
            // The user editing the text is what ends a selection's hold on the
            // input, wherever the effects happen to run in the commit.
            settledQuery.current = null;
            setQuery(event.target.value);
          }}
          onFocus={() => {
            if (hasRows || status !== "idle") setOpen(true);
          }}
          onBlur={() => {
            // Defer so a click/mousedown on a result still resolves first.
            // Clear any pending timer so rapid focus/blur cycles don't leak.
            if (blurTimerRef.current) clearTimeout(blurTimerRef.current);
            blurTimerRef.current = setTimeout(() => setOpen(false), 150);
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown" && hasRows) {
              event.preventDefault();
              setOpen(true);
              setActiveIndex((i) => Math.min(i + 1, rows.length - 1));
            } else if (event.key === "ArrowUp" && hasRows) {
              event.preventDefault();
              setActiveIndex((i) => Math.max(i - 1, 0));
            } else if (event.key === "Enter" && hasRows) {
              event.preventDefault();
              const row = rows[activeIndex >= 0 ? activeIndex : 0];
              if (row) handleSelect(row);
            } else if (event.key === "Escape") {
              handleClear();
            }
          }}
        />
        {query ? (
          <button
            type="button"
            className="absolute end-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
            aria-label={t("layers.searchPlacesClear")}
            title={t("layers.searchPlacesClear")}
            onClick={handleClear}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        ) : null}
      </div>
    </div>
  );
}
