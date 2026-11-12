import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@geolibre/ui";
import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { ProjectFileActions } from "../../../hooks/useProjectFileActions";
import type {
  QgisFormImportNote,
  QgisProjectImportWarning,
} from "../../../lib/qgis-project-import";
import { ImportWarningList } from "./ImportWarningList";

/**
 * What a QGIS project import could not bring across: layers that did not
 * load, form settings that were skipped, and symbology the style reader could
 * not represent. Open whenever any of the three has something to say.
 */
export function QgisImportReportDialog({ projectFiles }: { projectFiles: ProjectFileActions }) {
  const { t } = useTranslation();
  const describeQgisWarning = useCallback(
    (warning: QgisProjectImportWarning) =>
      t(`toolbar.item.qgisImportReason.${warning.reason}`, {
        provider: warning.provider || t("toolbar.item.qgisUnknownProvider"),
      }),
    [t],
  );

  const describeQgisFormNote = useCallback(
    (note: QgisFormImportNote & { reason: string }) =>
      t(`toolbar.item.qgisFormNoteReason.${note.reason as QgisFormImportNote["reason"]}`),
    [t],
  );
  // One entry per field, labelled "Layer: field", grouped by what was skipped.
  const qgisFormNotes = useMemo(
    () =>
      (projectFiles.qgisImportFormNotes ?? []).map((note) => ({
        ...note,
        layerName: `${note.layerName} › ${note.field}`,
      })),
    [projectFiles.qgisImportFormNotes],
  );
  // The style reader's messages are already sentences; group by message.
  const qgisStyleNotes = useMemo(
    () =>
      (projectFiles.qgisImportStyleNotes ?? []).map((note) => ({
        layerName: note.layerName,
        reason: note.message,
      })),
    [projectFiles.qgisImportStyleNotes],
  );
  const describeQgisStyleNote = useCallback((note: { reason: string }) => note.reason, []);
  const qgisWarningCount = projectFiles.qgisImportWarnings?.length ?? 0;
  const closeQgisImportDialog = () => {
    projectFiles.setQgisImportWarnings(null);
    projectFiles.setQgisImportFormNotes(null);
    projectFiles.setQgisImportStyleNotes(null);
  };

  return (
    <Dialog
      open={
        projectFiles.qgisImportWarnings !== null ||
        projectFiles.qgisImportFormNotes !== null ||
        projectFiles.qgisImportStyleNotes !== null
      }
      onOpenChange={(open: boolean) => {
        if (!open) closeQgisImportDialog();
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("toolbar.item.qgisImportComplete")}</DialogTitle>
          <DialogDescription>
            {qgisWarningCount > 0
              ? t("toolbar.item.qgisImportWarnings", { count: qgisWarningCount })
              : t("toolbar.item.qgisImportNotes")}
          </DialogDescription>
        </DialogHeader>
        {qgisWarningCount > 0 ? (
          <ImportWarningList
            warnings={projectFiles.qgisImportWarnings ?? []}
            describe={describeQgisWarning}
          />
        ) : null}
        {qgisFormNotes.length > 0 ? (
          <div className="space-y-2">
            <p className="text-sm text-muted-foreground">{t("toolbar.item.qgisImportFormNotes")}</p>
            <ImportWarningList
              warnings={qgisFormNotes}
              describe={describeQgisFormNote}
              countLabel={(count) => t("toolbar.item.qgisFormNoteFieldCount", { count })}
            />
          </div>
        ) : null}
        {qgisStyleNotes.length > 0 ? (
          <div className="space-y-2">
            <p className="text-sm text-muted-foreground">
              {t("toolbar.item.qgisImportStyleNotes")}
            </p>
            <ImportWarningList warnings={qgisStyleNotes} describe={describeQgisStyleNote} />
          </div>
        ) : null}
        <div className="flex justify-end">
          <Button onClick={closeQgisImportDialog}>{t("common.ok")}</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
