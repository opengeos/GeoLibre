import { type GeoLibreLayer, useAppStore } from "@geolibre/core";
import type { MapController } from "@geolibre/map";
import {
  getPaletteLegend,
  openLegendPanelWithItems,
  savedRasterSymbology,
} from "@geolibre/plugins";
import { type RasterData, readRasterData } from "@geolibre/processing";
import { Button, Input, Select } from "@geolibre/ui";
import { FileDown, ListChecks, Paintbrush, RefreshCw, Table2, X } from "lucide-react";
import { type RefObject, useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { createAppAPI } from "../../hooks/usePlugins";
import {
  type GdalRatEntry,
  type RasterAttributeTableRecord,
  type RasterAttributeTableRow,
  MAX_RAT_SYMBOLOGY_CLASSES,
  categoricalSymbologyFromRows,
  computeValueCounts,
  gdalAuxXmlUrl,
  parseGdalRat,
  pixelAreaSquareMeters,
  ratRowsToCsv,
  savedRasterAttributeTable,
  seedRatRows,
} from "../../lib/raster-attribute-table";
import { canExportRasterLayer, rasterExportUrl } from "../../lib/raster-export";
import { fetchableUrl } from "../../lib/url-utils";
import { PANEL_RESIZE_END_EVENT, PANEL_RESIZE_START_EVENT } from "../../lib/panel-resize";
import { saveBinaryFileWithFallback } from "../../lib/tauri-io";
import { sanitizeExportFileName } from "../../lib/vector-export";

const DEFAULT_PANEL_HEIGHT = 260;
const MIN_PANEL_HEIGHT = 140;

/**
 * Upper bound on a fetched `.aux.xml` sidecar (8 MB). Real PAM files are tiny;
 * the cap keeps a huge or hostile response from being buffered and regex-
 * scanned in full.
 */
const MAX_AUX_XML_BYTES = 8 * 1024 * 1024;

/** The layer types the table can census (a downloadable single GeoTIFF). */
function isRatLayer(layer: GeoLibreLayer | undefined): layer is GeoLibreLayer {
  return !!layer && canExportRasterLayer(layer);
}

/** The layer's `metadata.rasterState` as a record ({} when absent/malformed). */
function rasterStateOf(layer: GeoLibreLayer): Record<string, unknown> {
  const state = layer.metadata.rasterState;
  return state && typeof state === "object" && !Array.isArray(state)
    ? (state as Record<string, unknown>)
    : {};
}

/** The 1-indexed band the layer currently renders (rasterState.bands[0]). */
function currentBand(layer: GeoLibreLayer): number {
  const bands = rasterStateOf(layer).bands;
  if (Array.isArray(bands) && typeof bands[0] === "number" && bands[0] >= 1) {
    return bands[0];
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
  // Resolve through fetchableUrl like the census does, so wrapped URL schemes
  // (e.g. cog://https://…) also get their sidecar probed.
  const url = fetchableUrl(layer.source?.url);
  if (!url || !/^https?:\/\//.test(url)) return null;
  const auxUrl = gdalAuxXmlUrl(url);
  if (!auxUrl) return null;
  try {
    const response = await fetch(auxUrl, { signal });
    if (!response.ok) return null;
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MAX_AUX_XML_BYTES) return null;
    const text = await response.text();
    if (text.length > MAX_AUX_XML_BYTES) return null;
    return parseGdalRat(text, band);
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
  // Derived only while open: the panel stays mounted when closed, and
  // validating/sorting a stored table on every layers write would be dead work.
  const record = open && ratLayer ? savedRasterAttributeTable(ratLayer) : null;

  const [computing, setComputing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [panelHeight, setPanelHeight] = useState(DEFAULT_PANEL_HEIGHT);
  // In-progress edits, keyed by row value. Labels commit on blur/Enter and
  // colors on a trailing throttle, so a keystroke or picker-drag tick doesn't
  // trigger a full store write (and the layer-sync/texture work it fans out
  // to) per event.
  const [labelDrafts, setLabelDrafts] = useState<Record<number, string>>({});
  const [colorDrafts, setColorDrafts] = useState<Record<number, string>>({});
  const sectionRef = useRef<HTMLElement | null>(null);
  const computeAbortRef = useRef<AbortController | null>(null);
  const colorFlushRef = useRef<number | null>(null);
  // Pending color edits buffered per row value, so rapid edits across
  // multiple rows inside one throttle window all persist (a single-slot
  // buffer would drop all but the last row's edit). The target layer id is
  // captured with them so a flush always writes to the layer that was edited.
  const pendingColorsRef = useRef<{
    layerId: string;
    colors: Map<number, string>;
  } | null>(null);
  // The last decoded raster, so a band switch recounts the already-decoded
  // bands instead of re-downloading and re-decoding the whole file. Held only
  // while the panel is open on the same layer/source.
  const rasterCacheRef = useRef<{ key: string; raster: RasterData } | null>(null);

  /**
   * Commits any buffered color edits immediately, in one store write against
   * the layer they were made on, and cancels the trailing flush timer. Reads
   * only refs and stable store APIs, so the empty dependency list is safe.
   */
  const flushPendingColors = useCallback(() => {
    if (colorFlushRef.current !== null) {
      window.clearTimeout(colorFlushRef.current);
      colorFlushRef.current = null;
    }
    const pending = pendingColorsRef.current;
    pendingColorsRef.current = null;
    if (!pending || pending.colors.size === 0) return;
    const live = liveLayer(pending.layerId);
    const current = live ? savedRasterAttributeTable(live) : null;
    if (!current) return;
    const rows = current.rows.map((row) => {
      const pendingColor = pending.colors.get(row.value);
      return pendingColor ? { ...row, color: pendingColor } : row;
    });
    commitRows(pending.layerId, current, rows, { colorsChanged: true });
    setColorDrafts((drafts) => {
      const next = { ...drafts };
      for (const pendingValue of pending.colors.keys()) {
        delete next[pendingValue];
      }
      return next;
    });
    // commitRows/liveLayer close over only stable store APIs and their args.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * Settles in-progress edits before the table is replaced or the layer
   * switches: pending colors are committed (to the layer they were edited
   * on), then the draft state is cleared.
   */
  const resetEditBuffers = useCallback(() => {
    flushPendingColors();
    setLabelDrafts({});
    setColorDrafts({});
  }, [flushPendingColors]);

  // Reset transient state when the target layer changes, and abort any
  // in-flight computation so its result can't land on the wrong layer. The
  // aborted call's finally skips its own setComputing(false) (the abort means
  // someone else owns the flag now), so the flag is reset here — otherwise a
  // layer switch mid-compute would leave the panel stuck on "computing".
  useEffect(() => {
    setError(null);
    setNotice(null);
    resetEditBuffers();
    return () => {
      if (computeAbortRef.current) {
        computeAbortRef.current.abort();
        computeAbortRef.current = null;
        setComputing(false);
      }
      // Settle edits aimed at the previous layer (pending colors are
      // committed to it, not dropped) and release its decoded raster.
      resetEditBuffers();
      rasterCacheRef.current = null;
    };
  }, [ratLayer?.id, resetEditBuffers]);

  // Release the decoded raster (which can be large) when the panel closes.
  useEffect(() => {
    if (!open) rasterCacheRef.current = null;
  }, [open]);

  /**
   * Merges a metadata patch onto the layer's LIVE metadata, read from the
   * store at write time. The panel's async flows (compute, palette reads) can
   * take seconds; spreading a metadata snapshot captured before the await
   * would silently revert anything written meanwhile (style-panel edits, the
   * raster control's sync echo), since updateLayer replaces metadata
   * wholesale.
   */
  const patchLayerMetadata = useCallback(
    (layerId: string, patch: Record<string, unknown>): void => {
      const live = useAppStore.getState().layers.find((l) => l.id === layerId);
      if (!live) return;
      updateLayer(layerId, { metadata: { ...live.metadata, ...patch } });
    },
    [updateLayer],
  );

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
      // A recompute replaces the table, so in-progress edits (and any pending
      // throttled commit) target rows that are about to go away — a band
      // switch must not land an old band's color on the new band's table.
      resetEditBuffers();
      setComputing(true);
      setError(null);
      setNotice(null);
      try {
        // Labels/colors seed from an existing GDAL RAT (remote .aux.xml), then
        // the raster's embedded color table, then a sampled ramp — and any
        // labels/colors the user already edited win over all three. Both
        // lookups depend only on the URL, so they run concurrently with (and
        // hide under) the main download.
        const ratPromise = fetchGdalRat(target, band, controller.signal);
        const palettePromise = getPaletteLegend(target.id, url).catch(() => null);
        // readRasterData decodes every band, so a band switch on the same
        // source reuses the cached decode instead of re-downloading the file.
        const cacheKey = `${target.id}|${url}`;
        let raster =
          rasterCacheRef.current?.key === cacheKey ? rasterCacheRef.current.raster : null;
        if (!raster) {
          const response = await fetch(url, { signal: controller.signal });
          if (!response.ok) {
            throw new Error(t("rasterAttributeTable.readError"));
          }
          raster = await readRasterData(await response.arrayBuffer());
          rasterCacheRef.current = { key: cacheKey, raster };
        }
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
        const rat = await ratPromise;
        const paletteEntries = await palettePromise;
        const palette = paletteEntries
          ? new Map(paletteEntries.map((e) => [e.value, e.color]))
          : null;
        if (controller.signal.aborted) return;
        // Re-read the stored table from the live store (not the pre-await
        // snapshot) so label/color edits made during the scan survive.
        const live = useAppStore.getState().layers.find((l) => l.id === target.id);
        const previous = live ? savedRasterAttributeTable(live) : null;
        const seeded = seedRatRows(counts, { rat, palette });
        const priorByValue = new Map(
          (previous?.band === band ? previous.rows : []).map((row) => [row.value, row]),
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
        patchLayerMetadata(target.id, { rasterAttributeTable: next });
      } catch (err) {
        if (controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : t("rasterAttributeTable.readError"));
      } finally {
        if (computeAbortRef.current === controller) {
          computeAbortRef.current = null;
        }
        if (!controller.signal.aborted) setComputing(false);
      }
    },
    [t, patchLayerMetadata, resetEditBuffers],
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
    // Both the edges AND the colors must match what this table produced: if
    // the user re-colored the classes from the style panel (same breaks,
    // different ramp), a table color edit must not silently overwrite that
    // choice — Apply symbology remains the explicit way to retake ownership.
    const breaks = applied.symbology.breaks;
    const colors = applied.symbology.customColors ?? [];
    return (
      current.breaks.length === breaks.length &&
      current.breaks.every((edge, i) => edge === breaks[i]) &&
      current.customColors?.length === colors.length &&
      current.customColors.every((color, i) => color === colors[i])
    );
  }

  /** The layer's live store snapshot, read at write time. */
  function liveLayer(layerId: string): GeoLibreLayer | undefined {
    return useAppStore.getState().layers.find((l) => l.id === layerId);
  }

  /**
   * Persists edited rows and, when the colors changed while the table's
   * symbology is applied on the layer, re-derives that symbology in the same
   * store write so the map recolors live.
   */
  function commitRows(
    layerId: string,
    current: RasterAttributeTableRecord,
    rows: RasterAttributeTableRow[],
    options: { colorsChanged?: boolean } = {},
  ) {
    const live = liveLayer(layerId);
    if (!live) return;
    const liveSymbology =
      options.colorsChanged && tableSymbologyActive(live, current.rows)
        ? categoricalSymbologyFromRows(rows)?.symbology
        : undefined;
    patchLayerMetadata(layerId, {
      rasterAttributeTable: { ...current, rows },
      ...(liveSymbology ? { rasterSymbology: liveSymbology } : {}),
    });
  }

  /**
   * Applies a patch to one row (matched by value), re-reading the stored
   * table at commit time so a deferred commit (throttled color, blur label)
   * can never revert an earlier one from a stale snapshot.
   */
  function commitRowPatch(value: number, patch: Partial<RasterAttributeTableRow>) {
    if (!ratLayer) return;
    const live = liveLayer(ratLayer.id);
    const current = live ? savedRasterAttributeTable(live) : null;
    if (!current) return;
    const rows = current.rows.map((row) => (row.value === value ? { ...row, ...patch } : row));
    commitRows(ratLayer.id, current, rows, {
      colorsChanged: patch.color !== undefined,
    });
  }

  /**
   * Trailing-throttled color commit: at most one store write per interval,
   * flushing every buffered row edit in that single write.
   */
  function scheduleColorCommit(value: number, color: string) {
    if (!ratLayer) return;
    if (pendingColorsRef.current?.layerId !== ratLayer.id) {
      pendingColorsRef.current = { layerId: ratLayer.id, colors: new Map() };
    }
    pendingColorsRef.current.colors.set(value, color);
    if (colorFlushRef.current !== null) return;
    colorFlushRef.current = window.setTimeout(() => {
      colorFlushRef.current = null;
      flushPendingColors();
    }, 200);
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
    const live = liveLayer(ratLayer.id);
    if (!live) return;
    patchLayerMetadata(ratLayer.id, {
      rasterState: {
        ...rasterStateOf(live),
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
      // The palette scan can take seconds on a cache miss; re-read the stored
      // table so label/color edits made during the await survive.
      const live = liveLayer(ratLayer.id);
      const current = live ? savedRasterAttributeTable(live) : null;
      if (!current) return;
      const palette = new Map(entries.map((e) => [e.value, e.color]));
      const rows = current.rows.map((row) => {
        const color = palette.get(row.value);
        return color ? { ...row, color } : row;
      });
      commitRows(ratLayer.id, current, rows, { colorsChanged: true });
    } catch {
      setNotice(t("rasterAttributeTable.noPalette"));
    }
  }

  async function sendToLegend() {
    if (!ratLayer || !record) return;
    setError(null);
    const opened = await openLegendPanelWithItems(createAppAPI(mapControllerRef), {
      title: ratLayer.name,
      items: record.rows.map((row) => ({
        label: row.label,
        color: row.color,
        shape: "square" as const,
      })),
      legendPosition: "bottom-right",
    });
    if (!opened) setError(t("rasterAttributeTable.legendError"));
  }

  async function exportCsv() {
    if (!ratLayer || !record) return;
    setError(null);
    try {
      const csv = ratRowsToCsv(record.rows, record.pixelAreaM2);
      await saveBinaryFileWithFallback(new TextEncoder().encode(csv), {
        defaultName: `${sanitizeExportFileName(ratLayer.name)}_classes.csv`,
        filters: [{ name: "CSV", extensions: ["csv"] }],
        browserTypes: [{ description: "CSV", accept: { "text/csv": [".csv"] } }],
        mimeType: "text/csv",
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : t("rasterAttributeTable.csvError"));
    }
  }

  // Drag-to-resize, dispatching the shared panel-resize events so MapCanvas
  // pauses expensive work during the drag (same contract as AttributeTable).
  // The cleanup is idempotent and also fires on window blur and unmount, so a
  // drag interrupted mid-flight (alt-tab, panel teardown) can't leave global
  // listeners attached with the map's resize work paused.
  const resizeCleanupRef = useRef<(() => void) | null>(null);
  useEffect(() => () => resizeCleanupRef.current?.(), []);

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
    const finishResize = () => {
      if (resizeCleanupRef.current !== finishResize) return;
      resizeCleanupRef.current = null;
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", finishResize);
      window.removeEventListener("blur", finishResize);
      setPanelHeight(nextHeight);
      window.dispatchEvent(new Event(PANEL_RESIZE_END_EVENT));
    };
    resizeCleanupRef.current = finishResize;
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", finishResize);
    window.addEventListener("blur", finishResize);
  }

  if (!open) return null;

  const rows = record?.rows ?? [];
  const totalCount = rows.reduce((sum, row) => sum + row.count, 0);
  const pixelAreaM2 = record?.pixelAreaM2 ?? null;
  const maxAreaM2 = pixelAreaM2 ? Math.max(0, ...rows.map((row) => row.count * pixelAreaM2)) : 0;
  const areaUnit: "m2" | "ha" | "km2" = maxAreaM2 >= 1e6 ? "km2" : maxAreaM2 >= 1e4 ? "ha" : "m2";
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
        className="absolute -top-1 start-0 end-0 z-20 h-2 cursor-row-resize select-none border-t border-transparent hover:border-primary"
        onMouseDown={startResize}
      />
      <div className="flex flex-wrap items-center gap-2 border-b px-3 py-1.5 md:flex-nowrap">
        <Table2 className="h-4 w-4 text-muted-foreground" />
        <span className="text-sm font-semibold">{t("rasterAttributeTable.title")}</span>
        <span className="min-w-0 max-w-full truncate text-xs text-muted-foreground md:max-w-56">
          {ratLayer?.name ?? t("rasterAttributeTable.noRasterSelected")}
        </span>
        {ratLayer && bandCount > 1 ? (
          <Select
            aria-label={t("rasterAttributeTable.band")}
            className="h-7 w-auto py-0 text-xs"
            value={String(record?.band ?? currentBand(ratLayer))}
            disabled={computing}
            onChange={(event) => void compute(ratLayer, Number(event.target.value))}
          >
            {Array.from({ length: bandCount }, (_, index) => (
              <option key={index + 1} value={String(index + 1)}>
                {t("rasterAttributeTable.bandOption", { band: index + 1 })}
              </option>
            ))}
          </Select>
        ) : null}
        {error ? (
          <span className="max-w-64 truncate text-xs text-destructive" title={error}>
            {error}
          </span>
        ) : notice ? (
          <span className="max-w-64 truncate text-xs text-muted-foreground" title={notice}>
            {notice}
          </span>
        ) : null}
        <Button
          variant="outline"
          size="sm"
          className="ms-auto h-7 px-2"
          disabled={!ratLayer || computing}
          title={t("rasterAttributeTable.recomputeTitle")}
          onClick={() => ratLayer && void compute(ratLayer, record?.band ?? currentBand(ratLayer))}
        >
          <RefreshCw className={`h-3.5 w-3.5 ${computing ? "animate-spin" : ""}`} />
          <span className="hidden sm:inline">{t("rasterAttributeTable.buttons.recompute")}</span>
        </Button>
        <Button
          variant="default"
          size="sm"
          className="h-7 px-2"
          disabled={
            !record || rows.length === 0 || rows.length > MAX_RAT_SYMBOLOGY_CLASSES || computing
          }
          title={
            rows.length > MAX_RAT_SYMBOLOGY_CLASSES
              ? t("rasterAttributeTable.tooManyClasses", {
                  max: MAX_RAT_SYMBOLOGY_CLASSES,
                })
              : t("rasterAttributeTable.applyTitle")
          }
          onClick={applySymbology}
        >
          <Paintbrush className="h-3.5 w-3.5" />
          <span className="hidden sm:inline">{t("rasterAttributeTable.buttons.apply")}</span>
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
          <span className="hidden sm:inline">{t("rasterAttributeTable.buttons.palette")}</span>
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
          <span className="hidden sm:inline">{t("rasterAttributeTable.buttons.legend")}</span>
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
          <span className="hidden sm:inline">{t("rasterAttributeTable.buttons.csv")}</span>
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
          <p className="p-4 text-sm text-muted-foreground">{t("rasterAttributeTable.computing")}</p>
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
              {rows.map((row) => (
                <tr key={row.value} className="border-b last:border-b-0">
                  <td className="px-3 py-1 font-mono">{row.value}</td>
                  <td className="px-3 py-1 font-mono">{row.count.toLocaleString()}</td>
                  <td className="px-3 py-1 font-mono">
                    {totalCount > 0 ? `${((row.count / totalCount) * 100).toFixed(1)}%` : "–"}
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
                      value={colorDrafts[row.value] ?? row.color}
                      onChange={(event) => {
                        const color = event.target.value;
                        setColorDrafts((drafts) => ({
                          ...drafts,
                          [row.value]: color,
                        }));
                        scheduleColorCommit(row.value, color);
                      }}
                    />
                  </td>
                  <td className="px-3 py-1">
                    <Input
                      aria-label={t("rasterAttributeTable.rowLabel", {
                        value: row.value,
                      })}
                      className="h-6 px-2 py-0 text-xs"
                      value={labelDrafts[row.value] ?? row.label}
                      onChange={(event) =>
                        setLabelDrafts((drafts) => ({
                          ...drafts,
                          [row.value]: event.target.value,
                        }))
                      }
                      onBlur={(event) => {
                        // Read the DOM value: a same-tick type-then-blur can
                        // outrun the draft state update.
                        const text = event.currentTarget.value;
                        if (text !== row.label) {
                          commitRowPatch(row.value, { label: text });
                        }
                        setLabelDrafts((drafts) => {
                          const next = { ...drafts };
                          delete next[row.value];
                          return next;
                        });
                      }}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") event.currentTarget.blur();
                      }}
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
