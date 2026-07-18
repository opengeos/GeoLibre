import {
  Button,
  cn,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  ScrollArea,
} from "@geolibre/ui";
import { Clipboard, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  clearDiagnostics,
  setCaptureNetworkInfo,
  type DiagnosticRecord,
  type DiagnosticLevel,
  type DiagnosticsSnapshot,
} from "../../lib/diagnostics";

interface DiagnosticsDialogProps {
  diagnostics: DiagnosticsSnapshot;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

// "network" is a category-scoped filter, not a level, so the filter union is
// wider than DiagnosticLevel. It mirrors the network badge: every network
// record when request logging is on, only network errors when it is off.
type DiagnosticFilter = DiagnosticLevel | "all" | "network";

function matchesFilter(
  record: DiagnosticRecord,
  filter: DiagnosticFilter,
  captureNetworkInfo: boolean,
): boolean {
  if (filter === "all") return true;
  if (filter === "network") {
    return record.category === "network" && (captureNetworkInfo || record.level === "error");
  }
  return record.level === filter;
}

function formatTime(timestamp: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return timestamp;
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  }).format(date);
}

function recordAccent(record: DiagnosticRecord): string {
  if (record.level === "error") return "border-s-destructive";
  if (record.level === "warning") return "border-s-amber-500";
  return "border-s-primary";
}

function recordLevelClass(record: DiagnosticRecord): string {
  if (record.level === "error") {
    return "bg-destructive/10 text-destructive";
  }
  if (record.level === "warning") {
    return "bg-amber-500/10 text-amber-700 dark:text-amber-300";
  }
  return "bg-muted text-muted-foreground";
}

