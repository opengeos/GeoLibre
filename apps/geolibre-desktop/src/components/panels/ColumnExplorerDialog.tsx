import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  ScrollArea,
  Select,
} from "@geolibre/ui";
import { Hash, Type } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { ChartRow } from "../../lib/attribute-charts";
import { formatAxisValue } from "../../lib/attribute-charts";
import { formatStatValue } from "../../lib/attribute-stats";
import {
  populatedCount,
  summarizeColumns,
  type ColumnSummary,
} from "../../lib/column-explorer";

interface ColumnExplorerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Every row of the layer. */
  rows: ChartRow[];
  /** Rows matching the table's current search filter (a subset of `rows`). */
  filteredRows: ChartRow[];
  columns: string[];
  layerName: string;
}

type ExplorerScope = "all" | "filtered";

/** Theme tokens shared with the Charts panel so the sparklines match. */
const SERIES = "hsl(var(--primary))";
const TRACK = "hsl(var(--muted))";

/**
 * MotherDuck-style column explorer for the attribute table: an at-a-glance grid
 * showing every field's type, how many rows are populated vs null, its distinct
 * count, and a small distribution — a histogram for numeric fields, the most
 * frequent values for text fields. A search box filters the fields by name, and
 * when the table has an active attribute filter the scope can switch between all
 * features and the filtered subset. All computation lives in `column-explorer`;
 * this only renders it.
 */
export function ColumnExplorerDialog({
  open,
  onOpenChange,
  rows,
  filteredRows,
  columns,
  layerName,
}: ColumnExplorerDialogProps) {
  const [scope, setScope] = useState<ExplorerScope>("all");
  const [search, setSearch] = useState("");

  // A filter is worth offering as a scope only when it actually narrows the row
  // set; otherwise the two scopes would be identical (mirrors the Stats panel).
  const hasFilter = filteredRows.length !== rows.length;

  // Reset the controls when the dialog opens; keyed on `open` only so a fresh
  // `columns` identity each parent render does not clobber the user's input.
  useEffect(() => {
    if (!open) return;
    setScope("all");
    setSearch("");
  }, [open]);

  // Fall back to "all" when the active filter clears while the dialog is open,
  // so the scope select never points at an option that is no longer offered.
  useEffect(() => {
    if (!hasFilter) setScope("all");
  }, [hasFilter]);

  const scopedRows = scope === "filtered" && hasFilter ? filteredRows : rows;

  const summaries = useMemo<ColumnSummary[]>(() => {
    if (!open) return [];
    return summarizeColumns(scopedRows, columns);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, scopedRows, columns]);

  const query = search.trim().toLowerCase();
  const shown = query
    ? summaries.filter((s) => s.key.toLowerCase().includes(query))
    : summaries;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>Column explorer</DialogTitle>
          <DialogDescription>
            {`Type, completeness, and distribution of every field in "${layerName}".`}
          </DialogDescription>
        </DialogHeader>

        {columns.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            This layer has no fields to explore.
          </p>
        ) : (
          <>
            <div className="flex flex-wrap items-end gap-3">
              <div className="grid gap-1.5">
                <Label htmlFor="explorer-search">Find field</Label>
                <Input
                  id="explorer-search"
                  className="h-8 w-52"
                  placeholder="Filter fields by name..."
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                />
              </div>
              {hasFilter ? (
                <div className="grid gap-1.5">
                  <Label htmlFor="explorer-scope">Scope</Label>
                  <Select
                    id="explorer-scope"
                    className="h-8 w-44"
                    value={scope}
                    onChange={(event) =>
                      setScope(event.target.value as ExplorerScope)
                    }
                  >
                    <option value="all">
                      All features ({rows.length.toLocaleString()})
                    </option>
                    <option value="filtered">
                      Filtered ({filteredRows.length.toLocaleString()})
                    </option>
                  </Select>
                </div>
              ) : null}
              <span className="ml-auto self-end pb-1 text-xs text-muted-foreground">
                {shown.length.toLocaleString()} of{" "}
                {summaries.length.toLocaleString()} fields
              </span>
            </div>

            <ScrollArea className="-mx-1 mt-3 min-h-0 flex-1 px-1">
              {shown.length === 0 ? (
                <p className="py-6 text-center text-sm text-muted-foreground">
                  No fields match "{search}".
                </p>
              ) : (
                <div className="grid grid-cols-1 gap-3 pb-1 sm:grid-cols-2">
                  {shown.map((summary) => (
                    <ColumnCard key={summary.key} summary={summary} />
                  ))}
                </div>
              )}
            </ScrollArea>
          </>
        )}

        <div className="flex items-center justify-end">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** A single field's summary card: header, completeness bar, then distribution. */
