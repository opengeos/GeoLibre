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
import { useMemo, useState } from "react";
import {
  clearDiagnostics,
  type DiagnosticRecord,
  useDiagnosticsSnapshot,
} from "../../lib/diagnostics";

interface DiagnosticsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
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
  if (record.level === "error") return "border-l-destructive";
  if (record.level === "warning") return "border-l-amber-500";
  return "border-l-primary";
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

export function DiagnosticsDialog({
  open,
  onOpenChange,
}: DiagnosticsDialogProps) {
  const diagnostics = useDiagnosticsSnapshot();
  const [copyState, setCopyState] = useState<"copied" | "idle">("idle");
  const serializedRecords = useMemo(
    () => JSON.stringify(diagnostics.records, null, 2),
    [diagnostics.records],
  );

  const copyDiagnostics = async () => {
    if (!navigator.clipboard || diagnostics.records.length === 0) return;
    await navigator.clipboard.writeText(serializedRecords);
    setCopyState("copied");
    window.setTimeout(() => setCopyState("idle"), 1500);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[min(760px,92vh)] max-w-5xl grid-rows-[auto_auto_minmax(0,1fr)] p-0">
        <DialogHeader className="border-b px-6 py-4 pr-12">
          <DialogTitle>Diagnostics</DialogTitle>
          <DialogDescription>
            Recent network requests, MapLibre errors, console warnings, and
            runtime exceptions.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-wrap items-center justify-between gap-3 px-6">
          <div className="flex flex-wrap gap-2 text-xs">
            <span className="rounded border px-2 py-1">
              {diagnostics.totalCount} total
            </span>
            <span
              className={cn(
                "rounded border px-2 py-1",
                diagnostics.errorCount > 0 &&
                  "border-destructive/30 text-destructive",
              )}
            >
              {diagnostics.errorCount} errors
            </span>
            <span className="rounded border px-2 py-1">
              {diagnostics.warningCount} warnings
            </span>
            <span className="rounded border px-2 py-1">
              {diagnostics.networkCount} network
            </span>
          </div>
          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={diagnostics.records.length === 0}
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
              onClick={clearDiagnostics}
            >
              <Trash2 className="h-3.5 w-3.5" />
              Clear
            </Button>
          </div>
        </div>
        <ScrollArea className="min-h-0 border-t">
          {diagnostics.records.length === 0 ? (
            <div className="flex min-h-48 items-center justify-center px-6 py-12 text-sm text-muted-foreground">
              No diagnostics captured.
            </div>
          ) : (
            <ol className="divide-y">
              {diagnostics.records.map((record) => (
                <li
                  key={record.id}
                  className={cn("border-l-2 px-6 py-3", recordAccent(record))}
                >
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
                    <time>{formatTime(record.timestamp)}</time>
                    {record.method ? <span>{record.method}</span> : null}
                    {record.status ? <span>HTTP {record.status}</span> : null}
                    {record.durationMs != null ? (
                      <span>{record.durationMs} ms</span>
                    ) : null}
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
