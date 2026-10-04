import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@geolibre/ui";
import type { GeoLibreProject } from "@geolibre/core";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ProjectHistorySnapshot } from "../../lib/project-history-store";
import { autosavePausedMessage } from "../../lib/autosave-status";
import { CURRENT_PROJECT_TARGET, ProjectSnapshotDiff } from "./ProjectSnapshotDiff";

interface ProjectHistoryDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** True while autosave is skipping snapshots because the project is too large. */
  autosavePaused?: boolean;
  snapshots: ProjectHistorySnapshot[];
  restoreError: string | null;
  onRestore: (snapshot: ProjectHistorySnapshot) => boolean;
  /** Restores one layer from a snapshot; enables "Restore this layer". */
  onRestoreLayer?: (snapshot: ProjectHistorySnapshot, layerId: string) => boolean;
  /** Builds the live project for "Compare"; without it, Compare is hidden. */
  getCurrentProject?: () => GeoLibreProject;
}

export function ProjectHistoryDialog({
  open,
  onOpenChange,
  autosavePaused = false,
  snapshots,
  restoreError,
  onRestore,
  onRestoreLayer,
  getCurrentProject,
}: ProjectHistoryDialogProps) {
  const { t, i18n } = useTranslation();
  const [compare, setCompare] = useState<{ baseId: string; targetId: string } | null>(null);
  // Reopening the dialog starts from the snapshot list again.
  useEffect(() => {
    if (!open) setCompare(null);
  }, [open]);
  const compareBase = compare
    ? snapshots.find((snapshot) => snapshot.id === compare.baseId)
    : undefined;
  const formatDate = (iso: string) =>
    new Intl.DateTimeFormat(i18n.language, {
      dateStyle: "medium",
      timeStyle: "medium",
    }).format(new Date(iso));
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("projectHistory.title")}</DialogTitle>
          <DialogDescription>{t("projectHistory.description")}</DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          {autosavePaused ? (
            <p
              role="status"
              className="rounded-md border border-amber-500/50 p-3 text-sm text-amber-700 dark:text-amber-300"
            >
              {autosavePausedMessage(t, i18n.language)}
            </p>
          ) : null}
          {restoreError ? (
            <p
              role="alert"
              className="rounded-md border border-destructive/50 p-3 text-sm text-destructive"
            >
              {restoreError}
            </p>
          ) : null}
          {compare && compareBase && getCurrentProject ? (
            <ProjectSnapshotDiff
              base={compareBase}
              snapshots={snapshots}
              targetId={compare.targetId}
              onTargetChange={(targetId) => setCompare({ ...compare, targetId })}
              onBack={() => setCompare(null)}
              getCurrentProject={getCurrentProject}
              onRestoreLayer={onRestoreLayer}
            />
          ) : snapshots.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              {t("projectHistory.empty")}
            </p>
          ) : (
            snapshots.map((snapshot) => (
              <div
                key={snapshot.id}
                className="flex items-center justify-between gap-3 rounded-md border p-3"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{snapshot.name}</p>
                  <p className="text-xs text-muted-foreground">{formatDate(snapshot.createdAt)}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {t("projectHistory.summary", {
                      count: snapshot.layerCount,
                      zoom: new Intl.NumberFormat(i18n.language, {
                        minimumFractionDigits: 1,
                        maximumFractionDigits: 1,
                      }).format(snapshot.camera.zoom),
                    })}
                  </p>
                </div>
                <div className="flex shrink-0 gap-2">
                  {getCurrentProject ? (
                    <Button
                      size="sm"
                      variant="outline"
                      aria-label={t("projectHistory.diff.compareAria", {
                        date: formatDate(snapshot.createdAt),
                      })}
                      onClick={() =>
                        setCompare({ baseId: snapshot.id, targetId: CURRENT_PROJECT_TARGET })
                      }
                    >
                      {t("projectHistory.diff.compare")}
                    </Button>
                  ) : null}
                  <Button
                    size="sm"
                    onClick={() => {
                      if (onRestore(snapshot)) onOpenChange(false);
                    }}
                  >
                    {t("projectHistory.restore")}
                  </Button>
                </div>
              </div>
            ))
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
