import {
  fetchConversionJob,
  runVectorLayers,
  runVectorToVector,
  type ConversionJob,
  type VectorDatasetLayer,
} from "@geolibre/processing";
import { Button, Label, Select } from "@geolibre/ui";
import { FolderOpen, Layers } from "lucide-react";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { FeatureCollection } from "geojson";
import { tempDir, join } from "@tauri-apps/api/path";
import { startGeoLibreSidecar } from "../../../../lib/sidecar";
import {
  isTauri,
  pickLocalDirectory,
  readLocalFileBytes,
} from "../../../../lib/tauri-io";
import {
  createBaseLayer,
  errorMessage,
  fileNameFromPath,
  layerNameFromPath,
} from "../helpers";
import { AddDataSourceForm, useAddDataSource } from "../shared";

const POLL_INTERVAL_MS = 1000;
// Reading a File Geodatabase layer is a local disk read plus a GeoJSON write,
// but the sidecar's managed runtime may bootstrap itself (download DuckDB) on
// the very first conversion, so the ceiling is generous.
const POLL_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Poll a sidecar conversion job until it leaves the pending/running states.
 * Resolves with the finished job (whatever its outcome); the caller decides
 * how to surface a failure.
 */
async function waitForConversionJob(
  initial: ConversionJob,
  timeoutMessage: string,
): Promise<ConversionJob> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let job = initial;
  while (job.status === "pending" || job.status === "running") {
    if (Date.now() > deadline) throw new Error(timeoutMessage);
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    job = await fetchConversionJob(job.id);
  }
  return job;
}

/**
 * Add Data source for Esri File Geodatabases (`.gdb` folders). A geodatabase
 * is a directory-based, multi-layer format that neither MapLibre nor
 * DuckDB-WASM can read (the WASM spatial build lacks the OpenFileGDB driver),
 * so the layer list and the read both go through the Python sidecar's native
 * GDAL: the chosen layer is converted to a temporary WGS84 GeoJSON on disk and
 * loaded from there. Desktop only — the flow needs local paths and the local
 * sidecar.
 */
