import { CZML_QUICK_PICKS, createCzmlLayer, parseCzml } from "@geolibre/core";
import { Button, Input, Label, Select } from "@geolibre/ui";
import { FileUp } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { openLocalDataFileWithFallback } from "../../../../lib/tauri-io";
import { errorMessage, layerNameFromPath } from "../helpers";
import { AddDataSourceForm, useAddDataSource } from "../shared";

/** Mode for supplying CZML data: remote URL endpoint or local file. */
export type CzmlMode = "url" | "file";

/**
 * Add a CZML (Cesium Language) layer for dynamic 3D scenes (issue #2290).
 *
 * CZML describes time-dynamic 3D geospatial scenes, satellite orbits, vehicle
 * paths, and sensory models on the Cesium globe with synchronized clock playback.
 *
 * @param props Component properties.
 * @param props.initialUrl Optional prefilled URL from deep links.
 */
export function CzmlSource({ initialUrl }: { initialUrl?: string }) {
  const { t } = useTranslation();
  const [defaultName] = useState(() => t("addData.czml.defaultName"));
  const source = useAddDataSource(defaultName);
  const [czmlMode, setCzmlMode] = useState<CzmlMode>("url");
  const [czmlUrl, setCzmlUrl] = useState(initialUrl ?? "");
  const [selectedFile, setSelectedFile] = useState<{
    path: string;
    text: string;
  } | null>(null);

  const handleModeChange = (mode: CzmlMode) => {
    setCzmlMode(mode);
    setSelectedFile(null);
  };

  const handleChooseFile = async () => {
    source.setError(null);
    try {
      const result = await openLocalDataFileWithFallback({
        filters: [
          {
            name: "CZML / JSON",
            extensions: ["czml", "json"],
          },
        ],
        accept: ".czml,.json",
        readText: true,
      });
      if (!result) return;
      if (!result.text) throw new Error(t("addData.czml.errorFileMissing"));
      setSelectedFile({
        path: result.path,
        text: result.text,
      });
      source.setLayerName((current) =>
        current.trim() && current !== defaultName
          ? current
          : layerNameFromPath(result.path, defaultName),
      );
    } catch (err) {
      source.setError(errorMessage(err, t("addData.czml.readError")));
    }
  };

  const handleSubmit = source.runSubmit(() => {
    const name = source.layerName.trim() || defaultName;

    if (czmlMode === "file") {
      if (!selectedFile) throw new Error(t("addData.czml.errorChooseFile"));
      const doc = parseCzml(selectedFile.text);
      if (!doc) throw new Error(t("addData.czml.errorInvalidCzml"));
      source.addAndClose(
        createCzmlLayer({
          name,
          data: doc,
          sourcePath: selectedFile.path,
        }),
      );
      return;
    }

    const trimmedUrl = czmlUrl.trim();
    if (!trimmedUrl) throw new Error(t("addData.czml.errorUrl"));

    source.addAndClose(
      createCzmlLayer({
        name,
        url: trimmedUrl,
      }),
    );
  });

  // A quick pick adds straight from a button, so it cannot go through the
  // form's `runSubmit`; mirror its error handling here. The sample is cloned so
  // every layer owns its packets rather than sharing the exported constant.
  const handleSelectQuickPick = (pick: (typeof CZML_QUICK_PICKS)[number]) => {
    source.setLayerName(pick.name);
    source.setError(null);
    try {
      source.addAndClose(
        createCzmlLayer({
          name: pick.name,
          data: structuredClone(pick.data),
        }),
      );
    } catch (err) {
      source.setError(errorMessage(err, t("addData.shared.addError")));
    }
  };

  return (
    <AddDataSourceForm
      layerName={source.layerName}
      onLayerNameChange={source.setLayerName}
      beforeLayerId={source.beforeLayerId}
      onBeforeLayerIdChange={source.setBeforeLayerId}
      onSubmit={handleSubmit}
      error={source.error}
      submitDisabled={source.isSubmitting}
    >
      <div className="space-y-3">
        <div className="space-y-1.5">
          <Label htmlFor="czml-source-mode">{t("addData.common.sourceType")}</Label>
          <Select
            id="czml-source-mode"
            value={czmlMode}
            onChange={(event) => handleModeChange(event.target.value as CzmlMode)}
          >
            <option value="url">{t("addData.czml.sourceModeUrl")}</option>
            <option value="file">{t("addData.czml.sourceModeFile")}</option>
          </Select>
        </div>

        {czmlMode === "url" ? (
          <div className="space-y-1.5">
            <Label htmlFor="czml-url">{t("addData.czml.url")}</Label>
            <Input
              id="czml-url"
              placeholder="https://example.com/orbit.czml"
              value={czmlUrl}
              onChange={(event) => setCzmlUrl(event.target.value)}
            />
          </div>
        ) : (
          <div className="space-y-1.5">
            <Label>{t("addData.czml.file")}</Label>
            <div className="flex items-center gap-2">
              <Button type="button" variant="outline" size="sm" onClick={handleChooseFile}>
                <FileUp className="me-2 h-4 w-4" />
                {t("addData.common.chooseFile")}
              </Button>
              <span className="text-xs text-muted-foreground truncate">
                {selectedFile?.path ?? t("addData.common.noFileSelected")}
              </span>
            </div>
          </div>
        )}

        <div className="space-y-1.5">
          <Label>{t("addData.czml.quickPicks")}</Label>
          <div className="flex flex-wrap gap-2">
            {CZML_QUICK_PICKS.map((pick) => (
              <Button
                key={pick.name}
                type="button"
                variant="outline"
                size="sm"
                onClick={() => handleSelectQuickPick(pick)}
              >
                {pick.name}
              </Button>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">{t("addData.czml.hint")}</p>
        </div>
      </div>
    </AddDataSourceForm>
  );
}
