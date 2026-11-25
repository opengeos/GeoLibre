import { getActiveEllipsoid } from "@geolibre/core";
import { useTranslation } from "react-i18next";
import { Button } from "@geolibre/ui";
import { Check, ClipboardCopy, FileImage, FileText } from "lucide-react";
import type { PrintLayoutUiState } from "./state";
import type { AtlasSeries } from "./useAtlasSeries";
import type { useExportActions } from "./useExportActions";

interface ExportActionsProps {
  ui: Pick<PrintLayoutUiState, "atlasProgress" | "atlasBusy" | "exporting" | "copied">;
  hasCapture: boolean;
  insetReady: boolean;
  insetNeedsLocation: boolean;
  /** Whether the capture carries a georeference, so the PDF is a GeoPDF. */
  georeferenced: boolean;
  /** The atlas setting, AND-ed with the renderer being able to drive it. */
  atlasEnabled: boolean;
  atlas: AtlasSeries;
  actions: ReturnType<typeof useExportActions>;
}

/** The dialog's footer: atlas progress, Close, Copy, and the export buttons. */
export function ExportActions({
  ui,
  hasCapture,
  insetReady,
  insetNeedsLocation,
  georeferenced,
  atlasEnabled,
  atlas,
  actions,
}: ExportActionsProps) {
  const { t } = useTranslation();
  const { atlasProgress, atlasBusy, exporting, copied } = ui;
  const { atlasActive, atlasConfigBlocked, atlasPageCount } = atlas;
  const {
    handleCopy,
    handleExport,
    handleAtlasExport,
    handleCancelAtlasExport,
    handleDialogOpenChange,
  } = actions;
  return (
    <div className="flex flex-wrap items-center justify-end gap-2 pt-2">
      {hasCapture && !insetReady && insetNeedsLocation && (
        <span role="status" className="me-auto text-sm text-muted-foreground">
          {t("printLayout.inset.needsLocation")}
        </span>
      )}
      {/* Atlas export progress and cancel button, kept visible next to the export buttons. */}
      {atlasProgress && (
        <div className="me-auto flex items-center gap-2">
          <span className="text-sm text-muted-foreground">
            {t("printLayout.atlas.exporting", {
              current: atlasProgress.current,
              total: atlasProgress.total,
            })}
          </span>
          {atlasProgress.cancellable !== false && (
            <Button type="button" variant="outline" size="sm" onClick={handleCancelAtlasExport}>
              {t("common.cancel")}
            </Button>
          )}
        </div>
      )}
      <Button
        variant="ghost"
        disabled={atlasBusy || exporting}
        onClick={() => handleDialogOpenChange(false)}
      >
        {t("common.close")}
      </Button>
      {/* Copy the composed layout straight to the clipboard (GH #773). */}
      <Button
        variant="outline"
        disabled={exporting || atlasBusy || !hasCapture || !insetReady}
        onClick={() => void handleCopy()}
      >
        {copied ? <Check className="me-2 h-4 w-4" /> : <ClipboardCopy className="me-2 h-4 w-4" />}
        {copied ? t("printLayout.copied") : t("printLayout.copyToClipboard")}
      </Button>
      {!atlasEnabled && (
        <Button
          variant="outline"
          disabled={exporting || atlasBusy || !hasCapture || !insetReady}
          onClick={() => void handleExport("svg")}
        >
          <FileImage className="me-2 h-4 w-4" />
          {t("printLayout.exportSvg")}
        </Button>
      )}
      {/* Equal-weight export buttons: neither format is the "primary" one
          (GH #520). In atlas mode they become the whole-series exports:
          a zip of per-page PNGs and one multi-page PDF (GH #1291). */}
      <Button
        variant="outline"
        disabled={
          exporting ||
          atlasBusy ||
          atlasConfigBlocked ||
          !insetReady ||
          (atlasEnabled ? !atlasActive : !hasCapture)
        }
        onClick={() => void (atlasActive ? handleAtlasExport("zip") : handleExport("png"))}
      >
        <FileImage className="me-2 h-4 w-4" />
        {atlasActive ? t("printLayout.atlas.exportZip") : t("printLayout.exportPng")}
      </Button>
      <Button
        variant="outline"
        disabled={
          exporting ||
          atlasBusy ||
          atlasConfigBlocked ||
          !insetReady ||
          (atlasEnabled ? !atlasActive : !hasCapture)
        }
        // Say whether the PDF carries map coordinates (GeoPDF, GH #3523): a
        // tilted or globe view exports as a plain PDF.
        // An atlas georeferences each page on its own, so the current capture
        // does not speak for the whole series.
        title={
          atlasActive
            ? t("printLayout.geoPdf.atlas")
            : hasCapture
              ? georeferenced
                ? t("printLayout.geoPdf.georeferenced")
                : getActiveEllipsoid().id !== "earth"
                  ? t("printLayout.geoPdf.otherBody")
                  : t("printLayout.geoPdf.notGeoreferenced")
              : undefined
        }
        onClick={() => void (atlasActive ? handleAtlasExport("pdf") : handleExport("pdf"))}
      >
        <FileText className="me-2 h-4 w-4" />
        {atlasActive
          ? t("printLayout.atlas.exportPdfPages", {
              count: atlasPageCount,
            })
          : t("printLayout.exportPdf")}
      </Button>
    </div>
  );
}
