import { createCesiumKmlLayer } from "@geolibre/core";
import { Button, Input, Label } from "@geolibre/ui";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { openLocalDataFileWithFallback } from "../../../../lib/tauri-io";
import { errorMessage, layerNameFromPath } from "../helpers";
import { AddDataSourceForm, useAddDataSource } from "../shared";

/** Preserve the original KML document or KMZ archive in the project. */
export function KmlSource({ initialUrl }: { initialUrl?: string }) {
  const { t } = useTranslation();
  const [defaultName] = useState(() => t("addData.kml.defaultName"));
  const source = useAddDataSource(defaultName);
  const [url, setUrl] = useState(initialUrl ?? "");
  const [file, setFile] = useState<{ path: string; data: string } | null>(null);
  const chooseFile = async () => {
    source.setError(null);
    try {
      const picked = await openLocalDataFileWithFallback({
        filters: [{ name: "KML / KMZ", extensions: ["kml", "kmz"] }],
        accept: ".kml,.kmz",
        readText: true,
        binaryExtensions: ["kmz"],
      });
      if (!picked) return;
      let data = picked.text ?? "";
      if (picked.data) {
        data = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result));
          reader.onerror = () => reject(reader.error);
          reader.readAsDataURL(
            new Blob([picked.data!], { type: "application/vnd.google-earth.kmz" }),
          );
        });
      }
      if (!data.trim()) throw new Error(t("addData.kml.errorSource"));
      setFile({ path: picked.path, data });
      setUrl("");
      source.setLayerName((current) =>
        current.trim() && current !== defaultName
          ? current
          : layerNameFromPath(picked.path, defaultName),
      );
    } catch (error) {
      source.setError(errorMessage(error, t("addData.shared.addError")));
    }
  };
  const submit = source.runSubmit(() => {
    if (!file && !url.trim()) throw new Error(t("addData.kml.errorSource"));
    source.addAndClose(
      createCesiumKmlLayer({
        name: source.layerName.trim() || defaultName,
        url: url.trim(),
        data: file?.data,
        sourcePath: file?.path,
      }),
    );
  });
  return (
    <AddDataSourceForm
      layerName={source.layerName}
      onLayerNameChange={source.setLayerName}
      beforeLayerId={source.beforeLayerId}
      onBeforeLayerIdChange={source.setBeforeLayerId}
      onSubmit={submit}
      error={source.error}
      submitDisabled={source.isSubmitting}
    >
      <div className="space-y-3">
        <div className="space-y-1.5">
          <Label htmlFor="kml-url">{t("addData.kml.url")}</Label>
          <Input
            id="kml-url"
            value={url}
            placeholder="https://example.com/map.kmz"
            onChange={(event) => {
              setUrl(event.target.value);
              setFile(null);
            }}
          />
        </div>
        <div className="flex items-center gap-2">
          <Button type="button" variant="outline" onClick={chooseFile}>
            {t("addData.common.chooseFile")}
          </Button>
          <span className="truncate text-xs text-muted-foreground">
            {file?.path ?? t("addData.common.noFileSelected")}
          </span>
        </div>
      </div>
    </AddDataSourceForm>
  );
}
