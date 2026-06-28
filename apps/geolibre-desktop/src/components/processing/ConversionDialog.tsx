import { useAppStore, type ConversionToolKind } from "@geolibre/core";
import {
  fetchConversionJob,
  fetchConversionStatus,
  runCsvToGeoParquet,
  runRasterToCog,
  runVectorToFlatGeobuf,
  runVectorToGeoPackage,
  runVectorToGeoParquet,
  runVectorToPmtiles,
  runVectorToShapefile,
  runVectorToVector,
  type ConversionJob,
} from "@geolibre/processing";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  ScrollArea,
  Select,
  cn,
} from "@geolibre/ui";
import {
  AlertCircle,
  CheckCircle2,
  FolderOpen,
  Loader2,
  Play,
  Save,
  Server,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  isTauri,
  pickLocalPathWithFallback,
  pickSavePathWithFallback,
  readCsvHeaderColumns,
  saveBinaryFileWithFallback,
  type FileDialogFilter,
} from "../../lib/tauri-io";
import type { LargeVectorDataset } from "../../lib/duckdb-vector-guard";
import { startGeoLibreSidecar } from "../../lib/sidecar";
import i18n from "../../i18n";

const RUNNING_JOB_STATUSES = new Set(["pending", "running"]);

// Local (browser) conversions reuse the ConversionJob shape so the status and
// log UI stays identical; this id keeps them out of the sidecar job poller.
const BROWSER_JOB_ID = "browser-duckdb-wasm";

const SHAPEFILE_SIDECAR_EXTENSIONS = new Set(["dbf", "shx", "prj", "cpg"]);

const GEOPARQUET_MIME_TYPE = "application/vnd.apache.parquet";

function fileExtension(name: string): string {
  const index = name.lastIndexOf(".");
  return index >= 0 ? name.slice(index + 1).toLowerCase() : "";
}

function stripExtension(name: string): string {
  const extension = fileExtension(name);
  return extension ? name.slice(0, -(extension.length + 1)) : name;
}

function defaultGeoParquetName(inputName: string): string {
  return `${stripExtension(inputName) || "sorted"}.parquet`;
}

/**
 * Suggest an output file name for a tool from its input file: the input's stem
 * plus the tool's default output extension (e.g. `cities.geojson` →
 * `cities.gpkg` for Vector to Vector, `cities.parquet` for the GeoParquet
 * writers).
 */
function defaultOutputNameForKind(
  kind: ConversionToolKind,
  inputName: string,
): string {
  const stem = stripExtension(inputName) || "output";
  const extension = fileExtension(TOOL_CONFIGS[kind].defaultOutputName) || "parquet";
  return `${stem}.${extension}`;
}

function browserConversionJob(
  toolId: string,
  status: ConversionJob["status"],
  messages: string[],
  error: string | null = null,
): ConversionJob {
  const now = new Date().toISOString();
  return {
    id: BROWSER_JOB_ID,
    status,
    tool_id: toolId,
    created_at: now,
    updated_at: now,
    messages,
    outputs: {},
    error,
  };
}

const LON_PATTERN = /^(lon|lng|long|longitude|x|x_coord|easting)$/i;
const LAT_PATTERN = /^(lat|latitude|y|y_coord|northing)$/i;

/** Guess the longitude/latitude columns from a CSV's header names. */
function guessLonLatColumns(columns: string[]): {
  lon: string;
  lat: string;
} {
  const lon = columns.find((name) => LON_PATTERN.test(name.trim()));
  const lat = columns.find((name) => LAT_PATTERN.test(name.trim()));
  return {
    lon: lon ?? columns[0] ?? "",
    lat: lat ?? columns[1] ?? "",
  };
}

/** Pick the main vector file from a multi-file browser selection. */
function splitBrowserSelection(files: File[]): {
  mainFile: File | null;
  siblings: File[];
} {
  const mainFile =
    files.find((file) => fileExtension(file.name) === "shp") ??
    files.find(
      (file) => !SHAPEFILE_SIDECAR_EXTENSIONS.has(fileExtension(file.name)),
    ) ??
    null;
  return {
    mainFile,
    siblings: files.filter((file) => file !== mainFile),
  };
}

interface ConversionToolConfig {
  title: string;
  description: string;
  inputLabel: string;
  inputFilters: FileDialogFilter[];
  outputLabel: string;
  outputFilters: FileDialogFilter[];
  defaultOutputName: string;
  compressions?: string[];
  defaultCompression?: string;
}

