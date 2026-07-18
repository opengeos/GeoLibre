import { Button } from "@geolibre/ui";
import { BookOpen, ExternalLink, Loader2, MapPin, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  fetchArticleSummary,
  fetchNearbyPlaces,
  type WikiNearbyPlace,
  type WikiSummary,
} from "../../lib/knowledge";
import { openExternalLink } from "../../lib/open-external";

/** A place to explore: a clicked/searched coordinate, optionally with a title. */
export interface KnowledgePlace {
  lat: number;
  lng: number;
  /** Article title to open directly (e.g. from a place-search selection). */
  title?: string;
}

interface KnowledgeCardPanelProps {
  place: KnowledgePlace | null;
  /** Wikipedia language edition to query (already normalised by the caller). */
  lang: string;
  onClose: () => void;
  /** Recentre the map on a nearby article the user opens from the card. */
  onFlyTo?: (lat: number, lon: number) => void;
}

type CardStatus = "loading" | "ready" | "empty" | "error";

/** Round a metre distance to a compact "120 m" / "3.4 km" label. */
function formatDistance(distanceM: number): string {
  // An unknown distance (a malformed row parsed to Infinity) has no label.
  if (!Number.isFinite(distanceM)) return "";
  // Round before the unit check so a value just under a boundary (e.g. 999.6)
  // doesn't render past it ("1000 m" instead of "1.0 km").
  const rounded = Math.round(distanceM);
  if (rounded < 1000) return `${rounded} m`;
  const km = rounded / 1000;
  return `${km.toFixed(km < 10 ? 1 : 0)} km`;
}

/**
 * Google Earth-style "knowledge card": a slide-in panel over the map that
 * shows a Wikipedia summary, thumbnail, and nearby articles for a clicked or
 * searched place. Opening a nearby article swaps the card's main content and
 * flies the map to it. Purely informational and not persisted in the project.
 *
 * The panel owns its fetch lifecycle keyed on `place`: each new place aborts
 * the previous requests so a fast series of clicks never renders stale content.
 */
