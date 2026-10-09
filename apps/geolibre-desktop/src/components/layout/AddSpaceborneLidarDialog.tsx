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
  Input,
  Label,
  Select,
} from "@geolibre/ui";
import { FileUp, Satellite } from "lucide-react";
import { buildSymbologyStyle } from "../../lib/assistant/symbology";
import { pointBounds } from "../../lib/point-bounds";
import { openLocalDataFileWithFallback } from "../../lib/tauri-io";

const LOCAL_EXTENSIONS = ["h5", "hdf5", "he5"];

/**
 * Default cap on the features one layer receives. A full GEDI orbit holds over
 * a million shots; this keeps the GeoJSON layer responsive while still drawing
 * every footprint of a regional subset.
 */
const DEFAULT_MAX_POINTS = 100_000;

/** Point radius for footprint layers: dense tracks read better small. */
const FOOTPRINT_RADIUS = 3;

/** Distinct key for a field, since GEDI `rh` yields several columns of one path. */
function fieldKey(field: Pick<SpaceborneLidarField, "path" | "column">): string {
  return field.column === undefined ? field.path : `${field.path}[${field.column}]`;
}

/** The base file name without its directory or extension. */
function baseName(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? path;
  return name.replace(/\.(h5|hdf5|he5)$/i, "");
}

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

  useEffect(() => closeFile, []);

  const reset = () => {
    opGen.current += 1;
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

  const visibleFields = useMemo(() => {
    const query = fieldFilter.trim().toLowerCase();
    if (!query) return fields;
    return fields.filter(
      (field) =>
        field.path.toLowerCase().includes(query) ||
        field.name.toLowerCase().includes(query) ||
        field.description?.toLowerCase().includes(query),
    );
  }, [fields, fieldFilter]);

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

    opGen.current += 1;
    const gen = opGen.current;
    closeFile();
    // A submit superseded by this pick returns without clearing its busy state.
    setAdding(false);
    setFile(null);
    setFields([]);
    setFileName(selected.path);
    setLoading(true);
    let opened: SpaceborneLidarFile | null = null;
    try {
      opened = await openSpaceborneLidar(selected.data, selected.path);
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

  const toggle = (set: Set<string>, key: string, on: boolean): Set<string> => {
    const next = new Set(set);
    if (on) next.add(key);
    else next.delete(key);
    return next;
  };

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
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Satellite className="h-4 w-4" />
            {t("addData.spaceborneLidar.title")}
          </DialogTitle>
          <DialogDescription>{t("addData.spaceborneLidar.description")}</DialogDescription>
        </DialogHeader>

        <form className="space-y-4" onSubmit={handleSubmit}>
          <div className="space-y-1.5">
            <Label className="block">{t("addData.spaceborneLidar.fileLabel")}</Label>
            <Button type="button" variant="outline" onClick={handleChooseFile} disabled={loading}>
              <FileUp className="me-2 h-3.5 w-3.5" />
              {loading
                ? t("addData.spaceborneLidar.readingFile")
                : fileName
                  ? t("addData.spaceborneLidar.chooseDifferentFile")
                  : t("addData.common.chooseFile")}
            </Button>
            {fileName && <p className="text-xs text-muted-foreground break-all">{fileName}</p>}
            <p className="text-xs text-muted-foreground">{t("addData.spaceborneLidar.fileHelp")}</p>
          </div>

          {file && (
            <>
              <p className="text-sm font-medium" data-testid="spaceborne-lidar-product">
                {file.product.label}
              </p>

              <div className="space-y-1.5">
                <Label>{t("addData.spaceborneLidar.beamsLabel")}</Label>
                <div className="grid grid-cols-2 gap-1">
                  {file.beams.map((beam) => (
                    <label
                      key={beam.name}
                      className="flex cursor-pointer items-center gap-2 text-xs"
                    >
                      <input
                        type="checkbox"
                        className="h-3.5 w-3.5 rounded border"
                        checked={selectedBeams.has(beam.name)}
                        onChange={(e) =>
                          setSelectedBeams((prev) => toggle(prev, beam.name, e.target.checked))
                        }
                      />
                      <span>
                        {beam.name}
                        {beam.type ? ` (${beam.type})` : ""}
                        <span className="text-muted-foreground">
                          {" "}
                          · {beam.count.toLocaleString()}
                        </span>
                      </span>
                    </label>
                  ))}
                </div>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="spaceborne-lidar-field-filter">
                  {t("addData.spaceborneLidar.fieldsLabel", {
                    selected: chosenFields.length,
                    total: fields.length,
                  })}
                </Label>
                <Input
                  id="spaceborne-lidar-field-filter"
                  value={fieldFilter}
                  placeholder={t("addData.spaceborneLidar.fieldFilterPlaceholder")}
                  onChange={(e) => setFieldFilter(e.target.value)}
                />
                <div className="max-h-40 space-y-0.5 overflow-y-auto rounded border p-1.5">
                  {visibleFields.map((field) => {
                    const key = fieldKey(field);
                    return (
                      <label
                        key={key}
                        className="flex cursor-pointer items-center gap-2 text-xs"
                        title={field.description}
                      >
                        <input
                          type="checkbox"
                          className="h-3.5 w-3.5 rounded border"
                          checked={selectedFields.has(key)}
                          onChange={(e) =>
                            setSelectedFields((prev) => toggle(prev, key, e.target.checked))
                          }
                        />
                        <span className="font-mono">{field.name}</span>
                        <span className="truncate text-muted-foreground">
                          {field.name !== field.path ? field.path : ""}
                          {field.column !== undefined ? `[${field.column}]` : ""}
                          {field.units ? ` (${field.units})` : ""}
                        </span>
                      </label>
                    );
                  })}
                </div>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="spaceborne-lidar-color-by">
                  {t("addData.spaceborneLidar.colorByLabel")}
                </Label>
                <Select
                  id="spaceborne-lidar-color-by"
                  value={colorBy}
                  onChange={(e) => setColorBy(e.target.value)}
                  disabled={chosenFields.length === 0}
                >
                  {chosenFields.map((field) => (
                    <option key={fieldKey(field)} value={field.name}>
                      {field.name}
                    </option>
                  ))}
                </Select>
              </div>

              <div className="space-y-1.5">
                <label className="flex cursor-pointer items-center gap-2 text-xs">
                  <input
                    type="checkbox"
                    className="h-3.5 w-3.5 rounded border"
                    checked={qualityFilter}
                    onChange={(e) => setQualityFilter(e.target.checked)}
                  />
                  {t("addData.spaceborneLidar.qualityFilter")}
                </label>
                <p className="ps-5 text-xs text-muted-foreground">
                  {t(`addData.spaceborneLidar.qualityHelp.${file.product.id}`)}
                </p>
                <label className="flex cursor-pointer items-center gap-2 text-xs">
                  <input
                    type="checkbox"
                    className="h-3.5 w-3.5 rounded border"
                    checked={viewOnly}
                    onChange={(e) => setViewOnly(e.target.checked)}
                  />
                  {t("addData.spaceborneLidar.viewOnly")}
                </label>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="spaceborne-lidar-max-points">
                  {t("addData.spaceborneLidar.maxPointsLabel")}
                </Label>
                <Input
                  id="spaceborne-lidar-max-points"
                  type="number"
                  min={1}
                  value={maxPoints}
                  onChange={(e) => setMaxPoints(e.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  {t("addData.spaceborneLidar.maxPointsHelp")}
                </p>
              </div>
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