const VECTOR_INPUT_EXTENSIONS = [
  "parquet",
  "geoparquet",
  "geojson",
  "json",
  "shp",
  "gpkg",
  "fgb",
  "gml",
  "kml",
];
const PARQUET_COMPRESSIONS = ["zstd", "snappy", "gzip", "lz4", "uncompressed"];

// Input extensions the generic Vector to Vector tool accepts. Reading is handled
// by ST_Read (or read_parquet), so this only bounds the file picker; the actual
// detection is by content/extension at read time. `.zip` is a zipped Shapefile,
// read by the sidecar via GDAL's /vsizip/ (browser input is gated separately —
// the in-browser DuckDB reader can't open a zip).
const VECTOR_TO_VECTOR_INPUT_EXTENSIONS = [
  "geojson",
  "geojsonl",
  "json",
  "parquet",
  "geoparquet",
  "fgb",
  "gpkg",
  "shp",
  "zip",
  "kml",
  "gml",
  "gpx",
];

// In-browser writers, keyed by output extension. DuckDB-WASM cannot write GDAL
// vector formats (its virtual filesystem lacks the random-access seek/write the
// GDAL drivers need), so the web build is limited to GeoParquet (DuckDB) plus
// the pure-JS GeoJSON/CSV/GeoPackage/Shapefile writers. The Shapefile writer
// always emits a zip, so `.zip` (not bare `.shp`) is the browser Shapefile
// option; a bare `.shp` is produced only by the desktop sidecar.
const BROWSER_OUTPUT_FORMATS: Record<
  string,
  "geojson" | "csv" | "geoparquet" | "geopackage" | "shapefile"
> = {
  geojson: "geojson",
  json: "geojson",
  csv: "csv",
  parquet: "geoparquet",
  geoparquet: "geoparquet",
  gpkg: "geopackage",
  zip: "shapefile",
};

// Output extensions the generic Vector to Vector tool offers. The sidecar
// (native DuckDB spatial) writes every one of these via a GDAL driver; the
// in-browser runtime can only produce the BROWSER_OUTPUT_FORMATS subset.
const VECTOR_TO_VECTOR_OUTPUT_EXTENSIONS = [
  "geojson",
  "geojsonl",
  "json",
  "fgb",
  "gpkg",
  "shp",
  "zip",
  "kml",
  "gml",
  "gpx",
  "sqlite",
  "csv",
  "parquet",
  "geoparquet",
];

/** The in-browser writer for an output extension, or null when unsupported. */
function browserExportFormatForExtension(extension: string) {
  return BROWSER_OUTPUT_FORMATS[extension] ?? null;
}

