import type { TFunction } from "i18next";
import {
  ScrollArea,
  TableHeader,
  TableRow,
  TableHead,
  TableBody,
  TableCell,
  Select,
  Input,
} from "@geolibre/ui";
import { AttributeCardList } from "./AttributeCardList";
import {
  type SortKey,
  type SortDirection,
  CELL_PADDING,
  VERTICAL_SCROLLBAR_GUTTER,
} from "./table-layout";
import type { CSSProperties, RefObject, MouseEvent as ReactMouseEvent } from "react";
import {
  getAttributeDraftRow,
  draftCandidate,
  isInvalidObjectDraft,
  type AttributeTableRow,
  type RowFormResolver,
} from "./attribute-drafts";
import { formatAttributeValue } from "../../../lib/vector-export";
import { formatAttributeCellText } from "../../../lib/attribute-columns";
import {
  attributeLinkUrl,
  type GeoLibreLayer,
  type AttributeTableDrafts as AttributeDrafts,
  type AttributeFormFieldError,
} from "@geolibre/core";
import { valueMapOptions } from "./value-map-options";
import { openExternalLink } from "../../../lib/open-external";
import type { SortSpec } from "../../../lib/attribute-table-ops";
import type { MapEngine } from "@geolibre/map";
import type { Dispatch, JSX, SetStateAction } from "react";
import type { VirtualItem, Virtualizer } from "@tanstack/react-virtual";
import type { i18n } from "i18next";
import type { ArcGISAttributeConstraints } from "@geolibre/plugins/arcgis-layer";

interface AttributeTableGridProps {
  scrollViewportRef: RefObject<HTMLDivElement | null>;
  hasAttributeSource: boolean;
  loadingVectorGeojson: boolean;
  t: TFunction<"translation", undefined>;
  isCardViewActive: boolean;
  sorted: AttributeTableRow[];
  columns: string[];
  selectedIdSet: Set<string>;
  selectedFeatureId: string | null;
  sort: SortSpec;
  setSortSpecs: Dispatch<SetStateAction<SortSpec[]>>;
  handleRowClick: (featureId: string, event: ReactMouseEvent<HTMLElement>) => void;
  selectFeature: (id: string | null) => void;
  layer: GeoLibreLayer | undefined;
  mapControllerRef: RefObject<MapEngine | null>;
  tableWidth: string;
  tableColumns: string[];
  columnWidth: (key: SortKey) => number;
  sortableHeader: (key: SortKey, label: string, numeric?: boolean) => JSX.Element;
  attributeColumnHeader: (col: string, index: number) => JSX.Element;
  paddingTop: number;
  virtualRows: VirtualItem[];
  drafts: AttributeDrafts;
  formForRow: RowFormResolver;
  rowVirtualizer: Virtualizer<HTMLDivElement, Element>;
  formDraftErrors: Record<string, Record<string, AttributeFormFieldError>>;
  i18n: i18n;
  numericColumns: Set<string>;
  isEditing: boolean;
  canEnterEditMode: boolean;
  readOnlyColumns: Set<string>;
  formErrorText: (error: AttributeFormFieldError) => string;
  updateCellDraft: (
    featureId: string,
    column: string,
    value: string,
    previousValue: unknown,
  ) => void;
  virtualFieldColumns: Set<string>;
  joinDerivedColumns: Set<string>;
  trackingColumns: Set<string>;
  serviceConstraints: ArcGISAttributeConstraints | undefined;
  paddingBottom: number;
}

