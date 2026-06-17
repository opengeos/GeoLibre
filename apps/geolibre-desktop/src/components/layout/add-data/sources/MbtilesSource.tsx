import { Button, Input, Label } from "@geolibre/ui";
import { FileUp } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  mbtilesTileUrl,
  readMbtilesMetadata,
  registerMbtilesProtocol,
  type MbtilesMetadata,
} from "../../../../lib/mbtiles";
import { openLocalDataFileWithFallback } from "../../../../lib/tauri-io";
import {
  createBaseLayer,
  errorMessage,
  fileNameFromPath,
  layerNameFromPath,
} from "../helpers";
import { AddDataSourceForm, useAddDataSource } from "../shared";

export function MbtilesSource() {
  const { t } = useTranslation();
  // Captured once on mount so the "did the user rename it?" comparison below
  // stays stable even if the UI language changes while the dialog is open.
  const [defaultName] = useState(() => t("addData.mbtiles.defaultName"));
  const source = useAddDataSource(defaultName);
  const [selectedMbtiles, setSelectedMbtiles] = useState<{
    metadata: MbtilesMetadata;
    path: string;
  } | null>(null);
  const [mbtilesSourceLayers, setMbtilesSourceLayers] = useState("");

  const handleChooseMbtilesFile = async () => {
    source.setError(null);
    try {
      const result = await openLocalDataFileWithFallback({
        filters: [
          {
            name: "MBTiles",
            extensions: ["mbtiles"],
          },
        ],
        accept: ".mbtiles",
      });
      if (!result) return;
      const metadata = await readMbtilesMetadata(result.path);
      setSelectedMbtiles({ metadata, path: result.path });
      setMbtilesSourceLayers(metadata.sourceLayers.join(", "));
      source.setLayerName((current) =>
        current.trim() && current !== defaultName
          ? current
          : metadata.name || layerNameFromPath(result.path, defaultName),
      );
    } catch (err) {
      source.setError(errorMessage(err, t("addData.mbtiles.readError")));
    }
  };

  const handleSubmit = source.runSubmit(() => {
    const name = source.layerName.trim() || defaultName;
    if (!selectedMbtiles)
      throw new Error(t("addData.mbtiles.errorChooseFile"));
    registerMbtilesProtocol();

    const { metadata, path } = selectedMbtiles;
    const sourceLayers = mbtilesSourceLayers
      .split(",")
      .map((sourceLayer) => sourceLayer.trim())
      .filter(Boolean);
    if (metadata.tileType === "vector" && sourceLayers.length === 0) {
      throw new Error(t("addData.mbtiles.errorSourceLayers"));
    }

    const minzoom = metadata.minZoom ?? undefined;
    const maxzoom = metadata.maxZoom ?? undefined;
    source.addAndClose(
      createBaseLayer(
        name,
        "mbtiles",
        {
          bounds: metadata.bounds ?? undefined,
          maxzoom,
          minzoom,
          sourceLayers,
          tileSize: 256,
          tiles: [mbtilesTileUrl(path)],
          type: metadata.tileType,
        },
        {
          bounds: metadata.bounds,
          center: metadata.center,
          format: metadata.format,
          maxzoom,
          minzoom,
          scheme: metadata.scheme,
          sourceKind: "mbtiles-file",
          sourceLayers,
          tileType: metadata.tileType,
        },
      ),
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
    >
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={handleChooseMbtilesFile}
          >
            <FileUp className="mr-2 h-3.5 w-3.5" />
            {t("addData.common.chooseFile")}
          </Button>
          <span className="min-w-0 truncate text-xs text-muted-foreground">
            {selectedMbtiles
              ? fileNameFromPath(selectedMbtiles.path)
              : t("addData.common.noFileSelected")}
          </span>
        </div>
        {selectedMbtiles && (
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>{t("addData.mbtiles.tileType")}</Label>
              <div className="rounded-md border bg-muted/30 px-3 py-2 text-sm">
                {selectedMbtiles.metadata.tileType}
              </div>
            </div>
            <div className="space-y-1.5">
              <Label>{t("addData.common.format")}</Label>
              <div className="rounded-md border bg-muted/30 px-3 py-2 text-sm">
                {selectedMbtiles.metadata.format}
              </div>
            </div>
          </div>
        )}
        {selectedMbtiles?.metadata.tileType === "vector" && (
          <div className="space-y-1.5">
            <Label htmlFor="mbtiles-source-layers">
              {t("addData.mbtiles.sourceLayers")}
            </Label>
            <Input
              id="mbtiles-source-layers"
              placeholder={t("addData.mbtiles.sourceLayersPlaceholder")}
              value={mbtilesSourceLayers}
              onChange={(event) => setMbtilesSourceLayers(event.target.value)}
            />
          </div>
        )}
      </div>
    </AddDataSourceForm>
  );
}
