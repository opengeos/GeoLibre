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
import type { useTilePackageLoader } from "../../../hooks/useTilePackageLoader";
import { SampleDataSelect } from "../add-data/shared";
import { TILE_PACKAGE_SAMPLES } from "./constants";

interface TilePackageDialogsProps {
  tilePackage: ReturnType<typeof useTilePackageLoader>;
}

/** The ArcGIS tile package dialogs: the add dialog and the loading indicator. */
export function TilePackageDialogs({ tilePackage }: TilePackageDialogsProps) {
  const { t } = useTranslation();

  return (
    <>
      <Dialog open={tilePackage.dialogOpen} onOpenChange={tilePackage.setDialogOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{t("toolbar.item.addVtpkLayerTitle")}</DialogTitle>
            <DialogDescription>{t("toolbar.item.addVtpkLayerDesc")}</DialogDescription>
          </DialogHeader>
          <form
            className="space-y-3"
            onSubmit={(event: FormEvent) => {
              event.preventDefault();
              void tilePackage.handleLoadUrl();
            }}
          >
            <SampleDataSelect
              samples={TILE_PACKAGE_SAMPLES.map((sample) => ({
                label: t(sample.labelKey),
                value: sample.url,
              }))}
              onSelect={(sampleUrl) => tilePackage.setUrl(sampleUrl)}
            />
            <div className="space-y-1.5">
              <Label htmlFor="vtpk-url">{t("toolbar.item.urlLabel")}</Label>
              <Input
                id="vtpk-url"
                type="url"
                placeholder={t("toolbar.item.vtpkUrlPlaceholder")}
                value={tilePackage.url}
                onChange={(e) => tilePackage.setUrl(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">{t("toolbar.item.vtpkUrlHint")}</p>
            </div>
            <div className="flex items-center justify-between gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => void tilePackage.handleChooseFile()}
              >
                {t("toolbar.item.chooseLocalFile")}
              </Button>
              <Button type="submit" disabled={!tilePackage.url.trim()}>
                {t("toolbar.item.loadFromUrl")}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
      <Dialog
        open={tilePackage.loading}
        onOpenChange={(open: boolean) => {
          // Dismissing (Escape/backdrop) cancels: a result that arrives later
          // is dropped so no layer is added after the user backed out.
          if (!open) tilePackage.cancel();
        }}
      >
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{t("toolbar.item.loadingVtpk")}</DialogTitle>
            <DialogDescription>{t("toolbar.item.loadingVtpkDesc")}</DialogDescription>
          </DialogHeader>
          <div className="flex justify-end">
            <Button variant="outline" onClick={tilePackage.cancel}>
              {t("common.cancel")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
