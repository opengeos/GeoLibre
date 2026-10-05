import type { GeoLibreLayer } from "@geolibre/core";
import { openHtmlPanelWithEntry } from "@geolibre/plugins";
import type { MapEngine } from "@geolibre/map";
import { Button } from "@geolibre/ui";
import { type RefObject, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { createAppAPI } from "../../../hooks/usePlugins";
import {
  resolveWmsLegends,
  wmsLegendHtml,
  wmsLegendSource,
  type WmsLegendEntry,
} from "../../../lib/wms-legend";

/**
 * Style-panel section that fetches and shows a WMS layer's legend: the
 * capabilities `<LegendURL>` when the service advertises one, otherwise a
 * `GetLegendGraphic` request. Renders nothing for non-WMS layers.
 *
 * @param props - The selected layer and the map controller, used to put the
 *   legend on the map as an HTML control.
 * @returns The section, or null.
 */
export function WmsLegendSection({
  layer,
  mapControllerRef,
}: {
  layer: GeoLibreLayer;
  mapControllerRef: RefObject<MapEngine | null>;
}) {
  const { t } = useTranslation();
  const source = useMemo(
    () => wmsLegendSource(layer),
    // Only the request fields matter; ignore unrelated layer edits (opacity, style).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [layer.type, layer.source],
  );
  const [entries, setEntries] = useState<WmsLegendEntry[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState<Set<string>>(() => new Set());
  const [addedToMap, setAddedToMap] = useState<boolean | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  // A different layer (or edited WMS source) invalidates the shown legend and
  // cancels a lookup still in flight, so a late answer cannot land on the
  // wrong layer.
  useEffect(() => {
    setEntries(null);
    setLoadFailed(false);
    setFailed(new Set());
    setLoading(false);
    setAddedToMap(null);
    return () => abortRef.current?.abort();
  }, [layer.id, source]);

  if (!source) return null;

  const load = async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    setFailed(new Set());
    setAddedToMap(null);
    setLoadFailed(false);
    try {
      const result = await resolveWmsLegends(source, controller.signal);
      if (!controller.signal.aborted) setEntries(result);
    } catch {
      if (!controller.signal.aborted) setLoadFailed(true);
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  };

  const addToMap = async () => {
    const shown = (entries ?? []).filter((entry) => !failed.has(entry.url));
    if (shown.length === 0) return;
    setAddedToMap(
      await openHtmlPanelWithEntry(createAppAPI(mapControllerRef), {
        title: t("style.raster.legend.mapTitle", { layer: layer.name }),
        html: wmsLegendHtml(shown),
      }),
    );
  };

  const hasLegend = !loading && !!entries && entries.some((entry) => !failed.has(entry.url));

  return (
    <div className="space-y-2" data-testid="wms-legend-section">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium">{t("style.raster.legend.heading")}</span>
        <Button type="button" size="sm" variant="outline" disabled={loading} onClick={load}>
          {entries ? t("style.raster.legend.refresh") : t("style.raster.legend.get")}
        </Button>
      </div>
      {loading && (
        <p className="text-xs text-muted-foreground">{t("style.raster.legend.loading")}</p>
      )}
      {!loading && loadFailed && (
        <p className="text-xs text-amber-600">{t("style.raster.legend.failed")}</p>
      )}
      {!loading &&
        entries?.map((entry, index) => (
          <div key={`${index}:${entry.layer}`} className="space-y-1">
            {entries.length > 1 && <p className="text-[11px] font-medium">{entry.layer}</p>}
            {failed.has(entry.url) ? (
              <p className="text-xs text-amber-600">{t("style.raster.legend.failed")}</p>
            ) : (
              // A white plate keeps server-drawn legends (black text, transparent PNG) readable in dark mode.
              <img
                src={entry.url}
                alt={t("style.raster.legend.alt", { layer: entry.layer })}
                className="max-w-full rounded border bg-white p-1"
                referrerPolicy="no-referrer"
                onError={() => setFailed((prev) => new Set(prev).add(entry.url))}
              />
            )}
          </div>
        ))}
      {hasLegend && (
        <div className="space-y-1">
          <Button type="button" size="sm" variant="outline" className="w-full" onClick={addToMap}>
            {t("style.raster.legend.addToMap")}
          </Button>
          {addedToMap !== null && (
            <p className={addedToMap ? "text-xs text-muted-foreground" : "text-xs text-amber-600"}>
              {addedToMap ? t("style.raster.legend.added") : t("style.raster.legend.addFailed")}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
