import {
  useAppStore,
  type NetworkToolKind,
  type ProcessingRun,
  type RasterToolKind,
  type StatisticsToolKind,
  type VectorToolKind,
} from "@geolibre/core";
import { allAlgorithms } from "../../lib/scripting/scriptingApi";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  ScrollArea,
  cn,
} from "@geolibre/ui";
import {
  Braces,
  CheckCircle2,
  FileCode2,
  Pencil,
  Play,
  Trash2,
  XCircle,
} from "lucide-react";
import { useCallback, useMemo, useRef, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";

/** Tool ids reachable from the Python API (`m.run_algorithm`): the scripting
 * bridge's own registry list, so "Copy as Python" eligibility cannot drift
 * from what `run_algorithm` actually resolves. */
const PYTHON_TOOL_IDS = new Set(allAlgorithms().map((tool) => tool.id));
/**
 * Run kinds whose tool ids resolve against those registries. Ids are not
 * disjoint across engines (e.g. Whitebox and raster both have "clip"/
 * "reproject"), so a bare id match would offer a Python snippet that silently
 * invokes the client vector tool with foreign parameters.
 */
const PYTHON_ELIGIBLE_KINDS = new Set(["vector", "statistics", "algorithm"]);

/** Dialog families whose History "Re-run" can auto-start the run. */
const AUTO_RERUN_KINDS = new Set(["vector", "statistics", "network"]);
/** Dialog families that support "Edit & re-run" (pre-filled dialog). */
const EDIT_RERUN_KINDS = new Set([
  "vector",
  "statistics",
  "network",
  "whitebox",
  "raster",
]);

/**
 * Render a value as a Python literal (`true` → `True`, `null` → `None`), for
 * the "Copy as Python" action. Strings use JSON quoting, which Python accepts.
 */
function toPythonLiteral(value: unknown): string {
  if (value === null || value === undefined) return "None";
  if (typeof value === "boolean") return value ? "True" : "False";
  if (typeof value === "number")
    return Number.isFinite(value) ? String(value) : "None";
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value))
    return `[${value.map((item) => toPythonLiteral(item)).join(", ")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .map(([key, item]) => `${JSON.stringify(key)}: ${toPythonLiteral(item)}`);
    return `{${entries.join(", ")}}`;
  }
  return "None";
}

/** The `m.run_algorithm(...)` call equivalent to a recorded run. */
function pythonSnippet(run: ProcessingRun): string {
  return `m.run_algorithm(${JSON.stringify(run.toolId)}, ${toPythonLiteral(
    run.parameters,
  )})`;
}

/** Compact duration label: sub-second in ms, else one-decimal seconds. */
function formatDuration(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}

/**
 * Processing → History dialog (issue #1292): every processing run recorded by
 * the tool dialogs and the scripting bridge, newest first. Each entry offers
 * Re-run (client tools, runs immediately), Edit & re-run (reopens the tool
 * dialog pre-filled), Copy parameters as JSON, and Copy as Python for tools
 * reachable from the `geolibre` Python API. History persists in the project
 * file, so a saved project documents how its derived layers were produced.
 */
export function ProcessingHistoryDialog(): ReactElement {
  const { t } = useTranslation();
  const open = useAppStore((s) => s.ui.processingHistoryOpen);
  const setProcessingHistoryOpen = useAppStore(
    (s) => s.setProcessingHistoryOpen,
  );
  const history = useAppStore((s) => s.processingHistory);
  const clearProcessingHistory = useAppStore((s) => s.clearProcessingHistory);
  const setProcessingRerun = useAppStore((s) => s.setProcessingRerun);
  const setVectorToolOpen = useAppStore((s) => s.setVectorToolOpen);
  const setStatisticsToolOpen = useAppStore((s) => s.setStatisticsToolOpen);
  const setNetworkToolOpen = useAppStore((s) => s.setNetworkToolOpen);
  const setRasterToolOpen = useAppStore((s) => s.setRasterToolOpen);
  const setProcessingOpen = useAppStore((s) => s.setProcessingOpen);
  const setProcessingInitialTool = useAppStore(
    (s) => s.setProcessingInitialTool,
  );

  // Newest first for display; the store keeps runs oldest first.
  const entries = useMemo(() => [...history].reverse(), [history]);

  // Transient "Copied" feedback per entry+action, reset shortly after. Only
  // shown once a copy actually succeeded.
  const [copied, setCopied] = useState<string | null>(null);
  const copyTimerRef = useRef<number | null>(null);
  const copyText = useCallback(async (key: string, text: string) => {
    let ok = false;
    try {
      await navigator.clipboard.writeText(text);
      ok = true;
    } catch {
      // Clipboard access can be denied (insecure context, permissions). Fall
      // back to a transient textarea + execCommand, like MapContextMenu.
      const textarea = document.createElement("textarea");
      textarea.value = text;
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      textarea.select();
      try {
        ok = document.execCommand("copy");
      } finally {
        document.body.removeChild(textarea);
      }
    }
    if (!ok) return;
    setCopied(key);
    if (copyTimerRef.current) window.clearTimeout(copyTimerRef.current);
    copyTimerRef.current = window.setTimeout(() => setCopied(null), 1500);
  }, []);

  // Route a re-run to the dialog family that recorded the run: queue the
  // payload, open the dialog (pre-selecting the tool), and close History so
  // the reopened dialog is visible.
  const openForRun = useCallback(
    (run: ProcessingRun, autoRun: boolean) => {
      setProcessingRerun({
        kind: run.kind,
        toolId: run.toolId,
        parameters: run.parameters,
        engine: run.engine,
        autoRun,
      });
      switch (run.kind) {
        case "vector":
          setVectorToolOpen(run.toolId as VectorToolKind);
          break;
        case "statistics":
          setStatisticsToolOpen(run.toolId as StatisticsToolKind);
          break;
        case "network":
          setNetworkToolOpen(run.toolId as NetworkToolKind);
          break;
        case "raster":
          setRasterToolOpen(run.toolId as RasterToolKind);
          break;
        case "whitebox":
          setProcessingInitialTool(run.toolId);
          setProcessingOpen(true);
          break;
        default:
          return;
      }
      setProcessingHistoryOpen(false);
    },
    [
      setProcessingRerun,
      setVectorToolOpen,
      setStatisticsToolOpen,
      setNetworkToolOpen,
      setRasterToolOpen,
      setProcessingInitialTool,
      setProcessingOpen,
      setProcessingHistoryOpen,
    ],
  );

  return (
    <Dialog
      open={open}
      onOpenChange={(next: boolean) => {
        if (!next) setProcessingHistoryOpen(false);
      }}
    >
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>{t("processing.history.title")}</DialogTitle>
          <DialogDescription>
            {t("processing.history.description")}
          </DialogDescription>
        </DialogHeader>

        <ScrollArea className="h-[24rem] rounded-md border">
          {entries.length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">
              {t("processing.history.empty")}
            </p>
          ) : (
            <div className="flex flex-col gap-1 p-2">
              {entries.map((run) => {
                const inputs = Object.values(run.inputLayerNames ?? {});
                return (
                  <div
                    key={run.id}
                    className="rounded-md border bg-muted/20 px-3 py-2"
                  >
                    <div className="flex items-center gap-2">
                      {run.status === "success" ? (
                        <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600" />
                      ) : (
                        <XCircle className="h-4 w-4 shrink-0 text-destructive" />
                      )}
                      <span className="truncate text-sm font-medium">
                        {run.toolName}
                      </span>
                      <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                        {run.engine}
                      </span>
                      <span className="ms-auto shrink-0 text-xs text-muted-foreground">
                        {run.startedAt
                          ? new Date(run.startedAt).toLocaleString()
                          : ""}
                        {run.durationMs !== undefined
                          ? ` · ${formatDuration(run.durationMs)}`
                          : ""}
                      </span>
                    </div>
                    <div className="mt-1 flex items-center gap-1">
                      <p
                        className={cn(
                          "min-w-0 flex-1 truncate text-xs text-muted-foreground",
                          run.status === "error" && "text-destructive",
                        )}
                      >
                        {run.status === "error" && run.error
                          ? run.error
                          : [
                              inputs.length > 0
                                ? `${inputs.join(", ")}`
                                : (run.inputPath ?? ""),
                              (run.outputLayerNames?.length ?? 0) > 0
                                ? `→ ${run.outputLayerNames?.join(", ")}`
                                : run.outputPath
                                  ? `→ ${run.outputPath}`
                                  : "",
                            ]
                              .filter(Boolean)
                              .join(" ")}
                      </p>
                      {AUTO_RERUN_KINDS.has(run.kind) ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 gap-1 px-2 text-xs"
                          title={t("processing.history.rerun")}
                          onClick={() => openForRun(run, true)}
                        >
                          <Play className="h-3.5 w-3.5" />
                          {t("processing.history.rerun")}
                        </Button>
                      ) : null}
                      {EDIT_RERUN_KINDS.has(run.kind) ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 gap-1 px-2 text-xs"
                          title={t("processing.history.editRerun")}
                          onClick={() => openForRun(run, false)}
                        >
                          <Pencil className="h-3.5 w-3.5" />
                          {t("processing.history.editRerun")}
                        </Button>
                      ) : null}
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 gap-1 px-2 text-xs"
                        title={t("processing.history.copyJson")}
                        onClick={() =>
                          void copyText(
                            `${run.id}:json`,
                            JSON.stringify(
                              {
                                tool: run.toolId,
                                engine: run.engine,
                                parameters: run.parameters,
                              },
                              null,
                              2,
                            ),
                          )
                        }
                      >
                        <Braces className="h-3.5 w-3.5" />
                        {copied === `${run.id}:json`
                          ? t("processing.history.copied")
                          : t("processing.history.copyJson")}
                      </Button>
                      {PYTHON_ELIGIBLE_KINDS.has(run.kind) &&
                      PYTHON_TOOL_IDS.has(run.toolId) ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 gap-1 px-2 text-xs"
                          title={t("processing.history.copyPython")}
                          onClick={() =>
                            void copyText(`${run.id}:py`, pythonSnippet(run))
                          }
                        >
                          <FileCode2 className="h-3.5 w-3.5" />
                          {copied === `${run.id}:py`
                            ? t("processing.history.copied")
                            : t("processing.history.copyPython")}
                        </Button>
                      ) : null}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </ScrollArea>

        <div className="flex items-center justify-between">
          <span className="text-xs text-muted-foreground">
            {t("processing.history.count", { count: history.length })}
          </span>
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5"
            disabled={history.length === 0}
            onClick={clearProcessingHistory}
          >
            <Trash2 className="h-3.5 w-3.5" />
            {t("processing.history.clear")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
