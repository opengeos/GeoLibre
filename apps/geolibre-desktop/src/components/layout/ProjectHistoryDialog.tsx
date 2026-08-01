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

interface ProjectHistoryDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  snapshots: ProjectHistorySnapshot[];
  onRestore: (snapshot: ProjectHistorySnapshot) => void;
}

export function ProjectHistoryDialog({
  open,
  onOpenChange,
  snapshots,
  onRestore,
}: ProjectHistoryDialogProps) {
  const { t, i18n } = useTranslation();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("projectHistory.title")}</DialogTitle>
          <DialogDescription>{t("projectHistory.description")}</DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          {snapshots.length === 0 ? (
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
                  <p className="text-xs text-muted-foreground">
                    {new Intl.DateTimeFormat(i18n.language, {
                      dateStyle: "medium",
                      timeStyle: "medium",
                    }).format(new Date(snapshot.createdAt))}
                  </p>
                  <p className="truncate text-xs text-muted-foreground">
                    {t("projectHistory.summary", {
                      count: snapshot.layerCount,
                      zoom: snapshot.camera.zoom.toFixed(1),
                    })}
                  </p>
                </div>
                <Button
                  size="sm"
                  onClick={() => {
                    onRestore(snapshot);
                    onOpenChange(false);
                  }}
                >
                  {t("projectHistory.restore")}
                </Button>
              </div>
            ))
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
