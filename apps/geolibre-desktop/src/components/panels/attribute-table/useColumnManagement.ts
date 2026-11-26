import {
  addColumn,
  deleteColumn,
  moveColumn,
  showAllColumns,
  toggleColumnHidden,
  renameColumn,
  type ColumnMoveDirection,
  type NewColumnType,
} from "../../../lib/attribute-columns";
import { markAttributeEdit } from "../../../lib/edited-geometry-save";
import type { Dispatch, SetStateAction, RefObject } from "react";
import type { LayerCapabilities, GeoLibreLayer } from "@geolibre/core";
import type { Geometry, GeoJsonProperties, Feature } from "geojson";
import type { ColumnWidths } from "./table-sizes";
import type { SortSpec, ColumnFilterSpec } from "../../../lib/attribute-table-ops";

/**
 * The attribute table's column actions: rename, hide, exclude, reorder, delete and add a field.
 */
export function useColumnManagement({
  suppressColumnBlurRef,
  setEditingColumn,
  setEditingColumnName,
  editingColumn,
  layer,
  canManageColumns,
  editingColumnName,
  isReservedFieldName,
  mutationColumns,
  updateLayer,
  setColumnWidths,
  setSortSpecs,
  setColumnFilters,
  discoveredColumns,
  layerCaps,
  columnPendingDelete,
  setColumnPendingDelete,
  newColumnName,
  features,
  setNewColumnName,
  setNewColumnType,
  setNewColumnDefault,
  setAddingColumn,
  newColumnType,
  newColumnDefault,
}: {
  suppressColumnBlurRef: RefObject<boolean>;
  setEditingColumn: Dispatch<SetStateAction<string | null>>;
  setEditingColumnName: Dispatch<SetStateAction<string>>;
  editingColumn: string | null;
  layer: GeoLibreLayer | undefined;
  canManageColumns: boolean;
  editingColumnName: string;
  isReservedFieldName: (name: string) => boolean;
  mutationColumns: string[];
  updateLayer: (id: string, patch: Partial<GeoLibreLayer>) => void;
  setColumnWidths: Dispatch<SetStateAction<ColumnWidths>>;
  setSortSpecs: Dispatch<SetStateAction<SortSpec[]>>;
  setColumnFilters: Dispatch<SetStateAction<Record<string, ColumnFilterSpec>>>;
  discoveredColumns: string[];
  layerCaps: Required<LayerCapabilities>;
  columnPendingDelete: string | null;
  setColumnPendingDelete: Dispatch<SetStateAction<string | null>>;
  newColumnName: string;
  features: Feature<Geometry, GeoJsonProperties>[];
  setNewColumnName: Dispatch<SetStateAction<string>>;
  setNewColumnType: Dispatch<SetStateAction<NewColumnType>>;
  setNewColumnDefault: Dispatch<SetStateAction<string>>;
  setAddingColumn: Dispatch<SetStateAction<boolean>>;
  newColumnType: NewColumnType;
  newColumnDefault: string;
}) {
  const beginColumnRename = (col: string) => {
    suppressColumnBlurRef.current = false;
    setEditingColumn(col);
    setEditingColumnName(col);
  };
  const cancelColumnRename = () => {
    suppressColumnBlurRef.current = true;
    setEditingColumn(null);
    setEditingColumnName("");
  };
  const commitColumnRename = () => {
    if (suppressColumnBlurRef.current || !editingColumn || !layer || !canManageColumns) {
      suppressColumnBlurRef.current = false;
      return;
    }
    suppressColumnBlurRef.current = true;
    const oldKey = editingColumn;
    // Normalize the key here so the view-state updates below use exactly what
    // renameColumn writes. (renameColumn also trims defensively for other
    // callers; passing the already-trimmed value keeps the two in agreement.)
    const newKey = editingColumnName.trim();
    const patch = isReservedFieldName(newKey)
      ? null
      : renameColumn(layer, mutationColumns, oldKey, newKey);
    if (patch) {
      updateLayer(layer.id, markAttributeEdit(layer, patch));
      // Keep view state pointing at the renamed column.
      setColumnWidths((current) => {
        if (!(oldKey in current)) return current;
        const { [oldKey]: width, ...rest } = current;
        return { ...rest, [newKey]: width };
      });
      setSortSpecs((current) =>
        current.map((spec) => (spec.key === oldKey ? { ...spec, key: newKey } : spec)),
      );
      setColumnFilters((current) => {
        if (!(oldKey in current)) return current;
        const { [oldKey]: spec, ...rest } = current;
        return { ...rest, [newKey]: spec };
      });
    }
    // Always close the editor when committing, even on a no-op (empty,
    // unchanged, or a name that collides with an existing — possibly hidden —
    // column); the original name is kept. This matches the layer-rename UX in
    // LayerPanel. Use Escape to cancel.
    setEditingColumn(null);
    setEditingColumnName("");
  };
  const handleToggleHidden = (col: string) => {
    if (!layer) return;
    updateLayer(layer.id, toggleColumnHidden(layer, col));
  };
  const handleToggleExcluded = (col: string) => {
    if (!layer) return;
    const current = layer.fieldVisibility || {};
    const isExcluded = current[col] === "excluded";
    const next = { ...current };
    if (isExcluded) {
      delete next[col];
    } else {
      next[col] = "excluded";
    }
    updateLayer(layer.id, { fieldVisibility: next });
  };
  const handleShowAllColumns = () => {
    if (!layer) return;
    updateLayer(layer.id, showAllColumns(layer));
  };
  const handleMoveColumn = (col: string, direction: ColumnMoveDirection) => {
    if (!layer) return;
    const patch = moveColumn(layer, discoveredColumns, col, direction);
    if (patch) updateLayer(layer.id, patch);
  };
  const confirmDeleteColumn = () => {
    if (!layer || !canManageColumns || !layerCaps.delete || !columnPendingDelete) return;
    const patch = deleteColumn(layer, columnPendingDelete);
    if (patch) updateLayer(layer.id, markAttributeEdit(layer, patch));
    // Drop a sort that pointed at the deleted column, which would otherwise
    // leave sort.key referencing an absent field (every row compares equal).
    setSortSpecs((current) => {
      const remaining = current.filter((spec) => spec.key !== columnPendingDelete);
      return remaining.length > 0 ? remaining : [{ key: "__featureId", direction: "asc" }];
    });
    setColumnFilters((current) => {
      if (!(columnPendingDelete in current)) return current;
      const { [columnPendingDelete]: _removed, ...rest } = current;
      return rest;
    });
    // Drop the deleted column's width so columnWidths doesn't accumulate stale
    // entries across a session (mirrors the migration in commitColumnRename).
    setColumnWidths((current) => {
      if (!(columnPendingDelete in current)) return current;
      const { [columnPendingDelete]: _removed, ...rest } = current;
      return rest;
    });
    setColumnPendingDelete(null);
  };
  const newColumnNameTrimmed = newColumnName.trim();
  const newColumnCollides =
    newColumnNameTrimmed !== "" && mutationColumns.includes(newColumnNameTrimmed);
  const newColumnReserved = isReservedFieldName(newColumnNameTrimmed);
  // A field is only discoverable through feature property keys, so a new column
  // cannot be added to a layer with no features (see addColumn).
  const canAddColumn = features.length > 0;
  const canSubmitNewColumn =
    newColumnNameTrimmed !== "" && !newColumnCollides && !newColumnReserved && canAddColumn;
  const openAddColumn = () => {
    setNewColumnName("");
    setNewColumnType("text");
    setNewColumnDefault("");
    setAddingColumn(true);
  };
  const changeNewColumnType = (type: NewColumnType) => {
    setNewColumnType(type);
    // Reset the default to blank ("no default" → null) for every type so a value
    // typed for one type does not carry over to an incompatible one, and so the
    // user must explicitly choose a value rather than silently persisting one.
    setNewColumnDefault("");
  };
  const confirmAddColumn = () => {
    if (!layer || !canManageColumns || !canSubmitNewColumn) return;
    const patch = addColumn(layer, mutationColumns, newColumnName, newColumnType, newColumnDefault);
    if (patch) updateLayer(layer.id, markAttributeEdit(layer, patch));
    setAddingColumn(false);
  };
  return {
    beginColumnRename,
    cancelColumnRename,
    commitColumnRename,
    handleToggleHidden,
    handleToggleExcluded,
    handleShowAllColumns,
    handleMoveColumn,
    confirmDeleteColumn,
    newColumnNameTrimmed,
    newColumnCollides,
    newColumnReserved,
    canAddColumn,
    canSubmitNewColumn,
    openAddColumn,
    changeNewColumnType,
    confirmAddColumn,
  };
}
