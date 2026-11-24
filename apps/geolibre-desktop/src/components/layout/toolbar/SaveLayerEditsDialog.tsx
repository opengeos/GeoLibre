/**
 * Modal dialog for Project → Save layer edits to source files (issue #3528).
 *
 * Lists every layer backed by a writable source (local GeoJSON/GeoPackage files
 * on desktop, PostGIS/SQL Server tables, or writable ArcGIS feature services)
 * with checkboxes and a Select All toggle, plus quick external-copy actions
 * (Save copies to folder on desktop, or Export layers as GeoJSON ZIP).
 */

import { useAppCapability, useAppStore, useLayersWhen } from "@geolibre/core";
import {
  getGeometryEditTargetLayerId,
  subscribeGeometryEdit,
} from "@geolibre/plugins/geo-editor-state";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@geolibre/ui";
import { AlertTriangle, Archive, CheckCircle2, FolderOutput, Loader2, XCircle } from "lucide-react";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { browserSafeFileName, isImportedDocumentCopyPath } from "../../../lib/file-io/paths";
import {
  defaultSelectedWritableLayerIds,
  listWritableLayerCandidates,
  type BatchLayerSaveItemResult,
  type LayerWriteBackDisabledReason,
  type WritableLayerCandidate,
} from "../../../lib/batch-layer-save";
import { IS_MAS_BUILD } from "../../../lib/build-flags";
import { isExportableGeojsonLayer } from "../../../lib/geojson-zip-export";
import { isTauri } from "../../../lib/is-tauri";
import { notify } from "../../../lib/notify";

export interface SaveLayerEditsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * Write the selected layers back to their sources. Receives progress callbacks
   * so each row can show a live spinner and outcome.
   */
  onSaveSelected: (
    layerIds: string[],
    callbacks: {
      onLayerStart: (layerId: string) => void;
      onLayerDone: (result: BatchLayerSaveItemResult) => void;
    },
  ) => Promise<{ hasIssues: boolean; aborted: boolean }>;
  /** Export selected (or all, if none selected) exportable GeoJSON layers as a ZIP. */
  onExportGeojsonZip: (layerIds?: ReadonlySet<string>) => Promise<boolean>;
  /** Desktop-only: save external `.geojson` copies of the selected layers to a chosen folder. */
  onSaveCopiesToFolder?: (layerIds?: ReadonlySet<string>) => Promise<boolean>;
  /** Override for tests to inject custom writable candidates. */
  candidatesOverride?: WritableLayerCandidate[];
}

function disabledReasonKey(
  reason: LayerWriteBackDisabledReason,
):
  | "toolbar.saveLayerEdits.disabledGeometryEdit"
  | "toolbar.saveLayerEdits.disabledMssqlRefresh"
  | "toolbar.saveLayerEdits.disabledPostgisRefresh"
  | "toolbar.saveLayerEdits.disabledReadOnly" {
  switch (reason) {
    case "geometryEditActive":
      return "toolbar.saveLayerEdits.disabledGeometryEdit";
    case "mssqlRefreshRequired":
      return "toolbar.saveLayerEdits.disabledMssqlRefresh";
    case "postgisRefreshRequired":
      return "toolbar.saveLayerEdits.disabledPostgisRefresh";
    case "readOnlyCollaboration":
      return "toolbar.saveLayerEdits.disabledReadOnly";
  }
}