const TOOL_CONFIGS: Record<ConversionToolKind, ConversionToolConfig> = {
  "vector-to-vector": {
    title: "Vector to Vector",
    description:
      "Convert between any vector formats DuckDB's spatial extension supports. The input and output formats are detected from the file extensions. The desktop app writes any format (FlatGeobuf, GeoPackage, Shapefile, KML, GML, …); the browser writes GeoJSON, CSV, GeoParquet, GeoPackage, and Shapefile.",
    inputLabel: "Input vector file",
    inputFilters: [
      { name: "Vector", extensions: VECTOR_TO_VECTOR_INPUT_EXTENSIONS },
    ],
    outputLabel: "Output vector file",
    outputFilters: [
      { name: "Vector", extensions: VECTOR_TO_VECTOR_OUTPUT_EXTENSIONS },
    ],
    defaultOutputName: "output.gpkg",
  },
  "vector-to-geoparquet": {
    title: "Vector to GeoParquet",
    description:
      "Convert a vector dataset to a Hilbert-sorted, compressed GeoParquet file optimized for cloud-native range requests.",
    inputLabel: "Input vector file",
    inputFilters: [{ name: "Vector", extensions: VECTOR_INPUT_EXTENSIONS }],
    outputLabel: "Output GeoParquet file",
    outputFilters: [{ name: "GeoParquet", extensions: ["parquet"] }],
    defaultOutputName: "sorted.parquet",
    compressions: PARQUET_COMPRESSIONS,
    defaultCompression: "zstd",
  },
  "vector-to-flatgeobuf": {
    title: "Vector to FlatGeobuf",
    description:
      "Convert a vector dataset to a Hilbert-sorted FlatGeobuf with a packed spatial index for fast cloud-native access.",
    inputLabel: "Input vector file",
    inputFilters: [{ name: "Vector", extensions: VECTOR_INPUT_EXTENSIONS }],
    outputLabel: "Output FlatGeobuf file",
    outputFilters: [{ name: "FlatGeobuf", extensions: ["fgb"] }],
    defaultOutputName: "output.fgb",
  },
  "vector-to-shapefile": {
    title: "Vector to Shapefile",
    description:
      "Convert a vector dataset to a zipped ESRI Shapefile (.shp/.shx/.dbf/.prj). Field names are truncated to 10 characters.",
    inputLabel: "Input vector file",
    inputFilters: [{ name: "Vector", extensions: VECTOR_INPUT_EXTENSIONS }],
    outputLabel: "Output zipped Shapefile",
    outputFilters: [{ name: "Zip", extensions: ["zip"] }],
    defaultOutputName: "output.zip",
  },
  "vector-to-geopackage": {
    title: "Vector to GeoPackage",
    description:
      "Convert a vector dataset to a GeoPackage (.gpkg) for sharing with QGIS, ArcGIS, and other GIS tools.",
    inputLabel: "Input vector file",
    inputFilters: [{ name: "Vector", extensions: VECTOR_INPUT_EXTENSIONS }],
    outputLabel: "Output GeoPackage file",
    outputFilters: [{ name: "GeoPackage", extensions: ["gpkg"] }],
    defaultOutputName: "output.gpkg",
  },
  "csv-to-geoparquet": {
    title: "CSV to GeoParquet",
    description:
      "Build point geometries from longitude/latitude columns and write a Hilbert-sorted, compressed GeoParquet.",
    inputLabel: "Input CSV file",
    inputFilters: [{ name: "CSV", extensions: ["csv", "tsv", "txt"] }],
    outputLabel: "Output GeoParquet file",
    outputFilters: [{ name: "GeoParquet", extensions: ["parquet"] }],
    defaultOutputName: "points.parquet",
    compressions: PARQUET_COMPRESSIONS,
    defaultCompression: "zstd",
  },
  "vector-to-pmtiles": {
    title: "Vector to PMTiles",
    description:
      "Tile a vector dataset into a single PMTiles archive of vector tiles, ready for cloud-native serving.",
    inputLabel: "Input vector file",
    inputFilters: [
      {
        name: "Vector",
        extensions: ["parquet", "geoparquet", "geojson", "json", "gpkg", "fgb"],
      },
    ],
    outputLabel: "Output PMTiles file",
    outputFilters: [{ name: "PMTiles", extensions: ["pmtiles"] }],
    defaultOutputName: "tiles.pmtiles",
  },
  "raster-to-cog": {
    title: "Raster to COG",
    description:
      "Convert a raster dataset to a valid, compressed Cloud Optimized GeoTIFF with internal tiling and overviews.",
    inputLabel: "Input raster file",
    inputFilters: [
      {
        name: "Raster",
        extensions: ["tif", "tiff", "img", "vrt", "asc", "nc", "jp2", "hgt"],
      },
    ],
    outputLabel: "Output COG file",
    outputFilters: [{ name: "GeoTIFF", extensions: ["tif", "tiff"] }],
    defaultOutputName: "output_cog.tif",
    compressions: ["deflate", "zstd", "lzw", "webp", "jpeg", "packbits", "raw"],
    defaultCompression: "deflate",
  },
};

const DEFAULT_ROW_GROUP_SIZE = "30000";

function jobStatusTone(job: ConversionJob | null): string {
  if (!job) return "text-muted-foreground";
  if (job.status === "succeeded") return "text-emerald-700";
  if (job.status === "failed") return "text-destructive";
  return "text-primary";
}

