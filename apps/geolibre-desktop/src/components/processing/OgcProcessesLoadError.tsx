import { useAppStore } from "@geolibre/core";
import { Button, Dialog, DialogContent, DialogHeader, DialogTitle } from "@geolibre/ui";
import { useTranslation } from "react-i18next";

/** Keep the shell usable and offer recovery when the process dialog chunk fails. */
export function OgcProcessesLoadError() {
  const { t } = useTranslation();
  const open = useAppStore((state) => state.ui.ogcProcessesOpen);
  const setOpen = useAppStore((state) => state.setOgcProcessesOpen);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("processing.ogcProcesses.title")}</DialogTitle>
        </DialogHeader>
        <p role="alert">{t("processing.ogcProcesses.loadFailed")}</p>
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => setOpen(false)}>
            {t("common.close")}
          </Button>
          <Button onClick={() => window.location.reload()}>
            {t("processing.ogcProcesses.reloadApp")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