export function SaveLayerEditsDialog({
  open,
  onOpenChange,
  onSaveSelected,
  onExportGeojsonZip,
  onSaveCopiesToFolder,
  candidatesOverride,
}: SaveLayerEditsDialogProps) {
  const { t } = useTranslation();
  // The candidate rows are listed only while the dialog is open; closed, it
  // ignores layer edits.
  const layers = useLayersWhen(open);
  const projectGeneration = useAppStore((s) => s.projectGeneration);
  const collaboration = useAppStore((s) => s.collaboration);
  const attributeTableDrafts = useAppStore((s) => s.ui.attributeTableDrafts);
  const deploymentAllowsExportData = useAppStore((s) =>
    s.deploymentCapabilities.has("export:data"),
  );
  const exportDataCapability = useAppCapability("export:data");
  const canExportData = deploymentAllowsExportData && exportDataCapability.granted;
  const geometryEditLayerId = useSyncExternalStore(
    subscribeGeometryEdit,
    getGeometryEditTargetLayerId,
  );

  const candidates = useMemo(
    () =>
      candidatesOverride ??
      listWritableLayerCandidates(layers, {
        collaboration,
        geometryEditLayerId,
        attributeTableDrafts,
        projectGeneration,
      }),
    [
      attributeTableDrafts,
      candidatesOverride,
      collaboration,
      geometryEditLayerId,
      layers,
      projectGeneration,
    ],
  );

  const exportableGeojsonCount = useMemo(
    () => layers.filter(isExportableGeojsonLayer).length,
    [layers],
  );

  const enabledIds = useMemo(
    () => candidates.filter((c) => !c.disabledReason).map((c) => c.layer.id),
    [candidates],
  );
  const editedEnabledIds = useMemo(
    () => candidates.filter((c) => !c.disabledReason && c.hasPendingEdits).map((c) => c.layer.id),
    [candidates],
  );

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [activeLayerId, setActiveLayerId] = useState<string | null>(null);
  const [resultsById, setResultsById] = useState<Record<string, BatchLayerSaveItemResult>>({});
  const [hasCompletedRun, setHasCompletedRun] = useState(false);
  const runIdRef = useRef(0);
  const inFlightRunCountRef = useRef(0);
  const selectAllRef = useRef<HTMLInputElement>(null);

  // Reset selection and per-row statuses whenever the dialog opens fresh,
  // unless an earlier batch save is still in flight (keep it locked so
  // reopening mid-run cannot start a second overlapping write batch).
  useEffect(() => {
    if (!open || inFlightRunCountRef.current > 0) return;
    runIdRef.current += 1;
    setSelectedIds(new Set(defaultSelectedWritableLayerIds(candidates)));
    setSaving(false);
    setActiveLayerId(null);
    setResultsById({});
    setHasCompletedRun(false);
    // Intentionally initialize only on open transition so mid-run store updates
    // (such as clearing geometryEdited after each write) do not wipe results.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const selectedEnabledIds = useMemo(
    () => enabledIds.filter((id) => selectedIds.has(id)),
    [enabledIds, selectedIds],
  );
  const allSelected = enabledIds.length > 0 && selectedEnabledIds.length === enabledIds.length;
  const someSelected = selectedEnabledIds.length > 0 && !allSelected;

  useEffect(() => {
    if (selectAllRef.current) {
      selectAllRef.current.indeterminate = someSelected;
    }
  }, [someSelected]);

  const toggleAll = () => {
    if (allSelected) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(enabledIds));
    }
  };

  const toggleOne = (layerId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(layerId)) next.delete(layerId);
      else next.add(layerId);
      return next;
    });
  };

  const handleSave = async () => {
    if (saving || inFlightRunCountRef.current > 0 || selectedEnabledIds.length === 0) return;
    const runId = runIdRef.current + 1;
    runIdRef.current = runId;
    inFlightRunCountRef.current += 1;
    const isCurrentRun = () => runIdRef.current === runId;
    setSaving(true);
    setResultsById({});
    setActiveLayerId(null);
    setHasCompletedRun(false);
    try {
      const outcome = await onSaveSelected(selectedEnabledIds, {
        onLayerStart: (layerId) => {
          if (isCurrentRun()) setActiveLayerId(layerId);
        },
        onLayerDone: (result) => {
          if (!isCurrentRun()) return;
          setActiveLayerId((current) => (current === result.layerId ? null : current));
          setResultsById((current) => ({ ...current, [result.layerId]: result }));
        },
      });
      if (!isCurrentRun()) return;
      setActiveLayerId(null);
      setHasCompletedRun(true);
      if (!outcome.hasIssues && !outcome.aborted) {
        onOpenChange(false);
      }
    } catch (error) {
      if (isCurrentRun()) {
        notify.error(error instanceof Error ? error.message : t("layers.saveEditsError"));
      }
    } finally {
      inFlightRunCountRef.current = Math.max(0, inFlightRunCountRef.current - 1);
      if (isCurrentRun()) {
        setSaving(false);
        setActiveLayerId(null);
      }
    }
  };

  const canSaveCopiesToFolder =
    canExportData &&
    isTauri() &&
    !IS_MAS_BUILD &&
    Boolean(onSaveCopiesToFolder) &&
    exportableGeojsonCount > 0;
  const canExportZip = canExportData && exportableGeojsonCount > 0;
  const showSelectEditedButton =
    editedEnabledIds.length > 0 && editedEnabledIds.length < enabledIds.length;

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen: boolean) => {
        if (!saving) onOpenChange(nextOpen);
      }}
    >
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{t("toolbar.saveLayerEdits.title")}</DialogTitle>
          <DialogDescription>
            {candidates.length > 0
              ? t("toolbar.saveLayerEdits.description")
              : isTauri() && !IS_MAS_BUILD
                ? t("toolbar.saveLayerEdits.emptyDesktop")
                : t("toolbar.saveLayerEdits.emptyWeb")}
          </DialogDescription>
        </DialogHeader>

        {candidates.length === 0 ? (
          <div className="flex flex-wrap items-center justify-end gap-2 pt-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              {t("common.close")}
            </Button>
            {canExportZip && (
              <Button
                onClick={() => {
                  onOpenChange(false);
                  void onExportGeojsonZip();
                }}
              >
                <Archive className="me-2 h-4 w-4" />
                {t("toolbar.item.exportGeojsonZipEllipsis")}
              </Button>
            )}
          </div>
        ) : (
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-2 border-b pb-2">
              <label className="flex cursor-pointer items-center gap-2 text-sm font-medium">
                <input
                  ref={selectAllRef}
                  type="checkbox"
                  className="h-4 w-4 rounded border-input accent-primary"
                  checked={allSelected}
                  disabled={saving || enabledIds.length === 0}
                  onChange={toggleAll}
                />
                <span>{t("toolbar.saveLayerEdits.selectAll")}</span>
              </label>
              <div className="flex items-center gap-2">
                {showSelectEditedButton && (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={saving}
                    onClick={() => setSelectedIds(new Set(editedEnabledIds))}
                  >
                    {t("toolbar.saveLayerEdits.selectEditedOnly", {
                      count: editedEnabledIds.length,
                    })}
                  </Button>
                )}
                <span className="text-xs text-muted-foreground">
                  {t("toolbar.saveLayerEdits.selectedCount", {
                    selected: selectedEnabledIds.length,
                    total: enabledIds.length,
                  })}
                </span>
              </div>
            </div>

            <ul
              className="max-h-72 divide-y overflow-y-auto rounded-md border"
              aria-label={t("toolbar.saveLayerEdits.layerListLabel")}
            >
              {candidates.map((candidate) => {
                const { layer, destinationLabel, hasPendingEdits, disabledReason } = candidate;
                const isDisabled = Boolean(disabledReason) || saving;
                const isChecked = !disabledReason && selectedIds.has(layer.id);
                const isWorking = activeLayerId === layer.id;
                const result = resultsById[layer.id];

                return (
                  <li key={layer.id} className="p-2.5 text-sm">
                    <div className="flex items-start gap-2.5">
                      <input
                        id={`save-layer-edit-${layer.id}`}
                        type="checkbox"
                        className="mt-0.5 h-4 w-4 shrink-0 rounded border-input accent-primary"
                        checked={isChecked}
                        disabled={isDisabled}
                        onChange={() => toggleOne(layer.id)}
                      />
                      <label
                        htmlFor={`save-layer-edit-${layer.id}`}
                        className={`min-w-0 flex-1 ${isDisabled ? "opacity-60" : "cursor-pointer"}`}
                      >
                        <span className="flex items-center gap-2">
                          <span className="truncate font-medium" title={layer.name}>
                            {layer.name}
                          </span>
                          {hasPendingEdits && (
                            <span className="shrink-0 rounded bg-amber-500/15 px-1.5 py-0.5 text-[11px] font-medium text-amber-700 dark:text-amber-300">
                              {t("toolbar.saveLayerEdits.editedBadge")}
                            </span>
                          )}
                        </span>
                        <span
                          className="block truncate text-xs text-muted-foreground"
                          title={destinationLabel}
                        >
                          {isImportedDocumentCopyPath(layer.sourcePath)
                            ? t("layers.importedCopyDestination", {
                                name: browserSafeFileName(layer.sourcePath ?? ""),
                              })
                            : destinationLabel}
                        </span>
                        {disabledReason && (
                          <span className="mt-0.5 block text-xs text-muted-foreground">
                            {t(disabledReasonKey(disabledReason))}
                          </span>
                        )}
                      </label>
                      {isWorking ? (
                        <Loader2
                          className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-muted-foreground"
                          aria-label={t("toolbar.saveLayerEdits.savingLayer")}
                        />
                      ) : result?.status === "success" ? (
                        <CheckCircle2
                          className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400"
                          aria-hidden="true"
                        />
                      ) : result?.status === "warning" ? (
                        <AlertTriangle
                          className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400"
                          aria-hidden="true"
                        />
                      ) : result?.status === "error" ? (
                        <XCircle
                          className="mt-0.5 h-4 w-4 shrink-0 text-destructive"
                          aria-hidden="true"
                        />
                      ) : null}
                    </div>
                    {result && (
                      <p
                        className={`mt-1 ps-6 text-xs ${
                          result.status === "error"
                            ? "text-destructive"
                            : result.status === "warning"
                              ? "text-amber-700 dark:text-amber-300"
                              : "text-muted-foreground"
                        }`}
                      >
                        {result.message}
                      </p>
                    )}
                  </li>
                );
              })}
            </ul>

            <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
              <div className="flex flex-wrap items-center gap-2">
                {canSaveCopiesToFolder && onSaveCopiesToFolder && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={saving}
                    onClick={() => {
                      const ids =
                        selectedEnabledIds.length > 0 ? new Set(selectedEnabledIds) : undefined;
                      void onSaveCopiesToFolder(ids);
                    }}
                  >
                    <FolderOutput className="me-1.5 h-3.5 w-3.5" />
                    {t("toolbar.saveLayerEdits.saveCopiesToFolder")}
                  </Button>
                )}
                {canExportZip && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={saving}
                    onClick={() => {
                      const ids =
                        selectedEnabledIds.length > 0 ? new Set(selectedEnabledIds) : undefined;
                      void onExportGeojsonZip(ids);
                    }}
                  >
                    <Archive className="me-1.5 h-3.5 w-3.5" />
                    {t("toolbar.saveLayerEdits.exportZip")}
                  </Button>
                )}
              </div>
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  disabled={saving}
                  onClick={() => onOpenChange(false)}
                >
                  {hasCompletedRun ? t("common.close") : t("common.cancel")}
                </Button>
                <Button
                  type="button"
                  disabled={saving || selectedEnabledIds.length === 0}
                  onClick={() => void handleSave()}
                >
                  {saving ? (
                    <>
                      <Loader2 className="me-2 h-4 w-4 animate-spin" />
                      {t("toolbar.saveLayerEdits.savingButton")}
                    </>
                  ) : (
                    t("toolbar.saveLayerEdits.saveButton", { count: selectedEnabledIds.length })
                  )}
                </Button>
              </div>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
