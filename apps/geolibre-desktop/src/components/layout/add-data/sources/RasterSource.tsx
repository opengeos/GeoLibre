import { Button, Input, Label } from "@geolibre/ui";
import { addRasterToMap } from "@geolibre/plugins";
import { isTauri } from "@tauri-apps/api/core";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { createAppAPI } from "../../../../hooks/usePlugins";
import { openLocalDataFileWithFallback } from "../../../../lib/tauri-io";
import { AddDataSourceForm, useAddDataSource } from "../shared";

export function RasterSource() {
  const { t } = useTranslation();
  const source = useAddDataSource(t("toolbar.item.rasterLayer"));
  const [url, setUrl] = useState("");
  const [file, setFile] = useState<{ file: File; localPath?: string } | null>(null);
  const choose = async () => {
    source.setError(null);
    try {
      const selected = await openLocalDataFileWithFallback({
        filters: [{ name: "GeoTIFF", extensions: ["tif", "tiff"] }],
        accept: ".tif,.tiff",
        readBinary: true,
      });
      if (!selected?.data) return;
      const name = selected.path.split(/[\\/]/).pop() || "raster.tif";
      setFile({
        file: new File([selected.data], name),
        localPath: isTauri() ? selected.path : undefined,
      });
      setUrl("");
      source.setLayerName(name);
    } catch (error) {
      source.setError(error instanceof Error ? error.message : String(error));
    }
  };
  const submit = source.runSubmit(async () => {
    if (!file && !/^https?:\/\//i.test(url.trim()))
      throw new Error(t("addData.raster.errorSource"));
    await addRasterToMap(createAppAPI(source.shell.mapControllerRef), file?.file ?? url.trim(), {
      name: source.layerName,
      localPath: file?.localPath,
      beforeId: source.beforeLayer ?? undefined,
    });
    source.shell.closeDialog();
  });
  return (
    <AddDataSourceForm
      layerName={source.layerName}
      onLayerNameChange={source.setLayerName}
      beforeLayerId={source.beforeLayerId}
      onBeforeLayerIdChange={source.setBeforeLayerId}
      onSubmit={submit}
      error={source.error}
      submitDisabled={source.isSubmitting || (!file && !url.trim())}
    >
      <div>
        <Button type="button" variant="outline" onClick={choose}>
          {t("addData.common.chooseFile")}
        </Button>
        <span className="ms-2 text-xs">
          {file?.file.name ?? t("addData.common.noFileSelected")}
        </span>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="raster-url">{t("toolbar.item.urlLabel")}</Label>
        <Input
          id="raster-url"
          value={url}
          onChange={(e) => {
            setUrl(e.target.value);
            setFile(null);
          }}
          placeholder="https://example.com/image.tif"
        />
      </div>
    </AddDataSourceForm>
  );
}
