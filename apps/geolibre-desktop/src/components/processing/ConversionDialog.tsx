import { useAppStore, type ConversionToolKind } from "@geolibre/core";
import {
  COG_WASM_COMPRESSIONS,
  MAX_VECTOR_PMTILES_ZOOM,
  PMTILES_COLORMAPS,
  PMTILES_RESAMPLING_METHODS,
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
  type CogWasmCompression,
  type ConversionJob,
  type PmtilesColormap,
  type PmtilesResamplingMethod,
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
import type { ParseKeys } from "i18next";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
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
import {
  beginProcessingRun,
  type ProcessingRunTracker,
} from "../../lib/processing-history";
import i18n from "../../i18n";

const RUNNING_JOB_STATUSES = new Set(["pending", "running"]);

// Local (browser) conversions reuse the ConversionJob shape so the status and
// log UI stays identical; this id keeps them out of the sidecar job poller.
const BROWSER_JOB_ID = "browser-duckdb-wasm";

const SHAPEFILE_SIDECAR_EXTENSIONS = new Set(["dbf", "shx", "prj", "cpg"]);

const GEOPARQUET_MIME_TYPE = "application/vnd.apache.parquet";

const GEOTIFF_MIME_TYPE = "image/tiff";

const PMTILES_MIME_TYPE = "application/vnd.pmtiles";

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
  /** Translation keys for {@link title}/{@link description}. TOOL_CONFIGS is
   * module-level, so it cannot call `t()` itself without freezing the language
   * at import; the dialog resolves these at render and falls back to the
   * literals above. The older tools have not been migrated yet. */
  titleKey?: ParseKeys;
  descriptionKey?: ParseKeys;
  inputLabel: string;
  inputFilters: FileDialogFilter[];
  outputLabel: string;
  outputFilters: FileDialogFilter[];
  defaultOutputName: string;
  compressions?: string[];
  defaultCompression?: string;
  /** Input filters when running in-browser, for tools whose WASM engine reads a
   * different set of formats than the sidecar's — usually narrower (Raster to
   * COG reads GeoTIFF only), occasionally wider (the WASM vector tiler reads a
   * Shapefile, which freestiler does not). Falls back to `inputFilters`. */
  browserInputFilters?: FileDialogFilter[];
  /** Compression choices when running in-browser, for tools whose WASM encoder
   * supports fewer codecs than the sidecar's. Falls back to `compressions`. */
  browserCompressions?: string[];
  /** Translation key for an extra note shown only when the in-browser engine is
   * in use, calling out where it diverges from the sidecar. */
  browserNoteKey?: ParseKeys;
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

// In-browser JS writers, keyed by output extension. DuckDB-WASM cannot write
// GDAL vector formats (its virtual filesystem lacks the random-access
// seek/write the GDAL drivers need), so these are GeoParquet (DuckDB) plus the
// pure-JS GeoJSON/CSV/GeoPackage/Shapefile writers. Extensions no JS writer
// covers are handled by geolibre-wasm — see WASM_VECTOR_OUTPUT_FORMATS. The
// Shapefile writer always emits a zip, so `.zip` (not bare `.shp`) is the
// browser Shapefile option; a bare `.shp` is produced only by the sidecar.
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
// in-browser runtime produces the BROWSER_OUTPUT_FORMATS subset plus
// WASM_VECTOR_OUTPUT_EXTENSIONS.
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

// Conversions with a client-side engine (DuckDB-WASM, the pure-JS writers, or
// geolibre-wasm). On desktop these still prefer the sidecar, whose GDAL/rio-cogeo
// stack reads more input formats and preserves dtypes and codecs the WASM
// writers cannot — so this set only takes effect in the browser build.
//
// Vector to PMTiles is here as of geolibre-wasm 0.8.0, whose `vector_to_pmtiles`
// is the client-side counterpart to the sidecar's freestiler. Desktop keeps
// freestiler: it reads more input formats and tiles as deep as zoom 24, where
// the WASM tiler stops at MAX_VECTOR_PMTILES_ZOOM.
const WEB_RUNTIME_KINDS: ReadonlySet<ConversionToolKind> = new Set([
  "vector-to-vector",
  "vector-to-geoparquet",
  "csv-to-geoparquet",
  "vector-to-flatgeobuf",
  "vector-to-shapefile",
  "vector-to-geopackage",
  "vector-to-pmtiles",
  "raster-to-cog",
]);

// Raster to PMTiles has no sidecar endpoint at all — geolibre-wasm is its only
// engine — so it runs client-side on desktop too.
const WASM_ONLY_KINDS: ReadonlySet<ConversionToolKind> = new Set([
  "raster-to-pmtiles",
]);

/** Whether a tool runs client-side rather than through the Python sidecar. */
function conversionUsesBrowserRuntime(
  kind: ConversionToolKind,
  desktop: boolean,
): boolean {
  if (WASM_ONLY_KINDS.has(kind)) return true;
  return !desktop && WEB_RUNTIME_KINDS.has(kind);
}

// Vector output extensions no JS writer covers but geolibre-wasm's
// `vector_convert` does, so in-browser Vector to Vector can offer them too.
// FlatGeobuf has no registered IANA media type; octet-stream is what the
// browser save picker needs to offer a plain binary download.
const WASM_VECTOR_OUTPUT_FORMATS: Record<
  string,
  { description: string; mimeType: string }
> = {
  fgb: { description: "FlatGeobuf", mimeType: "application/octet-stream" },
};

const WASM_VECTOR_OUTPUT_EXTENSIONS = new Set(
  Object.keys(WASM_VECTOR_OUTPUT_FORMATS),
);

// Deepest zoom the sidecar's engines accept — freestiler's Vector to PMTiles cap
// and, since write_pmtiles imposes none of its own, what Raster to PMTiles uses
// too. The in-browser vector tiler stops lower, at MAX_VECTOR_PMTILES_ZOOM.
const MAX_PMTILES_ZOOM = 24;

// Plain decimal digits only. `Number` alone would accept JS numeric-literal
// quirks that these small integer fields should not take: "0x10" reads as 16
// and "1e1" as 10, both of which look like valid zooms.
const PLAIN_INTEGER_PATTERN = /^\d+$/;

/**
 * Parse an optional plain-integer field.
 *
 * @returns The value, `undefined` when blank (leave it to the engine), or
 * `null` when it is not a plain non-negative integer.
 */
function parsePlainInteger(raw: string): number | null | undefined {
  const text = raw.trim();
  if (!text) return undefined;
  if (!PLAIN_INTEGER_PATTERN.test(text)) return null;
  return Number(text);
}

/**
 * Parse the 1-based band field. Blank leaves it to `write_pmtiles`, which
 * defaults to band 1.
 *
 * @returns The band, `undefined` when blank, or `null` when not a positive integer.
 */
function parseBand(raw: string): number | null | undefined {
  const value = parsePlainInteger(raw);
  if (value === null || value === undefined) return value;
  return value >= 1 ? value : null;
}

/** A parsed zoom range; an undefined bound was left blank by the user. */
interface PmtilesZoomRange {
  minZoom?: number;
  maxZoom?: number;
}

/**
 * Parse the shared min/max zoom inputs, enforcing `0 ≤ min ≤ max ≤ maxAllowed`.
 * Blank means "unset" and is returned as undefined — Vector to PMTiles rejects
 * that on both of its engines, while Raster to PMTiles passes it through so
 * `write_pmtiles` applies its own native-resolution default.
 *
 * @param maxAllowed - The cap of the engine about to run, since the browser's
 * vector tiler stops shallower than the sidecar's.
 * @returns The parsed bounds, or null when the input is out of range.
 */
function parseZoomRange(
  rawMin: string,
  rawMax: string,
  maxAllowed: number,
): PmtilesZoomRange | null {
  const parse = (raw: string): number | null | undefined => {
    // parsePlainInteger, not parseInt: parseInt truncates, so "3.5"/"3abc"
    // would silently become zoom 3 rather than being rejected.
    const value = parsePlainInteger(raw);
    if (value === null || value === undefined) return value;
    return value > maxAllowed ? null : value;
  };
  const minZoom = parse(rawMin);
  const maxZoom = parse(rawMax);
  if (minZoom === null || maxZoom === null) return null;
  if (minZoom !== undefined && maxZoom !== undefined && minZoom > maxZoom) {
    return null;
  }
  return { minZoom, maxZoom };
}

/** Names the engine backing a tool's client-side path, for the status line. */
function browserRuntimeMessageKey(kind: ConversionToolKind): ParseKeys {
  switch (kind) {
    case "raster-to-cog":
    case "raster-to-pmtiles":
    case "vector-to-pmtiles":
    case "vector-to-flatgeobuf":
      return "toolbar.conversion.runsInBrowserWasm";
    case "vector-to-shapefile":
    case "vector-to-geopackage":
      return "toolbar.conversion.runsInBrowserWriters";
    case "vector-to-vector":
      // The banner is set when the dialog opens, before an output extension is
      // typed, and this tool's engine depends on it (.fgb goes through
      // vector_convert, everything else through DuckDB). Name both rather than
      // claim one and be wrong for .fgb.
      return "toolbar.conversion.runsInBrowserVectorEngines";
    default:
      return "toolbar.conversion.runsInBrowserDuckDb";
  }
}

const TOOL_CONFIGS: Record<ConversionToolKind, ConversionToolConfig> = {
  "vector-to-vector": {
    title: "Vector to Vector",
    description:
      "Convert between any vector formats DuckDB's spatial extension supports. The input and output formats are detected from the file extensions. The desktop app writes any format (FlatGeobuf, GeoPackage, Shapefile, KML, GML, …); the browser writes GeoJSON, CSV, GeoParquet, GeoPackage, FlatGeobuf, and Shapefile.",
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
    // `vector_to_pmtiles` reads everything freestiler does plus a Shapefile, as
    // long as the .dbf/.shx/.prj come with it — the picker already offers those
    // sidecars, so the .shp only needs to be selectable.
    browserInputFilters: [
      {
        name: "Vector",
        extensions: [
          "parquet",
          "geoparquet",
          "geojson",
          "json",
          "shp",
          "gpkg",
          "fgb",
        ],
      },
    ],
    outputLabel: "Output PMTiles file",
    outputFilters: [{ name: "PMTiles", extensions: ["pmtiles"] }],
    defaultOutputName: "tiles.pmtiles",
  },
  "raster-to-pmtiles": {
    title: "Raster to PMTiles",
    titleKey: "toolbar.conversion.rasterToPmtiles",
    description:
      "Render a raster into a single PMTiles archive of Web Mercator PNG tiles, ready for cloud-native serving. Runs entirely in WebAssembly, so it needs no sidecar on either the web or desktop app.",
    descriptionKey: "toolbar.conversion.rasterToPmtilesDesc",
    inputLabel: "Input raster file",
    inputFilters: [{ name: "GeoTIFF", extensions: ["tif", "tiff"] }],
    outputLabel: "Output PMTiles file",
    outputFilters: [{ name: "PMTiles", extensions: ["pmtiles"] }],
    defaultOutputName: "raster.pmtiles",
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
    // The in-browser encoder is geolibre-wasm's GeoTiffReader, which reads
    // GeoTIFF only; the other formats above need the sidecar's GDAL.
    browserInputFilters: [{ name: "GeoTIFF", extensions: ["tif", "tiff"] }],
    outputLabel: "Output COG file",
    outputFilters: [{ name: "GeoTIFF", extensions: ["tif", "tiff"] }],
    defaultOutputName: "output_cog.tif",
    compressions: ["deflate", "zstd", "lzw", "webp", "jpeg", "packbits", "raw"],
    browserCompressions: [...COG_WASM_COMPRESSIONS],
    defaultCompression: "deflate",
    browserNoteKey: "toolbar.conversion.cogBrowserNote",
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
  const { t } = useTranslation();
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
  // Empty means "leave it to the tool", which is what makes colormap optional:
  // write_pmtiles marks it optional and picks viridis itself, so the dialog
  // omits the flag rather than pinning a default of its own.
  // Blank means "leave it to the tool", which renders band 1.
  const [band, setBand] = useState("");
  const [colormap, setColormap] = useState<PmtilesColormap | "">("");
  const [resampling, setResampling] =
    useState<PmtilesResamplingMethod>("bilinear");
  const [runtimeAvailable, setRuntimeAvailable] = useState<boolean | null>(null);
  const [runtimeMessage, setRuntimeMessage] = useState("");
  const [startingServer, setStartingServer] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [job, setJob] = useState<ConversionJob | null>(null);
  // History tracker for the conversion dispatched last (#1292). Sidecar and
  // browser runs both settle through `job`, so one pending slot suffices;
  // `finish` is idempotent. Overlapping dispatches (which would cross-wire
  // trackers) are prevented by the synchronous guard in runConversion.
  const pendingTrackerRef = useRef<ProcessingRunTracker | null>(null);
  const dispatchGuardRef = useRef(false);
  const logEndRef = useRef<HTMLDivElement | null>(null);

  const config = kind ? TOOL_CONFIGS[kind] : null;
  const desktop = isTauri();
  const usesBrowserRuntime = kind ? conversionUsesBrowserRuntime(kind, desktop) : false;
  const isCsv = kind === "csv-to-geoparquet";
  const isPmtiles = kind === "vector-to-pmtiles";
  const isRasterPmtiles = kind === "raster-to-pmtiles";
  const isRasterInput = kind === "raster-to-cog" || kind === "raster-to-pmtiles";
  // The WASM encoder supports fewer codecs and reads fewer formats than the
  // sidecar's GDAL, so both lists resolve per runtime.
  const compressionOptions = usesBrowserRuntime
    ? (config?.browserCompressions ?? config?.compressions)
    : config?.compressions;
  const showCompression = Boolean(compressionOptions?.length);
  const inputFilters = usesBrowserRuntime
    ? (config?.browserInputFilters ?? config?.inputFilters ?? [])
    : (config?.inputFilters ?? []);
  // Row group size is a Parquet concept, so it is shown only for the
  // GeoParquet writers — not for Raster to COG, which also has a compression
  // option.
  const showRowGroup =
    kind === "vector-to-geoparquet" || kind === "csv-to-geoparquet";

  const checkRuntime = useCallback(async () => {
    if (usesBrowserRuntime && kind) {
      setRuntimeAvailable(true);
      setRuntimeMessage(i18n.t(browserRuntimeMessageKey(kind)));
      return;
    }
    if (!desktop) {
      // No kind reaches this today — every ConversionToolKind now has a
      // client-side engine (see WEB_RUNTIME_KINDS/WASM_ONLY_KINDS), Vector to
      // PMTiles being the last to get one. It stays as the guard for any future
      // sidecar-only conversion, so a pure web build says so outright instead of
      // trying to reach a sidecar it cannot start.
      setRuntimeAvailable(false);
      setRuntimeMessage(i18n.t("toolbar.conversion.needsDesktop"));
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
  }, [desktop, kind, usesBrowserRuntime]);

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
    // Vector to PMTiles tiles the whole pyramid and its sidecar needs explicit
    // bounds; Raster to PMTiles starts blank so write_pmtiles picks the zoom
    // matching the raster's own resolution.
    const rasterPmtiles = kind === "raster-to-pmtiles";
    setMinZoom(rasterPmtiles ? "" : "0");
    setMaxZoom(rasterPmtiles ? "" : "14");
    setBand("");
    setColormap("");
    setResampling("bilinear");
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

  // Record a History entry once a conversion reaches a terminal status (#1292).
  // Covers sidecar jobs (via polling) and browser runs (synthetic jobs that
  // arrive terminal). `finish` is idempotent across re-renders.
  useEffect(() => {
    if (!job || RUNNING_JOB_STATUSES.has(job.status)) return;
    pendingTrackerRef.current?.finish(
      job.status === "succeeded" ? "success" : "error",
      job.error ?? undefined,
    );
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
    input.accept = inputFilters
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

  /** Read a browser-selected file into the {name, data} shape the WASM tools take. */
  const toWasmFile = async (file: File) => ({
    name: file.name,
    data: new Uint8Array(await file.arrayBuffer()),
  });

  // The in-browser DuckDB reader cannot open a zipped Shapefile (ST_Read needs
  // GDAL's /vsizip/, which only the sidecar uses); guide the user instead of
  // failing deep in the loader. The desktop app reads .zip inputs directly.
  const rejectZipInput = (mainFile: File): boolean => {
    if (fileExtension(mainFile.name) !== "zip") return false;
    setError(i18n.t("toolbar.conversion.zipInputBrowserError"));
    return true;
  };

  /**
   * Read any vector input to GeoJSON with DuckDB-WASM, then hand it to one of the
   * bundled JS writers. Backs in-browser Vector to Vector as well as the
   * fixed-format Shapefile/GeoPackage writers.
   *
   * Returns once the job state has been set; `null` from the loader means the
   * user declined the large-dataset prompt.
   */
  const runBrowserVectorExport = async (
    toolId: ConversionToolKind,
    mainFile: File,
    siblings: File[],
    format: NonNullable<ReturnType<typeof browserExportFormatForExtension>>,
    outputName: string,
  ) => {
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
        err instanceof Error ? err.message : i18n.t("toolbar.conversion.convertFailed");
      setJob(browserConversionJob(toolId, "failed", [detail], detail));
    }
  };

  /**
   * In-browser vector conversion through geolibre-wasm's `vector_convert`, for
   * the formats the JS writers do not cover (FlatGeobuf). Unlike the DuckDB
   * path this streams the file straight into the WASI tool, so it never
   * materializes a GeoJSON copy.
   */
  const runBrowserVectorViaWasm = async (
    toolId: ConversionToolKind,
    mainFile: File,
    siblings: File[],
    outputName: string,
  ) => {
    setError(null);
    setJob(
      browserConversionJob(toolId, "running", [
        i18n.t("toolbar.conversion.convertingWithWasm", { name: mainFile.name }),
      ]),
    );
    try {
      const { convertVectorWithWasm } = await import("@geolibre/processing");
      const result = await convertVectorWithWasm(
        await toWasmFile(mainFile),
        outputName,
        await Promise.all(siblings.map(toWasmFile)),
      );
      const extension = fileExtension(outputName);
      const format = WASM_VECTOR_OUTPUT_FORMATS[extension];
      const savedName = await saveBinaryFileWithFallback(result.data, {
        defaultName: outputName,
        filters: config?.outputFilters ?? [],
        mimeType: format?.mimeType ?? "application/octet-stream",
        browserTypes: format
          ? [
              {
                description: format.description,
                accept: { [format.mimeType]: [`.${extension}`] },
              },
            ]
          : [],
      });
      setJob(
        browserConversionJob(toolId, "succeeded", [
          ...result.messages,
          savedName
            ? i18n.t("toolbar.conversion.savedFile", { name: savedName })
            : i18n.t("toolbar.conversion.saveCanceled"),
        ]),
      );
    } catch (err) {
      const detail =
        err instanceof Error ? err.message : i18n.t("toolbar.conversion.convertFailed");
      setJob(browserConversionJob(toolId, "failed", [detail], detail));
    }
  };

  // In-browser path for the generic Vector to Vector tool: dispatch on the
  // output extension to whichever client-side engine can write it. Arbitrary
  // GDAL formats (KML, GML, …) still need the desktop sidecar.
  const runBrowserVectorToVector = async (mainFile: File, siblings: File[]) => {
    if (!kind || rejectZipInput(mainFile)) return;
    const outputName =
      outputPath.trim() || defaultOutputNameForKind(kind, mainFile.name);
    const outputExtension = fileExtension(outputName);
    if (WASM_VECTOR_OUTPUT_EXTENSIONS.has(outputExtension)) {
      await runBrowserVectorViaWasm(kind, mainFile, siblings, outputName);
      return;
    }
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
    await runBrowserVectorExport(kind, mainFile, siblings, format, outputName);
  };

  /** In-browser Raster to COG via geolibre-wasm's CogBuilder. */
  const runBrowserRasterToCog = async (mainFile: File) => {
    if (!kind) return;
    const toolId = kind;
    const outputName =
      outputPath.trim() || defaultOutputNameForKind(kind, mainFile.name);
    setError(null);
    setJob(
      browserConversionJob(toolId, "running", [
        i18n.t("toolbar.conversion.convertingWithWasm", { name: mainFile.name }),
      ]),
    );
    try {
      const { convertGeoTiffToCog, readGeoTiffInfo } = await import(
        "@geolibre/processing"
      );
      const bytes = new Uint8Array(await mainFile.arrayBuffer());
      // Header-only read: cheap, and it lets us report the shape and warn about
      // an already-tiled input before decoding any pixels.
      const info = await readGeoTiffInfo(bytes);
      if (!info.ok) {
        throw new Error(i18n.t("toolbar.conversion.notAGeoTiff"));
      }
      const data = await convertGeoTiffToCog(bytes, {
        compression: compression as CogWasmCompression,
      });
      const savedName = await saveBinaryFileWithFallback(data, {
        defaultName: outputName,
        filters: config?.outputFilters ?? [],
        mimeType: GEOTIFF_MIME_TYPE,
        browserTypes: [
          {
            description: "GeoTIFF",
            accept: { [GEOTIFF_MIME_TYPE]: [".tif", ".tiff"] },
          },
        ],
      });
      setJob(
        browserConversionJob(toolId, "succeeded", [
          i18n.t("toolbar.conversion.rasterShape", {
            width: info.width,
            height: info.height,
            bands: info.bands,
          }),
          i18n.t("toolbar.conversion.wroteCog", { compression }),
          savedName
            ? i18n.t("toolbar.conversion.savedFile", { name: savedName })
            : i18n.t("toolbar.conversion.saveCanceled"),
        ]),
      );
    } catch (err) {
      const detail =
        err instanceof Error ? err.message : i18n.t("toolbar.conversion.convertFailed");
      setJob(browserConversionJob(toolId, "failed", [detail], detail));
    }
  };

  /** Raster to PMTiles via geolibre-wasm's `write_pmtiles`, on web and desktop. */
  const runBrowserRasterToPmtiles = async (mainFile: File) => {
    if (!kind) return;
    const toolId = kind;
    const zooms = parseZoomRange(minZoom, maxZoom, MAX_PMTILES_ZOOM);
    if (!zooms) {
      setError(
        i18n.t("toolbar.conversion.zoomRangeError", { max: MAX_PMTILES_ZOOM }),
      );
      return;
    }
    const parsedBand = parseBand(band);
    if (parsedBand === null) {
      setError(i18n.t("toolbar.conversion.bandError"));
      return;
    }
    const outputName =
      outputPath.trim() || defaultOutputNameForKind(kind, mainFile.name);
    setError(null);
    setJob(
      browserConversionJob(toolId, "running", [
        i18n.t("toolbar.conversion.convertingWithWasm", { name: mainFile.name }),
      ]),
    );
    try {
      const { readGeoTiffInfo, renderRasterToPmtiles } = await import(
        "@geolibre/processing"
      );
      const bytes = new Uint8Array(await mainFile.arrayBuffer());
      // Header-only check, matching runBrowserRasterToCog: a non-TIFF would
      // otherwise surface write_pmtiles' raw "unknown raster format" text. The
      // message is this tool's own: unlike Raster to COG, there is no sidecar
      // route, so pointing at the desktop app would be a dead end.
      const info = await readGeoTiffInfo(bytes);
      if (!info.ok) {
        throw new Error(i18n.t("toolbar.conversion.notAGeoTiffRasterOnly"));
      }
      // The header already carries the band count, so an out-of-range band gets
      // a real message instead of the tool's raw failure.
      if (parsedBand !== undefined && parsedBand > info.bands) {
        throw new Error(
          i18n.t("toolbar.conversion.bandOutOfRange", {
            band: parsedBand,
            bands: info.bands,
          }),
        );
      }
      const result = await renderRasterToPmtiles(
        { name: mainFile.name, data: bytes },
        outputName,
        {
          // Blank bounds are omitted so write_pmtiles picks the native zoom for
          // the raster's resolution, rather than this dialog forcing a 0-14
          // pyramid that a wide-extent raster would take a long time to render.
          ...zooms,
          band: parsedBand,
          // Omitted when unset, so the tool applies its own default.
          colormap: colormap || undefined,
          method: resampling,
        },
      );
      const savedName = await saveBinaryFileWithFallback(result.data, {
        defaultName: outputName,
        filters: config?.outputFilters ?? [],
        mimeType: PMTILES_MIME_TYPE,
        browserTypes: [
          {
            description: "PMTiles",
            accept: { [PMTILES_MIME_TYPE]: [".pmtiles"] },
          },
        ],
      });
      setJob(
        browserConversionJob(toolId, "succeeded", [
          ...result.messages,
          savedName
            ? i18n.t("toolbar.conversion.savedFile", { name: savedName })
            : i18n.t("toolbar.conversion.saveCanceled"),
        ]),
      );
    } catch (err) {
      const detail =
        err instanceof Error ? err.message : i18n.t("toolbar.conversion.convertFailed");
      setJob(browserConversionJob(toolId, "failed", [detail], detail));
    }
  };

  /** Vector to PMTiles via geolibre-wasm's `vector_to_pmtiles`, in the browser. */
  const runBrowserVectorToPmtiles = async (
    mainFile: File,
    siblings: File[],
  ) => {
    if (!kind) return;
    const toolId = kind;
    // The WASM tiler stops shallower than the sidecar's freestiler, so the same
    // zoom the desktop app accepts can be too deep here. Check it up front
    // rather than letting the user wait for the tool's own validation error.
    // A blank bound is rejected as well, matching the sidecar branch: the tool's
    // own defaults happen to equal this dialog's (0/14), so letting blanks
    // through would silently succeed here and error on desktop for the same
    // input.
    const zooms = parseZoomRange(minZoom, maxZoom, MAX_VECTOR_PMTILES_ZOOM);
    if (!zooms || zooms.minZoom === undefined || zooms.maxZoom === undefined) {
      setError(
        i18n.t("toolbar.conversion.zoomRangeError", {
          max: MAX_VECTOR_PMTILES_ZOOM,
        }),
      );
      return;
    }
    const outputName =
      outputPath.trim() || defaultOutputNameForKind(kind, mainFile.name);
    setError(null);
    setJob(
      browserConversionJob(toolId, "running", [
        i18n.t("toolbar.conversion.convertingWithWasm", { name: mainFile.name }),
      ]),
    );
    try {
      const { tileVectorToPmtiles } = await import("@geolibre/processing");
      const [data, siblingFiles] = await Promise.all([
        mainFile.arrayBuffer().then((buffer) => new Uint8Array(buffer)),
        Promise.all(
          siblings.map(async (file) => ({
            name: file.name,
            data: new Uint8Array(await file.arrayBuffer()),
          })),
        ),
      ]);
      const result = await tileVectorToPmtiles(
        { name: mainFile.name, data },
        outputName,
        {
          ...zooms,
          // Same fallback as the sidecar branch, so an archive tiled in the
          // browser and one tiled on desktop carry the same layer name and a
          // style written against either keeps working.
          layerName: layerName.trim() || "data",
        },
        siblingFiles,
      );
      const savedName = await saveBinaryFileWithFallback(result.data, {
        defaultName: outputName,
        filters: config?.outputFilters ?? [],
        mimeType: PMTILES_MIME_TYPE,
        browserTypes: [
          {
            description: "PMTiles",
            accept: { [PMTILES_MIME_TYPE]: [".pmtiles"] },
          },
        ],
      });
      setJob(
        browserConversionJob(toolId, "succeeded", [
          ...result.messages,
          savedName
            ? i18n.t("toolbar.conversion.savedFile", { name: savedName })
            : i18n.t("toolbar.conversion.saveCanceled"),
        ]),
      );
    } catch (err) {
      const detail =
        err instanceof Error ? err.message : i18n.t("toolbar.conversion.convertFailed");
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
    if (kind === "raster-to-cog") {
      await runBrowserRasterToCog(mainFile);
      return;
    }
    if (kind === "raster-to-pmtiles") {
      await runBrowserRasterToPmtiles(mainFile);
      return;
    }
    if (kind === "vector-to-pmtiles") {
      // vector_to_pmtiles reads a bare .shp with its siblings, not a .zip — the
      // same limit rejectZipInput covers for the other WASM vector tools.
      if (rejectZipInput(mainFile)) return;
      await runBrowserVectorToPmtiles(mainFile, siblings);
      return;
    }
    if (kind === "vector-to-flatgeobuf") {
      if (rejectZipInput(mainFile)) return;
      // vector_convert picks its driver from the output extension, but this tool
      // is fixed-format: force .fgb so a typed name like "data.gpkg" cannot
      // silently produce a GeoPackage under the "Vector to FlatGeobuf" title.
      // The sidecar forces output_format="flatgeobuf" for the same reason, and
      // the Shapefile/GeoPackage branches below hard-code their format too.
      const requested =
        outputPath.trim() || defaultOutputNameForKind(kind, mainFile.name);
      await runBrowserVectorViaWasm(
        kind,
        mainFile,
        siblings,
        `${stripExtension(requested) || "output"}.fgb`,
      );
      return;
    }
    if (kind === "vector-to-shapefile" || kind === "vector-to-geopackage") {
      if (rejectZipInput(mainFile)) return;
      await runBrowserVectorExport(
        kind,
        mainFile,
        siblings,
        kind === "vector-to-shapefile" ? "shapefile" : "geopackage",
        outputPath.trim() || defaultOutputNameForKind(kind, mainFile.name),
      );
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
        err instanceof Error ? err.message : i18n.t("toolbar.conversion.convertFailed");
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
    // Serialize dispatches. `running` derives from job state, which is not yet
    // set while the initial sidecar request is in flight, so rapid clicks
    // could otherwise dispatch overlapping jobs and cross-wire their history
    // trackers (#1292 review).
    if (dispatchGuardRef.current) return;
    dispatchGuardRef.current = true;
    try {
      await dispatchConversion();
    } finally {
      dispatchGuardRef.current = false;
    }
  };

  const dispatchConversion = async () => {
    if (!kind) return;
    setError(null);
    // History tracker for this run (#1292), built lazily so a submit that
    // fails the validation checks below is never recorded (matching the other
    // processing dialogs) and never occupies the pending slot. Only the
    // parameters that apply to the selected conversion kind are recorded.
    const makeTracker = () =>
      beginProcessingRun(
        {
          kind: "conversion",
          toolId: kind,
          toolName: TOOL_CONFIGS[kind].titleKey
            ? t(TOOL_CONFIGS[kind].titleKey)
            : TOOL_CONFIGS[kind].title,
          engine: usesBrowserRuntime ? "browser" : "sidecar",
          parameters: {
            ...(compression ? { compression } : {}),
            ...(kind === "vector-to-geoparquet" || kind === "csv-to-geoparquet"
              ? { rowGroupSize }
              : {}),
            ...(kind === "csv-to-geoparquet" ? { lonColumn, latColumn } : {}),
            ...(kind === "vector-to-pmtiles"
              ? { layerName, minZoom, maxZoom }
              : {}),
            ...(kind === "raster-to-pmtiles"
              ? {
                  ...(band ? { band } : {}),
                  ...(colormap ? { colormap } : {}),
                  resampling,
                  minZoom,
                  maxZoom,
                }
              : {}),
          },
        },
        {
          inputPath: usesBrowserRuntime
            ? (splitBrowserSelection(browserFiles).mainFile?.name ?? "")
            : inputPath.trim(),
          outputPath: outputPath.trim(),
        },
      );
    if (usesBrowserRuntime) {
      // Mirror runBrowserConversion's own input check before creating the
      // tracker. Deeper per-kind validations inside the browser sub-runners
      // return before any job is dispatched, so a tracker they strand is
      // never finished nor misattributed (the terminal-status effect only
      // fires on job transitions, and each dispatch overwrites the slot).
      if (!splitBrowserSelection(browserFiles).mainFile) {
        setError("Choose an input file.");
        return;
      }
      pendingTrackerRef.current = makeTracker();
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
    // Per-kind parameter validation, before the tracker exists so an invalid
    // submit is not recorded and cannot strand a pending tracker.
    if (
      (kind === "vector-to-geoparquet" || kind === "csv-to-geoparquet") &&
      !rowGroupValid
    ) {
      setError("Row group size must be a positive integer.");
      return;
    }
    if (
      kind === "csv-to-geoparquet" &&
      (!lonColumn.trim() || !latColumn.trim())
    ) {
      setError("Longitude and latitude column names are required.");
      return;
    }
    // Unlike Raster to PMTiles, the sidecar requires both bounds, so a blank
    // (undefined) one is an error rather than a "let the engine decide".
    let pmtilesZoomRange: { minZoom: number; maxZoom: number } | null = null;
    if (kind === "vector-to-pmtiles") {
      const zooms = parseZoomRange(minZoom, maxZoom, MAX_PMTILES_ZOOM);
      if (
        !zooms ||
        zooms.minZoom === undefined ||
        zooms.maxZoom === undefined
      ) {
        setError(
          i18n.t("toolbar.conversion.zoomRangeError", {
            max: MAX_PMTILES_ZOOM,
          }),
        );
        return;
      }
      pmtilesZoomRange = { minZoom: zooms.minZoom, maxZoom: zooms.maxZoom };
    }
    pendingTrackerRef.current = makeTracker();
    try {
      if (kind === "vector-to-vector") {
        // The backend resolves the output format from the output extension, so
        // the input/output paths are all it needs.
        setJob(await runVectorToVector({ input_path, output_path }));
      } else if (kind === "vector-to-geoparquet") {
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
      } else if (kind === "vector-to-pmtiles" && pmtilesZoomRange) {
        setJob(
          await runVectorToPmtiles({
            input_path,
            output_path,
            layer_name: layerName.trim() || "data",
            min_zoom: pmtilesZoomRange.minZoom,
            max_zoom: pmtilesZoomRange.maxZoom,
          }),
        );
      } else if (kind === "raster-to-cog") {
        setJob(await runRasterToCog({ input_path, output_path, compression }));
      } else {
        // raster-to-pmtiles is the only remaining kind and has no sidecar
        // endpoint; conversionUsesBrowserRuntime always routes it to the WASM
        // path above, so reaching here means those two have drifted apart.
        const message = i18n.t("toolbar.conversion.noSidecarConversion", {
          kind,
        });
        // No job will ever settle this dispatch, so finish the tracker here
        // rather than stranding it in the pending slot.
        pendingTrackerRef.current?.finish("error", message);
        setError(message);
      }
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Could not start conversion.";
      pendingTrackerRef.current?.finish("error", message);
      setError(message);
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
          <DialogTitle>
            {config?.titleKey ? t(config.titleKey) : (config?.title ?? "Conversion")}
          </DialogTitle>
          <DialogDescription>
            {config?.descriptionKey
              ? t(config.descriptionKey)
              : (config?.description ?? "")}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4">
          {usesBrowserRuntime && config?.browserNoteKey && (
            <p className="text-xs text-muted-foreground">
              {t(config.browserNoteKey)}
            </p>
          )}
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
                  placeholder={t("processing.filePicker.chooseFilePlaceholder")}
                  readOnly
                />
              ) : (
                <Input
                  id="conversion-input"
                  value={inputPath}
                  placeholder={t("processing.filePicker.filePath")}
                  onChange={(event) => setInputPath(event.target.value)}
                />
              )}
              <Button
                type="button"
                variant="outline"
                size="icon"
                title={t("processing.filePicker.chooseInputFile")}
                onClick={() => void pickInput()}
              >
                <FolderOpen className="h-4 w-4" />
              </Button>
            </div>
            {usesBrowserRuntime && !isCsv && !isRasterInput && (
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
                    : t("processing.filePicker.filePath")
                }
                onChange={(event) => setOutputPath(event.target.value)}
              />
              {!usesBrowserRuntime && (
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  title={t("processing.filePicker.chooseOutputFile")}
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
                  {(compressionOptions ?? []).map((option) => (
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
                <Label htmlFor="conversion-min-zoom">{t("toolbar.conversion.minZoom")}</Label>
                <Input
                  id="conversion-min-zoom"
                  inputMode="numeric"
                  value={minZoom}
                  onChange={(event) => setMinZoom(event.target.value)}
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="conversion-max-zoom">{t("toolbar.conversion.maxZoom")}</Label>
                <Input
                  id="conversion-max-zoom"
                  inputMode="numeric"
                  value={maxZoom}
                  onChange={(event) => setMaxZoom(event.target.value)}
                />
              </div>
            </div>
          )}

          {isRasterPmtiles && (
            <div className="grid grid-cols-[5rem_minmax(0,1fr)_minmax(0,1fr)_5rem_5rem] gap-4">
              <div className="grid gap-1.5">
                <Label htmlFor="conversion-band">
                  {t("toolbar.conversion.band")}
                </Label>
                <Input
                  id="conversion-band"
                  inputMode="numeric"
                  value={band}
                  placeholder="1"
                  onChange={(event) => setBand(event.target.value)}
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="conversion-colormap">
                  {t("toolbar.conversion.colormap")}
                </Label>
                <Select
                  id="conversion-colormap"
                  value={colormap}
                  onChange={(event) =>
                    setColormap(event.target.value as PmtilesColormap | "")
                  }
                >
                  <option value="">
                    {t("toolbar.conversion.colormapDefault")}
                  </option>
                  {PMTILES_COLORMAPS.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </Select>
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="conversion-resampling">
                  {t("toolbar.conversion.resampling")}
                </Label>
                <Select
                  id="conversion-resampling"
                  value={resampling}
                  onChange={(event) =>
                    setResampling(event.target.value as PmtilesResamplingMethod)
                  }
                >
                  {PMTILES_RESAMPLING_METHODS.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </Select>
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="conversion-raster-min-zoom">{t("toolbar.conversion.minZoom")}</Label>
                <Input
                  id="conversion-raster-min-zoom"
                  inputMode="numeric"
                  value={minZoom}
                  placeholder={t("toolbar.conversion.zoomNative")}
                  onChange={(event) => setMinZoom(event.target.value)}
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="conversion-raster-max-zoom">{t("toolbar.conversion.maxZoom")}</Label>
                <Input
                  id="conversion-raster-max-zoom"
                  inputMode="numeric"
                  value={maxZoom}
                  placeholder={t("toolbar.conversion.zoomNative")}
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
