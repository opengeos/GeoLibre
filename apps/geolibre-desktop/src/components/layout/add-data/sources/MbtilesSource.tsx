import { Button, Input, Label } from "@geolibre/ui";
import { FileUp } from "lucide-react";
import { useState } from "react";
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
  const source = useAddDataSource("MBTiles Layer");
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
        current.trim() && current !== "MBTiles Layer"
          ? current
          : metadata.name || layerNameFromPath(result.path, "MBTiles Layer"),
      );
    } catch (err) {
      source.setError(errorMessage(err, "Could not read MBTiles file."));
    }
  };

  const handleSubmit = source.runSubmit(() => {
    const name = source.layerName.trim() || "MBTiles Layer";
    if (!selectedMbtiles) throw new Error("Choose an MBTiles file.");
    registerMbtilesProtocol();

    const { metadata, path } = selectedMbtiles;
    const sourceLayers = mbtilesSourceLayers
      .split(",")
      .map((sourceLayer) => sourceLayer.trim())
      .filter(Boolean);
    if (metadata.tileType === "vector" && sourceLayers.length === 0) {
      throw new Error("Enter at least one vector source layer.");
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
            Choose file
          </Button>
          <span className="min-w-0 truncate text-xs text-muted-foreground">
            {selectedMbtiles
              ? fileNameFromPath(selectedMbtiles.path)
              : "No file selected"}
          </span>
        </div>
        {selectedMbtiles && (
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>Tile type</Label>
              <div className="rounded-md border bg-muted/30 px-3 py-2 text-sm">
                {selectedMbtiles.metadata.tileType}
              </div>
            </div>
            <div className="space-y-1.5">
              <Label>Format</Label>
              <div className="rounded-md border bg-muted/30 px-3 py-2 text-sm">
                {selectedMbtiles.metadata.format}
              </div>
            </div>
          </div>
        )}
        {selectedMbtiles?.metadata.tileType === "vector" && (
          <div className="space-y-1.5">
            <Label htmlFor="mbtiles-source-layers">Source layers</Label>
            <Input
              id="mbtiles-source-layers"
              placeholder="building, place, water"
              value={mbtilesSourceLayers}
              onChange={(event) => setMbtilesSourceLayers(event.target.value)}
            />
          </div>
        )}
      </div>
    </AddDataSourceForm>
  );
}
