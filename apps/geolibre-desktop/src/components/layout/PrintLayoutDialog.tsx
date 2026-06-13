import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAppStore } from "@geolibre/core";
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
import { FileImage, FileText, RefreshCw } from "lucide-react";
import {
  drawLayout,
  pageDimensionsMm,
  PAPER_SIZES,
  type LayoutOptions,
  type Orientation,
  type PaperSizeId,
} from "../../lib/print-layout";
import {
  buildLegend,
  captureMapImage,
  exportLayoutPdf,
  exportLayoutPng,
  type CapturedMap,
} from "../../lib/print-layout-export";

interface PrintLayoutDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mapControllerRef: React.RefObject<MapController | null>;
}

const PREVIEW_LONG_EDGE = 560;

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
 * size, then exports the result to PNG or PDF.
 */
export function PrintLayoutDialog({
  open,
  onOpenChange,
  mapControllerRef,
}: PrintLayoutDialogProps) {
  const layers = useAppStore((s) => s.layers);
  const projectName = useAppStore((s) => s.projectName);

  const [title, setTitle] = useState("");
  const [subtitle, setSubtitle] = useState("");
  const [paperSize, setPaperSize] = useState<PaperSizeId>("a4");
  const [orientation, setOrientation] = useState<Orientation>("landscape");
  const [showTitle, setShowTitle] = useState(true);
  const [showLegend, setShowLegend] = useState(true);
  const [showScaleBar, setShowScaleBar] = useState(true);
  const [showNorthArrow, setShowNorthArrow] = useState(true);
  const [showFooter, setShowFooter] = useState(true);
  const [footerText, setFooterText] = useState("");
  const [captured, setCaptured] = useState<CapturedMap | null>(null);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const previewRef = useRef<HTMLCanvasElement | null>(null);
  const wasOpenRef = useRef(false);

  const legend = useMemo(() => buildLegend(layers), [layers]);

  const recapture = useCallback(() => {
    const map = mapControllerRef.current?.getMap();
    if (!map) {
      setError("Map is not ready yet. Try again in a moment.");
      setCaptured(null);
      return;
    }
    try {
      setCaptured(captureMapImage(map));
      setError(null);
    } catch {
      setError("Could not capture the map image.");
      setCaptured(null);
    }
  }, [mapControllerRef]);

  // Capture the map and seed defaults only on the closed -> open transition, so
  // a background project-name change while the dialog is open does not replace
  // the snapshot the user is composing.
  useEffect(() => {
    if (open && !wasOpenRef.current) {
      setError(null);
      setTitle((prev) => prev || (projectName ?? "").trim());
      setFooterText(
        (prev) =>
          prev || `Created with GeoLibre · ${new Date().toLocaleDateString()}`,
      );
      recapture();
    }
    wasOpenRef.current = open;
  }, [open, projectName, recapture]);

  const options = useMemo<LayoutOptions>(
    () => ({
      title,
      subtitle,
      paperSize,
      orientation,
      showTitle,
      showLegend,
      showScaleBar,
      showNorthArrow,
      showFooter,
      footerText,
      legend,
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
      showTitle,
      showLegend,
      showScaleBar,
      showNorthArrow,
      showFooter,
      footerText,
      legend,
      captured,
    ],
  );

  // Redraw the preview whenever the layout options change.
  useEffect(() => {
    if (!open) return;
    const canvas = previewRef.current;
    if (!canvas) return;
    const { widthMm, heightMm } = pageDimensionsMm(
      options.paperSize,
      options.orientation,
    );
    const aspect = widthMm / heightMm;
    const pw = aspect >= 1 ? PREVIEW_LONG_EDGE : Math.round(PREVIEW_LONG_EDGE * aspect);
    const ph = aspect >= 1 ? Math.round(PREVIEW_LONG_EDGE / aspect) : PREVIEW_LONG_EDGE;
    canvas.width = pw;
    canvas.height = ph;
    drawLayout(canvas, options);
  }, [open, options]);

  const handleExport = async (kind: "png" | "pdf") => {
    if (!captured) {
      setError("Capture the map before exporting.");
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
      setError(`Failed to export ${kind.toUpperCase()}.`);
    } finally {
      setExporting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-5xl">
        <DialogHeader>
          <DialogTitle>Print Layout</DialogTitle>
          <DialogDescription>
            Compose a print-ready map with a title, legend, scale bar, and north
            arrow, then export it to PNG or PDF.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-6 md:grid-cols-[320px_1fr]">
          {/* Controls */}
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="layout-title">Title</Label>
              <Input
                id="layout-title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Map title"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="layout-subtitle">Subtitle</Label>
              <Input
                id="layout-subtitle"
                value={subtitle}
                onChange={(e) => setSubtitle(e.target.value)}
                placeholder="Optional subtitle"
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="layout-paper">Paper size</Label>
                <Select
                  id="layout-paper"
                  value={paperSize}
                  onChange={(e) => setPaperSize(e.target.value as PaperSizeId)}
                >
                  {PAPER_SIZES.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label}
                    </option>
                  ))}
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="layout-orientation">Orientation</Label>
                <Select
                  id="layout-orientation"
                  value={orientation}
                  onChange={(e) =>
                    setOrientation(e.target.value as Orientation)
                  }
                >
                  <option value="portrait">Portrait</option>
                  <option value="landscape">Landscape</option>
                </Select>
              </div>
            </div>

            <Separator />

            <div className="space-y-2">
              <p className="text-sm font-medium">Map elements</p>
              <ToggleField
                id="el-title"
                label="Title block"
                checked={showTitle}
                onChange={setShowTitle}
              />
              <ToggleField
                id="el-legend"
                label="Legend"
                checked={showLegend}
                onChange={setShowLegend}
              />
              <ToggleField
                id="el-scale"
                label="Scale bar"
                checked={showScaleBar}
                onChange={setShowScaleBar}
              />
              <ToggleField
                id="el-north"
                label="North arrow"
                checked={showNorthArrow}
                onChange={setShowNorthArrow}
              />
              <ToggleField
                id="el-footer"
                label="Footer"
                checked={showFooter}
                onChange={setShowFooter}
              />
            </div>

            {showFooter && (
              <div className="space-y-1.5">
                <Label htmlFor="layout-footer">Footer text</Label>
                <Input
                  id="layout-footer"
                  value={footerText}
                  onChange={(e) => setFooterText(e.target.value)}
                />
              </div>
            )}
          </div>

          {/* Preview */}
          <div className="flex flex-col items-center justify-start gap-3">
            <div className="flex w-full items-center justify-between">
              <span className="text-sm text-muted-foreground">Preview</span>
              <Button variant="ghost" size="sm" onClick={recapture}>
                <RefreshCw className="mr-2 h-3.5 w-3.5" />
                Recapture map
              </Button>
            </div>
            <div className="flex max-h-[420px] w-full items-center justify-center overflow-auto rounded-md border bg-muted/30 p-3">
              <canvas
                ref={previewRef}
                className="max-w-full shadow-md"
                style={{ imageRendering: "auto" }}
              />
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 pt-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Close
          </Button>
          <Button
            variant="outline"
            disabled={exporting || !captured}
            onClick={() => void handleExport("png")}
          >
            <FileImage className="mr-2 h-4 w-4" />
            Export PNG
          </Button>
          <Button
            disabled={exporting || !captured}
            onClick={() => void handleExport("pdf")}
          >
            <FileText className="mr-2 h-4 w-4" />
            Export PDF
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