export function KnowledgeCardPanel({ place, lang, onClose, onFlyTo }: KnowledgeCardPanelProps) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<CardStatus>("loading");
  const [summary, setSummary] = useState<WikiSummary | null>(null);
  const [nearby, setNearby] = useState<WikiNearbyPlace[]>([]);
  const abortRef = useRef<AbortController | null>(null);

  // Load the card whenever the target place changes. When the place carries a
  // title (from search) we open that article directly; otherwise we pick the
  // nearest geotagged article to the clicked point. The nearby list is fetched
  // either way so the user can hop between neighbouring places.
  useEffect(() => {
    abortRef.current?.abort();
    if (!place) return;
    const controller = new AbortController();
    abortRef.current = controller;
    const { signal } = controller;
    setStatus("loading");
    setSummary(null);
    setNearby([]);

    void (async () => {
      try {
        // With a title the summary is the primary content, so the nearby list
        // is secondary: swallow its failures to an empty list so a transient
        // error there can't discard an already-fetched summary. On a map click
        // the nearby list IS the primary content (it picks the main article),
        // so let its failure surface as an error rather than a misleading
        // "nothing found here".
        const nearbyPromise = place.title
          ? fetchNearbyPlaces(place.lat, place.lng, { lang, signal }).catch(
              () => [] as WikiNearbyPlace[],
            )
          : fetchNearbyPlaces(place.lat, place.lng, { lang, signal });
        let main: WikiSummary | null = null;
        if (place.title) {
          // Degrade a failed title lookup to null (like the fallback below) so
          // a transient 5xx doesn't discard an already-resolved nearby list;
          // execution then falls through to the nearest-article fallback.
          main = await fetchArticleSummary(place.title, { lang, signal }).catch(() => null);
        }
        const places = await nearbyPromise;
        if (signal.aborted) return;
        if (!main && places.length > 0) {
          // A failed fallback summary (e.g. a transient 5xx) must not discard
          // the nearby list we already have: degrade to no summary so the card
          // still shows the neighbours rather than dropping to the error state.
          main = await fetchArticleSummary(places[0].title, {
            lang,
            signal,
          }).catch(() => null);
        }
        if (signal.aborted) return;
        setNearby(places);
        setSummary(main);
        setStatus(main ? "ready" : "empty");
      } catch {
        if (signal.aborted) return;
        setStatus("error");
      }
    })();

    return () => controller.abort();
  }, [place, lang]);

  const openNearby = useCallback(
    (item: WikiNearbyPlace) => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      const { signal } = controller;
      // Clear the previous article's content before fetching, mirroring the
      // main load, so the header doesn't keep showing the old title while the
      // hop is loading.
      setStatus("loading");
      setSummary(null);
      setNearby([]);
      onFlyTo?.(item.lat, item.lon);
      void (async () => {
        try {
          // Re-centre the nearby list on the opened article too, so hopping to
          // a neighbour updates the whole card (list and re-clickability), not
          // just the summary. The list stays secondary, so its failures don't
          // sink the summary.
          const nearbyPromise = fetchNearbyPlaces(item.lat, item.lon, {
            lang,
            signal,
          }).catch(() => [] as WikiNearbyPlace[]);
          // Degrade a failed article fetch to null (consistent with the main
          // load) so a transient error keeps the refreshed nearby list instead
          // of erroring out and discarding it.
          const main = await fetchArticleSummary(item.title, {
            lang,
            signal,
          }).catch(() => null);
          const places = await nearbyPromise;
          if (signal.aborted) return;
          setNearby(places);
          setSummary(main);
          setStatus(main ? "ready" : "empty");
        } catch {
          if (signal.aborted) return;
          setStatus("error");
        }
      })();
    },
    [lang, onFlyTo],
  );

  useEffect(() => () => abortRef.current?.abort(), []);

  if (!place) return null;

  // Nearby articles other than the one currently shown as the main card.
  const otherNearby = nearby.filter((n) => n.title !== summary?.title);

  return (
    // Bottom-left, but lifted to `bottom-12` (matching BoundsRestrictionIndicator)
    // so it clears MapLibre's bottom-left scale/attribution control. As a large
    // z-20 panel it overlays the small bottom-left badges while open; see the
    // stacking notes in BoundsRestrictionIndicator and CollaborationStatusBadge.
    <div className="pointer-events-auto absolute bottom-12 left-2 z-20 flex max-h-[calc(100%-7.5rem)] w-[min(22rem,calc(100vw-1.5rem))] flex-col overflow-hidden rounded-lg border bg-background shadow-xl">
      <div className="flex items-center justify-between gap-2 border-b px-3 py-2">
        <div className="flex min-w-0 items-center gap-2 text-sm font-semibold">
          <BookOpen className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="truncate">{summary?.title ?? t("knowledgeCard.title")}</span>
        </div>
        <button
          type="button"
          className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          aria-label={t("common.close")}
          onClick={onClose}
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {status === "loading" ? (
          <div className="flex items-center gap-2 px-3 py-6 text-xs text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            {t("knowledgeCard.loading")}
          </div>
        ) : status === "error" ? (
          <div className="px-3 py-6 text-xs text-destructive">{t("knowledgeCard.error")}</div>
        ) : summary ? (
          <div className="flex flex-col gap-2 px-3 py-3">
            {summary.thumbnailUrl ? (
              <img
                src={summary.thumbnailUrl}
                alt={summary.title}
                loading="lazy"
                className="max-h-40 w-full rounded-md object-cover"
              />
            ) : null}
            {summary.description ? (
              <p className="text-xs italic text-muted-foreground">{summary.description}</p>
            ) : null}
            <p className="whitespace-pre-line text-xs leading-relaxed text-foreground">
              {summary.extract}
            </p>
            <Button
              variant="outline"
              size="sm"
              className="mt-1 w-full gap-2"
              onClick={() => void openExternalLink(summary.contentUrl)}
            >
              <ExternalLink className="h-3.5 w-3.5" />
              {t("knowledgeCard.readMore")}
            </Button>
          </div>
        ) : nearby.length === 0 ? (
          // Only truly empty when there is neither a summary nor any neighbour;
          // if the primary summary failed but nearby places loaded, fall through
          // to the list below instead of a contradictory "nothing found".
          <div className="px-3 py-6 text-xs text-muted-foreground">{t("knowledgeCard.empty")}</div>
        ) : null}

        {/* Only show the list once the content has settled: while a hop is
            loading (or after it errors) the summary/nearby state still holds the
            previous article, so gating on status avoids flashing a stale list
            below the spinner or error message. */}
        {status !== "loading" && status !== "error" && otherNearby.length > 0 ? (
          <div className="border-t px-3 py-2">
            <div className="mb-1 text-xs font-medium text-muted-foreground">
              {t("knowledgeCard.nearby")}
            </div>
            <ul className="flex flex-col">
              {otherNearby.map((item) => (
                <li key={item.pageId}>
                  <button
                    type="button"
                    className="flex w-full items-start gap-2 rounded px-1.5 py-1.5 text-start text-xs hover:bg-muted"
                    onClick={() => openNearby(item)}
                  >
                    <MapPin className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate">{item.title}</span>
                    <span className="shrink-0 text-[10px] text-muted-foreground">
                      {formatDistance(item.distanceM)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>

      <div className="border-t px-3 py-1.5 text-[10px] text-muted-foreground">
        {t("knowledgeCard.attribution")}
      </div>
    </div>
  );
}
