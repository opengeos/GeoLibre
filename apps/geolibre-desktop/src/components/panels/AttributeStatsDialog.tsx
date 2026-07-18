import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Label,
  Select,
} from "@geolibre/ui";
import { Copy } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { ChartRow } from "../../lib/attribute-charts";
import { computeFieldStats, formatStatValue, type FieldStats } from "../../lib/attribute-stats";

interface AttributeStatsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Every row of the layer. */
  rows: ChartRow[];
  /** Rows matching the table's current search filter (a subset of `rows`). */
  filteredRows: ChartRow[];
  columns: string[];
  layerName: string;
}

type StatsScope = "all" | "filtered";

/**
 * One-click field statistics summary for the attribute table: pick a field and
 * read its count / nulls / min / max / mean / median / std / sum / unique
 * (numeric) or count / nulls / unique / most-frequent values (text). When a
 * search filter is active the scope can switch between all features and the
 * filtered subset. The computation lives in `attribute-stats`; this only renders
 * it.
 */
export function AttributeStatsDialog({
  open,
  onOpenChange,
  rows,
  filteredRows,
  columns,
  layerName,
}: AttributeStatsDialogProps) {
  const [field, setField] = useState("");
  const [scope, setScope] = useState<StatsScope>("all");
  const [copied, setCopied] = useState(false);

  // A filter is active (and worth offering as a scope) only when it actually
  // narrows the row set; otherwise the two scopes would be identical.
  const hasFilter = filteredRows.length !== rows.length;

  // Seed the field picker when the dialog opens. Keyed on `open` only: `columns`
  // gets a fresh identity every parent render, so depending on it here would
  // reset the user's choice constantly (mirrors AttributeChartDialog).
  useEffect(() => {
    if (!open) return;
    setField(columns[0] ?? "");
    setScope("all");
    setCopied(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Fall back to "all" when the active filter clears while the dialog is open,
  // so the scope select never points at an option that is no longer offered.
  useEffect(() => {
    if (!hasFilter) setScope("all");
  }, [hasFilter]);

  const scopedRows = scope === "filtered" && hasFilter ? filteredRows : rows;

  const stats = useMemo<FieldStats | null>(() => {
    if (!open || !field) return null;
    return computeFieldStats(scopedRows, field);
  }, [open, field, scopedRows]);

  const copySummary = () => {
    if (!stats || !field) return;
    const lines = statRows(stats).map(([label, value]) => `${label}\t${value}`);
    const header = `Field statistics — ${field}${scope === "filtered" ? " (filtered)" : ""}`;
    void navigator.clipboard
      ?.writeText([header, ...lines].join("\n"))
      .then(() => setCopied(true))
      .catch(() => setCopied(false));
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Field statistics</DialogTitle>
          <DialogDescription>
            {`Summary statistics for a field in "${layerName}".`}
          </DialogDescription>
        </DialogHeader>

        {columns.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            This layer has no fields to summarize.
          </p>
        ) : (
          <div className="grid gap-3 py-1">
            <div className="flex flex-wrap items-end gap-3">
              <div className="grid gap-1.5">
                <Label htmlFor="stats-field">Field</Label>
                <Select
                  id="stats-field"
                  className="w-52"
                  value={field}
                  onChange={(event) => {
                    setField(event.target.value);
                    setCopied(false);
                  }}
                >
                  {columns.map((col) => (
                    <option key={col} value={col}>
                      {col}
                    </option>
                  ))}
                </Select>
              </div>
              {hasFilter ? (
                <div className="grid gap-1.5">
                  <Label htmlFor="stats-scope">Scope</Label>
                  <Select
                    id="stats-scope"
                    className="w-44"
                    value={scope}
                    onChange={(event) => {
                      setScope(event.target.value as StatsScope);
                      setCopied(false);
                    }}
                  >
                    <option value="all">All features ({rows.length.toLocaleString()})</option>
                    <option value="filtered">
                      Filtered ({filteredRows.length.toLocaleString()})
                    </option>
                  </Select>
                </div>
              ) : null}
            </div>

            <StatsReadout stats={stats} />
          </div>
        )}

        <div className="flex items-center justify-end gap-2">
          {copied ? (
            <span className="me-auto text-xs text-muted-foreground">Copied to clipboard.</span>
          ) : null}
          {stats ? (
            <Button variant="outline" onClick={copySummary}>
              <Copy className="h-4 w-4" />
              Copy
            </Button>
          ) : null}
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** The label/value pairs shown for a field, in display order. */
function statRows(stats: FieldStats): [string, string][] {
  if (stats.kind === "numeric") {
    return [
      ["Count", stats.count.toLocaleString()],
      ["Nulls", stats.nulls.toLocaleString()],
      ...(stats.nonNumeric > 0
        ? ([["Non-numeric", stats.nonNumeric.toLocaleString()]] as [string, string][])
        : []),
      ["Unique", stats.unique.toLocaleString()],
      ["Min", formatStatValue(stats.min)],
      ["Max", formatStatValue(stats.max)],
      ["Mean", formatStatValue(stats.mean)],
      ["Median", formatStatValue(stats.median)],
      ["Std dev", formatStatValue(stats.std)],
      ["Sum", formatStatValue(stats.sum)],
    ];
  }
  return [
    ["Count", stats.count.toLocaleString()],
    ["Nulls", stats.nulls.toLocaleString()],
    ["Unique", stats.unique.toLocaleString()],
  ];
}

function StatsReadout({ stats }: { stats: FieldStats | null }) {
  if (!stats) {
    return (
      <p className="py-6 text-center text-sm text-muted-foreground">No values to summarize.</p>
    );
  }

  return (
    <div className="grid gap-3">
      <dl className="grid grid-cols-2 gap-x-6 gap-y-1.5 rounded-md border bg-background p-3 sm:grid-cols-3">
        {statRows(stats).map(([label, value]) => (
          <div key={label} className="flex flex-col">
            <dt className="text-xs text-muted-foreground">{label}</dt>
            <dd className="font-mono text-sm tabular-nums">{value}</dd>
          </div>
        ))}
      </dl>

      {stats.kind === "text" ? (
        <div className="grid gap-1.5">
          <span className="text-xs font-medium text-muted-foreground">Most frequent values</span>
          {stats.top.length === 0 ? (
            <p className="text-sm text-muted-foreground">No populated values.</p>
          ) : (
            <ul className="rounded-md border bg-background">
              {stats.top.map(({ value, count }) => (
                <li
                  key={value}
                  className="flex items-center justify-between gap-3 border-b px-3 py-1.5 text-sm last:border-b-0"
                >
                  <span className="min-w-0 truncate font-mono" title={value}>
                    {value}
                  </span>
                  <span className="shrink-0 tabular-nums text-muted-foreground">
                    {count.toLocaleString()}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}
