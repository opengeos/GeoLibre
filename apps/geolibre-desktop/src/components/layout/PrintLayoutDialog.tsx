import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { DEFAULT_LEGEND_CONFIG, useAppStore } from "@geolibre/core";
import type { MapController } from "@geolibre/map";
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
} from "@geolibre/ui";
import {
  ArrowDown,
  ArrowUp,
  Crop,
  Eye,
  EyeOff,
  FileImage,
  FileText,
  RefreshCw,
  RotateCcw,
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

const PREVIEW_LONG_EDGE = 560;

/** Common industry scale denominators offered as quick presets (GH #522). */
const SCALE_PRESETS = [500, 1000, 2500, 5000, 10000, 25000, 50000, 100000];

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
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const previewRef = useRef<HTMLCanvasElement | null>(null);
  const wasOpenRef = useRef(false);
  // Set while the dialog is hidden to let the user draw on the map, so the
  // close handler does not tear down the in-progress extent box.
  const drawingRef = useRef(false);
  // Aborts an in-progress draw when the dialog unmounts mid-drag.
  const drawAbortRef = useRef<AbortController | null>(null);
  // True while the scale input has focus, so two-way sync does not overwrite
  // what the user is typing.
  const scaleFocusedRef = useRef(false);
  const [scaleDraft, setScaleDraft] = useState("");

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
      // An explicit override wins (used right after drawing, before state has
      // settled); otherwise clip to the stored extent only in extent mode.
      const clip =
        clipOverride !== undefined
          ? clipOverride
          : captureMode === "extent"
            ? extentBbox
            : null;
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
      const map = mapControllerRef.current?.getMap();
      if (map) clearPrintExtent(map);
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
      showInfoBlock,
      author,
      projectNumber,
      crs,
      revision,
      legend,
      legendConfig,
      captured,
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
  const applyScale = useCallback(
    (targetRatio: number) => {
      const map = mapControllerRef.current?.getMap();
      if (!map || !(targetRatio > 0) || !(currentRatio > 0)) return;
      const newZoom = map.getZoom() + Math.log2(currentRatio / targetRatio);
      map.setZoom(Math.max(0, Math.min(24, newZoom)));
      // Let the camera settle, then recapture so the scale label updates.
      requestAnimationFrame(() => recapture());
    },
    [mapControllerRef, currentRatio, recapture],
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
      }
    } finally {
      if (drawAbortRef.current === controller) drawAbortRef.current = null;
      if (!controller.signal.aborted) {
        drawingRef.current = false;
        setDrawingExtent(false);
        onOpenChange(true);
      }
    }
  }, [mapControllerRef, options, onOpenChange, recapture]);

  const handleClearExtent = useCallback(() => {
    const map = mapControllerRef.current?.getMap();
    if (map) clearPrintExtent(map);
    setExtentBbox(null);
    setCaptureMode("viewport");
    recapture(null);
  }, [mapControllerRef, recapture]);

  const setMode = useCallback(
    (mode: "viewport" | "extent") => {
      setCaptureMode(mode);
      recapture(mode === "extent" ? extentBbox : null);
    },
    [recapture, extentBbox],
  );

  // Redraw the preview whenever the layout options change. Drawing is scheduled
  // on an animation frame and retries until the canvas exists: the dialog mounts
  // its content in a portal, so on the open transition the first effect pass can
  // run before the canvas is committed -- without the retry the preview stayed
  // blank until the user clicked "Recapture map" (GH #521).
  useEffect(() => {
    if (!open) return;
    let raf = 0;
    // Cap the retries so a canvas that never attaches (e.g. a portal render
    // error) cannot spin the loop at ~60 fps until the next state change.
    let retries = 0;
    const draw = () => {
      const canvas = previewRef.current;
      if (!canvas) {
        if (retries++ < 20) raf = requestAnimationFrame(draw);
        return;
      }
      const size = resolvePageSize(options);
      const aspect = size.width / size.height;
      const pw =
        aspect >= 1 ? PREVIEW_LONG_EDGE : Math.round(PREVIEW_LONG_EDGE * aspect);
      const ph =
        aspect >= 1 ? Math.round(PREVIEW_LONG_EDGE / aspect) : PREVIEW_LONG_EDGE;
      canvas.width = pw;
      canvas.height = ph;
      drawLayout(canvas, options);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [open, options]);

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
      <DialogContent className="max-w-5xl">
        <DialogHeader>
          <DialogTitle>{t("printLayout.title")}</DialogTitle>
          <DialogDescription>{t("printLayout.description")}</DialogDescription>
        </DialogHeader>

        <div className="grid gap-6 md:grid-cols-[320px_1fr]">
          {/* Controls */}
          <div className="max-h-[60vh] space-y-4 overflow-y-auto pr-1">
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
                    disabled={!captured}
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
                    aria-label={t("printLayout.scalePresets")}
                    value=""
                    disabled={!captured}
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
            </div>

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

          {/* Preview */}
          <div className="flex flex-col items-center justify-start gap-3">
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
            <div className="flex w-full flex-1 items-center justify-center rounded-md border bg-muted/30 p-3">
              <canvas
                ref={previewRef}
                className="shadow-md"
                style={{
                  maxWidth: "100%",
                  maxHeight: "min(60vh, 460px)",
                  width: "auto",
                  height: "auto",
                  imageRendering: "auto",
                }}
              />
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 pt-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t("common.close")}
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
