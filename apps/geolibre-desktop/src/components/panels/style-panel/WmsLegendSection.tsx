import type { GeoLibreLayer } from "@geolibre/core";
import { Button } from "@geolibre/ui";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { resolveWmsLegends, wmsLegendSource, type WmsLegendEntry } from "../../../lib/wms-legend";

/**
 * Style-panel section that fetches and shows a WMS layer's legend: the
 * capabilities `<LegendURL>` when the service advertises one, otherwise a
 * `GetLegendGraphic` request. Renders nothing for non-WMS layers.
 *
 * @param props - The selected layer.
 * @returns The section, or null.
 */
export function WmsLegendSection({ layer }: { layer: GeoLibreLayer }) {
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

  // A different layer (or edited WMS source) invalidates the shown legend.
  useEffect(() => {
    setEntries(null);
    setFailed(new Set());
    setLoading(false);
  }, [layer.id, source]);

  if (!source) return null;

  const load = async () => {
    setLoading(true);
    setFailed(new Set());
    try {
      setEntries(await resolveWmsLegends(source));
    } finally {
      setLoading(false);
    }
  };

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
      {!loading &&
        entries?.map((entry) => (
          <div key={entry.layer} className="space-y-1">
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
    </div>
  );
}
