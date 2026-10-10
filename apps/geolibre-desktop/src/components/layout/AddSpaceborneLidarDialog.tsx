import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import {
  openSpaceborneLidar,
  type GeoLibreAppAPI,
  type SpaceborneLidarField,
  type SpaceborneLidarFile,
} from "@geolibre/plugins";
import { useAppStore } from "@geolibre/core";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Label,
} from "@geolibre/ui";
import { FileUp, Satellite } from "lucide-react";
import { useDialogResize } from "../../hooks/useDialogResize";
import { buildSymbologyStyle } from "../../lib/assistant/symbology";
import { SPACEBORNE_LIDAR_SOURCE_KIND } from "../../lib/along-track-profile";
import { pointBounds } from "../../lib/point-bounds";
import { openLocalDataFileWithFallback } from "../../lib/tauri-io";
import {
  baseName,
  downloadWithProgress,
  fieldKey,
  SAMPLE_BASE_URL,
  SAMPLES,
} from "../../lib/spaceborne-lidar-samples";
import {
  onSpaceborneLidarGranuleRequest,
  takePendingSpaceborneLidarGranule,
} from "../../lib/spaceborne-lidar-handoff";
import { SampleDataSelect } from "./add-data/shared";
import { SpaceborneLidarOptions } from "./SpaceborneLidarOptions";

const LOCAL_EXTENSIONS = ["h5", "hdf5", "he5"];

/**
 * Default cap on the features one layer receives. A full GEDI orbit holds over
 * a million shots; this keeps the GeoJSON layer responsive while still drawing
 * every footprint of a regional subset.
 */
const DEFAULT_MAX_POINTS = 100_000;

/** Point radius for footprint layers: dense tracks read better small. */
const FOOTPRINT_RADIUS = 3;

interface AddSpaceborneLidarDialogProps {
  open: boolean;
  appApi: GeoLibreAppAPI;
  onOpenChange: (open: boolean) => void;
}

/**
 * Dialog for adding ICESat-2 (ATL06, ATL08) and GEDI (L2A, L2B, L4A) footprints
 * from a local HDF5 granule as a GeoJSON point layer. The granule is decoded in
 * the browser; the user picks beams and fields, optionally limits the read to
 * the current view, and the layer arrives colored by the product's main field.
 */
