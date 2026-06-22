import {
  type ReactElement,
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import maplibregl from "maplibre-gl";
import {
  type GeocodeMatch,
  geocodeForward,
  resolveGeocoderConfig,
  useAppStore,
} from "@geolibre/core";
import type { MapController } from "@geolibre/map";
import { Input } from "@geolibre/ui";
import { Loader2, MapPin, Search, X } from "lucide-react";

interface LayerPanelPlaceSearchProps {
  mapControllerRef: RefObject<MapController | null>;
}

/** Debounce before firing a forward-geocode while the user types. */
const DEBOUNCE_MS = 500;
/** Cap the result list so the dropdown stays compact at the panel foot. */
const MAX_RESULTS = 6;
/** Don't search until the query is at least this many characters. */
const MIN_QUERY_LENGTH = 2;

type SearchStatus = "idle" | "loading" | "error" | "empty";

/**
 * A compact "Search places" geocoder input pinned to the bottom of the Layers
 * panel. Forward-geocodes the typed query through the configured provider,
 * lists matches in a dropdown above the input, and on selection flies the map
 * to the place and drops a marker. Replaces the former advanced-formats note.
 */
export function LayerPanelPlaceSearch({
  mapControllerRef,
}: LayerPanelPlaceSearchProps): ReactElement {
  const { t } = useTranslation();
  const geocodingPrefs = useAppStore((s) => s.preferences.geocoding);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<GeocodeMatch[]>([]);
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<SearchStatus>("idle");
  const abortRef = useRef<AbortController | null>(null);
  const markerRef = useRef<maplibregl.Marker | null>(null);
  // Skip the debounce effect for the one query change caused by selecting a
  // result (which fills the input with the place name); without this the
  // selection would immediately re-trigger a search for that full name.
  const skipNextSearch = useRef(false);

  useEffect(
    () => () => {
      abortRef.current?.abort();
      markerRef.current?.remove();
    },
    [],
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
      setStatus("idle");
      setOpen(false);
      return;
    }
    const handle = setTimeout(() => {
      void runSearch(trimmed);
    }, DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [query, runSearch]);

  const handleSelect = useCallback(
    (match: GeocodeMatch) => {
      const map = mapControllerRef.current?.getMap();
      if (map) {
        map.flyTo({
          center: [match.lon, match.lat],
          zoom: Math.max(map.getZoom(), 12),
        });
        markerRef.current?.remove();
        markerRef.current = new maplibregl.Marker({ color: "#ef4444" })
          .setLngLat([match.lon, match.lat])
          .addTo(map);
      }
      skipNextSearch.current = true;
      setQuery(match.displayName);
      setResults([]);
      setStatus("idle");
      setOpen(false);
    },
    [mapControllerRef],
  );

  const handleClear = useCallback(() => {
    abortRef.current?.abort();
    markerRef.current?.remove();
    markerRef.current = null;
    setQuery("");
    setResults([]);
    setStatus("idle");
    setOpen(false);
  }, []);

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
            <ul className="max-h-60 overflow-auto py-1">
              {results.map((match, index) => (
                <li key={`${match.lon},${match.lat},${index}`}>
                  <button
                    type="button"
                    className="flex w-full items-start gap-2 px-3 py-1.5 text-left text-xs hover:bg-muted"
                    onClick={() => handleSelect(match)}
                  >
                    <MapPin className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    <span className="line-clamp-2">{match.displayName}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
      <div className="relative">
        <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          type="text"
          value={query}
          placeholder={t("layers.searchPlacesPlaceholder")}
          aria-label={t("layers.searchPlaces")}
          className="h-8 pl-7 pr-7 text-xs"
          onChange={(event) => setQuery(event.target.value)}
          onFocus={() => {
            if (results.length > 0 || status !== "idle") setOpen(true);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && results.length > 0) {
              event.preventDefault();
              handleSelect(results[0]);
            } else if (event.key === "Escape") {
              handleClear();
            }
          }}
        />
        {query ? (
          <button
            type="button"
            className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
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