/** The attribute table's virtualized grid: header row, filter row and the visible feature rows. */
export function AttributeTableGrid({
  scrollViewportRef,
  hasAttributeSource,
  loadingVectorGeojson,
  t,
  isCardViewActive,
  sorted,
  columns,
  selectedIdSet,
  selectedFeatureId,
  sort,
  setSortSpecs,
  handleRowClick,
  selectFeature,
  layer,
  mapControllerRef,
  tableWidth,
  tableColumns,
  columnWidth,
  sortableHeader,
  attributeColumnHeader,
  paddingTop,
  virtualRows,
  drafts,
  formForRow,
  rowVirtualizer,
  formDraftErrors,
  i18n,
  numericColumns,
  isEditing,
  canEnterEditMode,
  readOnlyColumns,
  formErrorText,
  updateCellDraft,
  virtualFieldColumns,
  joinDerivedColumns,
  trackingColumns,
  serviceConstraints,
  paddingBottom,
}: AttributeTableGridProps) {
  return (
    <ScrollArea
      type="always"
      viewportRef={scrollViewportRef}
      className="flex-1 [&_[data-orientation=vertical]]:!top-[1.875rem] [&_[data-orientation=vertical]]:!h-[calc(100%-2.75rem)]"
    >
      {!hasAttributeSource ? (
        <p className="p-4 text-xs text-muted-foreground">
          {loadingVectorGeojson
            ? t("attributeTable.loadingAttributes")
            : t("attributeTable.requiresVectorLayer")}
        </p>
      ) : isCardViewActive ? (
        <AttributeCardList
          rows={sorted}
          columns={columns}
          selectedIds={selectedIdSet}
          activeFeatureId={selectedFeatureId}
          scrollElementRef={scrollViewportRef}
          sortKey={sort.key}
          sortDirection={sort.direction}
          onChangeSortKey={(key) => setSortSpecs([{ key, direction: "asc" }])}
          onToggleSortDirection={() =>
            setSortSpecs((current) => {
              const primary = current[0] ?? {
                key: "__featureId" as SortKey,
                direction: "asc" as SortDirection,
              };
              return [
                {
                  ...primary,
                  direction: primary.direction === "asc" ? "desc" : "asc",
                },
                ...current.slice(1),
              ];
            })
          }
          onSelectRow={handleRowClick}
          onZoomRow={(featureId) => {
            selectFeature(featureId);
            if (layer) {
              mapControllerRef.current?.highlightFeature(layer, [featureId], { fit: true });
            }
          }}
        />
      ) : (
        // mb-3.5 reserves room for the horizontal scrollbar, which overlays
        // the viewport and would otherwise cover the last row even at full
        // scroll.
        <table
          data-testid="attribute-table"
          // The last column's cells pad past the vertical scrollbar
          // (p-2 + VERTICAL_SCROLLBAR_GUTTER) so its values stay visible.
          className="mb-3.5 table-fixed caption-bottom text-sm [&_tr>*:last-child]:pe-[var(--attribute-table-last-pe)]"
          style={
            {
              minWidth: "100%",
              width: tableWidth,
              "--attribute-table-last-pe": `calc(${CELL_PADDING} + ${VERTICAL_SCROLLBAR_GUTTER})`,
            } as CSSProperties
          }
        >
          <colgroup>
            {tableColumns.map((col, index) => (
              <col
                key={col}
                style={{
                  width:
                    index === tableColumns.length - 1
                      ? `calc(${columnWidth(col)}px + ${VERTICAL_SCROLLBAR_GUTTER})`
                      : columnWidth(col),
                }}
              />
            ))}
          </colgroup>
          <TableHeader className="sticky top-0 z-10 bg-card shadow-xs">
            <TableRow>
              <TableHead className="h-[30px] bg-card">
                {sortableHeader("__featureId", "#")}
              </TableHead>
              {columns.map((col, index) => (
                <TableHead key={col} className="h-[30px] bg-card">
                  {attributeColumnHeader(col, index)}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {paddingTop > 0 ? (
              <tr aria-hidden="true">
                <td colSpan={tableColumns.length} style={{ height: paddingTop }} />
              </tr>
            ) : null}
            {virtualRows.map((virtualRow) => {
              const { featureId, properties } = sorted[virtualRow.index];
              const selected = selectedIdSet.has(featureId);
              const rowDrafts = getAttributeDraftRow(drafts, featureId);
              // Follows a drafted type/subtype, so dependent dropdowns
              // and bounds update as soon as the selector changes.
              const drafted = rowDrafts
                ? draftCandidate(properties, rowDrafts, formForRow)
                : undefined;
              const rowForm = drafted?.rowForm ?? formForRow(properties);
              const rowCandidate = drafted?.candidate ?? properties;
              return (
                <TableRow
                  key={featureId}
                  data-index={virtualRow.index}
                  ref={rowVirtualizer.measureElement}
                  data-state={selected ? "selected" : undefined}
                  // The shared row's selected tint (bg-muted) nearly
                  // vanishes in the dark theme and behind edit-mode
                  // inputs, so selection here uses the primary color.
                  className="cursor-pointer select-none data-[state=selected]:bg-primary/20 data-[state=selected]:hover:bg-primary/25 [&[data-state=selected]_input]:border-primary/70"
                  // Shift-click would otherwise select the page text between
                  // rows; suppress that so range picks stay clean.
                  onMouseDown={(event) => {
                    if (event.shiftKey) event.preventDefault();
                  }}
                  onClick={(event) => {
                    handleRowClick(featureId, event);
                  }}
                >
                  <TableCell className="py-[3px]">
                    <span className="block max-w-full truncate" title={featureId}>
                      {featureId}
                    </span>
                  </TableCell>
                  {columns.map((col) => {
                    const value = properties[col];
                    const draft = rowDrafts?.[col];
                    const changed = draft !== undefined;
                    const formError = formDraftErrors[featureId]?.[col];
                    const invalid =
                      (draft !== undefined && isInvalidObjectDraft(draft, value)) ||
                      formError !== undefined;
                    const inputClassName = invalid
                      ? "h-7 min-w-0 border-destructive bg-destructive/10 px-2 text-xs"
                      : changed
                        ? "h-7 min-w-0 border-primary/60 bg-primary/10 px-2 text-xs"
                        : "h-7 min-w-0 px-2 text-xs";
                    const config = rowForm.fields.get(col);
                    // Service coded values read as their published names;
                    // the stored code stays in the tooltip.
                    const codeLabel =
                      config?.widget === "valueMap" &&
                      rowForm.serviceForm?.fields.some((entry) => entry.field === col) &&
                      value != null
                        ? config.valueMap?.find((entry) => entry.value === String(value))?.label
                        : undefined;
                    const formattedValue = formatAttributeValue(value);
                    // Display-only text: numbers rounded and grouped for
                    // the active language, null/missing as null so it can
                    // read NULL. Edits, sorting and export use the raw value.
                    const cellText = formatAttributeCellText(value, i18n.language);
                    const numeric = numericColumns.has(col);
                    const current = draft ?? formattedValue;
                    const isEditableCell =
                      isEditing && canEnterEditMode && !readOnlyColumns.has(col);
                    const linkUrl = isEditableCell ? null : attributeLinkUrl(value);
                    const invalidTitle = invalid
                      ? formError
                        ? formErrorText(formError)
                        : t("attributeTable.invalidJson")
                      : undefined;
                    const cellAria = t("attributeTable.editCellAria", {
                      col,
                      featureId,
                    });
                    const commitDraft = (next: string) =>
                      updateCellDraft(featureId, col, next, value);
                    // Explains where a derived column comes from. The value
                    // span sets its own tooltip, so the hint is appended
                    // there too, or hovering the text would hide it.
                    const columnHint = virtualFieldColumns.has(col)
                      ? t("attributeTable.virtualColumnTitle")
                      : joinDerivedColumns.has(col)
                        ? t("attributeTable.joinedColumnTitle")
                        : trackingColumns.has(col)
                          ? t("attributeTable.trackingColumnTitle")
                          : undefined;
                    const withColumnHint = (text: string) =>
                      [text, columnHint].filter(Boolean).join("\n") || undefined;
                    return (
                      <TableCell
                        key={col}
                        data-state={changed ? "edited" : undefined}
                        className="py-[3px] data-[state=edited]:bg-primary/10 data-[state=edited]:shadow-[inset_3px_0_0_hsl(var(--primary))]"
                        title={columnHint}
                      >
                        {isEditableCell ? (
                          config?.widget === "valueMap" && config.valueMap?.length ? (
                            <Select
                              className={inputClassName}
                              aria-invalid={invalid || undefined}
                              title={invalidTitle}
                              aria-label={cellAria}
                              value={current}
                              onClick={(event) => event.stopPropagation()}
                              onChange={(event) => commitDraft(event.target.value)}
                            >
                              <option value="">—</option>
                              {/* Keep an out-of-map current value listed so
                                      the select shows it instead of silently
                                      snapping to the first entry. */}
                              {current !== "" &&
                                !config.valueMap.some((entry) => entry.value === current) && (
                                  <option value={current}>{current}</option>
                                )}
                              {valueMapOptions(
                                config.valueMap,
                                serviceConstraints?.contingentChoices(rowCandidate, col),
                                t,
                              )}
                            </Select>
                          ) : config?.widget === "checkbox" ? (
                            <input
                              type="checkbox"
                              className="h-4 w-4"
                              aria-invalid={invalid || undefined}
                              title={invalidTitle}
                              aria-label={cellAria}
                              checked={current === "true"}
                              onClick={(event) => event.stopPropagation()}
                              onChange={(event) =>
                                commitDraft(event.target.checked ? "true" : "false")
                              }
                            />
                          ) : (
                            <Input
                              className={inputClassName}
                              type={
                                config?.widget === "number" || config?.widget === "range"
                                  ? "number"
                                  : config?.widget === "date"
                                    ? "date"
                                    : "text"
                              }
                              min={config?.min}
                              max={config?.max}
                              step={config?.step}
                              aria-invalid={invalid || undefined}
                              title={invalidTitle}
                              aria-label={cellAria}
                              value={current}
                              onClick={(event) => event.stopPropagation()}
                              onChange={(event) => commitDraft(event.target.value)}
                            />
                          )
                        ) : linkUrl ? (
                          <a
                            href={linkUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            title={withColumnHint(linkUrl)}
                            className="inline-block max-w-full truncate align-bottom text-primary underline underline-offset-2"
                            onClick={(event) => {
                              event.preventDefault();
                              event.stopPropagation();
                              void openExternalLink(linkUrl);
                            }}
                          >
                            {linkUrl}
                          </a>
                        ) : codeLabel ? (
                          <span
                            className="block max-w-full truncate"
                            title={withColumnHint(
                              formattedValue && formattedValue !== codeLabel
                                ? `${codeLabel} (${formattedValue})`
                                : codeLabel,
                            )}
                          >
                            {codeLabel}
                          </span>
                        ) : cellText === null ? (
                          <span
                            className={`block max-w-full truncate italic text-muted-foreground ${
                              numeric ? "text-end" : ""
                            }`}
                            title={columnHint}
                          >
                            {t("attributeTable.nullValue")}
                          </span>
                        ) : (
                          <span
                            className={
                              numeric
                                ? "block max-w-full truncate text-end tabular-nums"
                                : "block max-w-full truncate"
                            }
                            // The raw value stays in the tooltip, so the
                            // unrounded number is one hover away.
                            title={withColumnHint(formattedValue)}
                          >
                            {cellText}
                          </span>
                        )}
                      </TableCell>
                    );
                  })}
                </TableRow>
              );
            })}
            {paddingBottom > 0 ? (
              <tr aria-hidden="true">
                <td colSpan={tableColumns.length} style={{ height: paddingBottom }} />
              </tr>
            ) : null}
          </TableBody>
        </table>
      )}
    </ScrollArea>
  );
}
