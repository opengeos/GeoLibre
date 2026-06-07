import { useAppStore, type ConversionToolKind } from "@geolibre/core";
import {
  fetchConversionJob,
  fetchConversionStatus,
  runRasterToCog,
  runVectorToGeoParquet,
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
import { useCallback, useEffect, useState } from "react";
import {
  pickLocalPathWithFallback,
  pickSavePathWithFallback,
  type FileDialogFilter,
} from "../../lib/tauri-io";
import { startGeoLibreSidecar } from "../../lib/sidecar";

const RUNNING_JOB_STATUSES = new Set(["pending", "running"]);

interface ConversionToolConfig {
  title: string;
  description: string;
  inputLabel: string;
  inputFilters: FileDialogFilter[];
  outputLabel: string;
  outputFilters: FileDialogFilter[];
  defaultOutputName: string;
  compressions: string[];
  defaultCompression: string;
}

const TOOL_CONFIGS: Record<ConversionToolKind, ConversionToolConfig> = {
  "vector-to-geoparquet": {
    title: "Vector to GeoParquet",
    description:
      "Convert a vector dataset to a Hilbert-sorted, compressed GeoParquet file optimized for cloud-native range requests.",
    inputLabel: "Input vector file",
    inputFilters: [
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
          "gml",
          "kml",
        ],
      },
    ],
    outputLabel: "Output GeoParquet file",
    outputFilters: [{ name: "GeoParquet", extensions: ["parquet"] }],
    defaultOutputName: "sorted.parquet",
    compressions: ["zstd", "snappy", "gzip", "lz4", "uncompressed"],
    defaultCompression: "zstd",
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
  const [compression, setCompression] = useState("");
  const [rowGroupSize, setRowGroupSize] = useState(DEFAULT_ROW_GROUP_SIZE);
  const [runtimeAvailable, setRuntimeAvailable] = useState<boolean | null>(null);
  const [runtimeMessage, setRuntimeMessage] = useState("");
  const [startingServer, setStartingServer] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [job, setJob] = useState<ConversionJob | null>(null);

  const config = kind ? TOOL_CONFIGS[kind] : null;

  const checkRuntime = useCallback(async () => {
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
  }, []);

  // Reset per-tool state when the dialog opens or the tool changes.
  useEffect(() => {
    if (!kind) return;
    setInputPath("");
    setOutputPath("");
    setCompression(TOOL_CONFIGS[kind].defaultCompression);
    setRowGroupSize(DEFAULT_ROW_GROUP_SIZE);
    setError(null);
    setJob(null);
    void checkRuntime();
  }, [checkRuntime, kind]);

  useEffect(() => {
    if (!job || !RUNNING_JOB_STATUSES.has(job.status)) return;
    // Schedule the next poll only after the current request resolves so a slow
    // sidecar cannot accumulate overlapping, out-of-order in-flight requests.
    let cancelled = false;
    const poll = async () => {
      if (cancelled) return;
      try {
        const next = await fetchConversionJob(job.id);
        if (cancelled) return;
        setJob(next);
        if (RUNNING_JOB_STATUSES.has(next.status)) {
          window.setTimeout(poll, 1000);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Could not poll job.");
        }
      }
    };
    const timer = window.setTimeout(poll, 1000);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [job]);

  const pickInput = async () => {
    if (!config) return;
    const path = await pickLocalPathWithFallback({
      filters: config.inputFilters,
    });
    if (path) setInputPath(path);
  };

  const pickOutput = async () => {
    if (!config) return;
    const path = await pickSavePathWithFallback({
      defaultName: config.defaultOutputName,
      filters: config.outputFilters,
    });
    if (path) setOutputPath(path);
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
    if (!inputPath.trim()) {
      setError("Choose an input file.");
      return;
    }
    if (!outputPath.trim()) {
      setError("Choose an output file.");
      return;
    }
    try {
      if (kind === "vector-to-geoparquet") {
        const parsedRowGroupSize = Number.parseInt(rowGroupSize, 10);
        if (!Number.isFinite(parsedRowGroupSize) || parsedRowGroupSize <= 0) {
          setError("Row group size must be a positive integer.");
          return;
        }
        setJob(
          await runVectorToGeoParquet({
            input_path: inputPath.trim(),
            output_path: outputPath.trim(),
            compression,
            row_group_size: parsedRowGroupSize,
          }),
        );
      } else {
        setJob(
          await runRasterToCog({
            input_path: inputPath.trim(),
            output_path: outputPath.trim(),
            compression,
          }),
        );
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
      onOpenChange={(open) => {
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
            </div>
          )}

          <div className="grid gap-1.5">
            <Label htmlFor="conversion-input">{config?.inputLabel}</Label>
            <div className="grid grid-cols-[minmax(0,1fr)_2.25rem] gap-2">
              <Input
                id="conversion-input"
                value={inputPath}
                placeholder="File path"
                onChange={(event) => setInputPath(event.target.value)}
              />
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
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="conversion-output">{config?.outputLabel}</Label>
            <div className="grid grid-cols-[minmax(0,1fr)_2.25rem] gap-2">
              <Input
                id="conversion-output"
                value={outputPath}
                placeholder="File path"
                onChange={(event) => setOutputPath(event.target.value)}
              />
              <Button
                type="button"
                variant="outline"
                size="icon"
                title="Choose output file"
                onClick={() => void pickOutput()}
              >
                <Save className="h-4 w-4" />
              </Button>
            </div>
          </div>

          <div
            className={cn(
              "grid gap-4",
              kind === "vector-to-geoparquet" && "grid-cols-2",
            )}
          >
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
            {kind === "vector-to-geoparquet" && (
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
                  job.messages.map((line, index) => (
                    <div key={`${index}-${line}`}>{line}</div>
                  ))
                )}
              </ScrollArea>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