export function DiagnosticsDialog({ diagnostics, open, onOpenChange }: DiagnosticsDialogProps) {
  const [copyState, setCopyState] = useState<"copied" | "idle">("idle");
  const copyResetTimerRef = useRef<number | null>(null);
  const [activeFilter, setActiveFilter] = useState<DiagnosticFilter>("all");
  const filteredRecords = useMemo(
    () =>
      activeFilter === "all"
        ? diagnostics.records
        : diagnostics.records.filter((record) =>
            matchesFilter(record, activeFilter, diagnostics.captureNetworkInfo),
          ),
    [diagnostics.records, activeFilter, diagnostics.captureNetworkInfo],
  );
  const listIsFiltered = activeFilter !== "all";
  // The network filter's label tracks the badge: plain "network" while request
  // logging is on, "network error" while it is off.
  const filterLabel =
    activeFilter === "network" && !diagnostics.captureNetworkInfo ? "network error" : activeFilter;
  // Derived here rather than assumed from networkCount so the badge label
  // and count cannot diverge if non-error network levels are introduced.
  const networkErrorCount = useMemo(
    () =>
      diagnostics.records.filter(
        (record) => record.category === "network" && record.level === "error",
      ).length,
    [diagnostics.records],
  );
  // When request logging is off, the network filter surfaces only errors, so it
  // should share the red "error" styling of the Errors button. With logging on
  // it tallies all requests (not just errors), so it stays neutral.
  const networkAsError = !diagnostics.captureNetworkInfo;

  useEffect(
    () => () => {
      if (copyResetTimerRef.current !== null) {
        window.clearTimeout(copyResetTimerRef.current);
      }
    },
    [],
  );

  const copyDiagnostics = async () => {
    if (!navigator.clipboard || filteredRecords.length === 0) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(filteredRecords, null, 2));
    } catch {
      // Clipboard access denied or unavailable.
      return;
    }
    setCopyState("copied");
    if (copyResetTimerRef.current !== null) {
      window.clearTimeout(copyResetTimerRef.current);
    }
    copyResetTimerRef.current = window.setTimeout(() => setCopyState("idle"), 1500);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-h-[min(760px,92vh)] max-w-5xl"
        bodyClassName="grid-rows-[auto_auto_minmax(0,1fr)] overflow-hidden p-0"
      >
        <DialogHeader className="border-b px-6 py-4 pe-12">
          <DialogTitle>Diagnostics</DialogTitle>
          <DialogDescription>
            Recent network requests, MapLibre errors, console warnings, and runtime exceptions.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-wrap items-center justify-between gap-3 px-6">
          <div className="flex flex-wrap gap-2 text-xs">
            <button
              type="button"
              aria-pressed={activeFilter === "all"}
              className={cn(
                "rounded border px-2 py-1 hover:bg-accent hover:text-accent-foreground",
                activeFilter === "all" && "bg-accent text-accent-foreground",
              )}
              onClick={() => setActiveFilter("all")}
            >
              {diagnostics.totalCount} total
            </button>
            <button
              type="button"
              aria-pressed={activeFilter === "error"}
              className={cn(
                "rounded border px-2 py-1 hover:bg-destructive/10 hover:text-destructive dark:hover:text-red-200",
                diagnostics.errorCount > 0 &&
                  "border-destructive/50 text-destructive dark:border-red-400/60 dark:text-red-300",
                activeFilter === "error" &&
                  "border-destructive bg-destructive text-destructive-foreground hover:bg-destructive hover:text-destructive-foreground dark:border-red-500 dark:bg-red-600 dark:text-white dark:hover:bg-red-600 dark:hover:text-white",
              )}
              onClick={() => setActiveFilter("error")}
            >
              {diagnostics.errorCount} errors
            </button>
            <button
              type="button"
              aria-pressed={activeFilter === "warning"}
              className={cn(
                "rounded border px-2 py-1 hover:bg-amber-500/10 hover:text-amber-700 dark:hover:text-amber-200",
                diagnostics.warningCount > 0 &&
                  "border-amber-500/50 text-amber-700 dark:border-amber-400/60 dark:text-amber-300",
                activeFilter === "warning" &&
                  "border-amber-500 bg-amber-500 text-white hover:bg-amber-500 hover:text-white dark:border-amber-500 dark:bg-amber-500 dark:text-white dark:hover:bg-amber-500 dark:hover:text-white",
              )}
              onClick={() => setActiveFilter("warning")}
            >
              {diagnostics.warningCount} warnings
            </button>
            <button
              type="button"
              aria-pressed={activeFilter === "network"}
              className={cn(
                "rounded border px-2 py-1",
                networkAsError
                  ? "hover:bg-destructive/10 hover:text-destructive dark:hover:text-red-200"
                  : "hover:bg-accent hover:text-accent-foreground",
                networkAsError &&
                  networkErrorCount > 0 &&
                  "border-destructive/50 text-destructive dark:border-red-400/60 dark:text-red-300",
                activeFilter === "network" &&
                  (networkAsError
                    ? "border-destructive bg-destructive text-destructive-foreground hover:bg-destructive hover:text-destructive-foreground dark:border-red-500 dark:bg-red-600 dark:text-white dark:hover:bg-red-600 dark:hover:text-white"
                    : "bg-accent text-accent-foreground"),
              )}
              onClick={() => setActiveFilter("network")}
            >
              {diagnostics.captureNetworkInfo
                ? `${diagnostics.networkCount} network`
                : `${networkErrorCount} network errors`}
            </button>
            <label
              className="flex items-center gap-1.5 rounded border px-2 py-1 text-muted-foreground"
              title="Record successful and aborted network requests from now on; requests made while logging was off are not backfilled. Off by default because logging every request slows the app down."
            >
              <input
                className="h-3.5 w-3.5"
                type="checkbox"
                checked={diagnostics.captureNetworkInfo}
                onChange={(event) => setCaptureNetworkInfo(event.target.checked)}
              />
              Log all network requests
            </label>
          </div>
          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={filteredRecords.length === 0}
              onClick={() => void copyDiagnostics()}
            >
              <Clipboard className="h-3.5 w-3.5" />
              {copyState === "copied" ? "Copied" : "Copy JSON"}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={diagnostics.records.length === 0}
              onClick={() => {
                setActiveFilter("all");
                clearDiagnostics();
              }}
            >
              <Trash2 className="h-3.5 w-3.5" />
              Clear
            </Button>
          </div>
        </div>
        <ScrollArea className="min-h-0 border-t">
          {filteredRecords.length === 0 ? (
            <div className="flex min-h-48 items-center justify-center px-6 py-12 text-sm text-muted-foreground">
              {listIsFiltered
                ? `No ${filterLabel} diagnostics captured.`
                : "No diagnostics captured."}
            </div>
          ) : (
            <ol className="divide-y">
              {filteredRecords.map((record) => (
                <li key={record.id} className={cn("border-s-2 px-6 py-3", recordAccent(record))}>
                  <div className="mb-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <span
                      className={cn(
                        "rounded px-1.5 py-0.5 font-medium uppercase",
                        recordLevelClass(record),
                      )}
                    >
                      {record.level}
                    </span>
                    <span className="rounded bg-muted px-1.5 py-0.5 uppercase">
                      {record.category}
                    </span>
                    <time dateTime={record.timestamp}>{formatTime(record.timestamp)}</time>
                    {record.method ? <span>{record.method}</span> : null}
                    {record.status ? <span>HTTP {record.status}</span> : null}
                    {record.durationMs != null ? <span>{record.durationMs} ms</span> : null}
                  </div>
                  <div className="break-words text-sm">{record.message}</div>
                  {record.url ? (
                    <div className="mt-1 break-all font-mono text-xs text-muted-foreground">
                      {record.url}
                    </div>
                  ) : null}
                  {record.source ? (
                    <div className="mt-1 break-all font-mono text-xs text-muted-foreground">
                      {record.source}
                    </div>
                  ) : null}
                  {record.detail ? (
                    <pre className="mt-2 max-h-44 overflow-auto whitespace-pre-wrap rounded border bg-muted/40 p-2 text-xs">
                      {record.detail}
                    </pre>
                  ) : null}
                </li>
              ))}
            </ol>
          )}
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}
