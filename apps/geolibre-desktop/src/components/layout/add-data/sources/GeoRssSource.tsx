import { Button, Input, Label, Select } from "@geolibre/ui";
import { FileUp } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { parseGeoRssLayer } from "../../../../lib/georss";
import { openLocalDataFileWithFallback } from "../../../../lib/tauri-io";
import { DEFAULT_GEORSS_URL } from "../constants";
import {
  createBaseLayer,
  errorMessage,
  fileNameFromPath,
  layerNameFromPath,
  proxyFeedRequestUrl,
} from "../helpers";
import { AddDataSourceForm, SampleDataSelect, useAddDataSource } from "../shared";
import type { GeoRssMode } from "../types";

export function GeoRssSource() {
  const { t } = useTranslation();
  // Captured once on mount so the "did the user rename it?" comparisons below
  // stay stable even if the UI language changes while the dialog is open.
  const [defaultName] = useState(() => t("addData.georss.defaultName"));
  const source = useAddDataSource(defaultName);
  const [georssMode, setGeoRssMode] = useState<GeoRssMode>("url");
  const [georssUrl, setGeoRssUrl] = useState("");
  const [selectedFile, setSelectedFile] = useState<{
    path: string;
    text: string;
  } | null>(null);

  const handleModeChange = (mode: GeoRssMode) => {
    setGeoRssMode(mode);
    setSelectedFile(null);
  };

  const handleChooseFile = async () => {
    source.setError(null);
    try {
      const result = await openLocalDataFileWithFallback({
        filters: [
          {
            name: "GeoRSS",
            extensions: ["xml", "rss", "atom"],
          },
        ],
        accept: ".xml,.rss,.atom",
        readText: true,
      });
      if (!result) return;
      if (!result.text) throw new Error(t("addData.georss.errorFileMissing"));
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
      source.setError(errorMessage(err, t("addData.georss.readError")));
    }
  };

  const readGeoRssSource = async (): Promise<{
    sourcePath: string;
    text: string;
  }> => {
    if (georssMode === "file") {
      if (!selectedFile) throw new Error(t("addData.georss.errorChooseFile"));
      return {
        sourcePath: selectedFile.path,
        text: selectedFile.text,
      };
    }

    const sourcePath = georssUrl.trim();
    if (!sourcePath) throw new Error(t("addData.georss.errorUrl"));

    const response = await fetch(proxyFeedRequestUrl(sourcePath));
    if (!response.ok) {
      throw new Error(t("addData.common.requestFailed", { status: response.status }));
    }
    return {
      sourcePath,
      text: await response.text(),
    };
  };

  const handleSubmit = source.runSubmit(async () => {
    const { sourcePath, text } = await readGeoRssSource();
    const result = parseGeoRssLayer(text);
    const name = source.layerName.trim() || result.feedTitle || defaultName;

    source.addAndClose(
      {
        ...createBaseLayer(
          name,
          "geojson",
          {
            type: "geojson",
            url: sourcePath,
          },
          {
            featureCount: result.featureCount,
            feedTitle: result.feedTitle,
            sourceKind: "georss",
          },
        ),
        geojson: result.features,
        sourcePath,
      },
      { fit: true },
    );
  });

  return (
    <AddDataSourceForm
      layerName={source.layerName}
      onLayerNameChange={source.setLayerName}
      beforeLayerId={source.beforeLayerId}
      onBeforeLayerIdChange={source.setBeforeLayerId}
      onSubmit={handleSubmit}
      error={source.error}
      submitDisabled={source.isSubmitting}
      // Globe icon, unlike GpxSource: GeoRSS lives under Web services and is primarily a live feed.
      useServiceIcon
    >
      <div className="space-y-3">
        <div className="space-y-1.5">
          <Label htmlFor="georss-mode">{t("addData.common.sourceType")}</Label>
          <Select
            id="georss-mode"
            value={georssMode}
            onChange={(event) => handleModeChange(event.target.value as GeoRssMode)}
          >
            <option value="url">{t("addData.georss.url")}</option>
            <option value="file">{t("addData.georss.file")}</option>
          </Select>
        </div>

        {georssMode === "file" ? (
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" variant="outline" onClick={handleChooseFile}>
              <FileUp className="me-2 h-3.5 w-3.5" />
              {t("addData.common.chooseFile")}
            </Button>
            <span className="min-w-0 truncate text-xs text-muted-foreground">
              {selectedFile
                ? fileNameFromPath(selectedFile.path)
                : t("addData.common.noFileSelected")}
            </span>
          </div>
        ) : (
          <div className="space-y-1.5">
            <Label htmlFor="georss-url">{t("addData.georss.url")}</Label>
            <Input
              id="georss-url"
              placeholder={t("addData.georss.urlPlaceholder")}
              value={georssUrl}
              onChange={(event) => setGeoRssUrl(event.target.value)}
            />
          </div>
        )}
        <SampleDataSelect
          samples={[{ label: t("addData.georss.sampleLabel"), value: DEFAULT_GEORSS_URL }]}
          onSelect={(url) => {
            setGeoRssMode("url");
            setSelectedFile(null);
            setGeoRssUrl(url);
          }}
        />
      </div>
    </AddDataSourceForm>
  );
}
