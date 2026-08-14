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
import { Hexagon, Loader2, LocateFixed, MapPin, Search, X } from "lucide-react";
import { formatLatLon, parseLatLon } from "../../lib/coordinates";
import { type H3CellMatch, parseH3Cell } from "../../lib/h3-search";

interface LayerPanelPlaceSearchProps {
  mapControllerRef: RefObject<MapController | null>;
}

/** Fast-UI minimum debounce before firing a forward-geocode while typing. */
const DEBOUNCE_MS = 500;
/** Cap the result list so the dropdown stays compact at the panel foot. */
const MAX_RESULTS = 6;
/** Don't search until the query is at least this many characters. */
const MIN_QUERY_LENGTH = 2;
/** Ephemeral map ids for the outline drawn around a searched H3 cell. */
const H3_SOURCE_ID = "geolibre-h3-search-cell";
const H3_FILL_LAYER_ID = "geolibre-h3-search-cell-fill";
const H3_LINE_LAYER_ID = "geolibre-h3-search-cell-line";
/** Highlight color for the H3 cell, matching the place-search marker. */
const H3_HIGHLIGHT_COLOR = "#ef4444";

type SearchStatus = "idle" | "loading" | "error" | "empty";

/**
 * A compact "Search places" geocoder input pinned to the bottom of the Layers
 * panel. Forward-geocodes the typed query through the configured provider,
 * lists matches in a dropdown above the input, and on selection flies the map
 * to the place and drops a marker. Replaces the former advanced-formats note.
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
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<GeocodeMatch[]>([]);
  // True when the single result is a parsed lat/lon jump rather than a geocoder
  // match, so the row is labeled and iconed as a coordinate instead of a place.
  const [isCoordinate, setIsCoordinate] = useState(false);
  // Set when the single result is a parsed H3 cell index, both to label the row
  // and to supply the outline drawn on selection.
  const [h3Cell, setH3Cell] = useState<H3CellMatch | null>(null);
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<SearchStatus>("idle");
  const [activeIndex, setActiveIndex] = useState(-1);
  const abortRef = useRef<AbortController | null>(null);
  const markerRef = useRef<maplibregl.Marker | null>(null);
  const blurTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Skip the debounce effect for the one query change caused by selecting a
  // result (which fills the input with the place name); without this the
  // selection would immediately re-trigger a search for that full name.
  const skipNextSearch = useRef(false);

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
      setIsCoordinate(false);
      setH3Cell(null);
      setStatus("loading");
      setActiveIndex(-1);
      setOpen(true);
      try {
        const config = resolveGeocoderConfig(geocodingPrefs);
        const matches = await geocodeForward(text, {
          signal: controller.signal,
          config,
          limit: MAX_RESULTS,
        });
        if (controller.signal.aborted) return;
        setResults(matches);
        setStatus(matches.length ? "idle" : "empty");
      } catch {
        if (controller.signal.aborted) return;
        setResults([]);
        setStatus("error");
      }
    },
    [geocodingPrefs],
  );

  useEffect(() => {
    if (skipNextSearch.current) {
      skipNextSearch.current = false;
      return;
    }
    const trimmed = query.trim();
    if (trimmed.length < MIN_QUERY_LENGTH) {
      abortRef.current?.abort();
      setResults([]);
      setActiveIndex(-1);
      setIsCoordinate(false);
      setH3Cell(null);
      setStatus("idle");
      setOpen(false);
      return;
    }
    // H3 short-circuit: a query that parses as an H3 cell index (hexadecimal or
    // unsigned 64-bit integer) resolves locally to that cell's center, so the
    // exact cell is used rather than whatever the geocoder makes of the digits.
    const cell = parseH3Cell(trimmed);
    if (cell) {
      abortRef.current?.abort();
      setResults([{ lat: cell.lat, lon: cell.lon, displayName: cell.cell, score: null }]);
      setActiveIndex(0);
      setIsCoordinate(false);
      setH3Cell(cell);
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
      setResults([
        { lat: coord.lat, lon: coord.lon, displayName: formatLatLon(coord), score: null },
      ]);
      setActiveIndex(0);
      setIsCoordinate(true);
      setH3Cell(null);
      setStatus("idle");
      setOpen(true);
      return;
    }
    const handle = setTimeout(() => {
      void runSearch(trimmed);
    }, debounceMs);
    return () => clearTimeout(handle);
  }, [query, debounceMs, runSearch]);

  const handleSelect = useCallback(
    (match: GeocodeMatch) => {
      const map = mapControllerRef.current?.getMap();
      // Drop the previous marker and cell outline unconditionally so neither is
      // ever orphaned when the map is briefly unavailable (mount/teardown/
      // headless) or when the next result is of a different kind.
      markerRef.current?.remove();
      markerRef.current = null;
      clearH3Highlight();
      if (map && h3Cell) {
        // An H3 cell spans anything from a continent (resolution 0) to under a
        // square meter (resolution 15), so frame the cell itself rather than
        // flying to a fixed zoom, and outline it so the match is visible.
        map.addSource(H3_SOURCE_ID, {
          type: "geojson",
          data: {
            type: "Feature",
            properties: { h3: h3Cell.cell, resolution: h3Cell.resolution },
            geometry: { type: "Polygon", coordinates: [h3Cell.boundary] },
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
        for (const position of h3Cell.boundary) bounds.extend(position);
        map.fitBounds(bounds, { padding: 60 });
      } else if (map) {
        map.flyTo({
          center: [match.lon, match.lat],
          zoom: Math.max(map.getZoom(), 12),
        });
        markerRef.current = new maplibregl.Marker({ color: H3_HIGHLIGHT_COLOR })
          .setLngLat([match.lon, match.lat])
          .addTo(map);
      }
      skipNextSearch.current = true;
      setQuery(match.displayName);
      setResults([]);
      setActiveIndex(-1);
      setIsCoordinate(false);
      setH3Cell(null);
      setStatus("idle");
      setOpen(false);
    },
    [clearH3Highlight, h3Cell, mapControllerRef],
  );

  const handleClear = useCallback(() => {
    abortRef.current?.abort();
    markerRef.current?.remove();
    markerRef.current = null;
    clearH3Highlight();
    setQuery("");
    setResults([]);
    setActiveIndex(-1);
    setIsCoordinate(false);
    setH3Cell(null);
    setStatus("idle");
    setOpen(false);
  }, [clearH3Highlight]);

  const showResults = status === "idle" && results.length > 0;

  return (
    <div className="relative p-2">
      {open ? (
        <div className="absolute bottom-full left-2 right-2 z-20 mb-1 overflow-hidden rounded-md border bg-popover text-popover-foreground shadow-md">
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
          ) : (
            <ul id={resultsId} role="listbox" className="max-h-60 overflow-auto py-1">
              {results.map((match, index) => (
                <li key={index}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={index === activeIndex}
                    id={`${resultsId}-option-${index}`}
                    className={`flex w-full items-start gap-2 px-3 py-1.5 text-start text-xs hover:bg-muted ${
                      index === activeIndex ? "bg-muted" : ""
                    }`}
                    // Use mousedown so the selection runs before the input's
                    // blur handler closes the dropdown.
                    onMouseDown={(event) => {
                      event.preventDefault();
                      handleSelect(match);
                    }}
                    onMouseEnter={() => setActiveIndex(index)}
                  >
                    {h3Cell ? (
                      <Hexagon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    ) : isCoordinate ? (
                      <LocateFixed className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    ) : (
                      <MapPin className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    )}
                    <span className="line-clamp-2">
                      {h3Cell
                        ? t("layers.searchPlacesGoToH3Cell", {
                            cell: h3Cell.cell,
                            resolution: h3Cell.resolution,
                          })
                        : isCoordinate
                          ? t("layers.searchPlacesGoToCoordinate", {
                              coordinate: match.displayName,
                            })
                          : match.displayName}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
      <div className="relative">
        <Search className="pointer-events-none absolute start-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          type="text"
          role="combobox"
          aria-expanded={open}
          aria-autocomplete="list"
          aria-controls={showResults ? resultsId : undefined}
          aria-activedescendant={
            showResults && activeIndex >= 0 ? `${resultsId}-option-${activeIndex}` : undefined
          }
          value={query}
          placeholder={t("layers.searchPlacesPlaceholder")}
          aria-label={t("layers.searchPlaces")}
          className="h-8 ps-7 pe-7 text-xs"
          onChange={(event) => setQuery(event.target.value)}
          onFocus={() => {
            if (results.length > 0 || status !== "idle") setOpen(true);
          }}
          onBlur={() => {
            // Defer so a click/mousedown on a result still resolves first.
            // Clear any pending timer so rapid focus/blur cycles don't leak.
            if (blurTimerRef.current) clearTimeout(blurTimerRef.current);
            blurTimerRef.current = setTimeout(() => setOpen(false), 150);
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown" && showResults) {
              event.preventDefault();
              setOpen(true);
              setActiveIndex((i) => Math.min(i + 1, results.length - 1));
            } else if (event.key === "ArrowUp" && showResults) {
              event.preventDefault();
              setActiveIndex((i) => Math.max(i - 1, 0));
            } else if (event.key === "Enter" && showResults) {
              event.preventDefault();
              handleSelect(results[activeIndex >= 0 ? activeIndex : 0]);
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
