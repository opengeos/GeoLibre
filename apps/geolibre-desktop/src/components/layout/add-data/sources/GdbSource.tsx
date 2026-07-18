import {
  fetchConversionJob,
  runVectorLayers,
  runVectorToVector,
  type ConversionJob,
  type VectorDatasetLayer,
} from "@geolibre/processing";
import { Button, Input, Label, Select } from "@geolibre/ui";
import { FolderOpen, Layers } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { FeatureCollection } from "geojson";
import { tempDir, join } from "@tauri-apps/api/path";
import { remove } from "@tauri-apps/plugin-fs";
import { startGeoLibreSidecar } from "../../../../lib/sidecar";
import { isTauri, pickLocalDirectory, readLocalFileBytes } from "../../../../lib/tauri-io";
import { LAST_GEODATABASE_STORAGE_KEY } from "../constants";
import {
  createBaseLayer,
  errorMessage,
  fileNameFromPath,
  layerNameFromPath,
  normalizeCrs,
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

interface StoredGdbSelection {
  path: string;
  layer?: string;
}

/** Reads the last-used geodatabase selection from localStorage (best-effort). */
function readStoredGdbSelection(): StoredGdbSelection | null {
  if (typeof window === "undefined") return null;
  try {
    const value = window.localStorage.getItem(LAST_GEODATABASE_STORAGE_KEY);
    if (!value) return null;
    const parsed = JSON.parse(value) as StoredGdbSelection;
    return typeof parsed?.path === "string" && parsed.path ? parsed : null;
  } catch {
    return null;
  }
}

/** Persists the last-used geodatabase selection to localStorage (best-effort). */
function writeStoredGdbSelection(selection: StoredGdbSelection): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(LAST_GEODATABASE_STORAGE_KEY, JSON.stringify(selection));
  } catch {
    // Best-effort persistence: a quota/private-mode failure must not break the
    // Add Data dialog (mirrors the service library's guard).
  }
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
  // Source CRS typed by the user, only consulted for layers whose spatial
  // reference GDAL could not resolve to an authority code (crs === null).
  const [crsOverride, setCrsOverride] = useState("");
  const [isReadingLayers, setIsReadingLayers] = useState(false);
  // Bumped on every folder pick so a slow layer probe that resolves after a
  // newer one cannot overwrite the newer geodatabase's layers.
  const loadSeq = useRef(0);
  const desktop = isTauri();
  const selectedInfo = layers.find((layer) => layer.name === selectedLayer);

  // Shared by the folder picker and the reopen-restore effect: list the
  // geodatabase's feature classes and select `preferredLayer` when it is
  // still present (else the first). Persists the selection so the panel can
  // restore it the next time it opens.
  const loadGdbLayers = async (path: string, preferredLayer?: string) => {
    const requestId = ++loadSeq.current;
    setGdbPath(path);
    setLayers([]);
    setSelectedLayer(null);
    setCrsOverride("");
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
      const result = job.result as { layers?: VectorDatasetLayer[] } | undefined;
      // Attribute-only tables (no geometry) cannot become map layers.
      const spatialLayers = (result?.layers ?? []).filter((layer) => layer.geometry_type);
      if (spatialLayers.length === 0) {
        throw new Error(t("addData.gdb.errorNoLayers"));
      }
      const selected =
        preferredLayer && spatialLayers.some((layer) => layer.name === preferredLayer)
          ? preferredLayer
          : spatialLayers[0].name;
      setLayers(spatialLayers);
      setSelectedLayer(selected);
      source.setLayerName((current) =>
        current.trim() && current !== defaultName ? current : layerNameFromPath(path, defaultName),
      );
      writeStoredGdbSelection({ path, layer: selected });
    } catch (err) {
      if (requestId === loadSeq.current) {
        source.setError(errorMessage(err, t("addData.gdb.readError")));
      }
    } finally {
      if (requestId === loadSeq.current) setIsReadingLayers(false);
    }
  };

  // Reopening the panel starts blank (the dialog unmounts on close), so
  // restore the last-used geodatabase and re-list its feature classes. A
  // stale path (moved/deleted .gdb) surfaces the normal read error and the
  // picker stays usable; the stored value is only replaced by a newer
  // successful listing, so a transient sidecar failure does not lose it.
  useEffect(() => {
    if (!desktop) return;
    const stored = readStoredGdbSelection();
    if (stored) void loadGdbLayers(stored.path, stored.layer);
    // Mount-only restore; loadGdbLayers is stable for the component's life.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
    await loadGdbLayers(path);
  };

  const handleSubmit = source.runSubmit(async () => {
    if (!gdbPath) throw new Error(t("addData.gdb.errorChooseFolder"));
    if (selectedLayer === null) throw new Error(t("addData.gdb.errorNoLayer"));

    const name = source.layerName.trim() || defaultName;

    // MapLibre renders lon/lat. Reproject from the layer's declared CRS, or
    // from the user-entered one when the geodatabase's spatial reference could
    // not be resolved. With neither, the coordinates would render wherever
    // their raw values land, so refuse instead of silently misplacing them.
    const sourceCrs = selectedInfo?.crs ?? normalizeCrs(crsOverride);
    if (!sourceCrs) throw new Error(t("addData.gdb.errorMissingCrs"));

    // The sidecar writes the converted layer into the OS temp directory; the
    // file only serves this one add and is removed after the read below.
    const outputPath = await join(
      await tempDir(),
      `geolibre-gdb-${Date.now()}-${Math.random().toString(36).slice(2)}.geojson`,
    );

    await startGeoLibreSidecar();
    let featureCollection: FeatureCollection;
    // Set once the job is known to have finished on the sidecar; cleanup is
    // gated on it because after a poll timeout (or a mid-poll network error)
    // the job may still be running and writing outputPath — removing it then
    // would unlink the file out from under the write. In that rare case the
    // file is left for the OS temp cleaner instead.
    let jobFinished = false;
    try {
      const job = await waitForConversionJob(
        await runVectorToVector({
          input_path: gdbPath,
          output_path: outputPath,
          input_layer: selectedLayer,
          target_srs: "EPSG:4326",
          // Only sent when the layer itself declares nothing; the backend
          // otherwise reads the CRS from the dataset.
          ...(selectedInfo?.crs ? {} : { source_srs: sourceCrs }),
        }),
        t("addData.gdb.errorTimeout"),
      );
      jobFinished = true;
      if (job.status !== "succeeded") {
        throw new Error(job.error || t("addData.gdb.convertError"));
      }
      const bytes = await readLocalFileBytes(outputPath);
      featureCollection = JSON.parse(new TextDecoder("utf-8").decode(bytes)) as FeatureCollection;
    } finally {
      // Best-effort cleanup so repeated imports cannot pile up in temp (the
      // capability grants remove for exactly this filename pattern). A failed
      // conversion already unlinked its partial output server-side, so a
      // missing file here is the normal failure-path outcome.
      if (jobFinished) await remove(outputPath).catch(() => undefined);
    }

    // Remember the layer that was actually added (it may differ from the
    // listing default), so reopening the panel preselects it.
    writeStoredGdbSelection({ path: gdbPath, layer: selectedLayer });

    source.addAndClose(
      {
        ...createBaseLayer(
          name,
          "geojson",
          { type: "geojson" },
          {
            sourceKind: "gdb",
            gdbLayer: selectedLayer,
            sourceCrs,
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
        source.isSubmitting || isReadingLayers || !desktop || !gdbPath || selectedLayer === null
      }
    >
      <div className="space-y-3">
        {!desktop ? (
          <p className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
            {t("addData.gdb.desktopOnly")}
          </p>
        ) : null}

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
            {gdbPath ? fileNameFromPath(gdbPath) : t("addData.gdb.noFolderSelected")}
          </span>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="gdb-layer">
            <Layers className="me-1 inline h-3.5 w-3.5 align-text-bottom" />
            {t("addData.gdb.layer")}
          </Label>
          <Select
            id="gdb-layer"
            value={selectedLayer ?? ""}
            disabled={isReadingLayers || layers.length === 0}
            onChange={(event) => {
              setSelectedLayer(event.target.value);
              // The override is a per-layer declaration; carrying it over to
              // another CRS-less layer would silently reproject that layer
              // from the previous layer's CRS.
              setCrsOverride("");
            }}
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
          <p className="text-xs text-muted-foreground">{t("addData.gdb.help")}</p>
        </div>

        {selectedInfo && !selectedInfo.crs ? (
          <div className="space-y-1.5">
            <Label htmlFor="gdb-crs">{t("addData.gdb.crs")}</Label>
            <Input
              id="gdb-crs"
              placeholder={t("addData.gdb.crsPlaceholder")}
              value={crsOverride}
              onChange={(event) => setCrsOverride(event.target.value)}
            />
            <p className="text-xs text-muted-foreground">{t("addData.gdb.crsHelp")}</p>
          </div>
        ) : null}
      </div>
    </AddDataSourceForm>
  );
}
