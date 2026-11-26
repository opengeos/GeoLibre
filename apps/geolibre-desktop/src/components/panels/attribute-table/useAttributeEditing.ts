import { computeBulkFillDrafts, computeFindReplaceDrafts } from "../../../lib/attribute-table-ops";
import {
  currentEditorIdentity,
  editorTrackingFieldNames,
  excludeHiddenFieldsFromGeojson,
  type AttributeFormFieldError,
} from "@geolibre/core";
import { updateDuckDBLayerRows } from "@geolibre/plugins/maplibre-duckdb";
import { useEffect } from "react";
import { markAttributeEdit } from "../../../lib/edited-geometry-save";
import { attributeFormErrorMessage } from "../../../lib/attribute-form-messages";
import { registerPendingAttributeDrafts } from "../../../lib/attribute-draft-commit";
import {
  exportVectorLayer,
  formatAttributeValue,
  kmlExportErrorMessage,
  sanitizeExportFileName,
  shapefileFieldWarnings,
  type VectorExportFormat,
} from "../../../lib/vector-export";
import {
  getAttributeDraftRow,
  applyDraftsToFeatures,
  applyDraftsToDuckDBRows,
} from "./attribute-drafts";
import type { AttributeTableRow } from "../../../lib/attribute-table-ops";
import type { TFunction } from "i18next";
import type { RowFormResolver } from "./attribute-drafts";
import type { Dispatch, SetStateAction } from "react";
import type { AttributeTableDrafts as AttributeDrafts, GeoLibreLayer } from "@geolibre/core";

/**
 * The attribute table's edit session: bulk fill, find and replace, cell drafts, saving drafts back to the layer, and exporting with drafts applied.
 */