function ColumnCard({ summary }: { summary: ColumnSummary }) {
  const { key, stats, total } = summary;
  const populated = populatedCount(summary);
  const fill = total > 0 ? populated / total : 0;
  const isNumeric = stats.kind === "numeric";

  return (
    <div className="flex flex-col gap-2 rounded-md border bg-background p-3">
      <div className="flex items-center gap-2">
        {isNumeric ? (
          <Hash className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <Type className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        )}
        <span className="min-w-0 flex-1 truncate text-sm font-medium" title={key}>
          {key}
        </span>
        <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
          {isNumeric ? "Numeric" : "Text"}
        </span>
      </div>

      <div className="flex flex-col gap-1">
        <div
          className="h-1.5 w-full overflow-hidden rounded-full"
          style={{ backgroundColor: TRACK }}
          title={`${populated.toLocaleString()} populated, ${stats.nulls.toLocaleString()} null`}
        >
          <div
            className="h-full rounded-full"
            style={{ width: `${(fill * 100).toFixed(1)}%`, backgroundColor: SERIES }}
          />
        </div>
        <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
          <span>{populated.toLocaleString()} populated</span>
          <span>{stats.nulls.toLocaleString()} null</span>
          <span>{stats.unique.toLocaleString()} unique</span>
        </div>
      </div>

      {isNumeric ? (
        <NumericDistribution summary={summary} />
      ) : (
        <TextDistribution summary={summary} />
      )}
    </div>
  );
}

/** Numeric column: min / mean / max readout plus a histogram sparkline. */
function NumericDistribution({ summary }: { summary: ColumnSummary }) {
  const { stats, histogram } = summary;
  if (stats.kind !== "numeric") return null;

  return (
    <div className="flex flex-col gap-1.5">
      <Sparkline histogram={histogram} field={summary.key} />
      <dl className="grid grid-cols-3 gap-x-3 text-[11px]">
        {(
          [
            ["Min", stats.min],
            ["Mean", stats.mean],
            ["Max", stats.max],
          ] as [string, number][]
        ).map(([label, value]) => (
          <div key={label} className="flex flex-col">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="truncate font-mono tabular-nums" title={String(value)}>
              {formatStatValue(value)}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/** Histogram bars scaled to the tallest bin, drawn as a compact inline SVG. */
function Sparkline({
  histogram,
  field,
}: {
  histogram: ColumnSummary["histogram"];
  field: string;
}) {
  const width = 200;
  const height = 44;

  if (!histogram || histogram.maxCount === 0) {
    return (
      <p className="text-[11px] text-muted-foreground">
        No numeric values to plot.
      </p>
    );
  }

  const bins = histogram.bins;
  const gap = bins.length > 1 ? 1 : 0;
  const barWidth = (width - gap * (bins.length - 1)) / bins.length;

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className="h-11 w-full"
      preserveAspectRatio="none"
      role="img"
      aria-label={`Distribution of ${field}: ${histogram.total.toLocaleString()} values from ${formatAxisValue(histogram.min)} to ${formatAxisValue(histogram.max)}`}
    >
      {bins.map((bin, index) => {
        const barHeight =
          bin.count === 0 ? 0 : (bin.count / histogram.maxCount) * height;
        return (
          <rect
            key={index}
            x={index * (barWidth + gap)}
            y={height - barHeight}
            width={barWidth}
            height={barHeight}
            fill={SERIES}
          >
            <title>{`${formatAxisValue(bin.x0)}–${formatAxisValue(bin.x1)}: ${bin.count.toLocaleString()}`}</title>
          </rect>
        );
      })}
    </svg>
  );
}

/** Text column: most-frequent values as proportional horizontal bars. */
function TextDistribution({ summary }: { summary: ColumnSummary }) {
  const { stats } = summary;
  if (stats.kind !== "text") return null;

  if (stats.top.length === 0) {
    return (
      <p className="text-[11px] text-muted-foreground">No populated values.</p>
    );
  }

  const maxCount = stats.top[0]?.count ?? 0;
  const remaining = stats.unique - stats.top.length;

  return (
    <div className="flex flex-col gap-1">
      {stats.top.map(({ value, count }) => (
        <div key={value} className="flex items-center gap-2 text-[11px]">
          <span className="w-28 shrink-0 truncate font-mono" title={value}>
            {value}
          </span>
          <div
            className="h-2 min-w-px flex-1 overflow-hidden rounded-sm"
            style={{ backgroundColor: TRACK }}
          >
            <div
              className="h-full rounded-sm"
              style={{
                width: `${maxCount > 0 ? (count / maxCount) * 100 : 0}%`,
                backgroundColor: SERIES,
              }}
            />
          </div>
          <span className="w-10 shrink-0 text-right tabular-nums text-muted-foreground">
            {count.toLocaleString()}
          </span>
        </div>
      ))}
      {remaining > 0 ? (
        <span className="text-[11px] text-muted-foreground">
          +{remaining.toLocaleString()} more values
        </span>
      ) : null}
    </div>
  );
}
