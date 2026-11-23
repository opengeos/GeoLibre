import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@geolibre/ui";
import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import type { ArcgisImportReport } from "../../../hooks/useArcgisImportReport";
import {
  countArcgisUnloadedLayers,
  type ArcgisProjectImportWarning,
} from "../../../lib/arcgis-project-import";
import { ImportWarningList } from "./ImportWarningList";

/**
 * What an ArcGIS Pro project import could not load, and, in the desktop app,
 * a Locate folder for each saved folder whose layers did not load.
 */
export function ArcgisImportReportDialog({ report }: { report: ArcgisImportReport }) {
  const { t } = useTranslation();
  // Stable identity so the warning list regroups only when the warnings change.
  const describeArcgisWarning = useCallback(
    (warning: ArcgisProjectImportWarning) => {
      const layerType = warning.layerType || t("toolbar.item.arcgisUnknownLayerType");
      // The importer gives every symbology warning an issue code, so the
      // `symbology`/`symbology-partial` reason texts are only a fallback; the
      // typed key below still needs one entry per reason.
      return warning.symbologyIssue
        ? t(`toolbar.item.arcgisSymbologyIssue.${warning.symbologyIssue}`, { layerType })
        : t(`toolbar.item.arcgisImportReason.${warning.reason}`, { layerType });
    },
    [t],
  );
  const { warnings, repairGroups, repairResult } = report;
  const unloadedCount = countArcgisUnloadedLayers(warnings ?? []);
  return (
    <Dialog
      open={warnings !== null}
      onOpenChange={(open: boolean) => {
        if (!open) report.close();
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("toolbar.item.arcgisImportComplete")}</DialogTitle>
          <DialogDescription>
            {unloadedCount > 0
              ? t("toolbar.item.arcgisImportWarnings", { count: unloadedCount })
              : warnings?.length
                ? t("toolbar.item.arcgisImportSymbologyOnly")
                : t("toolbar.item.arcgisRepairAllRestored")}
          </DialogDescription>
        </DialogHeader>
        <ImportWarningList warnings={warnings ?? []} describe={describeArcgisWarning} />
        {repairGroups.length > 0 ? (
          <section className="space-y-2 border-t pt-3 text-sm">
            <h3 className="font-medium">{t("toolbar.item.arcgisRepairHeading")}</h3>
            <p className="text-xs text-muted-foreground">
              {t("toolbar.item.arcgisRepairDescription")}
            </p>
            <ul className="max-h-48 space-y-2 overflow-y-auto">
              {repairGroups.map((group) => (
                <li key={group.key} className="flex items-center gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="break-all font-mono text-xs" dir="ltr">
                      {group.label}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {t("toolbar.item.importWarningLayerCount", { count: group.layerIds.length })}
                    </div>
                    <div className="break-words text-xs text-muted-foreground">
                      {group.layerNames.join(", ")}
                    </div>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={report.repairBusy}
                    aria-label={t("toolbar.item.arcgisRepairLocateFolderFor", {
                      folder: group.label,
                    })}
                    onClick={() => void report.locate(group.key)}
                  >
                    {t("toolbar.item.arcgisRepairLocateFolder")}
                  </Button>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
        {repairResult ? (
          <p role="status" className="text-sm">
            {repairResult.networkFolder
              ? t("toolbar.item.arcgisRepairNetworkFolder")
              : repairResult.restored > 0
                ? t("toolbar.item.arcgisRepairRestored", { count: repairResult.restored })
                : t("toolbar.item.arcgisRepairNoneFound", { folder: repairResult.folder })}
            {repairResult.restored > 0 && repairResult.remaining > 0
              ? ` ${t("toolbar.item.arcgisRepairStillMissing", { count: repairResult.remaining })}`
              : null}
          </p>
        ) : null}
        <div className="flex justify-end">
          <Button onClick={report.close}>{t("common.ok")}</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
