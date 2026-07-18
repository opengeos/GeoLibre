import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
} from "@geolibre/ui";
import type { FormEvent } from "react";
import { useTranslation } from "react-i18next";
import type { useOsmPbfLoader } from "../../../hooks/useOsmPbfLoader";
import { SampleDataSelect } from "../add-data/shared";
import { DEFAULT_OSM_PBF_URL } from "./constants";

interface OsmPbfDialogsProps {
  osmPbf: ReturnType<typeof useOsmPbfLoader>;
}

/** The OSM PBF dialogs: the add dialog, the large-file confirm, and the loading indicator. */
export function OsmPbfDialogs({ osmPbf }: OsmPbfDialogsProps) {
  const { t } = useTranslation();

  return (
    <>
      <Dialog
        open={osmPbf.confirm !== null}
        onOpenChange={(open: boolean) => {
          if (!open) osmPbf.setConfirm(null);
        }}
      >
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{t("toolbar.item.largeOsmPbfTitle")}</DialogTitle>
            <DialogDescription>
              {t("toolbar.item.largeOsmPbfDesc", {
                sizeMb: osmPbf.confirm?.sizeMb,
              })}
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => osmPbf.setConfirm(null)}>
              {t("common.cancel")}
            </Button>
            <Button onClick={osmPbf.runConfirmed}>{t("toolbar.item.continue")}</Button>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog open={osmPbf.dialogOpen} onOpenChange={osmPbf.setDialogOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{t("toolbar.item.addOsmPbfLayerTitle")}</DialogTitle>
            <DialogDescription>{t("toolbar.item.addOsmPbfLayerDesc")}</DialogDescription>
          </DialogHeader>
          <form
            className="space-y-3"
            onSubmit={(event: FormEvent) => {
              event.preventDefault();
              void osmPbf.handleLoadUrl();
            }}
          >
            <SampleDataSelect
              samples={[
                {
                  label: t("toolbar.item.osmPbfSampleLabel"),
                  value: DEFAULT_OSM_PBF_URL,
                },
              ]}
              onSelect={(sampleUrl) => osmPbf.setUrl(sampleUrl)}
            />
            <div className="space-y-1.5">
              <Label htmlFor="osm-pbf-url">{t("toolbar.item.urlLabel")}</Label>
              <Input
                id="osm-pbf-url"
                type="url"
                placeholder={t("toolbar.item.osmPbfUrlPlaceholder")}
                value={osmPbf.url}
                onChange={(e) => osmPbf.setUrl(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">{t("toolbar.item.osmPbfUrlHint")}</p>
            </div>
            <div className="flex items-center justify-between gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => void osmPbf.handleChooseFile()}
              >
                {t("toolbar.item.chooseLocalFile")}
              </Button>
              <Button type="submit" disabled={!osmPbf.url.trim()}>
                {t("toolbar.item.loadFromUrl")}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
      <Dialog
        open={osmPbf.loading}
        onOpenChange={(open: boolean) => {
          // Dismissing (Escape/backdrop) cancels: abort the worker parse and
          // drop a pending fetch result so no layers are added after dismissal.
          if (!open) osmPbf.cancel();
        }}
      >
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{t("toolbar.item.loadingOsmPbf")}</DialogTitle>
            <DialogDescription>
              {osmPbf.progress
                ? t("toolbar.item.loadingOsmPbfProgress", {
                    processed: osmPbf.progress.processed.toLocaleString(),
                    total: osmPbf.progress.total.toLocaleString(),
                  })
                : t("toolbar.item.loadingOsmPbfDesc")}
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end">
            <Button variant="outline" onClick={osmPbf.cancel}>
              {t("common.cancel")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