export function AddSpaceborneLidarDialog({
  open,
  appApi,
  onOpenChange,
}: AddSpaceborneLidarDialogProps) {
  const { t } = useTranslation();
  const [file, setFile] = useState<SpaceborneLidarFile | null>(null);
  const [fileName, setFileName] = useState("");
  const [fields, setFields] = useState<SpaceborneLidarField[]>([]);
  const [selectedBeams, setSelectedBeams] = useState<Set<string>>(new Set());
  const [selectedFields, setSelectedFields] = useState<Set<string>>(new Set());
  const [fieldFilter, setFieldFilter] = useState("");
  const [colorBy, setColorBy] = useState("");
  const [qualityFilter, setQualityFilter] = useState(true);
  const [viewOnly, setViewOnly] = useState(false);
  const [maxPoints, setMaxPoints] = useState(String(DEFAULT_MAX_POINTS));
  const [loading, setLoading] = useState(false);
  // Percent of a sample granule downloaded, or null when not downloading.
  const [downloadPercent, setDownloadPercent] = useState<number | null>(null);
  const downloadAbort = useRef<AbortController | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const { style: dialogStyle, startResize } = useDialogResize(dialogRef);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  // The open granule, read by the unmount cleanup (state is stale there).
  const fileRef = useRef<SpaceborneLidarFile | null>(null);
  // Bumped on reset so an open that resolves after the dialog closed is dropped.
  const opGen = useRef(0);

  const closeFile = () => {
    fileRef.current?.close();
    fileRef.current = null;
  };

  useEffect(
    () => () => {
      downloadAbort.current?.abort();
      closeFile();
    },
    [],
  );

  const reset = () => {
    opGen.current += 1;
    downloadAbort.current?.abort();
    downloadAbort.current = null;
    setDownloadPercent(null);
    closeFile();
    setFile(null);
    setFileName("");
    setFields([]);
    setSelectedBeams(new Set());
    setSelectedFields(new Set());
    setFieldFilter("");
    setColorBy("");
    setQualityFilter(true);
    setViewOnly(false);
    setMaxPoints(String(DEFAULT_MAX_POINTS));
    setLoading(false);
    setAdding(false);
    setError(null);
    setStatus(null);
  };

  const chosenFields = useMemo(
    () => fields.filter((field) => selectedFields.has(fieldKey(field))),
    [fields, selectedFields],
  );

  // Keep the color-by choice valid as fields are toggled.
  useEffect(() => {
    if (chosenFields.length === 0) {
      if (colorBy) setColorBy("");
    } else if (!chosenFields.some((field) => field.name === colorBy)) {
      setColorBy(chosenFields[0].name);
    }
  }, [chosenFields, colorBy]);

  const handleChooseFile = async () => {
    setError(null);
    setStatus(null);
    let selected: { data?: ArrayBuffer; path: string } | null;
    try {
      selected = await openLocalDataFileWithFallback({
        filters: [{ name: "ICESat-2 / GEDI (HDF5)", extensions: LOCAL_EXTENSIONS }],
        accept: LOCAL_EXTENSIONS.map((ext) => `.${ext}`).join(","),
        readBinary: true,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return;
    }
    if (!selected?.data) return;
    await openGranule(selected.data, selected.path);
  };

  const handleSample = async (file: string) => {
    setError(null);
    setStatus(null);
    downloadAbort.current?.abort();
    const controller = new AbortController();
    downloadAbort.current = controller;
    opGen.current += 1;
    const gen = opGen.current;
    closeFile();
    setAdding(false);
    setFile(null);
    setFields([]);
    setFileName(file);
    setDownloadPercent(0);
    let data: ArrayBuffer;
    try {
      data = await downloadWithProgress(`${SAMPLE_BASE_URL}/${file}`, controller.signal, (p) => {
        if (gen === opGen.current) setDownloadPercent(p);
      });
    } catch (err) {
      if (gen !== opGen.current || controller.signal.aborted) return;
      setDownloadPercent(null);
      setError(
        t("addData.spaceborneLidar.sampleDownloadFailed", {
          detail: err instanceof Error ? err.message : String(err),
        }),
      );
      return;
    } finally {
      if (downloadAbort.current === controller) downloadAbort.current = null;
    }
    if (gen !== opGen.current) return;
    setDownloadPercent(null);
    await openGranule(data, file);
  };

  /** Decode a granule's bytes and show its beams and fields. */
  const openGranule = async (data: ArrayBuffer, path: string) => {
    downloadAbort.current?.abort();
    downloadAbort.current = null;
    setDownloadPercent(null);
    opGen.current += 1;
    const gen = opGen.current;
    closeFile();
    // A submit superseded by this pick returns without clearing its busy state.
    setAdding(false);
    setFile(null);
    setFields([]);
    setFileName(path);
    setLoading(true);
    let opened: SpaceborneLidarFile | null = null;
    try {
      opened = await openSpaceborneLidar(data, path);
      const listed = opened.listFields();
      if (gen !== opGen.current) {
        opened.close();
        return;
      }
      fileRef.current = opened;
      setFile(opened);
      setFields(listed);
      setSelectedBeams(new Set(opened.beams.map((beam) => beam.name)));
      setSelectedFields(new Set(listed.filter((f) => f.isDefault).map(fieldKey)));
      setColorBy(opened.product.primaryField);
    } catch (err) {
      if (opened && fileRef.current !== opened) opened.close();
      if (gen !== opGen.current) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (gen === opGen.current) setLoading(false);
    }
  };

  // A granule handed over by a plugin (the Earthaccess panel): take it on
  // mount, and whenever another arrives while the dialog is open.
  const openGranuleRef = useRef(openGranule);
  openGranuleRef.current = openGranule;
  useEffect(() => {
    const takePending = () => {
      const granule = takePendingSpaceborneLidarGranule();
      if (granule) void openGranuleRef.current(granule.data, granule.fileName);
    };
    takePending();
    return onSpaceborneLidarGranuleRequest(takePending);
  }, []);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!file || selectedBeams.size === 0) return;
    setError(null);
    setStatus(null);
    const bbox = viewOnly ? (appApi.getViewBounds?.() ?? null) : null;
    if (viewOnly && !bbox) {
      setError(t("addData.spaceborneLidar.errorNoView"));
      return;
    }
    const parsedMax = Number(maxPoints);
    const gen = opGen.current;
    setAdding(true);
    // Let the busy state paint before the synchronous decode blocks the thread.
    await new Promise((resolve) => setTimeout(resolve, 0));
    // Closing the dialog or picking another file during the yield closes this
    // granule; reading it now would report an empty result for the wrong file.
    if (gen !== opGen.current || fileRef.current !== file) return;
    try {
      const result = file.readFootprints({
        beams: file.beams.filter((beam) => selectedBeams.has(beam.name)).map((b) => b.name),
        fields: chosenFields,
        qualityFilter,
        ...(bbox ? { bbox } : {}),
        // An empty or invalid cap falls back to the default rather than lifting
        // it: a full GEDI orbit has over a million shots.
        maxPoints: Number.isFinite(parsedMax) && parsedMax > 0 ? parsedMax : DEFAULT_MAX_POINTS,
      });
      if (result.kept === 0) {
        setError(t("addData.spaceborneLidar.errorNoFootprints"));
        return;
      }
      const store = useAppStore.getState();
      const name = `${file.product.id} ${baseName(fileName)}`;
      const id = store.addGeoJsonLayer(name, result.geojson, fileName);
      // Tag the layer so the Layers panel offers its along-track profile.
      const added = useAppStore.getState().layers.find((entry) => entry.id === id);
      store.updateLayer(id, {
        metadata: {
          // Keep whatever the store put there; updateLayer replaces the object.
          ...added?.metadata,
          sourceKind: SPACEBORNE_LIDAR_SOURCE_KIND,
          product: file.product.id,
          beams: result.perBeam.filter((entry) => entry.kept > 0).map((entry) => entry.beam),
        },
      });
      const layer = useAppStore.getState().layers.find((entry) => entry.id === id);
      let style: Parameters<typeof store.setLayerStyle>[1] = { circleRadius: FOOTPRINT_RADIUS };
      if (layer && colorBy) {
        try {
          style = {
            ...style,
            ...buildSymbologyStyle(layer, {
              mode: "graduated",
              property: colorBy,
              colorRamp: "viridis",
              scheme: "quantile",
              classCount: 7,
            }),
          };
        } catch {
          // A field with fewer than two values cannot be classified; the layer
          // keeps its single color and the user can restyle it.
        }
      }
      store.setLayerStyle(id, style);
      if (!bbox) {
        const bounds = pointBounds(result.geojson.features);
        if (bounds) appApi.fitBounds?.(bounds);
      }
      setStatus(
        result.stride > 1
          ? t("addData.spaceborneLidar.addedThinned", {
              kept: result.kept.toLocaleString(),
              matched: result.matched.toLocaleString(),
              stride: result.stride,
            })
          : t("addData.spaceborneLidar.added", {
              count: result.kept,
              formatted: result.kept.toLocaleString(),
            }),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (gen === opGen.current) setAdding(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next: boolean) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent
        ref={dialogRef}
        className="max-w-2xl"
        style={dialogStyle}
        resizeHandle={
          <div
            role="separator"
            aria-label={t("addData.spaceborneLidar.resizeDialog")}
            title={t("addData.spaceborneLidar.resizeDialog")}
            onPointerDown={startResize}
            className="absolute bottom-0 end-0 z-10 hidden h-5 w-5 cursor-nwse-resize touch-none select-none text-muted-foreground hover:text-foreground md:block rtl:cursor-nesw-resize"
          >
            <svg viewBox="0 0 16 16" className="h-full w-full rtl:scale-x-[-1]" aria-hidden="true">
              <path
                d="M11 15L15 11M6 15L15 6"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
              />
            </svg>
          </div>
        }
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Satellite className="h-4 w-4" />
            {t("addData.spaceborneLidar.title")}
          </DialogTitle>
          <DialogDescription>{t("addData.spaceborneLidar.description")}</DialogDescription>
        </DialogHeader>

        {/* min-w-0: the dialog body is a grid, whose column would otherwise
            grow to the longest unbreakable HDF5 path in the field list. */}
        <form className="min-w-0 space-y-4" onSubmit={handleSubmit}>
          <div className="space-y-1.5">
            <Label className="block">{t("addData.spaceborneLidar.fileLabel")}</Label>
            <Button
              type="button"
              variant="outline"
              onClick={handleChooseFile}
              disabled={loading || downloadPercent !== null}
            >
              <FileUp className="me-2 h-3.5 w-3.5" />
              {loading
                ? t("addData.spaceborneLidar.readingFile")
                : fileName
                  ? t("addData.spaceborneLidar.chooseDifferentFile")
                  : t("addData.common.chooseFile")}
            </Button>
            {fileName && <p className="text-xs text-muted-foreground break-all">{fileName}</p>}
            {downloadPercent !== null && (
              <p className="text-xs text-muted-foreground" role="status" aria-live="polite">
                {t("addData.spaceborneLidar.downloadingSample", { percent: downloadPercent })}
              </p>
            )}
            <p className="text-xs text-muted-foreground">{t("addData.spaceborneLidar.fileHelp")}</p>
            <SampleDataSelect
              samples={SAMPLES.map((sample) => ({
                label: t(`addData.spaceborneLidar.${sample.labelKey}`),
                value: sample.file,
              }))}
              onSelect={(sample) => void handleSample(sample)}
            />
          </div>

          {file && (
            <>
              <p className="text-sm font-medium" data-testid="spaceborne-lidar-product">
                {file.product.label}
              </p>

              <SpaceborneLidarOptions
                file={file}
                fields={fields}
                chosenFields={chosenFields}
                selectedBeams={selectedBeams}
                setSelectedBeams={setSelectedBeams}
                selectedFields={selectedFields}
                setSelectedFields={setSelectedFields}
                fieldFilter={fieldFilter}
                setFieldFilter={setFieldFilter}
                colorBy={colorBy}
                setColorBy={setColorBy}
                qualityFilter={qualityFilter}
                setQualityFilter={setQualityFilter}
                viewOnly={viewOnly}
                setViewOnly={setViewOnly}
                maxPoints={maxPoints}
                setMaxPoints={setMaxPoints}
              />
            </>
          )}

          {error && <p className="text-xs text-destructive">{error}</p>}
          {status && (
            <p className="text-xs text-muted-foreground" role="status">
              {status}
            </p>
          )}

          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                reset();
                onOpenChange(false);
              }}
            >
              {t("addData.spaceborneLidar.close")}
            </Button>
            <Button type="submit" disabled={!file || adding || selectedBeams.size === 0}>
              {adding ? t("addData.spaceborneLidar.adding") : t("addData.spaceborneLidar.add")}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
