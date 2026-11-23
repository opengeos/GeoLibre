import { useState } from "react";
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
} from "@geolibre/ui";
import { useTranslation } from "react-i18next";
import type { ColumnFilterMode, ColumnFilterSpec } from "../../lib/attribute-table-ops";

interface AttributeBulkEditDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editableColumns: string[];
  selectedCount: number;
  filteredCount: number;
  onBulkFill: (options: {
    column: string;
    value: string;
    scope: "selected" | "filtered";
  }) => number;
  onFindReplace: (options: {
    column: string;
    find: string;
    replace: string;
    matchCase: boolean;
    wholeCell: boolean;
    scope: "selected" | "filtered";
  }) => number;
}

export function AttributeBulkEditDialog({
  open,
  onOpenChange,
  editableColumns,
  selectedCount,
  filteredCount,
  onBulkFill,
  onFindReplace,
}: AttributeBulkEditDialogProps) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<"replace" | "fill">("replace");
  const [column, setColumn] = useState<string>(editableColumns[0] ?? "");
  const [scope, setScope] = useState<"selected" | "filtered">(
    selectedCount > 0 ? "selected" : "filtered",
  );
  const [find, setFind] = useState("");
  const [replace, setReplace] = useState("");
  const [fillValue, setFillValue] = useState("");
  const [matchCase, setMatchCase] = useState(false);
  const [wholeCell, setWholeCell] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  const activeColumn = editableColumns.includes(column) ? column : (editableColumns[0] ?? "");
  const effectiveScope = scope === "selected" && selectedCount === 0 ? "filtered" : scope;

  const handleApply = () => {
    if (!activeColumn) return;
    const count =
      mode === "fill"
        ? onBulkFill({ column: activeColumn, value: fillValue, scope: effectiveScope })
        : onFindReplace({
            column: activeColumn,
            find,
            replace,
            matchCase,
            wholeCell,
            scope: effectiveScope,
          });
    setStatus(t("attributeTable.bulkEdit.updatedCount", { count }));
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t("attributeTable.bulkEdit.title")}</DialogTitle>
          <DialogDescription>{t("attributeTable.bulkEdit.description")}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3 py-1">
          <div className="grid grid-cols-2 gap-2">
            <Button
              type="button"
              size="sm"
              variant={mode === "replace" ? "secondary" : "outline"}
              onClick={() => {
                setMode("replace");
                setStatus(null);
              }}
            >
              {t("attributeTable.bulkEdit.findReplace")}
            </Button>
            <Button
              type="button"
              size="sm"
              variant={mode === "fill" ? "secondary" : "outline"}
              onClick={() => {
                setMode("fill");
                setStatus(null);
              }}
            >
              {t("attributeTable.bulkEdit.bulkFill")}
            </Button>
          </div>
          <div className="space-y-1">
            <Label htmlFor="bulk-edit-col" className="text-xs">
              {t("attributeTable.bulkEdit.column")}
            </Label>
            <Select
              id="bulk-edit-col"
              value={activeColumn}
              onChange={(e) => setColumn(e.target.value)}
              disabled={editableColumns.length === 0}
            >
              {editableColumns.map((col) => (
                <option key={col} value={col}>
                  {col}
                </option>
              ))}
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="bulk-edit-scope" className="text-xs">
              {t("attributeTable.bulkEdit.scope")}
            </Label>
            <Select
              id="bulk-edit-scope"
              value={effectiveScope}
              onChange={(e) => setScope(e.target.value as "selected" | "filtered")}
            >
              <option value="selected" disabled={selectedCount === 0}>
                {t("attributeTable.bulkEdit.scopeSelected", { count: selectedCount })}
              </option>
              <option value="filtered">
                {t("attributeTable.bulkEdit.scopeFiltered", { count: filteredCount })}
              </option>
            </Select>
          </div>
          {mode === "replace" ? (
            <>
              <div className="space-y-1">
                <Label htmlFor="bulk-edit-find" className="text-xs">
                  {t("attributeTable.bulkEdit.find")}
                </Label>
                <Input
                  id="bulk-edit-find"
                  value={find}
                  onChange={(e) => setFind(e.target.value)}
                  className="h-8 text-xs"
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="bulk-edit-replace" className="text-xs">
                  {t("attributeTable.bulkEdit.replaceWith")}
                </Label>
                <Input
                  id="bulk-edit-replace"
                  value={replace}
                  onChange={(e) => setReplace(e.target.value)}
                  className="h-8 text-xs"
                />
              </div>
              <div className="flex items-center gap-4 text-xs">
                <label className="flex items-center gap-1.5">
                  <input
                    type="checkbox"
                    checked={matchCase}
                    onChange={(e) => setMatchCase(e.target.checked)}
                  />
                  {t("attributeTable.bulkEdit.matchCase")}
                </label>
                <label className="flex items-center gap-1.5">
                  <input
                    type="checkbox"
                    checked={wholeCell}
                    onChange={(e) => setWholeCell(e.target.checked)}
                  />
                  {t("attributeTable.bulkEdit.wholeCell")}
                </label>
              </div>
            </>
          ) : (
            <div className="space-y-1">
              <Label htmlFor="bulk-edit-fill" className="text-xs">
                {t("attributeTable.bulkEdit.fillValue")}
              </Label>
              <Input
                id="bulk-edit-fill"
                value={fillValue}
                onChange={(e) => setFillValue(e.target.value)}
                className="h-8 text-xs"
              />
            </div>
          )}
          {status ? <p className="text-xs text-muted-foreground">{status}</p> : null}
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            {t("common.close")}
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={!activeColumn || (mode === "replace" && !find)}
            onClick={handleApply}
          >
            {t("attributeTable.bulkEdit.apply")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

interface ColumnFilterBarProps {
  columns: string[];
  numericColumns: ReadonlySet<string>;
  filters: Readonly<Record<string, ColumnFilterSpec>>;
  onChangeFilter: (column: string, spec: ColumnFilterSpec | null) => void;
  onClearAll: () => void;
}

export function ColumnFilterBar({
  columns,
  numericColumns,
  filters,
  onChangeFilter,
  onClearAll,
}: ColumnFilterBarProps) {
  const { t } = useTranslation();
  const [selectedCol, setSelectedCol] = useState<string>(columns[0] ?? "");
  const [editorModes, setEditorModes] = useState<Record<string, ColumnFilterMode>>({});
  const activeCol = columns.includes(selectedCol) ? selectedCol : (columns[0] ?? "");
  const current = activeCol ? filters[activeCol] : undefined;
  const defaultMode: ColumnFilterMode =
    activeCol && numericColumns.has(activeCol) ? "range" : "contains";
  const mode: ColumnFilterMode = current?.mode ?? (activeCol ? editorModes[activeCol] : undefined) ?? defaultMode;
  const activeEntries = Object.entries(filters);

  if (columns.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-2 border-b bg-muted/30 px-3 py-1.5 text-xs">
      <Select
        compact
        aria-label={t("attributeTable.columnFilter.column")}
        value={activeCol}
        onChange={(e) => setSelectedCol(e.target.value)}
      >
        {columns.map((col) => (
          <option key={col} value={col}>
            {col}
          </option>
        ))}
      </Select>
      <Select
        compact
        aria-label={t("attributeTable.columnFilter.mode")}
        value={mode}
        onChange={(e) => {
          if (!activeCol) return;
          const nextMode = e.target.value as ColumnFilterMode;
          setEditorModes((prev) => ({ ...prev, [activeCol]: nextMode }));
          onChangeFilter(activeCol, { ...current, mode: nextMode });
        }}
      >
        <option value="contains">{t("attributeTable.columnFilter.contains")}</option>
        <option value="equals">{t("attributeTable.columnFilter.equals")}</option>
        <option value="range">{t("attributeTable.columnFilter.range")}</option>
        <option value="is-null">{t("attributeTable.columnFilter.isNull")}</option>
        <option value="not-null">{t("attributeTable.columnFilter.notNull")}</option>
      </Select>
      {mode === "contains" || mode === "equals" ? (
        <Input
          className="h-7 w-40 text-xs"
          placeholder={t("attributeTable.columnFilter.valuePlaceholder")}
          value={current?.text ?? ""}
          onChange={(e) => activeCol && onChangeFilter(activeCol, { mode, text: e.target.value })}
        />
      ) : mode === "range" ? (
        <div className="flex items-center gap-1">
          <Input
            type="number"
            className="h-7 w-24 text-xs"
            placeholder={t("attributeTable.columnFilter.min")}
            value={current?.min ?? ""}
            onChange={(e) =>
              activeCol &&
              onChangeFilter(activeCol, { mode: "range", min: e.target.value, max: current?.max })
            }
          />
          <span className="text-muted-foreground">..</span>
          <Input
            type="number"
            className="h-7 w-24 text-xs"
            placeholder={t("attributeTable.columnFilter.max")}
            value={current?.max ?? ""}
            onChange={(e) =>
              activeCol &&
              onChangeFilter(activeCol, { mode: "range", min: current?.min, max: e.target.value })
            }
          />
        </div>
      ) : null}
      {activeEntries.length > 0 ? (
        <div className="ms-auto flex flex-wrap items-center gap-1.5">
          {activeEntries.map(([col]) => (
            <Button
              key={col}
              type="button"
              size="sm"
              variant="secondary"
              className="h-6 px-2 text-[11px]"
              onClick={() => {
                setEditorModes((prev) => {
                  if (!(col in prev)) return prev;
                  const next = { ...prev };
                  delete next[col];
                  return next;
                });
                onChangeFilter(col, null);
              }}
            >
              {col} ×
            </Button>
          ))}
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-6 px-2 text-[11px]"
            onClick={() => {
              setEditorModes({});
              onClearAll();
            }}
          >
            {t("attributeTable.columnFilter.clearAll")}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
