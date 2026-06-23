import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  DEFAULT_LEGEND_CONFIG,
  getVectorColorRamp,
  useAppStore,
  VECTOR_COLOR_RAMPS,
} from "@geolibre/core";
import type { MapController } from "@geolibre/map";
import { GRATICULE_LABEL_LAYER_ID } from "@geolibre/plugins";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  Select,
  Separator,
  Slider,
  Textarea,
} from "@geolibre/ui";
import {
  ArrowDown,
  ArrowUp,
  Check,
  ClipboardCopy,
  Crop,
  Eye,
  EyeOff,
  FileImage,
  FileText,
  Plus,
  RefreshCw,
  RotateCcw,
  Trash2,
} from "lucide-react";
import {
  computeScaleRatio,
  drawLayout,
  PAPER_SIZES,
  resolvePageSize,
  type CustomSize,
  type LayoutOptions,
  type Orientation,
  type PaperSizeId,
  type SizeUnit,
} from "../../lib/print-layout";
import {
  clearPrintExtent,
  drawPrintExtent,
  setPrintExtentVisible,
  showPrintExtent,
  type PrintExtent,
} from "../../lib/print-extent";
import {
  applyLegendConfig,
  buildLegend,
  captureMapImage,
  copyLayoutToClipboard,
  exportLayoutPdf,
  exportLayoutPng,
  legendEditorRows,
  reorderLegendEntry,
  setLegendItemLabel,
  toggleLegendItemHidden,
  type CapturedMap,
} from "../../lib/print-layout-export";

interface PrintLayoutDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mapControllerRef: React.RefObject<MapController | null>;
}

/** Common industry scale denominators offered as quick presets (GH #522). */
const SCALE_PRESETS = [500, 1000, 2500, 5000, 10000, 25000, 50000, 100000];

/** Bounds (px) for the draggable controls column inside the dialog. */
const CONTROLS_MIN_WIDTH = 260;
const CONTROLS_MAX_WIDTH = 560;
const CONTROLS_DEFAULT_WIDTH = 320;

function sanitizeFilename(name: string): string {
  // Keep letters and digits from any script (\p{L}\p{N}) so non-Latin project
  // names are not stripped to the fallback.
  const cleaned = name
    .trim()
    .replace(/[^\p{L}\p{N} _-]+/gu, "")
    .replace(/\s+/g, "-");
  return cleaned || "map-layout";
}

interface ToggleFieldProps {
  id: string;
  label: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}

/** A labelled checkbox row for toggling a map element on or off. */
function ToggleField({ id, label, checked, onChange }: ToggleFieldProps) {
  return (
    <label htmlFor={id} className="flex cursor-pointer items-center gap-2 text-sm">
      <input
        id={id}
        type="checkbox"
        className="h-4 w-4 accent-primary"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      {label}
    </label>
  );
}

/**
 * Print Layout composer dialog: captures the current map view and composes it
 * with a title, legend, scale bar, north arrow, and footer onto a chosen paper
 * or screen size, then exports the result to PNG or PDF.
 */
