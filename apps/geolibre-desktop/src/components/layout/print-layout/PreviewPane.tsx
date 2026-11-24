import { useTranslation } from "react-i18next";
import type { Dispatch } from "react";
import type { PrintLayoutConfig } from "@geolibre/core";
import { Button } from "@geolibre/ui";
import { ChevronLeft, ChevronRight, Move, RefreshCw, RotateCcw } from "lucide-react";
import type { AtlasSeries } from "./useAtlasSeries";
import { ArrangeOverlay, type ArrangeFrame } from "./ArrangeOverlay";
import type { PrintLayoutAction } from "./state";

interface PreviewPaneProps {
  atlas: AtlasSeries;
  atlasBusy: boolean;
  /** True once the dialog has an explicit (grip-dragged) size. */
  sized: boolean;
  error: string | null;
  previewRef: React.RefObject<HTMLCanvasElement | null>;
  previewBoxRef: React.RefObject<HTMLDivElement | null>;
  onRecapture: () => void;
  onGoToAtlasPage: (index: number) => Promise<void>;
  /** True while the drag/resize handles are shown over the page. */
  arranging: boolean;
  /** Where the preview last drew each element. */
  arrangeFrame: ArrangeFrame | null;
  layout: PrintLayoutConfig;
  dispatch: Dispatch<PrintLayoutAction>;
}

/** The page preview: recapture button, atlas page stepper, canvas and error. */
export function PreviewPane({
  atlas,
  atlasBusy,
  sized,
  error,
  previewRef,
  previewBoxRef,
  onRecapture,
  onGoToAtlasPage,
  arranging,
  arrangeFrame,
  layout,
  dispatch,
}: PreviewPaneProps) {
  const { t } = useTranslation();
  const { atlasActive, clampedAtlasIndex, atlasPageCount, currentAtlasPage } = atlas;
  return (
    <div
      className={`flex min-w-0 flex-col items-center justify-start gap-3 ${
        sized ? "h-full min-h-0" : ""
      }`}
    >
      <div className="flex w-full items-center justify-between">
        <span className="text-sm text-muted-foreground">{t("printLayout.preview")}</span>
        <div className="flex items-center gap-1">
          <Button
            variant={arranging ? "secondary" : "ghost"}
            size="sm"
            aria-pressed={arranging}
            onClick={() => dispatch({ type: "setUi", patch: { arranging: !arranging } })}
          >
            <Move className="me-2 h-3.5 w-3.5" />
            {arranging ? t("printLayout.arrange.done") : t("printLayout.arrange.toggle")}
          </Button>
          {arranging && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => dispatch({ type: "resetArrangement" })}
            >
              <RotateCcw className="me-2 h-3.5 w-3.5" />
              {t("printLayout.arrange.reset")}
            </Button>
          )}
          {/* In atlas mode, recapture must re-drive the current page
            (never the plain viewport/extent capture, which would clip to
            an unrelated print-extent box and skip the fixed-scale
            correction). */}
          <Button variant="ghost" size="sm" disabled={atlasBusy} onClick={onRecapture}>
            <RefreshCw className="me-2 h-3.5 w-3.5" />
            {t("printLayout.recapture")}
          </Button>
        </div>
      </div>
      {arranging && (
        <p className="w-full text-xs text-muted-foreground">{t("printLayout.arrange.hint")}</p>
      )}
      {/* Atlas page stepper: flip through the series before exporting. */}
      {atlasActive && (
        <div className="flex w-full min-w-0 items-center justify-center gap-2">
          <Button
            variant="outline"
            size="sm"
            aria-label={t("printLayout.atlas.prevPage")}
            disabled={atlasBusy || clampedAtlasIndex <= 0}
            onClick={() => void onGoToAtlasPage(clampedAtlasIndex - 1)}
          >
            <ChevronLeft className="h-4 w-4 rtl:rotate-180" />
          </Button>
          <span className="shrink-0 text-sm tabular-nums">
            {t("printLayout.atlas.pageOf", {
              current: clampedAtlasIndex + 1,
              total: atlasPageCount,
            })}
          </span>
          <Button
            variant="outline"
            size="sm"
            aria-label={t("printLayout.atlas.nextPage")}
            disabled={atlasBusy || clampedAtlasIndex >= atlasPageCount - 1}
            onClick={() => void onGoToAtlasPage(clampedAtlasIndex + 1)}
          >
            <ChevronRight className="h-4 w-4 rtl:rotate-180" />
          </Button>
          {currentAtlasPage && (
            <span
              className="min-w-0 truncate text-sm text-muted-foreground"
              title={currentAtlasPage.name}
            >
              {currentAtlasPage.name}
            </span>
          )}
        </div>
      )}
      {/* Fit the whole page in view: the canvas scales down to honour both
          max constraints without ever showing a scrollbar (GH #520). */}
      <div
        ref={previewBoxRef}
        className={`flex w-full items-center justify-center overflow-hidden rounded-md border bg-muted/30 p-3 ${
          sized ? "min-h-0 flex-1" : "h-[min(60vh,460px)]"
        }`}
      >
        {/* The canvas width/height (backing + CSS) are set imperatively in
            the draw effect to fit this pane, so it scales with the dialog. */}
        <div className="relative">
          <canvas ref={previewRef} className="block shadow-md" style={{ imageRendering: "auto" }} />
          {arranging && arrangeFrame && (
            <ArrangeOverlay frame={arrangeFrame} layout={layout} dispatch={dispatch} />
          )}
        </div>
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}
