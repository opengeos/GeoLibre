import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@geolibre/ui";
import { useTranslation } from "react-i18next";
import type { ProjectHistorySnapshot } from "../../lib/project-history-store";

interface ProjectRecoveryDialogProps {
  snapshot: ProjectHistorySnapshot | null;
  restoreError: string | null;
  onRestore: (snapshot: ProjectHistorySnapshot) => boolean;
  onDiscard: () => void;
  onDismiss: () => void;
}

export function ProjectRecoveryDialog({
  snapshot,
  restoreError,
  onRestore,
  onDiscard,
  onDismiss,
}: ProjectRecoveryDialogProps) {
  const { t } = useTranslation();
  return (
    <Dialog open={snapshot !== null} onOpenChange={(open) => !open && onDismiss()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("projectHistory.recoveryTitle")}</DialogTitle>
          <DialogDescription>
            {t("projectHistory.recoveryDescription", { name: snapshot?.name })}
          </DialogDescription>
        </DialogHeader>
        {restoreError ? (
          <p
            role="alert"
            className="rounded-md border border-destructive/50 p-3 text-sm text-destructive"
          >
            {restoreError}
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onDiscard}>
            {t("projectHistory.discard")}
          </Button>
          <Button onClick={() => snapshot && onRestore(snapshot)}>
            {t("projectHistory.restore")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
