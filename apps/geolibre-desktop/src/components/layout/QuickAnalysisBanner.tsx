import { useAppStore } from "@geolibre/core";
import { Button } from "@geolibre/ui";
import { Loader2, TriangleAlert, X } from "lucide-react";
import { useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import {
  clearQuickAnalysisStatus,
  getQuickAnalysisStatus,
  subscribeQuickAnalysisStatus,
} from "../../lib/quick-analysis";

/**
 * Reports the state of a Quick analysis run (issue #1523) over the map.
 *
 * A quick action is dispatched from a menu that closes immediately, so there is
 * nowhere for progress or an error to land — and a networked action (drive
 * time) can take a few seconds. This banner covers that gap: it shows which
 * tool is running, and on failure offers "View details", which opens the
 * Processing History panel where the run is recorded with its parameters and
 * error. Success needs no banner — the result layer appears and the map frames
 * it.
 */
export function QuickAnalysisBanner() {
  const { t } = useTranslation();
  const status = useSyncExternalStore(
    subscribeQuickAnalysisStatus,
    getQuickAnalysisStatus,
    getQuickAnalysisStatus,
  );
  const setProcessingHistoryOpen = useAppStore((s) => s.setProcessingHistoryOpen);

  if (status.phase === "idle") return null;

  const running = status.phase === "running";

  return (
    // Bottom-centered so it never collides with MapModeBanner, which owns the
    // top-center slot. The wrapper stays click-through; only the pill itself
    // takes pointer events, so the map underneath keeps working.
    <div className="pointer-events-none absolute bottom-10 left-1/2 z-20 flex w-[min(92vw,28rem)] -translate-x-1/2 justify-center">
      <div
        role="status"
        className="pointer-events-auto flex w-full items-center gap-2 rounded-md border bg-background/95 px-3 py-2 text-xs shadow-md backdrop-blur"
      >
        {running ? (
          <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" />
        ) : (
          <TriangleAlert className="h-4 w-4 shrink-0 text-destructive" />
        )}
        <div className="min-w-0">
          <p className="font-medium">
            {running
              ? t("quickAnalysis.running", { tool: status.toolName })
              : t("quickAnalysis.failed", { tool: status.toolName })}
          </p>
          {!running && <p className="truncate text-muted-foreground">{status.message}</p>}
        </div>
        {!running && (
          <>
            <Button
              variant="outline"
              size="sm"
              className="ms-auto h-7 shrink-0 text-xs"
              onClick={() => {
                clearQuickAnalysisStatus();
                setProcessingHistoryOpen(true);
              }}
            >
              {t("quickAnalysis.viewDetails")}
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 shrink-0"
              aria-label={t("common.close")}
              onClick={clearQuickAnalysisStatus}
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