export function PrintLayoutDialog({
  open,
  onOpenChange,
  mapControllerRef,
}: PrintLayoutDialogProps) {
  const { t } = useTranslation();
  const layers = useAppStore((s) => s.layers);
  const projectName = useAppStore((s) => s.projectName);
  const legendConfig = useAppStore((s) => s.legend);
  const setLegendConfig = useAppStore((s) => s.setLegend);

  const [title, setTitle] = useState("");
  const [subtitle, setSubtitle] = useState("");
  const [titlePlacement, setTitlePlacement] = useState<"outside" | "inside">(
    "outside",
  );
  const [titleAlign, setTitleAlign] = useState<"left" | "center" | "right">(
    "center",
  );
  const [paperSize, setPaperSize] = useState<PaperSizeId>("a4");
  const [orientation, setOrientation] = useState<Orientation>("landscape");
  const [customWidth, setCustomWidth] = useState(1280);
  const [customHeight, setCustomHeight] = useState(720);
  const [customUnit, setCustomUnit] = useState<SizeUnit>("px");
  const [showTitle, setShowTitle] = useState(true);
  const [showSubtitle, setShowSubtitle] = useState(true);
  const [showLegend, setShowLegend] = useState(true);
  const [showScaleBar, setShowScaleBar] = useState(true);
  const [showNorthArrow, setShowNorthArrow] = useState(true);
  const [navigationGrouped, setNavigationGrouped] = useState(true);
  const [showFooter, setShowFooter] = useState(false);
  const [footerText, setFooterText] = useState("");
  const [showDate, setShowDate] = useState(true);
  const [dateText, setDateText] = useState("");
  const [showAttribution, setShowAttribution] = useState(true);
  const [pageMargin, setPageMargin] = useState<"normal" | "narrow" | "none">(
    "normal",
  );
  const [showPageBorder, setShowPageBorder] = useState(false);
  const [pageBorderColor, setPageBorderColor] = useState("#111827");
  const [pageBorderWidth, setPageBorderWidth] = useState(2);
  // Map frame (the border around the map body). Width is a 0–10 scale; 0 hides
  // the frame. Defaults match the original hardcoded hairline (GH #749).
  const [mapBorderColor, setMapBorderColor] = useState("#9ca3af");
  const [mapBorderWidth, setMapBorderWidth] = useState(1);
  const [mapBackground, setMapBackground] = useState("#e5e7eb");
  // Draft for the free-form hex field; only complete #RGB / #RRGGBB values are
  // committed to mapBackground (which also drives <input type="color"> and the
  // canvas fillStyle), so a half-typed "#" never corrupts the layout colour.
  const [mapBackgroundDraft, setMapBackgroundDraft] = useState("#e5e7eb");
  const commitMapBackground = useCallback((value: string) => {
    setMapBackgroundDraft(value);
    if (/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(value.trim())) {
      setMapBackground(value.trim());
    }
  }, []);
  // Native colorbar composed in the dialog (GH follow-up).
  const [showColorbar, setShowColorbar] = useState(false);
  const [colorbarRamp, setColorbarRamp] = useState("viridis");
  const [colorbarMin, setColorbarMin] = useState("0");
  const [colorbarMax, setColorbarMax] = useState("100");
  const [colorbarLabel, setColorbarLabel] = useState("");
  const [colorbarOrientation, setColorbarOrientation] = useState<
    "vertical" | "horizontal"
  >("vertical");
  // Bar length as a percentage of the body width/height.
  const [colorbarLength, setColorbarLength] = useState(34);
  // User-defined legend composed in the dialog (like Controls -> Legend).
  const [showCustomLegend, setShowCustomLegend] = useState(false);
  const [customLegendTitle, setCustomLegendTitle] = useState("Legend");
  const [customLegendEntries, setCustomLegendEntries] = useState<
    { id: string; label: string; color: string }[]
  >([
    { id: "cl-1", label: "Class 1", color: "#2563eb" },
    { id: "cl-2", label: "Class 2", color: "#16a34a" },
  ]);
  const [customLegendPosition, setCustomLegendPosition] = useState<
    "top-left" | "top-right" | "bottom-left" | "bottom-right"
  >("top-left");
  const customLegendId = useRef(2);
  const [legendDict, setLegendDict] = useState("");
  const [legendDictError, setLegendDictError] = useState<string | null>(null);

  // Replace the legend items from a `{ label: color }` dictionary, matching the
  // Controls -> Legend "Import from Dictionary" format.
  const importLegendDict = useCallback(() => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(legendDict);
    } catch {
      setLegendDictError(t("printLayout.customLegend.importError"));
      return;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      setLegendDictError(t("printLayout.customLegend.importError"));
      return;
    }
    const entries = Object.entries(parsed as Record<string, unknown>).map(
      ([label, color]) => ({
        id: `cl-${++customLegendId.current}`,
        label,
        color: String(color),
      }),
    );
    if (entries.length === 0) {
      setLegendDictError(t("printLayout.customLegend.importError"));
      return;
    }
    setCustomLegendEntries(entries);
    setLegendDictError(null);
  }, [legendDict, t]);
  // Default away from the bottom-right nav duo and top-left legend.
  const [colorbarPosition, setColorbarPosition] = useState<
    "top-left" | "top-right" | "bottom-left" | "bottom-right"
  >("top-right");
  // Cartographic title block ("stempel") fields (GH #522).
  const [showInfoBlock, setShowInfoBlock] = useState(false);
  const [author, setAuthor] = useState("");
  const [projectNumber, setProjectNumber] = useState("");
  const [crs, setCrs] = useState("");
  const [revision, setRevision] = useState("");
  // Custom print extent drawn on the map (GH #523).
  const [captureMode, setCaptureMode] = useState<"viewport" | "extent">(
    "viewport",
  );
  const [extentBbox, setExtentBbox] = useState<PrintExtent | null>(null);
  const [drawingExtent, setDrawingExtent] = useState(false);
  const [captured, setCaptured] = useState<CapturedMap | null>(null);
  // "contain" when a graticule is active, so its edge labels are not trimmed by
  // the default "cover" crop; "cover" (fill the frame) otherwise.
  const [mapFit, setMapFit] = useState<"cover" | "contain">("cover");
  const [exporting, setExporting] = useState(false);
  // Brief "Copied" confirmation on the clipboard button (GH #773).
  const [copied, setCopied] = useState(false);
  const copiedTimeoutRef = useRef<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const previewRef = useRef<HTMLCanvasElement | null>(null);
  const previewBoxRef = useRef<HTMLDivElement | null>(null);
  const wasOpenRef = useRef(false);
  // Set while the dialog is hidden to let the user draw on the map, so the
  // close handler does not tear down the in-progress extent box.
  const drawingRef = useRef(false);
  // Aborts an in-progress draw when the dialog unmounts mid-drag.
  const drawAbortRef = useRef<AbortController | null>(null);
  // A pending "recapture once the map is idle" handler (from applyScale), kept
  // so any newer capture can cancel it before it overwrites a fresh result.
  const idleRecaptureRef = useRef<(() => void) | null>(null);
  // Tears down an in-progress dialog/splitter resize drag (removes the window
  // pointer listeners) if the dialog unmounts mid-drag.
  const resizeCleanupRef = useRef<(() => void) | null>(null);
  // True while the scale input has focus, so two-way sync does not overwrite
  // what the user is typing.
  const scaleFocusedRef = useRef(false);
  const [scaleDraft, setScaleDraft] = useState("");
  // Inline notice shown when a requested scale can't be reached at the map's
  // zoom limits, so a clamped result is never silently swallowed (GH #743).
  const [scaleNotice, setScaleNotice] = useState<string | null>(null);
  // Fallback timer that forces a recapture if the map's "idle" event is delayed
  // or never fires (e.g. WebKit throttling the occluded map canvas behind the
  // dialog), so a scale change is never silently dropped (GH #743).
  const idleFallbackRef = useRef<number | null>(null);
  // Width of the left controls column; dragged via the splitter handle.
  const [controlsWidth, setControlsWidth] = useState(CONTROLS_DEFAULT_WIDTH);
  // Mirror of controlsWidth so the resize handler can read the latest start
  // width without listing it as a dep (which would recreate the callback every
  // RAF tick during a drag).
  const controlsWidthRef = useRef(controlsWidth);
  controlsWidthRef.current = controlsWidth;
  // Explicit dialog size once the user drags the corner grip (null = the
  // default responsive size). The dialog element, for reading its live size.
  const dialogRef = useRef<HTMLDivElement>(null);
  const [dialogSize, setDialogSize] = useState<{
    width: number;
    height: number;
  } | null>(null);

  // Resize the whole dialog from its bottom-right grip. The dialog is centred
  // via a -50% transform, so the right/bottom edges move by half the size
  // change; growing by 2x the pointer delta keeps the grip under the cursor.
  const startDialogResize = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      event.stopPropagation();
      event.currentTarget.setPointerCapture?.(event.pointerId);
      const el = dialogRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const startX = event.clientX;
      const startY = event.clientY;
      const startW = rect.width;
      const startH = rect.height;
      let next = { width: startW, height: startH };
      let frame: number | null = null;
      const prevCursor = document.body.style.cursor;
      const prevSelect = document.body.style.userSelect;
      document.body.style.cursor = "nwse-resize";
      document.body.style.userSelect = "none";

      const onMove = (e: PointerEvent) => {
        next = {
          width: Math.max(
            480,
            Math.min(window.innerWidth - 16, startW + (e.clientX - startX) * 2),
          ),
          height: Math.max(
            360,
            Math.min(window.innerHeight - 16, startH + (e.clientY - startY) * 2),
          ),
        };
        if (frame !== null) return;
        frame = window.requestAnimationFrame(() => {
          frame = null;
          setDialogSize(next);
        });
      };
      const cleanup = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onUp);
        if (frame !== null) window.cancelAnimationFrame(frame);
        document.body.style.cursor = prevCursor;
        document.body.style.userSelect = prevSelect;
        resizeCleanupRef.current = null;
      };
      const onUp = () => {
        cleanup();
        setDialogSize(next);
      };
      resizeCleanupRef.current = cleanup;
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
    },
    [],
  );

  // Drag the splitter between the controls column and the preview. Mirrors the
  // shell's panel-resize idiom: pointer capture so the drag survives leaving the
  // handle, RAF-throttled width updates, and a col-resize body cursor.
  const startSplitterResize = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      event.currentTarget.setPointerCapture?.(event.pointerId);
      const startX = event.clientX;
      const startWidth = controlsWidthRef.current;
      let nextWidth = startWidth;
      let frame: number | null = null;
      const prevCursor = document.body.style.cursor;
      const prevSelect = document.body.style.userSelect;
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";

      const onMove = (e: PointerEvent) => {
        nextWidth = Math.max(
          CONTROLS_MIN_WIDTH,
          Math.min(CONTROLS_MAX_WIDTH, startWidth + e.clientX - startX),
        );
        if (frame !== null) return;
        frame = window.requestAnimationFrame(() => {
          frame = null;
          setControlsWidth(nextWidth);
        });
      };
      const cleanup = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onUp);
        if (frame !== null) window.cancelAnimationFrame(frame);
        document.body.style.cursor = prevCursor;
        document.body.style.userSelect = prevSelect;
        resizeCleanupRef.current = null;
      };
      const onUp = () => {
        cleanup();
        setControlsWidth(nextWidth);
      };
      resizeCleanupRef.current = cleanup;
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
    },
    [],
  );

  const isCustom = paperSize === "custom";
  const paperOptions = useMemo(
    () => PAPER_SIZES.filter((p) => p.group === "paper"),
    [],
  );
  const screenOptions = useMemo(
    () => PAPER_SIZES.filter((p) => p.group === "screen" && p.id !== "custom"),
    [],
  );

  const baseLegend = useMemo(() => buildLegend(layers), [layers]);
  const legend = useMemo(
    () => applyLegendConfig(baseLegend, legendConfig),
    [baseLegend, legendConfig],
  );
  const editorRows = useMemo(
    () => legendEditorRows(baseLegend, legendConfig),
    [baseLegend, legendConfig],
  );
  const entryIdsInOrder = useMemo(
    () =>
      editorRows.filter((r) => r.kind === "entry").map((r) => r.layerId),
    [editorRows],
  );

  const moveEntry = useCallback(
    (layerId: string, direction: "up" | "down") => {
      setLegendConfig(
        reorderLegendEntry(legendConfig, entryIdsInOrder, layerId, direction),
      );
    },
    [legendConfig, entryIdsInOrder, setLegendConfig],
  );

  const recapture = useCallback(
    (clipOverride?: PrintExtent | null) => {
      const map = mapControllerRef.current?.getMap();
      if (!map) {
        setError(t("printLayout.errors.mapNotReady"));
        setCaptured(null);
        return;
      }
      // Cancel any pending post-zoom idle capture: this fresh capture supersedes
      // it, so it must not fire later and overwrite the result (e.g. a viewport
      // recapture clobbering an extent the user drew while tiles were loading).
      if (idleRecaptureRef.current) {
        map.off("idle", idleRecaptureRef.current);
        idleRecaptureRef.current = null;
      }
      if (idleFallbackRef.current !== null) {
        window.clearTimeout(idleFallbackRef.current);
        idleFallbackRef.current = null;
      }
      // An explicit override wins (used right after drawing, before state has
      // settled); otherwise clip to the stored extent only in extent mode.
      const clip =
        clipOverride !== undefined
          ? clipOverride
          : captureMode === "extent"
            ? extentBbox
            : null;
      // An active graticule draws coordinate labels at the map edges; fit the
      // captured map with "contain" so the page crop does not trim them.
      setMapFit(map.getLayer(GRATICULE_LABEL_LAYER_ID) ? "contain" : "cover");
      // Hide the extent box while reading the drawing buffer so its outline is
      // never baked into the captured image.
      setPrintExtentVisible(map, false);
      try {
        setCaptured(captureMapImage(map, clip));
        setError(null);
      } catch {
        setError(t("printLayout.errors.captureFailed"));
        setCaptured(null);
      } finally {
        setPrintExtentVisible(map, true);
      }
    },
    [mapControllerRef, t, captureMode, extentBbox],
  );

  // Capture the map and seed defaults only on the closed -> open transition, so
  // a background project-name change while the dialog is open does not replace
  // the snapshot the user is composing.
  useEffect(() => {
    const map = mapControllerRef.current?.getMap();
    if (open && !wasOpenRef.current) {
      setError(null);
      // Clear any out-of-range scale notice from a prior session: the dialog is
      // hidden (not unmounted) on close, so it would otherwise persist into the
      // next open even though no scale was just attempted (GH #743).
      setScaleNotice(null);
      // Same reasoning for the clipboard "Copied" flag: a copy made just before
      // the dialog was closed (within the 2s window) would otherwise re-open
      // still showing the confirmation (GH #773).
      if (copiedTimeoutRef.current !== null) {
        window.clearTimeout(copiedTimeoutRef.current);
        copiedTimeoutRef.current = null;
      }
      setCopied(false);
      setTitle((prev) => prev || (projectName ?? "").trim());
      setDateText((prev) => prev || new Date().toLocaleDateString());
      // Re-show a previously drawn extent box while composing.
      if (map && extentBbox) showPrintExtent(map, extentBbox);
      recapture();
    } else if (!open && wasOpenRef.current && !drawingRef.current) {
      // Closing for good (not to draw): take the extent box off the map.
      if (map) clearPrintExtent(map);
    }
    wasOpenRef.current = open;
  }, [open, projectName, recapture, mapControllerRef, extentBbox]);

  // Clean up if the dialog unmounts: abort an in-progress draw (so its window
  // listeners are torn down and it does not setState on an unmounted component)
  // and take the extent box off the map.
  useEffect(
    () => () => {
      drawAbortRef.current?.abort();
      // Tear down an in-progress resize drag so its window listeners don't leak.
      resizeCleanupRef.current?.();
      if (idleFallbackRef.current !== null) {
        window.clearTimeout(idleFallbackRef.current);
        idleFallbackRef.current = null;
      }
      if (copiedTimeoutRef.current !== null) {
        window.clearTimeout(copiedTimeoutRef.current);
        copiedTimeoutRef.current = null;
      }
      const map = mapControllerRef.current?.getMap();
      if (map) {
        if (idleRecaptureRef.current) {
          map.off("idle", idleRecaptureRef.current);
          idleRecaptureRef.current = null;
        }
        clearPrintExtent(map);
      }
    },
    [mapControllerRef],
  );

  const customSize = useMemo<CustomSize | null>(
    () =>
      isCustom
        ? { width: customWidth, height: customHeight, unit: customUnit }
        : null,
    [isCustom, customWidth, customHeight, customUnit],
  );

  const options = useMemo<LayoutOptions>(
    () => ({
      title,
      subtitle,
      paperSize,
      orientation,
      customSize,
      showTitle,
      showSubtitle,
      titlePlacement,
      titleAlign,
      showLegend,
      showScaleBar,
      showNorthArrow,
      navigationGrouped,
      showFooter,
      footerText,
      showDate,
      dateText,
      showAttribution,
      pageMargin,
      showPageBorder,
      pageBorderColor,
      pageBorderWidth,
      mapBorderColor,
      mapBorderWidth,
      mapBackground,
      colorbar: showColorbar
        ? {
            colors: getVectorColorRamp(colorbarRamp).colors,
            // Treat a blank/invalid field as 0 explicitly (Number("abc") is NaN,
            // which would otherwise flow into a degenerate gradient).
            min: Number.isFinite(Number(colorbarMin)) ? Number(colorbarMin) : 0,
            max: Number.isFinite(Number(colorbarMax)) ? Number(colorbarMax) : 0,
            label: colorbarLabel,
            orientation: colorbarOrientation,
            position: colorbarPosition,
            lengthPct: colorbarLength,
          }
        : null,
      customLegend: showCustomLegend
        ? {
            title: customLegendTitle,
            entries: customLegendEntries.map((e) => ({
              label: e.label,
              color: e.color,
            })),
            position: customLegendPosition,
          }
        : null,
      showInfoBlock,
      author,
      projectNumber,
      crs,
      revision,
      infoLabels: {
        author: t("printLayout.info.author"),
        project: t("printLayout.info.project"),
        crs: t("printLayout.info.crs"),
        scale: t("printLayout.info.scale"),
        revision: t("printLayout.info.revision"),
      },
      legend,
      legendTitle: legendConfig.title,
      legendGroupByLayer: legendConfig.groupByLayer,
      metersPerPixel: captured?.metersPerPixel ?? 0,
      bearingDeg: captured?.bearingDeg ?? 0,
      mapImage: captured?.image ?? null,
      mapImageWidth: captured?.width ?? 0,
      mapImageHeight: captured?.height ?? 0,
      mapFit,
    }),
    [
      title,
      subtitle,
      paperSize,
      orientation,
      customSize,
      showTitle,
      showSubtitle,
      titlePlacement,
      titleAlign,
      showLegend,
      showScaleBar,
      showNorthArrow,
      navigationGrouped,
      showFooter,
      footerText,
      showDate,
      dateText,
      showAttribution,
      pageMargin,
      showPageBorder,
      pageBorderColor,
      pageBorderWidth,
      mapBorderColor,
      mapBorderWidth,
      mapBackground,
      showColorbar,
      colorbarRamp,
      colorbarMin,
      colorbarMax,
      colorbarLabel,
      colorbarOrientation,
      colorbarPosition,
      colorbarLength,
      showCustomLegend,
      customLegendTitle,
      customLegendEntries,
      customLegendPosition,
      showInfoBlock,
      author,
      projectNumber,
      crs,
      revision,
      legend,
      legendConfig,
      captured,
      mapFit,
      t,
    ],
  );

  // Current representative fraction (1:N), and whether scale is meaningful for
  // the chosen page (only physical paper carries a true cartographic scale).
  const isMmPage = resolvePageSize(options).unit === "mm";
  const currentRatio = useMemo(() => computeScaleRatio(options), [options]);

  // Two-way scale sync: reflect the captured view's scale into the input unless
  // the user is actively editing it.
  useEffect(() => {
    if (!scaleFocusedRef.current) {
      setScaleDraft(currentRatio > 0 ? String(Math.round(currentRatio)) : "");
    }
  }, [currentRatio]);

  // Drive the live map to a target 1:N scale, then recapture. The reported
  // scale is linear in metres-per-pixel, which halves per zoom level, so the
  // zoom delta is log2(currentScale / targetScale).
  // A drawn extent fixes the ground area, so zooming would not reach the
  // requested denominator (it changes the crop size inversely); only allow
  // manual scale entry in viewport mode.
  const scaleEditable = Boolean(captured) && captureMode !== "extent";
  const applyScale = useCallback(
    (targetRatio: number) => {
      const map = mapControllerRef.current?.getMap();
      if (
        captureMode === "extent" ||
        !map ||
        !(targetRatio > 0) ||
        !(currentRatio > 0)
      ) {
        return;
      }
      const newZoom = map.getZoom() + Math.log2(currentRatio / targetRatio);
      // Clamp to the map's own zoom limits (not a fixed 0–24) so the out-of-range
      // notice reflects what this map can actually reach.
      const minZoom = map.getMinZoom();
      const maxZoom = map.getMaxZoom();
      const clampedZoom = Math.max(minZoom, Math.min(maxZoom, newZoom));
      // The requested scale needs a zoom past the map's limits, so it can only be
      // applied partially: surface that instead of letting the value snap back
      // with no explanation (GH #743). A reachable scale clears the notice.
      setScaleNotice(
        Math.abs(clampedZoom - newZoom) > 1e-3
          ? t("printLayout.errors.scaleOutOfRange")
          : null,
      );
      // Drop a still-pending idle handler / fallback timer from a prior applyScale
      // before registering new ones, so two quick scale changes don't both fire.
      if (idleRecaptureRef.current) {
        map.off("idle", idleRecaptureRef.current);
        idleRecaptureRef.current = null;
      }
      if (idleFallbackRef.current !== null) {
        window.clearTimeout(idleFallbackRef.current);
        idleFallbackRef.current = null;
      }
      // No effective zoom change (already at target, or clamped): MapLibre won't
      // emit an "idle", so recapture directly rather than registering a handler
      // that would never fire and could later fire on an unrelated render.
      if (Math.abs(clampedZoom - map.getZoom()) < 1e-6) {
        recapture(null);
        return;
      }
      map.setZoom(clampedZoom);
      // Recapture once the map is idle, so tiles for the new zoom have finished
      // loading and the snapshot is not blurry/blank mid-fetch. applyScale only
      // runs in viewport mode, so pin the recapture to a null clip. Use map.on
      // with manual self-removal (not map.once) so cancelling via map.off never
      // depends on MapLibre's internal once-wrapper. The ref lets a capture that
      // happens first (e.g. the user draws an extent while tiles load) cancel it.
      const handler = () => {
        map.off("idle", handler);
        idleRecaptureRef.current = null;
        if (idleFallbackRef.current !== null) {
          window.clearTimeout(idleFallbackRef.current);
          idleFallbackRef.current = null;
        }
        recapture(null);
      };
      idleRecaptureRef.current = handler;
      map.on("idle", handler);
      // Fallback: if "idle" is delayed or never arrives (some browsers throttle
      // the occluded map canvas behind this dialog, so the zoom never settles and
      // the scale would appear to silently do nothing), force the recapture after
      // a short grace period. GH #743.
      idleFallbackRef.current = window.setTimeout(() => {
        idleFallbackRef.current = null;
        if (idleRecaptureRef.current) {
          map.off("idle", idleRecaptureRef.current);
          idleRecaptureRef.current = null;
          recapture(null);
        }
      }, 1500);
    },
    [mapControllerRef, captureMode, currentRatio, recapture, t],
  );

  // Hide the dialog so the map is interactive, let the user drag an extent box,
  // then reopen with the new extent active.
  const handleDrawExtent = useCallback(async () => {
    const map = mapControllerRef.current?.getMap();
    if (!map) return;
    const page = resolvePageSize(options);
    const aspect = page.width / page.height;
    const controller = new AbortController();
    drawAbortRef.current = controller;
    drawingRef.current = true;
    setDrawingExtent(true);
    onOpenChange(false);
    try {
      const extent = await drawPrintExtent(map, {
        aspect,
        signal: controller.signal,
      });
      // Aborted means the dialog unmounted mid-draw: do not touch state.
      if (controller.signal.aborted) return;
      if (extent) {
        setExtentBbox(extent);
        setCaptureMode("extent");
        recapture(extent);
      } else if (extentBbox) {
        // Cancelled drag: drop the half-drawn preview back to the prior extent.
        showPrintExtent(map, extentBbox);
      } else {
        clearPrintExtent(map);
      }
    } finally {
      if (drawAbortRef.current === controller) drawAbortRef.current = null;
      if (!controller.signal.aborted) {
        drawingRef.current = false;
        setDrawingExtent(false);
        onOpenChange(true);
      }
    }
  }, [mapControllerRef, options, onOpenChange, recapture, extentBbox]);

  const handleClearExtent = useCallback(() => {
    const map = mapControllerRef.current?.getMap();
    if (map) clearPrintExtent(map);
    setExtentBbox(null);
    setCaptureMode("viewport");
    recapture(null);
  }, [mapControllerRef, recapture]);

  const setMode = useCallback(
    (mode: "viewport" | "extent") => {
      if (mode === captureMode) return;
      // The scale control is disabled in extent mode, so a stale out-of-range
      // notice from a viewport scale attempt must not linger (GH #743).
      if (mode === "extent") setScaleNotice(null);
      setCaptureMode(mode);
      recapture(mode === "extent" ? extentBbox : null);
    },
    [recapture, extentBbox, captureMode],
  );

  // Redraw the preview whenever the layout options change, sizing the canvas to
  // fill the preview pane (so it grows when the dialog is resized) while keeping
  // the page aspect ratio. Drawing is scheduled on an animation frame and
  // retries until the canvas exists: the dialog mounts its content in a portal,
  // so the first effect pass can run before the canvas is committed -- without
  // the retry the preview stayed blank until "Recapture map" (GH #521). A
  // ResizeObserver re-renders when the pane resizes (e.g. dragging the splitter
  // or the dialog grip).
  useEffect(() => {
    if (!open) return;
    let raf = 0;
    let retries = 0;
    let observer: ResizeObserver | null = null;
    const render = () => {
      raf = 0;
      const canvas = previewRef.current;
      const box = previewBoxRef.current;
      if (!canvas || !box) {
        if (retries++ < 20) raf = requestAnimationFrame(render);
        return;
      }
      const size = resolvePageSize(options);
      const aspect = size.width / size.height;
      // Available space inside the pane (p-3 padding = 12px each side).
      const availW = Math.max(1, box.clientWidth - 24);
      const availH = Math.max(1, box.clientHeight - 24);
      let dispW = availW;
      let dispH = availW / aspect;
      if (dispH > availH) {
        dispH = availH;
        dispW = availH * aspect;
      }
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.max(1, Math.round(dispW * dpr));
      canvas.height = Math.max(1, Math.round(dispH * dpr));
      canvas.style.width = `${Math.round(dispW)}px`;
      canvas.style.height = `${Math.round(dispH)}px`;
      drawLayout(canvas, options);
      if (!observer) {
        // Coalesce resize-driven re-renders to one drawLayout per frame so a
        // fast splitter/grip drag doesn't run the draw synchronously per event.
        observer = new ResizeObserver(() => {
          if (raf) return;
          raf = requestAnimationFrame(() => {
            raf = 0;
            render();
          });
        });
        observer.observe(box);
      }
    };
    raf = requestAnimationFrame(render);
    return () => {
      cancelAnimationFrame(raf);
      observer?.disconnect();
    };
  }, [open, options]);

  // Copy the composed layout to the clipboard as a PNG, so it can be pasted
  // straight into a document without saving a file first (GH #773).
  const handleCopy = async () => {
    if (!captured) {
      setError(t("printLayout.errors.captureFirst"));
      return;
    }
    setExporting(true);
    setError(null);
    try {
      await copyLayoutToClipboard(options);
      setCopied(true);
      if (copiedTimeoutRef.current !== null) {
        window.clearTimeout(copiedTimeoutRef.current);
      }
      copiedTimeoutRef.current = window.setTimeout(() => {
        setCopied(false);
        copiedTimeoutRef.current = null;
      }, 2000);
    } catch {
      setError(t("printLayout.errors.clipboardFailed"));
    } finally {
      setExporting(false);
    }
  };

  const handleExport = async (kind: "png" | "pdf") => {
    if (!captured) {
      setError(t("printLayout.errors.captureFirst"));
      return;
    }
    setExporting(true);
    setError(null);
    try {
      const base = sanitizeFilename(title || projectName || "map-layout");
      if (kind === "png") {
        await exportLayoutPng(options, `${base}.png`);
      } else {
        await exportLayoutPdf(options, `${base}.pdf`);
      }
    } catch {
      setError(t("printLayout.errors.exportFailed", { format: kind.toUpperCase() }));
    } finally {
      setExporting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        ref={dialogRef}
        className="max-w-5xl"
        style={
          dialogSize
            ? {
                width: dialogSize.width,
                height: dialogSize.height,
                maxWidth: "none",
              }
            : undefined
        }
        bodyClassName={
          dialogSize
            ? "flex min-h-0 flex-1 flex-col gap-4 overflow-hidden p-4 sm:p-6"
            : undefined
        }
        resizeHandle={
          <div
            role="separator"
            aria-label={t("printLayout.resizeDialog")}
            onPointerDown={startDialogResize}
            className="absolute bottom-0 right-0 z-10 hidden h-5 w-5 cursor-nwse-resize touch-none select-none text-muted-foreground hover:text-foreground md:block"
            title={t("printLayout.resizeDialog")}
          >
            <svg viewBox="0 0 16 16" className="h-full w-full" aria-hidden="true">
              <path
                d="M11 15L15 11M6 15L15 6"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
              />
            </svg>
          </div>
        }
      >
        <DialogHeader>
          <DialogTitle>{t("printLayout.title")}</DialogTitle>
          <DialogDescription>{t("printLayout.description")}</DialogDescription>
        </DialogHeader>

        <div
          className={`grid min-h-0 grid-cols-1 gap-6 md:gap-2 md:[grid-template-columns:var(--pl-cols)] ${
            dialogSize ? "flex-1" : ""
          }`}
          style={
            {
              "--pl-cols": `${controlsWidth}px 10px minmax(0,1fr)`,
            } as React.CSSProperties
          }
        >
          {/* Controls */}
          <div
            className={`min-w-0 space-y-4 overflow-y-auto pr-1 ${
              dialogSize ? "h-full" : "max-h-[60vh]"
            }`}
          >
            <div className="space-y-1.5">
              <Label htmlFor="layout-title">{t("printLayout.titleLabel")}</Label>
              <Input
                id="layout-title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder={t("printLayout.titlePlaceholder")}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="layout-subtitle">
                {t("printLayout.subtitleLabel")}
              </Label>
              <Input
                id="layout-subtitle"
                value={subtitle}
                onChange={(e) => setSubtitle(e.target.value)}
                placeholder={t("printLayout.subtitlePlaceholder")}
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="layout-title-placement">
                  {t("printLayout.titlePlacement")}
                </Label>
                <Select
                  id="layout-title-placement"
                  value={titlePlacement}
                  onChange={(e) =>
                    setTitlePlacement(e.target.value as "outside" | "inside")
                  }
                >
                  <option value="outside">
                    {t("printLayout.placement.outside")}
                  </option>
                  <option value="inside">
                    {t("printLayout.placement.inside")}
                  </option>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="layout-title-align">
                  {t("printLayout.alignment")}
                </Label>
                <Select
                  id="layout-title-align"
                  value={titleAlign}
                  onChange={(e) =>
                    setTitleAlign(e.target.value as "left" | "center" | "right")
                  }
                >
                  <option value="left">{t("printLayout.align.left")}</option>
                  <option value="center">{t("printLayout.align.center")}</option>
                  <option value="right">{t("printLayout.align.right")}</option>
                </Select>
              </div>
            </div>

            <Separator />

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="layout-paper">{t("printLayout.size")}</Label>
                <Select
                  id="layout-paper"
                  value={paperSize}
                  onChange={(e) => setPaperSize(e.target.value as PaperSizeId)}
                >
                  <optgroup label={t("printLayout.sizeGroup.paper")}>
                    {paperOptions.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.label}
                      </option>
                    ))}
                  </optgroup>
                  <optgroup label={t("printLayout.sizeGroup.screen")}>
                    {screenOptions.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.label}
                      </option>
                    ))}
                  </optgroup>
                  <option value="custom">{t("printLayout.sizeCustom")}</option>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="layout-orientation">
                  {t("printLayout.orientation")}
                </Label>
                <Select
                  id="layout-orientation"
                  value={orientation}
                  disabled={isCustom}
                  onChange={(e) =>
                    setOrientation(e.target.value as Orientation)
                  }
                >
                  <option value="portrait">{t("printLayout.portrait")}</option>
                  <option value="landscape">{t("printLayout.landscape")}</option>
                </Select>
              </div>
            </div>

            {isCustom && (
              <div className="grid grid-cols-3 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="layout-custom-w">
                    {t("printLayout.width")}
                  </Label>
                  <Input
                    id="layout-custom-w"
                    type="number"
                    min={1}
                    value={customWidth}
                    onChange={(e) =>
                      setCustomWidth(Math.max(1, Number(e.target.value) || 0))
                    }
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="layout-custom-h">
                    {t("printLayout.height")}
                  </Label>
                  <Input
                    id="layout-custom-h"
                    type="number"
                    min={1}
                    value={customHeight}
                    onChange={(e) =>
                      setCustomHeight(Math.max(1, Number(e.target.value) || 0))
                    }
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="layout-custom-unit" className="sr-only">
                    {t("printLayout.unit")}
                  </Label>
                  <span aria-hidden="true" className="block h-5">
                    &nbsp;
                  </span>
                  <Select
                    id="layout-custom-unit"
                    aria-label={t("printLayout.unit")}
                    value={customUnit}
                    onChange={(e) => setCustomUnit(e.target.value as SizeUnit)}
                  >
                    <option value="px">px</option>
                    <option value="mm">mm</option>
                  </Select>
                </div>
              </div>
            )}

            <div className="space-y-1.5">
              <Label htmlFor="layout-margin">{t("printLayout.margin")}</Label>
              <Select
                id="layout-margin"
                value={pageMargin}
                onChange={(e) =>
                  setPageMargin(e.target.value as "normal" | "narrow" | "none")
                }
              >
                <option value="normal">
                  {t("printLayout.marginOption.normal")}
                </option>
                <option value="narrow">
                  {t("printLayout.marginOption.narrow")}
                </option>
                <option value="none">
                  {t("printLayout.marginOption.none")}
                </option>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="layout-map-bg">
                {t("printLayout.mapBackground")}
              </Label>
              <div className="flex items-center gap-2">
                <input
                  id="layout-map-bg"
                  type="color"
                  className="h-9 w-12 shrink-0 cursor-pointer rounded-md border border-input bg-background"
                  value={mapBackground}
                  onChange={(e) => commitMapBackground(e.target.value)}
                />
                <Input
                  aria-label={t("printLayout.mapBackground")}
                  className="flex-1"
                  value={mapBackgroundDraft}
                  onChange={(e) => commitMapBackground(e.target.value)}
                />
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => commitMapBackground("#e5e7eb")}
                >
                  {t("common.reset")}
                </Button>
              </div>
            </div>

            {/* Map frame border (color + thickness; 0 hides it). GH #749. */}
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="layout-map-border-color">
                  {t("printLayout.mapBorderColor")}
                </Label>
                <input
                  id="layout-map-border-color"
                  type="color"
                  className="h-9 w-full cursor-pointer rounded-md border border-input bg-background"
                  value={mapBorderColor}
                  onChange={(e) => setMapBorderColor(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="layout-map-border-width">
                  {t("printLayout.mapBorderWidth")}
                </Label>
                <Input
                  id="layout-map-border-width"
                  type="number"
                  min={0}
                  max={10}
                  value={mapBorderWidth}
                  onChange={(e) =>
                    setMapBorderWidth(
                      Math.max(0, Math.min(10, Number(e.target.value) || 0)),
                    )
                  }
                />
              </div>
            </div>

            {isMmPage && (
              <div className="space-y-1.5">
                <Label htmlFor="layout-scale">
                  {t("printLayout.scaleLabel")}
                </Label>
                <div className="flex items-center gap-2">
                  <span className="text-sm text-muted-foreground">1:</span>
                  <Input
                    id="layout-scale"
                    inputMode="numeric"
                    className="flex-1"
                    value={scaleDraft}
                    disabled={!scaleEditable}
                    placeholder={t("printLayout.scalePlaceholder")}
                    onFocus={() => {
                      scaleFocusedRef.current = true;
                    }}
                    onChange={(e) =>
                      setScaleDraft(e.target.value.replace(/[^0-9]/g, ""))
                    }
                    onBlur={() => {
                      scaleFocusedRef.current = false;
                      const n = Number(scaleDraft);
                      if (n > 0) applyScale(n);
                      else
                        setScaleDraft(
                          currentRatio > 0
                            ? String(Math.round(currentRatio))
                            : "",
                        );
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter")
                        (e.target as HTMLInputElement).blur();
                    }}
                  />
                  <Select
                    aria-label={t("printLayout.scalePresetsAria")}
                    value=""
                    disabled={!scaleEditable}
                    onChange={(e) => {
                      const n = Number(e.target.value);
                      if (n > 0) applyScale(n);
                    }}
                  >
                    <option value="">{t("printLayout.scalePresets")}</option>
                    {SCALE_PRESETS.map((n) => (
                      <option key={n} value={n}>
                        1:{n.toLocaleString()}
                      </option>
                    ))}
                  </Select>
                </div>
                {scaleNotice && (
                  <p className="text-xs text-destructive">{scaleNotice}</p>
                )}
              </div>
            )}

            <div className="space-y-1.5">
              <Label>{t("printLayout.extent.label")}</Label>
              <Button
                variant="outline"
                size="sm"
                className="w-full"
                disabled={drawingExtent}
                onClick={() => void handleDrawExtent()}
              >
                <Crop className="mr-2 h-4 w-4" />
                {extentBbox
                  ? t("printLayout.extent.redraw")
                  : t("printLayout.extent.draw")}
              </Button>
              {extentBbox && (
                <div className="space-y-1.5 pt-1">
                  <fieldset className="m-0 space-y-1.5 border-0 p-0">
                    <legend className="sr-only">
                      {t("printLayout.extent.label")}
                    </legend>
                    <label className="flex cursor-pointer items-center gap-2 text-sm">
                      <input
                        type="radio"
                        name="capture-mode"
                        className="h-4 w-4 accent-primary"
                        checked={captureMode === "viewport"}
                        onChange={() => setMode("viewport")}
                      />
                      {t("printLayout.extent.useViewport")}
                    </label>
                    <label className="flex cursor-pointer items-center gap-2 text-sm">
                      <input
                        type="radio"
                        name="capture-mode"
                        className="h-4 w-4 accent-primary"
                        checked={captureMode === "extent"}
                        onChange={() => setMode("extent")}
                      />
                      {t("printLayout.extent.useCustom")}
                    </label>
                  </fieldset>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={handleClearExtent}
                  >
                    <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
                    {t("printLayout.extent.clear")}
                  </Button>
                </div>
              )}
              <p className="text-xs text-muted-foreground">
                {t("printLayout.extent.hint")}
              </p>
            </div>

            <Separator />

            <div className="space-y-2">
              <p className="text-sm font-medium">
                {t("printLayout.mapElements")}
              </p>
              <ToggleField
                id="el-title"
                label={t("printLayout.element.title")}
                checked={showTitle}
                onChange={setShowTitle}
              />
              <ToggleField
                id="el-subtitle"
                label={t("printLayout.element.subtitle")}
                checked={showSubtitle}
                onChange={setShowSubtitle}
              />
              <ToggleField
                id="el-legend"
                label={t("printLayout.element.legend")}
                checked={showLegend}
                onChange={setShowLegend}
              />
              <ToggleField
                id="el-scale"
                label={t("printLayout.element.scaleBar")}
                checked={showScaleBar}
                onChange={setShowScaleBar}
              />
              <ToggleField
                id="el-north"
                label={t("printLayout.element.northArrow")}
                checked={showNorthArrow}
                onChange={setShowNorthArrow}
              />
              {showScaleBar && showNorthArrow && (
                <ToggleField
                  id="el-nav-group"
                  label={t("printLayout.element.groupNavigation")}
                  checked={navigationGrouped}
                  onChange={setNavigationGrouped}
                />
              )}
              <ToggleField
                id="el-date"
                label={t("printLayout.element.date")}
                checked={showDate}
                onChange={setShowDate}
              />
              <ToggleField
                id="el-attribution"
                label={t("printLayout.element.attribution")}
                checked={showAttribution}
                onChange={setShowAttribution}
              />
              <ToggleField
                id="el-footer"
                label={t("printLayout.element.footer")}
                checked={showFooter}
                onChange={setShowFooter}
              />
              <ToggleField
                id="el-border"
                label={t("printLayout.element.pageBorder")}
                checked={showPageBorder}
                onChange={setShowPageBorder}
              />
              <ToggleField
                id="el-info-block"
                label={t("printLayout.element.infoBlock")}
                checked={showInfoBlock}
                onChange={setShowInfoBlock}
              />
              <ToggleField
                id="el-colorbar"
                label={t("printLayout.element.colorbar")}
                checked={showColorbar}
                onChange={setShowColorbar}
              />
              <ToggleField
                id="el-custom-legend"
                label={t("printLayout.element.customLegend")}
                checked={showCustomLegend}
                onChange={setShowCustomLegend}
              />
            </div>

            {showCustomLegend && (
              <div className="space-y-3 rounded-md border p-3">
                <div className="space-y-1.5">
                  <Label htmlFor="cl-title">
                    {t("printLayout.customLegend.title")}
                  </Label>
                  <Input
                    id="cl-title"
                    value={customLegendTitle}
                    placeholder={t("printLayout.legend.defaultTitle")}
                    onChange={(e) => setCustomLegendTitle(e.target.value)}
                  />
                </div>
                <div className="space-y-1.5">
                  {customLegendEntries.map((entry) => (
                    <div key={entry.id} className="flex items-center gap-2">
                      <input
                        type="color"
                        aria-label={t("printLayout.customLegend.color")}
                        className="h-8 w-9 shrink-0 cursor-pointer rounded-md border border-input bg-background"
                        value={entry.color}
                        onChange={(e) =>
                          setCustomLegendEntries((prev) =>
                            prev.map((x) =>
                              x.id === entry.id
                                ? { ...x, color: e.target.value }
                                : x,
                            ),
                          )
                        }
                      />
                      <Input
                        className="h-8 flex-1 text-sm"
                        value={entry.label}
                        placeholder={t("printLayout.customLegend.itemLabel")}
                        onChange={(e) =>
                          setCustomLegendEntries((prev) =>
                            prev.map((x) =>
                              x.id === entry.id
                                ? { ...x, label: e.target.value }
                                : x,
                            ),
                          )
                        }
                      />
                      <button
                        type="button"
                        aria-label={t("printLayout.customLegend.removeItem")}
                        className="shrink-0 text-muted-foreground hover:text-foreground"
                        onClick={() =>
                          setCustomLegendEntries((prev) =>
                            prev.filter((x) => x.id !== entry.id),
                          )
                        }
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  ))}
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() =>
                      setCustomLegendEntries((prev) => [
                        ...prev,
                        {
                          id: `cl-${++customLegendId.current}`,
                          label: "",
                          color: "#888888",
                        },
                      ])
                    }
                  >
                    <Plus className="mr-1.5 h-3.5 w-3.5" />
                    {t("printLayout.customLegend.addItem")}
                  </Button>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="cl-position">
                    {t("printLayout.customLegend.position")}
                  </Label>
                  <Select
                    id="cl-position"
                    value={customLegendPosition}
                    onChange={(e) =>
                      setCustomLegendPosition(
                        e.target.value as typeof customLegendPosition,
                      )
                    }
                  >
                    <option value="top-left">
                      {t("printLayout.position.topLeft")}
                    </option>
                    <option value="top-right">
                      {t("printLayout.position.topRight")}
                    </option>
                    <option value="bottom-left">
                      {t("printLayout.position.bottomLeft")}
                    </option>
                    <option value="bottom-right">
                      {t("printLayout.position.bottomRight")}
                    </option>
                  </Select>
                </div>
                <Separator />
                <div className="space-y-1.5">
                  <Label htmlFor="cl-dict">
                    {t("printLayout.customLegend.importFromDict")}
                  </Label>
                  <Textarea
                    id="cl-dict"
                    rows={3}
                    className="font-mono text-xs"
                    value={legendDict}
                    placeholder={'{"Label A": "#ff6b6b", "Label B": "#4ecdc4"}'}
                    onChange={(e) => setLegendDict(e.target.value)}
                  />
                  {legendDictError && (
                    <p className="text-xs text-destructive">
                      {legendDictError}
                    </p>
                  )}
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!legendDict.trim()}
                    onClick={importLegendDict}
                  >
                    {t("printLayout.customLegend.import")}
                  </Button>
                </div>
              </div>
            )}

            {showColorbar && (
              <div className="space-y-3 rounded-md border p-3">
                <div className="space-y-1.5">
                  <Label htmlFor="cb-ramp">
                    {t("printLayout.colorbar.colormap")}
                  </Label>
                  <Select
                    id="cb-ramp"
                    value={colorbarRamp}
                    onChange={(e) => setColorbarRamp(e.target.value)}
                  >
                    {VECTOR_COLOR_RAMPS.map((r) => (
                      <option key={r.value} value={r.value}>
                        {r.label}
                      </option>
                    ))}
                  </Select>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <Label htmlFor="cb-min">
                      {t("printLayout.colorbar.min")}
                    </Label>
                    <Input
                      id="cb-min"
                      type="number"
                      value={colorbarMin}
                      onChange={(e) => setColorbarMin(e.target.value)}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="cb-max">
                      {t("printLayout.colorbar.max")}
                    </Label>
                    <Input
                      id="cb-max"
                      type="number"
                      value={colorbarMax}
                      onChange={(e) => setColorbarMax(e.target.value)}
                    />
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="cb-label">
                    {t("printLayout.colorbar.label")}
                  </Label>
                  <Input
                    id="cb-label"
                    value={colorbarLabel}
                    placeholder={t("printLayout.colorbar.labelPlaceholder")}
                    onChange={(e) => setColorbarLabel(e.target.value)}
                  />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <Label htmlFor="cb-orientation">
                      {t("printLayout.colorbar.orientation")}
                    </Label>
                    <Select
                      id="cb-orientation"
                      value={colorbarOrientation}
                      onChange={(e) =>
                        setColorbarOrientation(
                          e.target.value as "vertical" | "horizontal",
                        )
                      }
                    >
                      <option value="vertical">
                        {t("printLayout.colorbar.vertical")}
                      </option>
                      <option value="horizontal">
                        {t("printLayout.colorbar.horizontal")}
                      </option>
                    </Select>
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="cb-position">
                      {t("printLayout.colorbar.position")}
                    </Label>
                    <Select
                      id="cb-position"
                      value={colorbarPosition}
                      onChange={(e) =>
                        setColorbarPosition(
                          e.target.value as typeof colorbarPosition,
                        )
                      }
                    >
                      <option value="top-left">
                        {t("printLayout.position.topLeft")}
                      </option>
                      <option value="top-right">
                        {t("printLayout.position.topRight")}
                      </option>
                      <option value="bottom-left">
                        {t("printLayout.position.bottomLeft")}
                      </option>
                      <option value="bottom-right">
                        {t("printLayout.position.bottomRight")}
                      </option>
                    </Select>
                  </div>
                </div>
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <Label htmlFor="cb-length">
                      {t("printLayout.colorbar.length")}
                    </Label>
                    <span className="text-sm tabular-nums text-muted-foreground">
                      {colorbarLength}%
                    </span>
                  </div>
                  <Slider
                    id="cb-length"
                    aria-label={t("printLayout.colorbar.length")}
                    min={5}
                    max={95}
                    step={1}
                    value={[colorbarLength]}
                    onValueChange={(v: number[]) => setColorbarLength(v[0])}
                  />
                </div>
              </div>
            )}

            {showFooter && (
              <div className="space-y-1.5">
                <Label htmlFor="layout-footer">
                  {t("printLayout.footerTextLabel")}
                </Label>
                <Input
                  id="layout-footer"
                  value={footerText}
                  placeholder={t("printLayout.footerPlaceholder")}
                  onChange={(e) => setFooterText(e.target.value)}
                />
              </div>
            )}

            {showPageBorder && (
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="layout-border-color">
                    {t("printLayout.borderColor")}
                  </Label>
                  <input
                    id="layout-border-color"
                    type="color"
                    className="h-9 w-full cursor-pointer rounded-md border border-input bg-background"
                    value={pageBorderColor}
                    onChange={(e) => setPageBorderColor(e.target.value)}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="layout-border-width">
                    {t("printLayout.borderWidth")}
                  </Label>
                  <Input
                    id="layout-border-width"
                    type="number"
                    min={1}
                    max={10}
                    value={pageBorderWidth}
                    onChange={(e) =>
                      setPageBorderWidth(
                        Math.max(1, Math.min(10, Number(e.target.value) || 1)),
                      )
                    }
                  />
                </div>
              </div>
            )}

            {showInfoBlock && (
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="layout-author">
                    {t("printLayout.info.author")}
                  </Label>
                  <Input
                    id="layout-author"
                    value={author}
                    placeholder={t("printLayout.info.authorPlaceholder")}
                    onChange={(e) => setAuthor(e.target.value)}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="layout-project">
                    {t("printLayout.info.project")}
                  </Label>
                  <Input
                    id="layout-project"
                    value={projectNumber}
                    placeholder={t("printLayout.info.projectPlaceholder")}
                    onChange={(e) => setProjectNumber(e.target.value)}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="layout-crs">
                    {t("printLayout.info.crs")}
                  </Label>
                  <Input
                    id="layout-crs"
                    value={crs}
                    placeholder={t("printLayout.info.crsPlaceholder")}
                    onChange={(e) => setCrs(e.target.value)}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="layout-revision">
                    {t("printLayout.info.revision")}
                  </Label>
                  <Input
                    id="layout-revision"
                    value={revision}
                    placeholder={t("printLayout.info.revisionPlaceholder")}
                    onChange={(e) => setRevision(e.target.value)}
                  />
                </div>
              </div>
            )}

            {showLegend && (
              <>
                <Separator />
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <p className="text-sm font-medium">
                      {t("printLayout.legend.section")}
                    </p>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() =>
                        setLegendConfig({ ...DEFAULT_LEGEND_CONFIG })
                      }
                    >
                      <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
                      {t("common.reset")}
                    </Button>
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="legend-title">
                      {t("printLayout.legend.titleLabel")}
                    </Label>
                    <Input
                      id="legend-title"
                      value={legendConfig.title}
                      placeholder={t("printLayout.legend.defaultTitle")}
                      onChange={(e) =>
                        setLegendConfig({
                          ...legendConfig,
                          title: e.target.value,
                        })
                      }
                    />
                  </div>
                  <ToggleField
                    id="legend-group"
                    label={t("printLayout.legend.groupByLayer")}
                    checked={legendConfig.groupByLayer}
                    onChange={(next) =>
                      setLegendConfig({ ...legendConfig, groupByLayer: next })
                    }
                  />

                  {editorRows.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                      {t("printLayout.legend.empty")}
                    </p>
                  ) : (
                    <div className="max-h-56 space-y-1 overflow-auto rounded-md border p-2">
                      {editorRows.map((row) => {
                        const entryIndex = entryIdsInOrder.indexOf(row.layerId);
                        return (
                          <div
                            key={row.key}
                            className={`flex items-center gap-1.5 ${
                              row.kind === "class" ? "pl-5" : ""
                            } ${row.hidden ? "opacity-50" : ""}`}
                          >
                            {row.kind === "entry" ? (
                              <div className="flex flex-col">
                                <button
                                  type="button"
                                  aria-label={t("printLayout.legend.moveUp")}
                                  className="text-muted-foreground hover:text-foreground disabled:opacity-30"
                                  disabled={entryIndex <= 0}
                                  onClick={() => moveEntry(row.layerId, "up")}
                                >
                                  <ArrowUp className="h-3 w-3" />
                                </button>
                                <button
                                  type="button"
                                  aria-label={t("printLayout.legend.moveDown")}
                                  className="text-muted-foreground hover:text-foreground disabled:opacity-30"
                                  disabled={
                                    entryIndex >= entryIdsInOrder.length - 1
                                  }
                                  onClick={() => moveEntry(row.layerId, "down")}
                                >
                                  <ArrowDown className="h-3 w-3" />
                                </button>
                              </div>
                            ) : (
                              <span className="w-3 shrink-0" />
                            )}
                            {row.color ? (
                              <span
                                className="h-3.5 w-3.5 shrink-0 rounded-sm border"
                                style={{ backgroundColor: row.color }}
                              />
                            ) : (
                              <span className="w-3.5 shrink-0" />
                            )}
                            <Input
                              className="h-7 flex-1 text-sm"
                              value={row.label}
                              placeholder={
                                row.defaultLabel ||
                                t("printLayout.legend.labelPlaceholder")
                              }
                              onChange={(e) =>
                                setLegendConfig(
                                  setLegendItemLabel(
                                    legendConfig,
                                    row.key,
                                    e.target.value,
                                    row.defaultLabel,
                                  ),
                                )
                              }
                            />
                            <button
                              type="button"
                              aria-label={
                                row.hidden
                                  ? t("printLayout.legend.showEntry")
                                  : t("printLayout.legend.hideEntry")
                              }
                              className="shrink-0 text-muted-foreground hover:text-foreground"
                              onClick={() =>
                                setLegendConfig(
                                  toggleLegendItemHidden(legendConfig, row.key),
                                )
                              }
                            >
                              {row.hidden ? (
                                <EyeOff className="h-4 w-4" />
                              ) : (
                                <Eye className="h-4 w-4" />
                              )}
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </>
            )}
          </div>

          {/* Splitter between the controls and the preview */}
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label={t("printLayout.resizeControls")}
            aria-valuenow={Math.round(controlsWidth)}
            aria-valuemin={CONTROLS_MIN_WIDTH}
            aria-valuemax={CONTROLS_MAX_WIDTH}
            tabIndex={0}
            className="group relative hidden cursor-col-resize touch-none select-none focus:outline-none focus-visible:ring-2 focus-visible:ring-ring md:block"
            onPointerDown={startSplitterResize}
            onKeyDown={(e) => {
              const step = e.shiftKey ? 32 : 8;
              if (e.key === "ArrowLeft") {
                e.preventDefault();
                setControlsWidth((w) => Math.max(CONTROLS_MIN_WIDTH, w - step));
              } else if (e.key === "ArrowRight") {
                e.preventDefault();
                setControlsWidth((w) => Math.min(CONTROLS_MAX_WIDTH, w + step));
              }
            }}
          >
            <div className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-border transition-colors group-hover:bg-primary" />
          </div>

          {/* Preview */}
          <div
            className={`flex min-w-0 flex-col items-center justify-start gap-3 ${
              dialogSize ? "h-full min-h-0" : ""
            }`}
          >
            <div className="flex w-full items-center justify-between">
              <span className="text-sm text-muted-foreground">
                {t("printLayout.preview")}
              </span>
              <Button variant="ghost" size="sm" onClick={() => recapture()}>
                <RefreshCw className="mr-2 h-3.5 w-3.5" />
                {t("printLayout.recapture")}
              </Button>
            </div>
            {/* Fit the whole page in view: the canvas scales down to honour both
                max constraints without ever showing a scrollbar (GH #520). */}
            <div
              ref={previewBoxRef}
              className={`flex w-full items-center justify-center overflow-hidden rounded-md border bg-muted/30 p-3 ${
                dialogSize ? "min-h-0 flex-1" : "h-[min(60vh,460px)]"
              }`}
            >
              {/* The canvas width/height (backing + CSS) are set imperatively in
                  the draw effect to fit this pane, so it scales with the dialog. */}
              <canvas
                ref={previewRef}
                className="shadow-md"
                style={{ imageRendering: "auto" }}
              />
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 pt-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t("common.close")}
          </Button>
          {/* Copy the composed layout straight to the clipboard (GH #773). */}
          <Button
            variant="outline"
            disabled={exporting || !captured}
            onClick={() => void handleCopy()}
          >
            {copied ? (
              <Check className="mr-2 h-4 w-4" />
            ) : (
              <ClipboardCopy className="mr-2 h-4 w-4" />
            )}
            {copied
              ? t("printLayout.copied")
              : t("printLayout.copyToClipboard")}
          </Button>
          {/* Equal-weight export buttons: neither format is the "primary" one
              (GH #520). */}
          <Button
            variant="outline"
            disabled={exporting || !captured}
            onClick={() => void handleExport("png")}
          >
            <FileImage className="mr-2 h-4 w-4" />
            {t("printLayout.exportPng")}
          </Button>
          <Button
            variant="outline"
            disabled={exporting || !captured}
            onClick={() => void handleExport("pdf")}
          >
            <FileText className="mr-2 h-4 w-4" />
            {t("printLayout.exportPdf")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
