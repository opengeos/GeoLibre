import { Button, Input, Label } from "@geolibre/ui";
import { FileUp } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  mbtilesTileUrl,
  openBrowserMbtiles,
  readMbtilesMetadata,
  registerMbtilesProtocol,
  releaseBrowserMbtiles,
  type MbtilesMetadata,
} from "../../../../lib/mbtiles";
import { MAX_BROWSER_MBTILES_BYTES } from "../../../../lib/mbtiles-sqljs";
import {
  FileTooLargeError,
  openLocalDataFileWithFallback,
} from "../../../../lib/file-io/file-dialogs";
import { isTauri } from "../../../../lib/tauri-io";
import { createBaseLayer, errorMessage, fileNameFromPath, layerNameFromPath } from "../helpers";
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
  // In the browser the file is opened into an in-memory sql.js database keyed
  // by a synthetic path. Track the one not yet added to the map so it is freed
  // when the user picks another file or closes the dialog; once a layer uses it
  // the key is cleared and the database lives on with the layer.
  const pendingBrowserKey = useRef<string | null>(null);

  const discardPendingBrowserFile = () => {
    if (pendingBrowserKey.current) releaseBrowserMbtiles(pendingBrowserKey.current);
    pendingBrowserKey.current = null;
  };

  // Free a picked-but-never-added file when the dialog closes.
  useEffect(
    () => () => {
      if (pendingBrowserKey.current) releaseBrowserMbtiles(pendingBrowserKey.current);
      pendingBrowserKey.current = null;
    },
    [],
  );

  const handleChooseMbtilesFile = async () => {
    source.setError(null);
    try {
      const desktop = isTauri();
      const result = await openLocalDataFileWithFallback({
        filters: [
          {
            name: "MBTiles",
            extensions: ["mbtiles"],
          },
        ],
        accept: ".mbtiles",
        // Desktop reads tiles straight from disk by path; the browser has no
        // path, so it needs the bytes to open with sql.js.
        readBinary: !desktop,
        // Only the browser loads the whole file into memory; desktop reads
        // tiles from disk, so it has no size limit.
        maxBytes: desktop ? undefined : MAX_BROWSER_MBTILES_BYTES,
      });
      if (!result) return;

      let metadata: MbtilesMetadata;
      let path = result.path;
      if (desktop) {
        metadata = await readMbtilesMetadata(result.path);
      } else {
        if (!result.data) throw new Error(t("addData.mbtiles.readError"));
        const opened = await openBrowserMbtiles(result.data, result.path);
        discardPendingBrowserFile();
        pendingBrowserKey.current = opened.key;
        metadata = opened.metadata;
        path = opened.key;
      }

      setSelectedMbtiles({ metadata, path });
      setMbtilesSourceLayers(metadata.sourceLayers.join(", "));
      source.setLayerName((current) =>
        current.trim() && current !== defaultName
          ? current
          : metadata.name || layerNameFromPath(result.path, defaultName),
      );
    } catch (err) {
      source.setError(
        err instanceof FileTooLargeError
          ? t("addData.mbtiles.errorTooLarge", {
              size: Math.ceil(err.size / 1_048_576),
              limit: Math.floor(MAX_BROWSER_MBTILES_BYTES / 1_048_576),
            })
          : errorMessage(err, t("addData.mbtiles.readError")),
      );
    }
  };

  const handleSubmit = source.runSubmit(() => {
    const name = source.layerName.trim() || defaultName;
    if (!selectedMbtiles) throw new Error(t("addData.mbtiles.errorChooseFile"));
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
    // The layer now owns the in-memory database; don't free it on unmount.
    if (pendingBrowserKey.current === path) pendingBrowserKey.current = null;
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
          <Button type="button" variant="outline" onClick={handleChooseMbtilesFile}>
            <FileUp className="me-2 h-3.5 w-3.5" />
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
            <Label htmlFor="mbtiles-source-layers">{t("addData.mbtiles.sourceLayers")}</Label>
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
