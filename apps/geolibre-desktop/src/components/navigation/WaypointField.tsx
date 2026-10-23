import { geocodeForward, type GeocodeMatch, type GeocoderConfig } from "@geolibre/core";
import { Button, Input, cn } from "@geolibre/ui";
import { Crosshair, Loader2, Search } from "lucide-react";
import { useEffect, useId, useRef, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { logNavigation } from "../../lib/navigation/log";
import { parseTypedCoordinates, type NavPoint } from "../../lib/navigation/session";

/** Most matches offered for one search. */
const MAX_MATCHES = 5;

/**
 * One route point as a text field: type an address (looked up with the
 * geocoder chosen in Settings → Geocoding) or a "lat, lng" pair and press
 * Enter, or press the crosshair and tap the map.
 *
 * The lookup runs on Enter or the search button, never per keystroke: the
 * public Nominatim server's usage policy forbids search-as-you-type.
 *
 * @param props - The point, its label, and callbacks.
 * @returns The field.
 */
export function WaypointField({
  label,
  placeholder,
  roleLabel,
  picking,
  geocoder,
  onPickToggle,
  onChange,
  testId,
}: {
  /** What the field shows for the placed point, or "" when none is placed. */
  label: string;
  placeholder: string;
  /** "start", "stop", or "destination", for the accessible names. */
  roleLabel: string;
  /** Whether the next map click places this point. */
  picking: boolean;
  geocoder: GeocoderConfig;
  onPickToggle: () => void;
  onChange: (point: NavPoint) => void;
  testId?: string;
}): ReactElement {
  const { t } = useTranslation();
  const [text, setText] = useState(label);
  const [editing, setEditing] = useState(false);
  const [matches, setMatches] = useState<GeocodeMatch[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const listId = useId();

  // Show the placed point's label unless the user is typing over it.
  useEffect(() => {
    if (!editing) setText(label);
  }, [label, editing]);

  useEffect(() => () => abortRef.current?.abort(), []);

  const choose = (point: NavPoint) => {
    setMatches(null);
    setError(null);
    setEditing(false);
    onChange(point);
  };

  const search = () => {
    const query = text.trim();
    // Enter on an untouched field would geocode its display label ("My
    // location", a road name, formatted coordinates) and move the point.
    if (!query || !editing) return;
    const typed = parseTypedCoordinates(query);
    if (typed) {
      choose(typed);
      return;
    }
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setSearching(true);
    setError(null);
    geocodeForward(query, { signal: controller.signal, config: geocoder, limit: MAX_MATCHES })
      .then((found) => {
        if (controller.signal.aborted) return;
        if (found.length === 0) setError(t("navigation.noMatches"));
        else if (found.length === 1)
          choose({ lng: found[0].lon, lat: found[0].lat, label: found[0].displayName });
        else setMatches(found);
      })
      .catch((searchError: unknown) => {
        if (controller.signal.aborted) return;
        logNavigation("Navigation address search failed.", searchError);
        setError(t("navigation.searchError"));
      })
      .finally(() => {
        if (abortRef.current === controller) setSearching(false);
      });
  };

  return (
    <div className="relative min-w-0 flex-1">
      <div className="flex items-center gap-1">
        <Input
          value={text}
          placeholder={placeholder}
          aria-label={t("navigation.searchLabel", { role: roleLabel })}
          aria-expanded={matches !== null}
          aria-controls={matches ? listId : undefined}
          className={cn(
            "h-8 min-w-0 flex-1 text-xs",
            picking && "border-primary ring-1 ring-primary",
          )}
          onFocus={(event) => event.currentTarget.select()}
          onChange={(event) => {
            setText(event.target.value);
            setEditing(true);
            setMatches(null);
            setError(null);
          }}
          onBlur={() => {
            // Leaving the field without searching puts the placed point back.
            if (!matches && !searching) setEditing(false);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              search();
            } else if (event.key === "Escape" && (matches || editing)) {
              // Escape here leaves the search, not the tool.
              event.preventDefault();
              setMatches(null);
              setEditing(false);
            }
          }}
          data-testid={testId}
        />
        <Button
          size="icon"
          variant="ghost"
          className="h-8 w-8 shrink-0"
          aria-label={t("navigation.search")}
          title={t("navigation.search")}
          disabled={searching || !text.trim() || !editing}
          onClick={search}
        >
          {searching ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Search className="h-4 w-4" />
          )}
        </Button>
        <Button
          size="icon"
          variant={picking ? "secondary" : "ghost"}
          className="h-8 w-8 shrink-0"
          aria-pressed={picking}
          aria-label={t("navigation.pickOnMap", { role: roleLabel })}
          title={t("navigation.pickOnMap", { role: roleLabel })}
          onClick={onPickToggle}
        >
          <Crosshair className="h-4 w-4" />
        </Button>
      </div>
      {error && <p className="mt-0.5 text-[11px] text-destructive">{error}</p>}
      {matches && (
        <ul
          id={listId}
          aria-label={t("navigation.matches")}
          className="mt-1 flex max-h-48 flex-col overflow-y-auto rounded-md border bg-background shadow-md"
        >
          {matches.map((match, index) => (
            <li key={`${match.lat},${match.lon},${index}`}>
              <button
                type="button"
                className="w-full px-2 py-1.5 text-start text-xs hover:bg-muted"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => choose({ lng: match.lon, lat: match.lat, label: match.displayName })}
              >
                {match.displayName}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