export function ConversionDialog() {
  const kind = useAppStore((s) => s.ui.conversionOpen);
  const setConversionOpen = useAppStore((s) => s.setConversionOpen);

  const [inputPath, setInputPath] = useState("");
  const [outputPath, setOutputPath] = useState("");
  const [browserFiles, setBrowserFiles] = useState<File[]>([]);
  const [compression, setCompression] = useState("");
  const [rowGroupSize, setRowGroupSize] = useState(DEFAULT_ROW_GROUP_SIZE);
  const [lonColumn, setLonColumn] = useState("longitude");
  const [latColumn, setLatColumn] = useState("latitude");
  const [csvColumns, setCsvColumns] = useState<string[]>([]);
  const [layerName, setLayerName] = useState("data");
  const [minZoom, setMinZoom] = useState("0");
  const [maxZoom, setMaxZoom] = useState("14");
  const [runtimeAvailable, setRuntimeAvailable] = useState<boolean | null>(null);
  const [runtimeMessage, setRuntimeMessage] = useState("");
  const [startingServer, setStartingServer] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [job, setJob] = useState<ConversionJob | null>(null);
  const logEndRef = useRef<HTMLDivElement | null>(null);

  const config = kind ? TOOL_CONFIGS[kind] : null;
  const desktop = isTauri();
  // These conversions run entirely in-browser with DuckDB-WASM (plus the
  // bundled JS writers) and never need the Python sidecar. On desktop the same
  // tools prefer the sidecar, which covers every format. FlatGeobuf and PMTiles
  // have no WASM writer, so they stay sidecar-only.
  const usesBrowserRuntime =
    !desktop &&
    (kind === "vector-to-vector" ||
      kind === "vector-to-geoparquet" ||
      kind === "csv-to-geoparquet");
  const isCsv = kind === "csv-to-geoparquet";
  const isPmtiles = kind === "vector-to-pmtiles";
  const showCompression = Boolean(config?.compressions);
  // Row group size is a Parquet concept, so it is shown only for the
  // GeoParquet writers — not for Raster to COG, which also has a compression
  // option.
  const showRowGroup =
    kind === "vector-to-geoparquet" || kind === "csv-to-geoparquet";

  const checkRuntime = useCallback(async () => {
    if (usesBrowserRuntime) {
      setRuntimeAvailable(true);
      setRuntimeMessage("Conversion runs in your browser with DuckDB-WASM.");
      return;
    }
    if (!desktop) {
      // FlatGeobuf / PMTiles have no in-browser writer and need the sidecar,
      // which a pure web build cannot start.
      setRuntimeAvailable(false);
      setRuntimeMessage(
        "This conversion needs the GeoLibre desktop app or a running sidecar.",
      );
      return;
    }
    setRuntimeAvailable(null);
    setRuntimeMessage("Checking conversion runtime.");
    try {
      const status = await fetchConversionStatus();
      setRuntimeAvailable(status.available);
      setRuntimeMessage(status.message);
    } catch (err) {
      setRuntimeAvailable(false);
      setRuntimeMessage(
        err instanceof Error ? err.message : "Could not connect to sidecar.",
      );
    }
  }, [desktop, usesBrowserRuntime]);

  // Reset per-tool state when the dialog opens or the tool changes.
  useEffect(() => {
    if (!kind) return;
    setInputPath("");
    setOutputPath("");
    setBrowserFiles([]);
    setCompression(TOOL_CONFIGS[kind].defaultCompression ?? "zstd");
    setRowGroupSize(DEFAULT_ROW_GROUP_SIZE);
    setLonColumn("longitude");
    setLatColumn("latitude");
    setCsvColumns([]);
    setLayerName("data");
    setMinZoom("0");
    setMaxZoom("14");
    setError(null);
    setJob(null);
    void checkRuntime();
  }, [checkRuntime, kind]);

  useEffect(() => {
    if (!job || !RUNNING_JOB_STATUSES.has(job.status)) return;
    // Browser conversions complete locally; there is no sidecar job to poll.
    if (job.id === BROWSER_JOB_ID) return;
    // Schedule the next poll only after the current request resolves so a slow
    // sidecar cannot accumulate overlapping, out-of-order in-flight requests.
    let cancelled = false;
    let timer: number;
    const poll = async () => {
      if (cancelled) return;
      try {
        const next = await fetchConversionJob(job.id);
        if (cancelled) return;
        setJob(next);
        if (RUNNING_JOB_STATUSES.has(next.status)) {
          timer = window.setTimeout(poll, 1000);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Could not poll job.");
        }
      }
    };
    timer = window.setTimeout(poll, 1000);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [job]);

  // Keep the newest log lines in view as messages stream in.
  useEffect(() => {
    logEndRef.current?.scrollIntoView({ block: "end" });
  }, [job?.messages.length]);

  // Read the CSV header and pre-fill the lon/lat dropdowns with a best guess.
  const loadCsvColumns = async (source: File | string) => {
    const columns = await readCsvHeaderColumns(source);
    setCsvColumns(columns);
    if (columns.length) {
      const guess = guessLonLatColumns(columns);
      setLonColumn(guess.lon);
      setLatColumn(guess.lat);
    }
  };

  const pickBrowserInput = () => {
    if (!config) return;
    const input = document.createElement("input");
    input.type = "file";
    // Allow multi-select so Shapefile sidecars (.dbf/.shx/.prj/.cpg) can be
    // provided alongside the .shp file.
    input.multiple = true;
    input.accept = config.inputFilters
      .flatMap((filter) => filter.extensions)
      .concat([...SHAPEFILE_SIDECAR_EXTENSIONS])
      .map((extension) => `.${extension}`)
      .join(",");
    input.onchange = () => {
      const files = Array.from(input.files ?? []);
      if (!files.length) return;
      setBrowserFiles(files);
      const { mainFile } = splitBrowserSelection(files);
      if (mainFile && kind) {
        setOutputPath((current) =>
          current.trim() ? current : defaultOutputNameForKind(kind, mainFile.name),
        );
        if (isCsv) void loadCsvColumns(mainFile);
      }
    };
    input.click();
  };

  const pickInput = async () => {
    if (!config) return;
    if (usesBrowserRuntime) {
      pickBrowserInput();
      return;
    }
    const path = await pickLocalPathWithFallback({
      filters: config.inputFilters,
    });
    if (path) {
      setInputPath(path);
      if (isCsv) void loadCsvColumns(path);
    }
  };

  const pickOutput = async () => {
    if (!config) return;
    const path = await pickSavePathWithFallback({
      defaultName: config.defaultOutputName,
      filters: config.outputFilters,
    });
    if (path) setOutputPath(path);
  };

  // In-browser path for the generic Vector to Vector tool: read any format with
  // DuckDB-WASM (ST_Read), then write the subset the browser can produce by
  // dispatching on the output extension. Arbitrary GDAL formats need the desktop
  // sidecar; this is only reached on the web build.
  const runBrowserVectorToVector = async (mainFile: File, siblings: File[]) => {
    if (!kind) return;
    const toolId = kind;
    // The in-browser DuckDB reader cannot open a zipped Shapefile (ST_Read needs
    // GDAL's /vsizip/, which only the sidecar uses); guide the user instead of
    // failing deep in the loader. The desktop app reads .zip inputs directly.
    if (fileExtension(mainFile.name) === "zip") {
      setError(i18n.t("toolbar.conversion.zipInputBrowserError"));
      return;
    }
    const outputName =
      outputPath.trim() || defaultOutputNameForKind(kind, mainFile.name);
    const outputExtension = fileExtension(outputName);
    const format = browserExportFormatForExtension(outputExtension);
    if (!format) {
      setError(
        outputExtension
          ? i18n.t("toolbar.conversion.browserOutputUnsupported", {
              extension: outputExtension,
            })
          : i18n.t("toolbar.conversion.outputExtensionRequired"),
      );
      return;
    }
    setError(null);
    setJob(
      browserConversionJob(toolId, "running", [
        i18n.t("toolbar.conversion.readingWithDuckDb", { name: mainFile.name }),
      ]),
    );
    try {
      const [
        { loadDuckDbVectorFile, VectorLoadCancelledError },
        { exportVectorLayer },
      ] = await Promise.all([
        import("../../lib/duckdb-vector-loader"),
        import("../../lib/vector-export"),
      ]);
      const toVectorFile = async (file: File) => ({
        name: file.name,
        extension: fileExtension(file.name),
        data: new Uint8Array(await file.arrayBuffer()),
      });
      let geojson;
      try {
        geojson = await loadDuckDbVectorFile(
          {
            ...(await toVectorFile(mainFile)),
            siblingFiles: await Promise.all(siblings.map(toVectorFile)),
          },
          {
            // Preflight a feature count and confirm before materializing a huge
            // dataset to GeoJSON in memory, matching the Add Data vector loaders.
            onLargeDataset: ({ name, featureCount }: LargeVectorDataset) =>
              window.confirm(
                i18n.t("toolbar.item.largeVectorDesc", {
                  name,
                  count: featureCount.toLocaleString(),
                }),
              ),
          },
        );
      } catch (loadErr) {
        if (loadErr instanceof VectorLoadCancelledError) {
          // The user declined the large-dataset confirmation; clear the job
          // rather than showing it as a failure.
          setJob(null);
          return;
        }
        throw loadErr;
      }
      const baseName = stripExtension(outputName) || "output";
      const savedName = await exportVectorLayer(geojson, format, baseName);
      setJob(
        browserConversionJob(toolId, "succeeded", [
          i18n.t("toolbar.conversion.readFeatures", {
            features: geojson.features.length,
            name: mainFile.name,
          }),
          // Cancelling the save dialog is a deliberate user action, not a
          // failure, so keep the status green.
          savedName
            ? i18n.t("toolbar.conversion.savedFile", { name: savedName })
            : i18n.t("toolbar.conversion.saveCanceled"),
        ]),
      );
    } catch (err) {
      const detail =
        err instanceof Error ? err.message : "Could not convert this file.";
      setJob(browserConversionJob(toolId, "failed", [detail], detail));
    }
  };

  const runBrowserConversion = async () => {
    // Only reached when usesBrowserRuntime is true, which requires a kind.
    if (!kind) return;
    const toolId = kind;
    const { mainFile, siblings } = splitBrowserSelection(browserFiles);
    if (!mainFile) {
      setError("Choose an input file.");
      return;
    }
    if (kind === "vector-to-vector") {
      await runBrowserVectorToVector(mainFile, siblings);
      return;
    }
    const parsedRowGroupSize = Number.parseInt(rowGroupSize, 10);
    if (!Number.isFinite(parsedRowGroupSize) || parsedRowGroupSize <= 0) {
      setError("Row group size must be a positive integer.");
      return;
    }
    if (isCsv && (!lonColumn.trim() || !latColumn.trim())) {
      setError("Longitude and latitude column names are required.");
      return;
    }
    const outputName = outputPath.trim() || defaultGeoParquetName(mainFile.name);
    setJob(
      browserConversionJob(toolId, "running", [
        `Converting ${mainFile.name} with DuckDB-WASM`,
      ]),
    );
    try {
      const { convertDuckDbVectorToGeoParquet } = await import(
        "../../lib/duckdb-vector-loader"
      );
      const toVectorFile = async (file: File) => ({
        name: file.name,
        extension: fileExtension(file.name),
        data: new Uint8Array(await file.arrayBuffer()),
      });
      const result = await convertDuckDbVectorToGeoParquet(
        {
          ...(await toVectorFile(mainFile)),
          siblingFiles: await Promise.all(siblings.map(toVectorFile)),
        },
        {
          compression,
          rowGroupSize: parsedRowGroupSize,
          csv: isCsv
            ? { lonColumn: lonColumn.trim(), latColumn: latColumn.trim() }
            : undefined,
        },
      );
      const savedName = await saveBinaryFileWithFallback(
        new Uint8Array(result.data),
        {
          defaultName: outputName,
          filters: [{ name: "GeoParquet", extensions: ["parquet"] }],
          browserTypes: [
            {
              description: "GeoParquet",
              accept: { [GEOPARQUET_MIME_TYPE]: [".parquet"] },
            },
          ],
          mimeType: GEOPARQUET_MIME_TYPE,
        },
      );
      const sortedLine =
        result.featureCount === undefined
          ? `Hilbert-sorted on column ${result.geometryColumn}`
          : `Hilbert-sorted ${result.featureCount} features on column ${result.geometryColumn}`;
      // The conversion itself succeeded; cancelling the save dialog is a
      // deliberate user action, not a failure, so keep the status green.
      setJob(
        browserConversionJob(toolId, "succeeded", [
          `Converting ${mainFile.name} with DuckDB-WASM`,
          sortedLine,
          savedName
            ? `Saved GeoParquet as ${savedName}`
            : "Conversion finished; save was canceled.",
        ]),
      );
    } catch (err) {
      const detail =
        err instanceof Error ? err.message : "Could not convert this file.";
      setJob(browserConversionJob(toolId, "failed", [detail], detail));
    }
  };

  const startServer = async () => {
    setStartingServer(true);
    setError(null);
    try {
      await startGeoLibreSidecar();
      await checkRuntime();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Could not start GeoLibre sidecar.",
      );
    } finally {
      setStartingServer(false);
    }
  };

  const runConversion = async () => {
    if (!kind) return;
    setError(null);
    if (usesBrowserRuntime) {
      await runBrowserConversion();
      return;
    }
    if (!inputPath.trim()) {
      setError("Choose an input file.");
      return;
    }
    if (!outputPath.trim()) {
      setError("Choose an output file.");
      return;
    }
    const input_path = inputPath.trim();
    const output_path = outputPath.trim();
    const parsedRowGroupSize = Number.parseInt(rowGroupSize, 10);
    const rowGroupValid =
      Number.isFinite(parsedRowGroupSize) && parsedRowGroupSize > 0;
    try {
      if (kind === "vector-to-vector") {
        // The backend resolves the output format from the output extension, so
        // the input/output paths are all it needs.
        setJob(await runVectorToVector({ input_path, output_path }));
      } else if (kind === "vector-to-geoparquet") {
        if (!rowGroupValid) {
          setError("Row group size must be a positive integer.");
          return;
        }
        setJob(
          await runVectorToGeoParquet({
            input_path,
            output_path,
            compression,
            row_group_size: parsedRowGroupSize,
          }),
        );
      } else if (kind === "vector-to-flatgeobuf") {
        setJob(await runVectorToFlatGeobuf({ input_path, output_path }));
      } else if (kind === "vector-to-shapefile") {
        setJob(await runVectorToShapefile({ input_path, output_path }));
      } else if (kind === "vector-to-geopackage") {
        setJob(await runVectorToGeoPackage({ input_path, output_path }));
      } else if (kind === "csv-to-geoparquet") {
        if (!rowGroupValid) {
          setError("Row group size must be a positive integer.");
          return;
        }
        if (!lonColumn.trim() || !latColumn.trim()) {
          setError("Longitude and latitude column names are required.");
          return;
        }
        setJob(
          await runCsvToGeoParquet({
            input_path,
            output_path,
            lon_column: lonColumn.trim(),
            lat_column: latColumn.trim(),
            compression,
            row_group_size: parsedRowGroupSize,
          }),
        );
      } else if (kind === "vector-to-pmtiles") {
        const parsedMin = Number.parseInt(minZoom, 10);
        const parsedMax = Number.parseInt(maxZoom, 10);
        if (
          !Number.isFinite(parsedMin) ||
          !Number.isFinite(parsedMax) ||
          parsedMin < 0 ||
          parsedMin > parsedMax ||
          parsedMax > 24
        ) {
          setError("Zoom levels must satisfy 0 ≤ min ≤ max ≤ 24.");
          return;
        }
        setJob(
          await runVectorToPmtiles({
            input_path,
            output_path,
            layer_name: layerName.trim() || "data",
            min_zoom: parsedMin,
            max_zoom: parsedMax,
          }),
        );
      } else {
        setJob(await runRasterToCog({ input_path, output_path, compression }));
      }
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Could not start conversion.",
      );
    }
  };

  const running = Boolean(job && RUNNING_JOB_STATUSES.has(job.status));

  return (
    <Dialog
      open={Boolean(kind)}
      onOpenChange={(open: boolean) => {
        if (!open) setConversionOpen(null);
      }}
    >
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{config?.title ?? "Conversion"}</DialogTitle>
          <DialogDescription>{config?.description ?? ""}</DialogDescription>
        </DialogHeader>

        <div className="grid gap-4">
          {runtimeAvailable === false && (
            <div className="grid gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3">
              <p className="flex items-start gap-2 text-sm text-destructive">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                {runtimeMessage}
              </p>
              {desktop && (
                <Button
                  type="button"
                  variant="outline"
                  onClick={startServer}
                  disabled={startingServer}
                >
                  {startingServer ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Server className="h-4 w-4" />
                  )}
                  Start server
                </Button>
              )}
            </div>
          )}

          <div className="grid gap-1.5">
            <Label htmlFor="conversion-input">{config?.inputLabel}</Label>
            <div className="grid grid-cols-[minmax(0,1fr)_2.25rem] gap-2">
              {usesBrowserRuntime ? (
                <Input
                  id="conversion-input"
                  value={browserFiles.map((file) => file.name).join(", ")}
                  placeholder="Choose a file"
                  readOnly
                />
              ) : (
                <Input
                  id="conversion-input"
                  value={inputPath}
                  placeholder="File path"
                  onChange={(event) => setInputPath(event.target.value)}
                />
              )}
              <Button
                type="button"
                variant="outline"
                size="icon"
                title="Choose input file"
                onClick={() => void pickInput()}
              >
                <FolderOpen className="h-4 w-4" />
              </Button>
            </div>
            {usesBrowserRuntime && !isCsv && (
              <p className="text-xs text-muted-foreground">
                For Shapefiles, select the .shp together with its .dbf, .shx,
                and .prj files.
              </p>
            )}
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="conversion-output">
              {usesBrowserRuntime ? "Output file name" : config?.outputLabel}
            </Label>
            <div
              className={cn(
                "grid gap-2",
                !usesBrowserRuntime && "grid-cols-[minmax(0,1fr)_2.25rem]",
              )}
            >
              <Input
                id="conversion-output"
                value={outputPath}
                placeholder={
                  usesBrowserRuntime
                    ? (config?.defaultOutputName ?? "output")
                    : "File path"
                }
                onChange={(event) => setOutputPath(event.target.value)}
              />
              {!usesBrowserRuntime && (
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  title="Choose output file"
                  onClick={() => void pickOutput()}
                >
                  <Save className="h-4 w-4" />
                </Button>
              )}
            </div>
          </div>

          {isCsv && (
            <div className="grid grid-cols-2 gap-4">
              <div className="grid gap-1.5">
                <Label htmlFor="conversion-lon">Longitude column</Label>
                {csvColumns.length > 0 ? (
                  <Select
                    id="conversion-lon"
                    value={lonColumn}
                    onChange={(event) => setLonColumn(event.target.value)}
                  >
                    {csvColumns.map((column) => (
                      <option key={column} value={column}>
                        {column}
                      </option>
                    ))}
                  </Select>
                ) : (
                  <Input
                    id="conversion-lon"
                    value={lonColumn}
                    placeholder="longitude"
                    onChange={(event) => setLonColumn(event.target.value)}
                  />
                )}
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="conversion-lat">Latitude column</Label>
                {csvColumns.length > 0 ? (
                  <Select
                    id="conversion-lat"
                    value={latColumn}
                    onChange={(event) => setLatColumn(event.target.value)}
                  >
                    {csvColumns.map((column) => (
                      <option key={column} value={column}>
                        {column}
                      </option>
                    ))}
                  </Select>
                ) : (
                  <Input
                    id="conversion-lat"
                    value={latColumn}
                    placeholder="latitude"
                    onChange={(event) => setLatColumn(event.target.value)}
                  />
                )}
              </div>
            </div>
          )}

          {showCompression && (
            <div className={cn("grid gap-4", showRowGroup && "grid-cols-2")}>
              <div className="grid gap-1.5">
                <Label htmlFor="conversion-compression">Compression</Label>
                <Select
                  id="conversion-compression"
                  value={compression}
                  onChange={(event) => setCompression(event.target.value)}
                >
                  {(config?.compressions ?? []).map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </Select>
              </div>
              {showRowGroup && (
                <div className="grid gap-1.5">
                  <Label htmlFor="conversion-row-group-size">
                    Row group size
                  </Label>
                  <Input
                    id="conversion-row-group-size"
                    inputMode="numeric"
                    value={rowGroupSize}
                    onChange={(event) => setRowGroupSize(event.target.value)}
                  />
                </div>
              )}
            </div>
          )}

          {isPmtiles && (
            <div className="grid grid-cols-[minmax(0,1fr)_5rem_5rem] gap-4">
              <div className="grid gap-1.5">
                <Label htmlFor="conversion-layer">Layer name</Label>
                <Input
                  id="conversion-layer"
                  value={layerName}
                  placeholder="data"
                  onChange={(event) => setLayerName(event.target.value)}
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="conversion-min-zoom">Min zoom</Label>
                <Input
                  id="conversion-min-zoom"
                  inputMode="numeric"
                  value={minZoom}
                  onChange={(event) => setMinZoom(event.target.value)}
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="conversion-max-zoom">Max zoom</Label>
                <Input
                  id="conversion-max-zoom"
                  inputMode="numeric"
                  value={maxZoom}
                  onChange={(event) => setMaxZoom(event.target.value)}
                />
              </div>
            </div>
          )}

          <div className="flex items-center justify-end gap-2">
            <Button
              type="button"
              onClick={() => void runConversion()}
              disabled={running || runtimeAvailable !== true}
            >
              {running ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Play className="h-4 w-4" />
              )}
              Convert
            </Button>
          </div>

          {error && (
            <p className="flex items-center gap-2 text-sm text-destructive">
              <AlertCircle className="h-4 w-4" />
              {error}
            </p>
          )}

          {job && (
            <div className="grid gap-2">
              <p
                className={cn(
                  "flex items-center gap-2 text-sm font-medium",
                  jobStatusTone(job),
                )}
              >
                {job.status === "succeeded" ? (
                  <CheckCircle2 className="h-4 w-4" />
                ) : job.status === "failed" ? (
                  <AlertCircle className="h-4 w-4" />
                ) : (
                  <Loader2 className="h-4 w-4 animate-spin" />
                )}
                {job.status}
                {job.error ? `: ${job.error}` : ""}
              </p>
              <ScrollArea className="h-24 rounded-md border bg-muted/30 p-2 font-mono text-xs">
                {job.messages.length === 0 ? (
                  <span className="text-muted-foreground">No output yet.</span>
                ) : (
                  <>
                    {/* The message list is append-only, so the slot index is a
                        stable key. */}
                    {job.messages.map((line, index) => (
                      <div key={index}>{line}</div>
                    ))}
                    <div ref={logEndRef} />
                  </>
                )}
              </ScrollArea>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
