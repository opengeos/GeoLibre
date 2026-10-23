import { useTranslation } from "react-i18next";
import { Button } from "@geolibre/ui";
import { Check, ClipboardCopy, FileImage, FileText } from "lucide-react";
import type { PrintLayoutUiState } from "./state";
import type { AtlasSeries } from "./useAtlasSeries";
import type { useExportActions } from "./useExportActions";

interface ExportActionsProps {
  ui: Pick<PrintLayoutUiState, "atlasProgress" | "atlasBusy" | "exporting" | "copied">;
  hasCapture: boolean;
  /** The atlas setting, AND-ed with the renderer being able to drive it. */
  atlasEnabled: boolean;
  atlas: AtlasSeries;
  actions: ReturnType<typeof useExportActions>;
}

/** The dialog's footer: atlas progress, Close, Copy, and the export buttons. */
export function ExportActions({
  ui,
  hasCapture,
  atlasEnabled,
  atlas,
  actions,
}: ExportActionsProps) {
  const { t } = useTranslation();
  const { atlasProgress, atlasBusy, exporting, copied } = ui;
  const { atlasActive, atlasConfigBlocked, atlasPageCount } = atlas;
  const { handleCopy, handleExport, handleAtlasExport, handleDialogOpenChange } = actions;
  return (
    <div className="flex flex-wrap items-center justify-end gap-2 pt-2">
      {/* Atlas export progress, kept visible next to the buttons. */}
      {atlasProgress && (
        <span className="me-auto text-sm text-muted-foreground">
          {t("printLayout.atlas.exporting", {
            current: atlasProgress.current,
            total: atlasProgress.total,
          })}
        </span>
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
        disabled={exporting || atlasBusy || !hasCapture}
        onClick={() => void handleCopy()}
      >
        {copied ? <Check className="me-2 h-4 w-4" /> : <ClipboardCopy className="me-2 h-4 w-4" />}
        {copied ? t("printLayout.copied") : t("printLayout.copyToClipboard")}
      </Button>
      {!atlasEnabled && (
        <Button
          variant="outline"
          disabled={exporting || atlasBusy || !hasCapture}
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
          (atlasEnabled ? !atlasActive : !hasCapture)
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
