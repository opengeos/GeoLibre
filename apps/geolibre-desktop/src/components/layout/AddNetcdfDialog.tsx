import { useRef, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import {
  addCloudNetcdfLayer,
  composeRgbImage,
  listKerchunkVariables,
  loadKerchunkReference,
  openLocalNetcdf,
  type GeoLibreAppAPI,
  type KerchunkRefs,
  type KerchunkVariable,
  type LocalNetcdfAxis,
  type LocalNetcdfFile,
  type LocalNetcdfGrid,
  type LocalNetcdfProfile,
} from "@geolibre/plugins";
import { useAppStore } from "@geolibre/core";
import {
  Button,
  ColorRampSelect,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  Select,
} from "@geolibre/ui";
import { Boxes, FileUp } from "lucide-react";
import { useColormapRamps } from "../../hooks/useColormapRamps";
import {
  axisOptionLabel,
  defaultRgbBands,
  isTimeAxisName,
  MAX_AXIS_OPTIONS,
  pickBandAxis,
} from "../../lib/netcdf-band-axis";
import {
  isNetcdfFileUrl,
  openRemoteNetcdfFile,
  type RemoteNetcdfFile,
} from "../../lib/netcdf-remote-client";
import {
  bakeNetcdfImage,
  encodeImageOverlay,
  NETCDF_IMAGE_SOURCE_KIND,
  registerNetcdfLayer,
  warmNetcdfColormap,
  type NetcdfLayerState,
} from "../../lib/netcdf-image-symbology";
import { openLocalDataFileWithFallback } from "../../lib/tauri-io";
import { SampleDataSelect } from "./add-data/shared";

// A real sample: NOAA NCEP/NCAR Reanalysis surface air temperature, stored as a
// Cloud-Optimized NetCDF and served from Source Cooperative (CORS-enabled,
// range-request capable). The reference uses a relative chunk URL, so it
// resolves against the manifest's own location.
const SAMPLE_URL = "https://data.source.coop/giswqs/opengeos/netcdf/air-temperature.kerchunk.json";

// Extensions accepted for a local file: classic NetCDF-3 (.nc/.cdf, via
// netcdfjs) and HDF5-backed NetCDF-4/HDF5 (.nc/.nc4/.h5/.hdf5, via h5wasm).
// `.hdf` (usually HDF4) is omitted since neither backend reads it.
const LOCAL_EXTENSIONS = ["nc", "nc4", "cdf", "h5", "hdf5"];

/** Which source the dialog opens on. */
const DEFAULT_SOURCE = "file" as const;

/** Default single-band colormap, matching the Zarr panel's own default. */
const DEFAULT_COLORMAP = "viridis";

/**
 * A renderable variable, shared shape across the cloud and local readers. The
 * local reader also reports CF `long_name`/`units`; the cloud one does not, so
 * both are optional.
 */
type RenderableVariable = KerchunkVariable & { longName?: string; units?: string };

/** How a local variable is turned into a layer. */
type RenderMode = "single" | "rgb";

/**
 * The dataset the dialog is working with, whichever way it was opened. Both
 * answer the same questions; a remote one answers them over range requests, so
 * every accessor is async and callers must not assume they return promptly.
 */
type OpenDataset =
  | { kind: "local"; file: LocalNetcdfFile }
  | { kind: "remote"; file: RemoteNetcdfFile; url: string };

/** The dataset's leading axes for a variable, or [] when they cannot be read. */
async function datasetAxes(dataset: OpenDataset, variable: string): Promise<LocalNetcdfAxis[]> {
  try {
    return dataset.kind === "local"
      ? dataset.file.listAxes(variable)
      : await dataset.file.listAxes(variable);
  } catch {
    // A variable whose axes cannot be described still renders; the dialog falls
    // back to the plain numeric index boxes.
    return [];
  }
}

/**
 * The cube reads bound to one dataset, variable, and band axis, for the layer
 * registry: a spectral profile at a pixel, and a single band's plane. Local
 * reads resolve immediately; remote ones round trip to the worker, which is why
 * the registry stores functions rather than the file.
 */
function cubeReader(
  dataset: OpenDataset,
  variable: string,
  axis: LocalNetcdfAxis,
  selector: Record<string, number>,
): NonNullable<NetcdfLayerState["cube"]> {
  return {
    axis,
    readProfile: (row, column) =>
      dataset.kind === "local"
        ? Promise.resolve(
            dataset.file.readProfile(variable, { axis: axis.name, row, column, selector }),
          )
        : dataset.file.readProfile(variable, { axis: axis.name, row, column, selector }),
    readBand: (bandIndex, window) => {
      const bandSelector = { ...selector, [axis.name]: bandIndex };
      return dataset.kind === "local"
        ? Promise.resolve(dataset.file.readGrid(variable, bandSelector, window))
        : dataset.file.readGrid(variable, bandSelector, window);
    },
    close: () => dataset.file.close(),
  };
}

/** One 2-D slice of a variable, with its coordinates and packing. */
function datasetGrid(
  dataset: OpenDataset,
  variable: string,
  selector: Record<string, number>,
): Promise<LocalNetcdfGrid> {
  return dataset.kind === "local"
    ? Promise.resolve(dataset.file.readGrid(variable, selector))
    : dataset.file.readGrid(variable, selector);
}

interface AddNetcdfDialogProps {
  open: boolean;
  appApi: GeoLibreAppAPI;
  onOpenChange: (open: boolean) => void;
}

/**
 * Dialog for adding a NetCDF/HDF5 layer, from any of three sources:
 *
 * - a local HDF5/NetCDF-4 or NetCDF-3 file, decoded in-browser;
 * - a direct NetCDF/HDF **URL**, read in place by HTTP range request in a
 *   worker, so a cube far larger than the slice wanted is not downloaded whole;
 * - a kerchunk reference URL, streamed by the shared Zarr control.
 *
 * The first two share one code path once opened (see {@link OpenDataset}): the
 * user picks a variable and any leading-dimension index, and the grid is
 * colormapped here rather than by a shader.
 */
export function AddNetcdfDialog({ open, appApi, onOpenChange }: AddNetcdfDialogProps) {
  const { t } = useTranslation();
  const addImageOverlayLayer = useAppStore((state) => state.addImageOverlayLayer);
  // The same catalogue the Style panel's Raster symbology offers, so the choice
  // made here and the choice made after the fact are drawn from one list.
  const rampOptions = useColormapRamps();
  // Local file first: it is the common case, and it is the path that renders the
  // pixels itself (see `useImagePath`) rather than through the Zarr control.
  const [source, setSource] = useState<"url" | "file">(DEFAULT_SOURCE);
  const [url, setUrl] = useState("");
  // The opened dataset, local or remote, kept between loading its variables and
  // submitting so the (potentially expensive) open happens once. Closed on
  // reset, unless a layer took ownership of it for spectral profiles.
  const [dataset, setDataset] = useState<OpenDataset | null>(null);
  const [fileName, setFileName] = useState("");
  const [variables, setVariables] = useState<RenderableVariable[]>([]);
  const [variable, setVariable] = useState("");
  // The normalized reference from the last successful URL load, reused on submit
  // so the (potentially large) manifest is not fetched a second time.
  const [loadedRefs, setLoadedRefs] = useState<KerchunkRefs | null>(null);
  const [dimIndex, setDimIndex] = useState<Record<string, string>>({});
  const [climMin, setClimMin] = useState("");
  const [climMax, setClimMax] = useState("");
  const [colormap, setColormap] = useState(DEFAULT_COLORMAP);
  const [mode, setMode] = useState<RenderMode>("single");
  // The selected variable's leading axes with their coordinate values, read once
  // per variable so the band pickers can label indices with wavelengths.
  const [axes, setAxes] = useState<LocalNetcdfAxis[]>([]);
  const [rgbBands, setRgbBands] = useState<[number, number, number]>([0, 0, 0]);
  const [loadingVars, setLoadingVars] = useState(false);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  // Incremented on every reset; lets in-flight async handlers detect that the
  // dialog was closed/reopened and bail out before stomping fresh state.
  const opGen = useRef(0);
  // Per-call ordering for `selectVariable`, which `opGen` cannot provide: it
  // reads within one unchanged dataset, so two overlapping reads share a gen.
  const selectSeq = useRef(0);
  // Holds the currently-open local file so it can be closed synchronously on
  // reset even if the latest setLocalFile has not flushed to state yet.
  const openFileRef = useRef<OpenDataset | null>(null);
  // A file handed to a layer for spectral profiles outlives this dialog, so
  // reset must not close it; the layer registry owns it from then on.
  const retainedFileRef = useRef<LocalNetcdfFile | RemoteNetcdfFile | null>(null);

  const selectedVar = variables.find((v) => v.name === variable);
  // Dimensions other than the trailing two (lat/lon) need a fixed index.
  const leadingDims = selectedVar
    ? selectedVar.dims.slice(0, Math.max(0, selectedVar.dims.length - 2))
    : [];
  // The axis an RGB composite draws its three channels from. A time axis is
  // excluded however many steps it has: combining three dates as red/green/blue
  // is meaningless, and (time, lat, lon) is the commonest cube shape there is,
  // so without this nearly every one would offer a bogus RGB option.
  const rgbAxis = pickBandAxis(axes);
  // Composing an RGB image needs the pixels in hand, which means an opened
  // dataset (local file or remote URL). A kerchunk manifest has none: it streams
  // chunks through the renderer instead.
  const canComposeRgb = dataset !== null && rgbAxis !== null;
  const rgbMode = mode === "rgb" && canComposeRgb;
  // A cube the Time Slider can drive stays on the Zarr renderer, which can
  // re-select a slice without rebuilding the layer; a baked image cannot.
  // `axes` is empty when listAxes throws, but `leadingDims` comes from
  // listVariables and survives; without the fallback a time cube would quietly
  // lose the Time Slider by taking the baked-image path.
  const hasTimeAxis =
    axes.some((axis) => isTimeAxisName(axis.name)) || leadingDims.some(isTimeAxisName);
  // Single-band grids from an opened dataset are colormapped on the CPU and
  // added as an image overlay rather than drawn by @carbonplan/zarr-layer, whose
  // `shift_x` uniform lookup throws on drivers that eliminate it (Mesa, so most
  // Linux Intel/AMD machines), leaving the layer permanently blank. See
  // composeColormappedImage.
  const useImagePath = dataset !== null && !rgbMode && !hasTimeAxis;

  const closeOpenFile = () => {
    const open = openFileRef.current;
    if (open && open.file !== retainedFileRef.current) open.file.close();
    openFileRef.current = null;
  };

  const reset = () => {
    opGen.current += 1;
    closeOpenFile();
    setSource(DEFAULT_SOURCE);
    setUrl("");
    setDataset(null);
    setFileName("");
    setVariables([]);
    setVariable("");
    setLoadedRefs(null);
    setDimIndex({});
    setClimMin("");
    setClimMax("");
    setColormap(DEFAULT_COLORMAP);
    setMode("single");
    setAxes([]);
    setRgbBands([0, 0, 0]);
    setError(null);
    setStatus(null);
    setLoadingVars(false);
    setAdding(false);
  };

  // Invalidate everything tied to the previously loaded source (URL manifest or
  // local file) when the input changes, and bump opGen so an in-flight load for
  // the old source cannot write back into state. Bumping opGen makes that load's
  // finally skip its own setLoadingVars(false), so the flags are cleared here
  // too (otherwise Load variables stays disabled).
  const invalidateLoadedSource = () => {
    opGen.current += 1;
    closeOpenFile();
    setDataset(null);
    setFileName("");
    setVariables([]);
    setVariable("");
    setLoadedRefs(null);
    setDimIndex({});
    setClimMin("");
    setClimMax("");
    setMode("single");
    setAxes([]);
    setRgbBands([0, 0, 0]);
    setStatus(null);
    setError(null);
    setLoadingVars(false);
    setAdding(false);
  };

  const applyLoadedVariables = (vars: RenderableVariable[], opened?: OpenDataset) => {
    setVariables(vars);
    setVariable(vars[0].name);
    void selectVariable(vars[0].name, opened ?? openFileRef.current);
    setStatus(`Found ${vars.length} variable${vars.length > 1 ? "s" : ""}.`);
  };

  /**
   * Point the dimension/band controls at a variable: read its leading axes (with
   * their coordinate values) from the local reader and seed the RGB channels
   * from the axis' own wavelengths, so the composite opens on a sensible
   * natural-colour guess rather than three copies of band 0.
   */
  const selectVariable = async (name: string, opened: OpenDataset | null) => {
    setDimIndex({});
    const gen = opGen.current;
    // `opGen` only moves when the dialog resets or its source changes, so it
    // cannot order two reads of the *same* dataset. Switching variables while a
    // read is outstanding — seconds, for a remote cube — would otherwise let
    // whichever finishes last win, seeding the axes and RGB defaults from a
    // variable the user has already moved off.
    const seq = ++selectSeq.current;
    const nextAxes = opened ? await datasetAxes(opened, name) : [];
    if (gen !== opGen.current || seq !== selectSeq.current) return; // moved on while reading
    setAxes(nextAxes);
    const bandAxis = pickBandAxis(nextAxes);
    setRgbBands(bandAxis ? defaultRgbBands(bandAxis) : [0, 0, 0]);
    if (!bandAxis) setMode("single");
  };

  const handleLoadVariables = async () => {
    const gen = opGen.current;
    setError(null);
    setStatus(null);
    // Clear any prior result so the picker hides and "Add layer" disables while
    // a new source loads (avoids submitting a variable from the old dataset).
    setVariables([]);
    setVariable("");
    setLoadedRefs(null);
    setLoadingVars(true);
    try {
      const target = url.trim();
      // A raw NetCDF/HDF URL is read in place by range request; only a kerchunk
      // manifest goes through the reference loader.
      if (isNetcdfFileUrl(target)) {
        // Close a dataset from a previous load, but deliberately do NOT call
        // invalidateLoadedSource: it bumps opGen, which would make this
        // function's own `finally` skip clearing the loading flag and strand the
        // button on "Loading...".
        closeOpenFile();
        setDataset(null);
        setStatus(t("addData.netcdf.readingRemote"));
        const remote = await openRemoteNetcdfFile(target);
        if (gen !== opGen.current) {
          remote.close();
          return;
        }
        if (remote.variables.length === 0) {
          remote.close();
          throw new Error(t("addData.netcdf.errorNoVariables"));
        }
        const opened: OpenDataset = { kind: "remote", file: remote, url: target };
        openFileRef.current = opened;
        setDataset(opened);
        applyLoadedVariables(remote.variables, opened);
        return;
      }
      const refs = await loadKerchunkReference(target);
      const vars = listKerchunkVariables(refs);
      if (gen !== opGen.current) return; // dialog was closed/reopened
      if (vars.length === 0) {
        throw new Error("No renderable (2-D or higher) variables found in the reference.");
      }
      setLoadedRefs(refs);
      applyLoadedVariables(vars);
    } catch (err) {
      if (gen !== opGen.current) return;
      setVariables([]);
      setVariable("");
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (gen === opGen.current) setLoadingVars(false);
    }
  };

  const handleChooseLocalFile = async () => {
    setError(null);
    setStatus(null);
    let selected: { data?: ArrayBuffer; path: string } | null;
    try {
      selected = await openLocalDataFileWithFallback({
        filters: [{ name: "NetCDF / HDF5", extensions: LOCAL_EXTENSIONS }],
        accept: LOCAL_EXTENSIONS.map((ext) => `.${ext}`).join(","),
        readBinary: true,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return;
    }
    if (!selected?.data) return; // dialog dismissed

    // Any prior open file (or URL result) is now stale; bump opGen and close it.
    invalidateLoadedSource();
    const gen = opGen.current;
    setFileName(selected.path);
    setLoadingVars(true);
    // Held outside the try so a throw after open (e.g. listVariables on a
    // corrupt dataset) still closes the WASM file handle in the catch.
    let file: LocalNetcdfFile | null = null;
    try {
      file = await openLocalNetcdf(selected.data);
      const vars = file.listVariables();
      if (gen !== opGen.current) {
        file.close(); // dialog was closed/reopened while decoding
        return;
      }
      if (vars.length === 0) {
        throw new Error(t("addData.netcdf.errorNoVariables"));
      }
      const opened: OpenDataset = { kind: "local", file };
      openFileRef.current = opened;
      setDataset(opened);
      applyLoadedVariables(vars, opened);
    } catch (err) {
      // Close the just-opened handle unless it was stored for later use.
      if (file && openFileRef.current?.file !== file) file.close();
      if (gen !== opGen.current) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (gen === opGen.current) setLoadingVars(false);
    }
  };

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!variable) return;
    const gen = opGen.current;
    setError(null);
    setAdding(true);
    try {
      const selector: Record<string, number> = {};
      for (const dim of leadingDims) {
        // Zarr indices are non-negative integers; clamp/truncate user input.
        const parsed = Number(dimIndex[dim] ?? "0");
        selector[dim] = Number.isFinite(parsed) ? Math.max(0, Math.trunc(parsed)) : 0;
      }
      const min = climMin.trim() === "" ? undefined : Number(climMin);
      const max = climMax.trim() === "" ? undefined : Number(climMax);
      const clim =
        min !== undefined &&
        max !== undefined &&
        Number.isFinite(min) &&
        Number.isFinite(max) &&
        min < max
          ? ([min, max] as [number, number])
          : undefined;

      if (dataset) {
        // Yield once so the "Adding..." state paints before the CPU-heavy
        // decode/encode of a potentially large grid.
        await new Promise((resolve) => setTimeout(resolve, 0));
        // A local path is a full path on desktop; a URL's last segment is its
        // file name. Either way the layer takes the bare name.
        const baseName =
          (dataset.kind === "local" ? fileName : new URL(dataset.url).pathname)
            .split(/[\\/]/)
            .pop() || "netcdf";

        if (rgbMode && rgbAxis) {
          // Compose from three plane reads rather than the reader's own helper,
          // so the remote path (which has no synchronous reader) works too.
          const channels = await Promise.all(
            rgbBands.map((index) =>
              datasetGrid(dataset, variable, { ...selector, [rgbAxis.name]: index }),
            ),
          );
          const image = composeRgbImage({
            ny: channels[0].ny,
            nx: channels[0].nx,
            channels: channels.map((channel: LocalNetcdfGrid) => channel.values),
            lat: channels[0].lat,
            lon: channels[0].lon,
            fillValue: channels[0].fillValue,
            scaleFactor: channels[0].scaleFactor,
            addOffset: channels[0].addOffset,
          });
          addImageOverlayLayer(
            `${baseName} - ${variable} (RGB)`,
            {
              url: encodeImageOverlay(image),
              coordinates: image.coordinates,
            },
            {
              bounds: image.bounds,
              // Without this the store defaults it to "kml-ground-overlay",
              // which every consumer of that marker would then act on.
              sourceKind: NETCDF_IMAGE_SOURCE_KIND,
              metadata: { variable },
            },
          );
          appApi.fitBounds?.(image.bounds);
        } else if (useImagePath) {
          // The grid itself, not just its pixels, so the Style panel can
          // re-colormap the layer without re-reading the file.
          const grid = await datasetGrid(dataset, variable, selector);
          const symbology = {
            colormap,
            reversed: false,
            clim: clim ?? grid.dataClim,
          };
          // The picker lists every ramp as soon as it opens, including sprite
          // ramps the catalogue is still sampling; baking before one resolves
          // would silently paint viridis under the chosen name.
          await warmNetcdfColormap(colormap);
          const image = bakeNetcdfImage(grid, symbology);
          const layerId = addImageOverlayLayer(
            `${baseName} - ${variable}`,
            {
              url: encodeImageOverlay(image),
              coordinates: image.coordinates,
            },
            {
              bounds: image.bounds,
              sourceKind: NETCDF_IMAGE_SOURCE_KIND,
              metadata: {
                netcdfSymbology: symbology,
                variable,
                // Identify reads a cell value, not a feature, so the button's
                // tooltip should say so — the same marker COG-backed Time
                // Slider sources use.
                pixelIdentify: true,
              },
            },
          );
          // The file stays open only for a cube, whose band axis is what a
          // spectral signature walks; a plain 2-D grid needs nothing beyond the
          // slice already read.
          if (rgbAxis) retainedFileRef.current = dataset.file;
          registerNetcdfLayer(layerId, {
            grid,
            variable,
            ...(selectedVar?.units ? { units: selectedVar.units } : {}),
            ...(rgbAxis ? { cube: cubeReader(dataset, variable, rgbAxis, selector) } : {}),
          });
          appApi.fitBounds?.(image.bounds);
        } else if (dataset.kind === "local") {
          const built = dataset.file.buildLayerRefs(variable, selector);
          await addCloudNetcdfLayer(appApi, {
            // Encoded so a name with URL-special chars (#, ?, %) survives
            // layerNameFromUrl's new URL(...) parse; that helper decodes it
            // again for the display name.
            url: `local:${encodeURIComponent(baseName)}`,
            refs: built.refs,
            variable,
            // The renderer's stock 0-300 limits paint most real grids as a flat
            // wash, so fall back to the slice's own robust range when the user
            // left the fields blank.
            clim: clim ?? built.clim ?? undefined,
            colormap,
            bounds: built.bounds,
          });
          appApi.fitBounds?.(built.bounds);
        }
      } else {
        // No opened dataset: a kerchunk manifest, streamed by the Zarr renderer.
        await addCloudNetcdfLayer(appApi, {
          url: url.trim(),
          refs: loadedRefs ?? undefined,
          variable,
          selector: leadingDims.length > 0 ? selector : undefined,
          clim,
          colormap,
        });
      }
      if (gen !== opGen.current) return; // dialog was closed/reopened
      onOpenChange(false);
      reset();
    } catch (err) {
      if (gen !== opGen.current) return;
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
            <Boxes className="h-4 w-4" />
            {t("addData.netcdf.title")}
          </DialogTitle>
          <DialogDescription>{t("addData.netcdf.description")}</DialogDescription>
        </DialogHeader>

        <form className="space-y-4" onSubmit={handleSubmit}>
          {/* The title/description and the local-file cohort of strings added
              here are routed through t(). The older Cloud-URL prose (kerchunk
              URL label, variable/color inputs, buttons) predates the Add Data
              i18n catalog and remains English pre-existing debt, out of scope
              for this change. */}
          <div className="space-y-1.5">
            <Label htmlFor="netcdf-source">{t("addData.netcdf.sourceLabel")}</Label>
            <Select
              id="netcdf-source"
              value={source}
              onChange={(event) => {
                // Reset the loaded-manifest/file state, but keep any typed URL
                // so switching to "Local file" and back doesn't discard it.
                invalidateLoadedSource();
                setSource(event.target.value as "url" | "file");
              }}
            >
              <option value="url">{t("addData.netcdf.sourceCloud")}</option>
              <option value="file">{t("addData.netcdf.sourceLocal")}</option>
            </Select>
          </div>

          {source === "url" ? (
            <>
              <SampleDataSelect
                samples={[{ label: t("addData.netcdf.sampleLabel"), value: SAMPLE_URL }]}
                onSelect={(sampleUrl) => {
                  invalidateLoadedSource();
                  setUrl(sampleUrl);
                }}
              />
              <div className="space-y-1.5">
                <Label htmlFor="netcdf-url">{t("addData.netcdf.kerchunkUrlLabel")}</Label>
                <div className="grid gap-2 sm:grid-cols-[1fr_auto]">
                  <Input
                    id="netcdf-url"
                    placeholder="https://example.com/data.kerchunk.json"
                    value={url}
                    onChange={(event) => {
                      invalidateLoadedSource();
                      setUrl(event.target.value);
                    }}
                  />
                  <Button
                    type="button"
                    variant="outline"
                    onClick={handleLoadVariables}
                    disabled={!url.trim() || loadingVars}
                  >
                    {loadingVars ? t("addData.netcdf.loading") : t("addData.netcdf.loadVariables")}
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  {t("addData.netcdf.kerchunkUrlHelp")}
                </p>
              </div>
            </>
          ) : (
            <div className="space-y-1.5">
              <Label>{t("addData.netcdf.localFileLabel")}</Label>
              <Button
                type="button"
                variant="outline"
                onClick={handleChooseLocalFile}
                disabled={loadingVars}
              >
                <FileUp className="me-2 h-3.5 w-3.5" />
                {loadingVars
                  ? t("addData.netcdf.readingFile")
                  : fileName
                    ? t("addData.netcdf.chooseDifferentFile")
                    : t("addData.common.chooseFile")}
              </Button>
              {fileName && <p className="text-xs text-muted-foreground">{fileName}</p>}
              <p className="text-xs text-muted-foreground">{t("addData.netcdf.localFileHelp")}</p>
            </div>
          )}

          {variables.length > 0 && (
            <div className="space-y-1.5">
              <Label htmlFor="netcdf-variable">{t("addData.netcdf.variableLabel")}</Label>
              <Select
                id="netcdf-variable"
                value={variable}
                onChange={(event) => {
                  setVariable(event.target.value);
                  void selectVariable(event.target.value, openFileRef.current);
                }}
              >
                {variables.map((item) => (
                  <option key={item.name} value={item.name}>
                    {item.dims.length > 0
                      ? `${item.name} (${item.dims.join(", ")})`
                      : `${item.name} [${item.shape.join("×")}]`}
                  </option>
                ))}
              </Select>
            </div>
          )}

          {canComposeRgb && (
            <div className="space-y-1.5">
              <Label htmlFor="netcdf-mode">{t("addData.netcdf.bandCombinationLabel")}</Label>
              <Select
                id="netcdf-mode"
                value={mode}
                onChange={(event) => setMode(event.target.value as RenderMode)}
              >
                <option value="single">{t("addData.netcdf.modeSingleBand")}</option>
                <option value="rgb">{t("addData.netcdf.modeRgb")}</option>
              </Select>
              <p className="text-xs text-muted-foreground">
                {t("addData.netcdf.bandCombinationHelp")}
              </p>
            </div>
          )}

          {rgbMode &&
            rgbAxis &&
            (["red", "green", "blue"] as const).map((channel, index) => (
              <div className="space-y-1.5" key={channel}>
                <Label htmlFor={`netcdf-rgb-${channel}`}>
                  {t(`addData.netcdf.channel.${channel}`)}
                </Label>
                <AxisSelect
                  id={`netcdf-rgb-${channel}`}
                  axis={rgbAxis}
                  value={String(rgbBands[index])}
                  onChange={(next) =>
                    setRgbBands((prev) => {
                      const updated = [...prev] as [number, number, number];
                      updated[index] = Math.max(
                        0,
                        Math.min(rgbAxis.size - 1, Math.trunc(Number(next) || 0)),
                      );
                      return updated;
                    })
                  }
                />
              </div>
            ))}

          {/* Every leading dimension the channels do not already fix. In RGB
              mode handleSubmit still reads dimIndex for these, so hiding them
              would pin e.g. a cube's time step at index 0 with no way to change
              it. */}
          {leadingDims
            .filter((dim) => !(rgbMode && rgbAxis?.name === dim))
            .map((dim) => {
              const axis = axes.find((item) => item.name === dim);
              return (
                <div className="space-y-1.5" key={dim}>
                  <Label htmlFor={`netcdf-dim-${dim}`}>
                    {t("addData.netcdf.dimIndexLabel", { dim })}
                  </Label>
                  {axis ? (
                    <AxisSelect
                      id={`netcdf-dim-${dim}`}
                      axis={axis}
                      value={dimIndex[dim] ?? "0"}
                      onChange={(next) => setDimIndex((prev) => ({ ...prev, [dim]: next }))}
                    />
                  ) : (
                    <Input
                      id={`netcdf-dim-${dim}`}
                      inputMode="numeric"
                      placeholder="0"
                      value={dimIndex[dim] ?? ""}
                      onChange={(event) =>
                        setDimIndex((prev) => ({
                          ...prev,
                          [dim]: event.target.value,
                        }))
                      }
                    />
                  )}
                </div>
              );
            })}

          {variables.length > 0 && !rgbMode && (
            <div className="space-y-1.5">
              <Label htmlFor="netcdf-colormap">{t("addData.netcdf.colormapLabel")}</Label>
              <ColorRampSelect
                id="netcdf-colormap"
                aria-label={t("addData.netcdf.colormapLabel")}
                value={colormap}
                ramps={rampOptions}
                onValueChange={setColormap}
              />
            </div>
          )}

          {variables.length > 0 && !rgbMode && (
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="netcdf-clim-min">{t("addData.netcdf.colorMin")}</Label>
                <Input
                  id="netcdf-clim-min"
                  inputMode="decimal"
                  value={climMin}
                  onChange={(event) => setClimMin(event.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="netcdf-clim-max">{t("addData.netcdf.colorMax")}</Label>
                <Input
                  id="netcdf-clim-max"
                  inputMode="decimal"
                  value={climMax}
                  onChange={(event) => setClimMax(event.target.value)}
                />
              </div>
            </div>
          )}

          {error && <p className="text-sm text-destructive">{error}</p>}
          {status && !error && <p className="text-sm text-muted-foreground">{status}</p>}

          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                reset();
                onOpenChange(false);
              }}
            >
              {t("common.cancel")}
            </Button>
            <Button type="submit" disabled={!variable || adding}>
              {adding ? t("addData.netcdf.adding") : t("addData.netcdf.addLayer")}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * A picker for one index along a non-spatial axis, labelled with the axis' own
 * coordinate values when the file has them — so a hyperspectral cube reads as
 * "650.4 nm (band 47)" rather than a bare number the user has to look up.
 *
 * Falls back to a number box for an axis with no coordinate variable or with
 * more entries than a `<select>` can carry (see {@link MAX_AXIS_OPTIONS}).
 */
function AxisSelect({
  axis,
  id,
  onChange,
  value,
}: {
  axis: LocalNetcdfAxis;
  id: string;
  onChange: (value: string) => void;
  value: string;
}) {
  if (!axis.values || axis.size > MAX_AXIS_OPTIONS) {
    return (
      <Input
        id={id}
        inputMode="numeric"
        placeholder="0"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    );
  }
  return (
    <Select id={id} value={value} onChange={(event) => onChange(event.target.value)}>
      {axis.values.map((coordinate, index) => (
        <option key={index} value={String(index)}>
          {axisOptionLabel(axis, coordinate, index)}
        </option>
      ))}
    </Select>
  );
}
