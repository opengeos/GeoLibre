import { type GeoLibreLayer, useAppStore } from "@geolibre/core";
import type { MapController } from "@geolibre/map";
import {
  getPaletteLegend,
  openLegendPanelWithItems,
  savedRasterSymbology,
} from "@geolibre/plugins";
import { readRasterData } from "@geolibre/processing";
import { Button, Input, Select } from "@geolibre/ui";
import {
  FileDown,
  ListChecks,
  Paintbrush,
  RefreshCw,
  Table2,
  X,
} from "lucide-react";
import {
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";

import { createAppAPI } from "../../hooks/usePlugins";
import {
  type GdalRatEntry,
  type RasterAttributeTableRecord,
  type RasterAttributeTableRow,
  MAX_RAT_SYMBOLOGY_CLASSES,
  categoricalSymbologyFromRows,
  computeValueCounts,
  parseGdalRat,
  pixelAreaSquareMeters,
  ratRowsToCsv,
  savedRasterAttributeTable,
  seedRatRows,
} from "../../lib/raster-attribute-table";
import { canExportRasterLayer, rasterExportUrl } from "../../lib/raster-export";
import {
  PANEL_RESIZE_END_EVENT,
  PANEL_RESIZE_START_EVENT,
} from "../../lib/panel-resize";
import { saveBinaryFileWithFallback } from "../../lib/tauri-io";
import { sanitizeExportFileName } from "../../lib/vector-export";

const DEFAULT_PANEL_HEIGHT = 260;
const MIN_PANEL_HEIGHT = 140;

/** The layer types the table can census (a downloadable single GeoTIFF). */
function isRatLayer(layer: GeoLibreLayer | undefined): layer is GeoLibreLayer {
  return !!layer && canExportRasterLayer(layer);
}

/** The 1-indexed band the layer currently renders (rasterState.bands[0]). */
function currentBand(layer: GeoLibreLayer): number {
  const state = layer.metadata.rasterState;
  if (state && typeof state === "object" && !Array.isArray(state)) {
    const bands = (state as Record<string, unknown>).bands;
    if (Array.isArray(bands) && typeof bands[0] === "number" && bands[0] >= 1) {
      return bands[0];
    }
  }
  return 1;
}

function bandCountOf(layer: GeoLibreLayer): number {
  const value = layer.metadata.bandCount;
  return typeof value === "number" && value > 0 ? value : 1;
}

/**
 * Best-effort read of a GDAL PAM (`.aux.xml`) raster attribute table next to a
 * remote raster. Local (blob-backed) rasters have no reachable sidecar file,
 * and most servers simply 404 — any failure quietly returns null.
 */
async function fetchGdalRat(
  layer: GeoLibreLayer,
  band: number,
  signal: AbortSignal,
): Promise<GdalRatEntry[] | null> {
  const url = layer.source?.url;
  if (typeof url !== "string" || !/^https?:\/\//.test(url)) return null;
  try {
    const response = await fetch(`${url}.aux.xml`, { signal });
    if (!response.ok) return null;
    return parseGdalRat(await response.text(), band);
  } catch {
    return null;
  }
}

/** Area formatted in the unit that keeps the largest class readable. */
function formatArea(m2: number, unit: "m2" | "ha" | "km2"): string {
  const value = unit === "km2" ? m2 / 1e6 : unit === "ha" ? m2 / 1e4 : m2;
  return value >= 100
    ? Math.round(value).toLocaleString()
    : value.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

/**
 * Raster Attribute Table bottom panel (issue #1307): a tabular view of a
 * single-band categorical raster's classes — value, pixel count, share, area —
 * with editable labels and colors that persist on the layer
 * (`metadata.rasterAttributeTable`), drive the layer's categorical symbology,
 * and fill the on-map legend. Opened from a raster layer's context menu.
 */
export function RasterAttributeTable({
  mapControllerRef,
}: {
  mapControllerRef: RefObject<MapController | null>;
}) {
  const { t } = useTranslation();
  const open = useAppStore((s) => s.ui.rasterAttributeTableOpen);
  const setOpen = useAppStore((s) => s.setRasterAttributeTableOpen);
  const selectedLayerId = useAppStore((s) => s.selectedLayerId);
  const layers = useAppStore((s) => s.layers);
  const updateLayer = useAppStore((s) => s.updateLayer);

  const layer = layers.find((l) => l.id === selectedLayerId);
  const ratLayer = isRatLayer(layer) ? layer : null;
  const record = ratLayer ? savedRasterAttributeTable(ratLayer) : null;

  const [computing, setComputing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [panelHeight, setPanelHeight] = useState(DEFAULT_PANEL_HEIGHT);
  const sectionRef = useRef<HTMLElement | null>(null);
  const computeAbortRef = useRef<AbortController | null>(null);

  // Reset transient state when the target layer changes, and abort any
  // in-flight computation so its result can't land on the wrong layer.
  useEffect(() => {
    setError(null);
    setNotice(null);
    return () => {
      computeAbortRef.current?.abort();
      computeAbortRef.current = null;
    };
  }, [ratLayer?.id]);

  const compute = useCallback(
    async (target: GeoLibreLayer, band: number) => {
      const url = rasterExportUrl(target);
      if (!url) {
        setError(t("rasterAttributeTable.noSource"));
        return;
      }
      computeAbortRef.current?.abort();
      const controller = new AbortController();
      computeAbortRef.current = controller;
      setComputing(true);
      setError(null);
      setNotice(null);
      try {
        const response = await fetch(url, { signal: controller.signal });
        if (!response.ok) {
          throw new Error(t("rasterAttributeTable.readError"));
        }
        const raster = await readRasterData(await response.arrayBuffer());
        if (controller.signal.aborted) return;
        const bandValues = raster.bands[band - 1];
        if (!bandValues) {
          throw new Error(t("rasterAttributeTable.bandMissing", { band }));
        }
        const counts = computeValueCounts(bandValues, raster.nodata);
        if (!counts) {
          setError(t("rasterAttributeTable.notCategorical"));
          return;
        }
        // Labels/colors seed from an existing GDAL RAT (remote .aux.xml), then
        // the raster's embedded color table, then a sampled ramp — and any
        // labels/colors the user already edited win over all three.
        const rat = await fetchGdalRat(target, band, controller.signal);
        let palette: Map<number, string> | null = null;
        try {
          const entries = await getPaletteLegend(target.id, url);
          if (entries) {
            palette = new Map(entries.map((e) => [e.value, e.color]));
          }
        } catch {
          // No palette is fine; colors fall back to the ramp.
        }
        if (controller.signal.aborted) return;
        const previous = savedRasterAttributeTable(target);
        const seeded = seedRatRows(counts, { rat, palette });
        const priorByValue = new Map(
          (previous?.band === band ? previous.rows : []).map((row) => [
            row.value,
            row,
          ]),
        );
        const rows = seeded.map((row) => {
          const prior = priorByValue.get(row.value);
          return prior ? { ...row, label: prior.label, color: prior.color } : row;
        });
        const next: RasterAttributeTableRecord = {
          band,
          rows,
          pixelAreaM2: pixelAreaSquareMeters(raster),
        };
        updateLayer(target.id, {
          metadata: { ...target.metadata, rasterAttributeTable: next },
        });
      } catch (err) {
        if (controller.signal.aborted) return;
        setError(
          err instanceof Error
            ? err.message
            : t("rasterAttributeTable.readError"),
        );
      } finally {
        if (computeAbortRef.current === controller) {
          computeAbortRef.current = null;
        }
        if (!controller.signal.aborted) setComputing(false);
      }
    },
    [t, updateLayer],
  );

  // First open for a layer with no stored table: build it automatically so the
  // panel is immediately useful (a manual Recompute stays available).
  const autoComputedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!open || !ratLayer || record || computing) return;
    if (autoComputedRef.current === ratLayer.id) return;
    autoComputedRef.current = ratLayer.id;
    void compute(ratLayer, currentBand(ratLayer));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, ratLayer?.id, record === null]);

  /**
   * Whether the layer's current symbology is the one this table applied: a
   * classified manual symbology whose breaks are exactly the table's
   * categorical edges. When it is, color edits write through to it live.
   */
  function tableSymbologyActive(
    target: GeoLibreLayer,
    rows: readonly RasterAttributeTableRow[],
  ): boolean {
    const current = savedRasterSymbology(target);
    const applied = categoricalSymbologyFromRows(rows);
    if (!current?.classified || current.method !== "manual" || !applied) {
      return false;
    }
    const breaks = applied.symbology.breaks;
    return (
      current.breaks.length === breaks.length &&
      current.breaks.every((edge, i) => edge === breaks[i])
    );
  }

  /**
   * Persists edited rows and, when the colors changed while the table's
   * symbology is applied on the layer, re-derives that symbology in the same
   * store write so the map recolors live.
   */
  function commitRows(
    target: GeoLibreLayer,
    current: RasterAttributeTableRecord,
    rows: RasterAttributeTableRow[],
    options: { colorsChanged?: boolean } = {},
  ) {
    const liveSymbology =
      options.colorsChanged && tableSymbologyActive(target, current.rows)
        ? categoricalSymbologyFromRows(rows)?.symbology
        : undefined;
    updateLayer(target.id, {
      metadata: {
        ...target.metadata,
        rasterAttributeTable: { ...current, rows },
        ...(liveSymbology ? { rasterSymbology: liveSymbology } : {}),
      },
    });
  }

  function updateRow(index: number, patch: Partial<RasterAttributeTableRow>) {
    if (!ratLayer || !record) return;
    const rows = record.rows.map((row, i) =>
      i === index ? { ...row, ...patch } : row,
    );
    commitRows(ratLayer, record, rows, {
      colorsChanged: patch.color !== undefined,
    });
  }

  function applySymbology() {
    if (!ratLayer || !record) return;
    const result = categoricalSymbologyFromRows(record.rows);
    if (!result) {
      setError(
        t("rasterAttributeTable.tooManyClasses", {
          max: MAX_RAT_SYMBOLOGY_CLASSES,
        }),
      );
      return;
    }
    const state =
      ratLayer.metadata.rasterState &&
      typeof ratLayer.metadata.rasterState === "object" &&
      !Array.isArray(ratLayer.metadata.rasterState)
        ? (ratLayer.metadata.rasterState as Record<string, unknown>)
        : {};
    updateLayer(ratLayer.id, {
      metadata: {
        ...ratLayer.metadata,
        rasterState: {
          ...state,
          mode: "single",
          bands: [record.band],
          // Move off the "palette" colormap so the single-band pseudocolor
          // pipeline (rescale + colormap module) is active; the injected
          // classified texture then replaces the named ramp's colors, exactly
          // as the classification UI does.
          colormap: result.symbology.ramp,
          rescale: result.rescale,
          // The injected classified texture bakes its own colors; reversal
          // would double-apply through the upstream shader.
          reversed: false,
        },
        rasterSymbology: result.symbology,
      },
    });
    setError(null);
    setNotice(t("rasterAttributeTable.symbologyApplied"));
  }

  async function seedFromPalette() {
    if (!ratLayer || !record) return;
    const url = rasterExportUrl(ratLayer);
    if (!url) return;
    setError(null);
    setNotice(null);
    try {
      const entries = await getPaletteLegend(ratLayer.id, url);
      if (!entries || entries.length === 0) {
        setNotice(t("rasterAttributeTable.noPalette"));
        return;
      }
      const palette = new Map(entries.map((e) => [e.value, e.color]));
      const rows = record.rows.map((row) => {
        const color = palette.get(row.value);
        return color ? { ...row, color } : row;
      });
      commitRows(ratLayer, record, rows, { colorsChanged: true });
    } catch {
      setNotice(t("rasterAttributeTable.noPalette"));
    }
  }

  async function sendToLegend() {
    if (!ratLayer || !record) return;
    setError(null);
    const opened = await openLegendPanelWithItems(
      createAppAPI(mapControllerRef),
      {
        title: ratLayer.name,
        items: record.rows.map((row) => ({
          label: row.label,
          color: row.color,
          shape: "square" as const,
        })),
        legendPosition: "bottom-right",
      },
    );
    if (!opened) setError(t("rasterAttributeTable.legendError"));
  }

  async function exportCsv() {
    if (!ratLayer || !record) return;
    setError(null);
    try {
      const csv = ratRowsToCsv(record.rows, record.pixelAreaM2);
      await saveBinaryFileWithFallback(
        new TextEncoder().encode(csv),
        {
          defaultName: `${sanitizeExportFileName(ratLayer.name)}_classes.csv`,
          filters: [{ name: "CSV", extensions: ["csv"] }],
          browserTypes: [
            { description: "CSV", accept: { "text/csv": [".csv"] } },
          ],
          mimeType: "text/csv",
        },
      );
    } catch (err) {
      setError(
        err instanceof Error ? err.message : t("rasterAttributeTable.csvError"),
      );
    }
  }

  // Drag-to-resize, dispatching the shared panel-resize events so MapCanvas
  // pauses expensive work during the drag (same contract as AttributeTable).
  function startResize(event: React.MouseEvent) {
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = sectionRef.current?.offsetHeight ?? panelHeight;
    const maxHeight = Math.round(window.innerHeight * 0.6);
    let nextHeight = startHeight;
    window.dispatchEvent(new Event(PANEL_RESIZE_START_EVENT));
    const onMouseMove = (move: MouseEvent) => {
      nextHeight = Math.min(
        maxHeight,
        Math.max(MIN_PANEL_HEIGHT, startHeight + (startY - move.clientY)),
      );
      if (sectionRef.current) {
        sectionRef.current.style.height = `${nextHeight}px`;
      }
    };
    const onMouseUp = () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
      setPanelHeight(nextHeight);
      window.dispatchEvent(new Event(PANEL_RESIZE_END_EVENT));
    };
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
  }

  if (!open) return null;

  const rows = record?.rows ?? [];
  const totalCount = rows.reduce((sum, row) => sum + row.count, 0);
  const pixelAreaM2 = record?.pixelAreaM2 ?? null;
  const maxAreaM2 = pixelAreaM2
    ? Math.max(0, ...rows.map((row) => row.count * pixelAreaM2))
    : 0;
  const areaUnit: "m2" | "ha" | "km2" =
    maxAreaM2 >= 1e6 ? "km2" : maxAreaM2 >= 1e4 ? "ha" : "m2";
  const bandCount = ratLayer ? bandCountOf(ratLayer) : 1;

  return (
    <section
      ref={sectionRef}
      aria-label={t("rasterAttributeTable.title")}
      data-testid="raster-attribute-table"
      className="relative flex shrink-0 flex-col border-t bg-card"
      style={{ height: panelHeight }}
    >
      <div
        role="separator"
        aria-orientation="horizontal"
        aria-label={t("rasterAttributeTable.resize")}
        className="absolute -top-1 left-0 right-0 z-20 h-2 cursor-row-resize select-none border-t border-transparent hover:border-primary"
        onMouseDown={startResize}
      />
      <div className="flex flex-wrap items-center gap-2 border-b px-3 py-1.5 md:flex-nowrap">
        <Table2 className="h-4 w-4 text-muted-foreground" />
        <span className="text-sm font-semibold">
          {t("rasterAttributeTable.title")}
        </span>
        {ratLayer ? (
          <span className="min-w-0 max-w-full truncate text-xs text-muted-foreground md:max-w-56">
            {ratLayer.name}
          </span>
        ) : (
          <span className="min-w-0 max-w-full truncate text-xs text-muted-foreground md:max-w-56">
            {t("rasterAttributeTable.noRasterSelected")}
          </span>
        )}
        {ratLayer && bandCount > 1 ? (
          <Select
            aria-label={t("rasterAttributeTable.band")}
            className="h-7 w-auto py-0 text-xs"
            value={String(record?.band ?? currentBand(ratLayer))}
            disabled={computing}
            onChange={(event) =>
              void compute(ratLayer, Number(event.target.value))
            }
          >
            {Array.from({ length: bandCount }, (_, index) => (
              <option key={index + 1} value={String(index + 1)}>
                {t("rasterAttributeTable.bandOption", { band: index + 1 })}
              </option>
            ))}
          </Select>
        ) : null}
        {error ? (
          <span
            className="max-w-64 truncate text-xs text-destructive"
            title={error}
          >
            {error}
          </span>
        ) : notice ? (
          <span
            className="max-w-64 truncate text-xs text-muted-foreground"
            title={notice}
          >
            {notice}
          </span>
        ) : null}
        <Button
          variant="outline"
          size="sm"
          className="ms-auto h-7 px-2"
          disabled={!ratLayer || computing}
          title={t("rasterAttributeTable.recomputeTitle")}
          onClick={() =>
            ratLayer &&
            void compute(ratLayer, record?.band ?? currentBand(ratLayer))
          }
        >
          <RefreshCw
            className={`h-3.5 w-3.5 ${computing ? "animate-spin" : ""}`}
          />
          <span className="hidden sm:inline">
            {t("rasterAttributeTable.buttons.recompute")}
          </span>
        </Button>
        <Button
          variant="default"
          size="sm"
          className="h-7 px-2"
          disabled={!record || rows.length === 0 || computing}
          title={t("rasterAttributeTable.applyTitle")}
          onClick={applySymbology}
        >
          <Paintbrush className="h-3.5 w-3.5" />
          <span className="hidden sm:inline">
            {t("rasterAttributeTable.buttons.apply")}
          </span>
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="h-7 px-2"
          disabled={!record || rows.length === 0 || computing}
          title={t("rasterAttributeTable.paletteTitle")}
          onClick={() => void seedFromPalette()}
        >
          <ListChecks className="h-3.5 w-3.5" />
          <span className="hidden sm:inline">
            {t("rasterAttributeTable.buttons.palette")}
          </span>
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="h-7 px-2"
          disabled={!record || rows.length === 0}
          title={t("rasterAttributeTable.legendTitle")}
          onClick={() => void sendToLegend()}
        >
          <Table2 className="h-3.5 w-3.5" />
          <span className="hidden sm:inline">
            {t("rasterAttributeTable.buttons.legend")}
          </span>
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="h-7 px-2"
          disabled={!record || rows.length === 0}
          title={t("rasterAttributeTable.csvTitle")}
          onClick={() => void exportCsv()}
        >
          <FileDown className="h-3.5 w-3.5" />
          <span className="hidden sm:inline">
            {t("rasterAttributeTable.buttons.csv")}
          </span>
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 w-7 p-0"
          aria-label={t("rasterAttributeTable.close")}
          onClick={() => setOpen(false)}
        >
          <X className="h-4 w-4" />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {!ratLayer ? (
          <p className="p-4 text-sm text-muted-foreground">
            {t("rasterAttributeTable.noRasterSelected")}
          </p>
        ) : computing ? (
          <p className="p-4 text-sm text-muted-foreground">
            {t("rasterAttributeTable.computing")}
          </p>
        ) : rows.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground">
            {error ?? t("rasterAttributeTable.empty")}
          </p>
        ) : (
          <table className="w-full border-collapse text-xs">
            <thead className="sticky top-0 z-10 bg-card">
              <tr className="border-b text-start">
                <th className="px-3 py-1.5 text-start font-medium">
                  {t("rasterAttributeTable.columns.value")}
                </th>
                <th className="px-3 py-1.5 text-start font-medium">
                  {t("rasterAttributeTable.columns.count")}
                </th>
                <th className="px-3 py-1.5 text-start font-medium">
                  {t("rasterAttributeTable.columns.percent")}
                </th>
                {pixelAreaM2 !== null ? (
                  <th className="px-3 py-1.5 text-start font-medium">
                    {t(`rasterAttributeTable.columns.area_${areaUnit}`)}
                  </th>
                ) : null}
                <th className="px-3 py-1.5 text-start font-medium">
                  {t("rasterAttributeTable.columns.color")}
                </th>
                <th className="w-full px-3 py-1.5 text-start font-medium">
                  {t("rasterAttributeTable.columns.label")}
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, index) => (
                <tr key={row.value} className="border-b last:border-b-0">
                  <td className="px-3 py-1 font-mono">{row.value}</td>
                  <td className="px-3 py-1 font-mono">
                    {row.count.toLocaleString()}
                  </td>
                  <td className="px-3 py-1 font-mono">
                    {totalCount > 0
                      ? `${((row.count / totalCount) * 100).toFixed(1)}%`
                      : "–"}
                  </td>
                  {pixelAreaM2 !== null ? (
                    <td className="px-3 py-1 font-mono">
                      {formatArea(row.count * pixelAreaM2, areaUnit)}
                    </td>
                  ) : null}
                  <td className="px-3 py-1">
                    <input
                      type="color"
                      aria-label={t("rasterAttributeTable.rowColor", {
                        value: row.value,
                      })}
                      className="h-6 w-10 cursor-pointer rounded border bg-transparent"
                      value={row.color}
                      onChange={(event) =>
                        updateRow(index, { color: event.target.value })
                      }
                    />
                  </td>
                  <td className="px-3 py-1">
                    <Input
                      aria-label={t("rasterAttributeTable.rowLabel", {
                        value: row.value,
                      })}
                      className="h-6 px-2 py-0 text-xs"
                      value={row.label}
                      onChange={(event) =>
                        updateRow(index, { label: event.target.value })
                      }
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}
