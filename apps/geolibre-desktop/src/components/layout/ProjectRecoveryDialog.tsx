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
  onRestore: (snapshot: ProjectHistorySnapshot) => void;
  onDiscard: () => void;
}

export function ProjectRecoveryDialog({
  snapshot,
  onRestore,
  onDiscard,
}: ProjectRecoveryDialogProps) {
  const { t } = useTranslation();
  return (
    <Dialog open={snapshot !== null} onOpenChange={(open) => !open && onDiscard()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("projectHistory.recoveryTitle")}</DialogTitle>
          <DialogDescription>
            {t("projectHistory.recoveryDescription", { name: snapshot?.name })}
          </DialogDescription>
        </DialogHeader>
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