export function useAttributeEditing({
  canEnterEditMode,
  readOnlyColumns,
  selectedIdSet,
  filtered,
  attributeRows,
  drafts,
  setIsEditing,
  setDrafts,
  t,
  isEditing,
  hasEdits,
  layer,
  hasUnsafeDraftTargets,
  hasInvalidDrafts,
  hasFormErrors,
  isDuckDBLayer,
  formForRow,
  updateLayer,
  setExportError,
  setExportWarning,
}: {
  canEnterEditMode: boolean;
  readOnlyColumns: Set<string>;
  selectedIdSet: Set<string>;
  filtered: AttributeTableRow[];
  attributeRows: AttributeTableRow[];
  drafts: AttributeDrafts;
  setIsEditing: (editing: boolean) => void;
  setDrafts: (next: AttributeDrafts | ((current: AttributeDrafts) => AttributeDrafts)) => void;
  t: TFunction<"translation", undefined>;
  isEditing: boolean;
  hasEdits: boolean;
  layer: GeoLibreLayer | undefined;
  hasUnsafeDraftTargets: boolean;
  hasInvalidDrafts: boolean;
  hasFormErrors: boolean;
  isDuckDBLayer: boolean;
  formForRow: RowFormResolver;
  updateLayer: (id: string, patch: Partial<GeoLibreLayer>) => void;
  setExportError: Dispatch<SetStateAction<string | null>>;
  setExportWarning: Dispatch<SetStateAction<string | null>>;
}) {
  const handleBulkFill = ({
    column,
    value,
    scope,
  }: {
    column: string;
    value: string;
    scope: "selected" | "filtered";
  }): number => {
    if (!canEnterEditMode || readOnlyColumns.has(column)) return 0;
    const targetRowIds =
      scope === "selected" && selectedIdSet.size > 0
        ? selectedIdSet
        : new Set(filtered.map((row) => row.featureId));
    const result = computeBulkFillDrafts({
      rows: attributeRows,
      targetRowIds,
      column,
      value,
      currentDrafts: drafts,
    });
    if (result.updatedCount > 0) {
      setIsEditing(true);
      setDrafts(result.drafts);
    }
    return result.updatedCount;
  };
  const handleFindReplace = ({
    column,
    find,
    replace,
    matchCase,
    wholeCell,
    scope,
  }: {
    column: string;
    find: string;
    replace: string;
    matchCase: boolean;
    wholeCell: boolean;
    scope: "selected" | "filtered";
  }): number => {
    if (!canEnterEditMode || readOnlyColumns.has(column)) return 0;
    const targetRowIds =
      scope === "selected" && selectedIdSet.size > 0
        ? selectedIdSet
        : new Set(filtered.map((row) => row.featureId));
    const result = computeFindReplaceDrafts({
      rows: attributeRows,
      targetRowIds,
      column,
      find,
      replace,
      matchCase,
      wholeCell,
      currentDrafts: drafts,
    });
    if (result.updatedCount > 0) {
      setIsEditing(true);
      setDrafts(result.drafts);
    }
    return result.updatedCount;
  };
  // Localize an Attribute Form validation error for a cell tooltip.
  const formErrorText = (error: AttributeFormFieldError): string =>
    attributeFormErrorMessage(t, error);
  const updateCellDraft = (
    featureId: string,
    column: string,
    value: string,
    previousValue: unknown,
  ) => {
    setDrafts((current) => {
      const row = { ...getAttributeDraftRow(current, featureId) };

      if (value === formatAttributeValue(previousValue)) {
        delete row[column];
      } else {
        row[column] = value;
      }

      const rows = Object.entries(current).filter(([id]) => id !== featureId);
      if (Object.keys(row).length > 0) rows.push([featureId, row]);
      return Object.fromEntries(rows);
    });
  };
  const cancelEditing = () => {
    setIsEditing(false);
    setDrafts({});
  };
  const toggleEditing = () => {
    if (isEditing && !hasEdits) {
      setIsEditing(false);
      return;
    }

    if (!isEditing) {
      setIsEditing(true);
    }
  };
  /** Apply the drafts to the layer; returns whether they were committed. */
  const saveDrafts = (): boolean => {
    // Re-read the capability here rather than trusting the disabled state:
    // edit mode (and the dialogs below) can be open across a project reload or
    // a collaborator's change that revokes the capability, and the commit would
    // otherwise still run.
    if (
      !layer ||
      !canEnterEditMode ||
      !hasEdits ||
      hasUnsafeDraftTargets ||
      hasInvalidDrafts ||
      hasFormErrors
    )
      return false;

    if (isDuckDBLayer) {
      updateDuckDBLayerRows(layer.id, applyDraftsToDuckDBRows(attributeRows, drafts));
      setIsEditing(false);
      setDrafts({});
      return true;
    }

    if (!layer.geojson) return false;

    const geojson = {
      ...layer.geojson,
      features: applyDraftsToFeatures(
        layer.geojson.features,
        drafts,
        formForRow,
        editorTrackingFieldNames(layer.editorTracking)
          ? {
              config: layer.editorTracking,
              userIdentity: currentEditorIdentity(),
              // One timestamp for the save, so rows edited together agree.
              timestamp: new Date().toISOString(),
            }
          : undefined,
      ),
    };

    updateLayer(layer.id, markAttributeEdit(layer, { geojson }));
    setIsEditing(false);
    setDrafts({});
    return true;
  };
  // Offer unsaved drafts to the Layers panel's write-back action, which reads
  // the layer from the store: without this, Save edits to source/ArcGIS/PostGIS
  // silently writes the pre-edit values the table no longer shows (#2438, #2439).
  // Re-registered every render so the committer always sees the latest drafts.
  const pendingDraftsLayerId = isEditing && hasEdits ? (layer?.id ?? null) : null;
  useEffect(() => {
    if (!pendingDraftsLayerId) return;
    return registerPendingAttributeDrafts(pendingDraftsLayerId, saveDrafts);
  });
  const geojsonWithDrafts = () => {
    if (!layer?.geojson || hasUnsafeDraftTargets) return null;

    return {
      ...layer.geojson,
      features: applyDraftsToFeatures(layer.geojson.features, drafts, formForRow),
    };
  };
  const exportLayer = async (format: VectorExportFormat, precision?: number) => {
    if (!layer?.geojson) return;
    if (hasUnsafeDraftTargets) {
      setExportError(t("layers.pendingTableDraftsBlocked"));
      return;
    }

    try {
      setExportError(null);
      setExportWarning(null);
      let exportGeojson = geojsonWithDrafts();
      if (!exportGeojson) return;
      if (layer.fieldVisibility) {
        exportGeojson = excludeHiddenFieldsFromGeojson(exportGeojson, layer.fieldVisibility);
      }

      const baseName = sanitizeExportFileName(layer.name);
      const polylinePrecision =
        precision ??
        (typeof layer.metadata?.polylinePrecision === "number"
          ? layer.metadata.polylinePrecision
          : 5);
      const savedPath = await exportVectorLayer(
        exportGeojson,
        format,
        baseName,
        layer.name,
        polylinePrecision,
      );
      // Surface Shapefile field-name limitations (10-char truncation and any
      // resulting collisions) only when a file was actually written; a null
      // path means the user cancelled the save dialog.
      if (savedPath !== null && format === "shapefile") {
        const warnings = shapefileFieldWarnings(exportGeojson);
        setExportWarning(warnings.length > 0 ? warnings.join(" ") : null);
      }
    } catch (error) {
      console.error("Failed to export attribute table", error);
      setExportError(
        kmlExportErrorMessage(error, t) ??
          (error instanceof Error ? error.message : t("attributeTable.exportFailed")),
      );
    }
  };
  return {
    handleBulkFill,
    handleFindReplace,
    formErrorText,
    updateCellDraft,
    cancelEditing,
    toggleEditing,
    saveDrafts,
    exportLayer,
  };
}