export function GdbSource() {
  const { t } = useTranslation();
  const [defaultName] = useState(() => t("addData.gdb.defaultName"));
  const source = useAddDataSource(defaultName);
  const [gdbPath, setGdbPath] = useState<string | null>(null);
  const [layers, setLayers] = useState<VectorDatasetLayer[]>([]);
  const [selectedLayer, setSelectedLayer] = useState<string | null>(null);
  const [isReadingLayers, setIsReadingLayers] = useState(false);
  // Bumped on every folder pick so a slow layer probe that resolves after a
  // newer one cannot overwrite the newer geodatabase's layers.
  const loadSeq = useRef(0);
  const desktop = isTauri();

  const handleChooseFolder = async () => {
    source.setError(null);
    const path = await pickLocalDirectory().catch((err: unknown) => {
      source.setError(errorMessage(err, t("addData.gdb.readError")));
      return null;
    });
    if (!path) return;
    if (!/\.gdb$/i.test(path.replace(/[/\\]+$/, ""))) {
      source.setError(t("addData.gdb.errorNotGdb"));
      return;
    }

    const requestId = ++loadSeq.current;
    setGdbPath(path);
    setLayers([]);
    setSelectedLayer(null);
    setIsReadingLayers(true);
    try {
      await startGeoLibreSidecar();
      const job = await waitForConversionJob(
        await runVectorLayers({ input_path: path }),
        t("addData.gdb.errorTimeout"),
      );
      if (requestId !== loadSeq.current) return; // superseded by a newer pick
      if (job.status !== "succeeded") {
        throw new Error(job.error || t("addData.gdb.readError"));
      }
      const result = job.result as
        | { layers?: VectorDatasetLayer[] }
        | undefined;
      // Attribute-only tables (no geometry) cannot become map layers.
      const spatialLayers = (result?.layers ?? []).filter(
        (layer) => layer.geometry_type,
      );
      if (spatialLayers.length === 0) {
        throw new Error(t("addData.gdb.errorNoLayers"));
      }
      setLayers(spatialLayers);
      setSelectedLayer(spatialLayers[0].name);
      source.setLayerName((current) =>
        current.trim() && current !== defaultName
          ? current
          : layerNameFromPath(path, defaultName),
      );
    } catch (err) {
      if (requestId === loadSeq.current) {
        source.setError(errorMessage(err, t("addData.gdb.readError")));
      }
    } finally {
      if (requestId === loadSeq.current) setIsReadingLayers(false);
    }
  };

  const handleSubmit = source.runSubmit(async () => {
    if (!gdbPath) throw new Error(t("addData.gdb.errorChooseFolder"));
    if (selectedLayer === null) throw new Error(t("addData.gdb.errorNoLayer"));

    const layerInfo = layers.find((layer) => layer.name === selectedLayer);
    const name = source.layerName.trim() || defaultName;

    // The sidecar writes the converted layer into the OS temp directory; the
    // file is read straight back and only serves this one add, so a leftover
    // (there is no delete IPC) is ephemeral and reclaimed by the OS.
    const outputPath = await join(
      await tempDir(),
      `geolibre-gdb-${Date.now()}-${Math.random().toString(36).slice(2)}.geojson`,
    );

    await startGeoLibreSidecar();
    const job = await waitForConversionJob(
      await runVectorToVector({
        input_path: gdbPath,
        output_path: outputPath,
        input_layer: selectedLayer,
        // MapLibre renders lon/lat; reproject unless the layer declares no CRS
        // (then the data is passed through as-is rather than rejected).
        ...(layerInfo?.crs ? { target_srs: "EPSG:4326" } : {}),
      }),
      t("addData.gdb.errorTimeout"),
    );
    if (job.status !== "succeeded") {
      throw new Error(job.error || t("addData.gdb.convertError"));
    }

    const bytes = await readLocalFileBytes(outputPath);
    const featureCollection = JSON.parse(
      new TextDecoder("utf-8").decode(bytes),
    ) as FeatureCollection;

    source.addAndClose(
      {
        ...createBaseLayer(
          name,
          "geojson",
          { type: "geojson" },
          {
            sourceKind: "gdb",
            gdbLayer: selectedLayer,
            sourceCrs: layerInfo?.crs ?? null,
            featureCount: featureCollection.features.length,
          },
        ),
        geojson: featureCollection,
        sourcePath: gdbPath,
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
      submitDisabled={
        source.isSubmitting ||
        isReadingLayers ||
        !desktop ||
        !gdbPath ||
        selectedLayer === null
      }
    >
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={handleChooseFolder}
            disabled={!desktop || isReadingLayers || source.isSubmitting}
          >
            <FolderOpen className="me-2 h-3.5 w-3.5" />
            {t("addData.gdb.chooseFolder")}
          </Button>
          <span className="min-w-0 truncate text-xs text-muted-foreground">
            {gdbPath
              ? fileNameFromPath(gdbPath)
              : t("addData.gdb.noFolderSelected")}
          </span>
        </div>

        {!desktop ? (
          <p className="text-xs text-muted-foreground">
            {t("addData.gdb.desktopOnly")}
          </p>
        ) : null}

        <div className="space-y-1.5">
          <Label htmlFor="gdb-layer">
            <Layers className="me-1 inline h-3.5 w-3.5 align-text-bottom" />
            {t("addData.gdb.layer")}
          </Label>
          <Select
            id="gdb-layer"
            value={selectedLayer ?? ""}
            disabled={isReadingLayers || layers.length === 0}
            onChange={(event) => setSelectedLayer(event.target.value)}
          >
            {layers.length === 0 ? (
              <option value="">
                {isReadingLayers
                  ? t("addData.gdb.readingLayers")
                  : t("addData.gdb.layerPlaceholder")}
              </option>
            ) : (
              layers.map((layer) => (
                <option key={layer.name} value={layer.name}>
                  {t("addData.gdb.layerOption", {
                    name: layer.name,
                    type: layer.geometry_type || "?",
                    count: layer.feature_count ?? "?",
                  })}
                </option>
              ))
            )}
          </Select>
          <p className="text-xs text-muted-foreground">
            {t("addData.gdb.help")}
          </p>
        </div>
      </div>
    </AddDataSourceForm>
  );
}
