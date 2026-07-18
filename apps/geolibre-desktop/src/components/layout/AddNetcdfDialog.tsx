import { useRef, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import {
  addCloudNetcdfLayer,
  listKerchunkVariables,
  loadKerchunkReference,
  openLocalNetcdf,
  type GeoLibreAppAPI,
  type KerchunkRefs,
  type KerchunkVariable,
  type LocalNetcdfFile,
} from "@geolibre/plugins";
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
import { Boxes, FileUp } from "lucide-react";
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

/** A renderable variable, shared shape across the cloud and local readers. */
type RenderableVariable = KerchunkVariable;

interface AddNetcdfDialogProps {
  open: boolean;
  appApi: GeoLibreAppAPI;
  onOpenChange: (open: boolean) => void;
}

/**
 * Dialog for adding a NetCDF/HDF5 layer. Two sources are supported: a remote
 * Cloud-Optimized NetCDF via a kerchunk reference URL (read over HTTP range
 * requests), or a local HDF5/NetCDF-4 file decoded in-browser with h5wasm. In
 * both cases the user picks a renderable variable (and any leading dimension
 * index), and the layer renders through the shared Zarr control.
 */
export function AddNetcdfDialog({ open, appApi, onOpenChange }: AddNetcdfDialogProps) {
  const { t } = useTranslation();
  const [source, setSource] = useState<"url" | "file">("url");
  const [url, setUrl] = useState("");
  // The local file opened in the WASM filesystem, kept between "Load variables"
  // and submit so the (potentially large) decode happens once. Closed on reset.
  const [localFile, setLocalFile] = useState<LocalNetcdfFile | null>(null);
  const [fileName, setFileName] = useState("");
  const [variables, setVariables] = useState<RenderableVariable[]>([]);
  const [variable, setVariable] = useState("");
  // The normalized reference from the last successful URL load, reused on submit
  // so the (potentially large) manifest is not fetched a second time.
  const [loadedRefs, setLoadedRefs] = useState<KerchunkRefs | null>(null);
  const [dimIndex, setDimIndex] = useState<Record<string, string>>({});
  const [climMin, setClimMin] = useState("");
  const [climMax, setClimMax] = useState("");
  const [loadingVars, setLoadingVars] = useState(false);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  // Incremented on every reset; lets in-flight async handlers detect that the
  // dialog was closed/reopened and bail out before stomping fresh state.
  const opGen = useRef(0);
  // Holds the currently-open local file so it can be closed synchronously on
  // reset even if the latest setLocalFile has not flushed to state yet.
  const openFileRef = useRef<LocalNetcdfFile | null>(null);

  const selectedVar = variables.find((v) => v.name === variable);
  // Dimensions other than the trailing two (lat/lon) need a fixed index.
  const leadingDims = selectedVar
    ? selectedVar.dims.slice(0, Math.max(0, selectedVar.dims.length - 2))
    : [];

  const closeOpenFile = () => {
    openFileRef.current?.close();
    openFileRef.current = null;
  };

  const reset = () => {
    opGen.current += 1;
    closeOpenFile();
    setSource("url");
    setUrl("");
    setLocalFile(null);
    setFileName("");
    setVariables([]);
    setVariable("");
    setLoadedRefs(null);
    setDimIndex({});
    setClimMin("");
    setClimMax("");
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
    setLocalFile(null);
    setFileName("");
    setVariables([]);
    setVariable("");
    setLoadedRefs(null);
    setDimIndex({});
    setClimMin("");
    setClimMax("");
    setStatus(null);
    setError(null);
    setLoadingVars(false);
    setAdding(false);
  };

  const applyLoadedVariables = (vars: RenderableVariable[]) => {
    setVariables(vars);
    setVariable(vars[0].name);
    setStatus(`Found ${vars.length} variable${vars.length > 1 ? "s" : ""}.`);
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
      const refs = await loadKerchunkReference(url.trim());
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
      openFileRef.current = file;
      setLocalFile(file);
      applyLoadedVariables(vars);
    } catch (err) {
      // Close the just-opened handle unless it was stored for later use.
      if (file && openFileRef.current !== file) file.close();
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

      if (source === "file") {
        const file = localFile;
        if (!file) throw new Error(t("addData.netcdf.errorNoFile"));
        // Yield once so the "Adding..." state paints before the synchronous,
        // CPU-heavy decode/base64-encode of a potentially large local grid.
        await new Promise((resolve) => setTimeout(resolve, 0));
        const { refs } = file.buildLayerRefs(variable, selector);
        // Use just the file's base name (fileName is a full path on desktop) so
        // the derived layer name is clean on every platform. Encode it so a name
        // with URL-special chars (#, ?, %) survives layerNameFromUrl's new
        // URL(...) parse; that helper decodes it again for the display name.
        const baseName = fileName.split(/[\\/]/).pop() || "netcdf";
        await addCloudNetcdfLayer(appApi, {
          url: `local:${encodeURIComponent(baseName)}`,
          refs,
          variable,
          clim,
        });
      } else {
        await addCloudNetcdfLayer(appApi, {
          url: url.trim(),
          refs: loadedRefs ?? undefined,
          variable,
          selector: leadingDims.length > 0 ? selector : undefined,
          clim,
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
                <Label htmlFor="netcdf-url">Kerchunk reference URL</Label>
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
                    {loadingVars ? "Loading..." : "Load variables"}
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  Choose a sample dataset above, or paste your own kerchunk reference URL, then
                  click Load variables.
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
              <Label htmlFor="netcdf-variable">Variable</Label>
              <Select
                id="netcdf-variable"
                value={variable}
                onChange={(event) => setVariable(event.target.value)}
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

          {leadingDims.map((dim) => (
            <div className="space-y-1.5" key={dim}>
              <Label htmlFor={`netcdf-dim-${dim}`}>{dim} index</Label>
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
            </div>
          ))}

          {variables.length > 0 && (
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="netcdf-clim-min">Color min (optional)</Label>
                <Input
                  id="netcdf-clim-min"
                  inputMode="decimal"
                  value={climMin}
                  onChange={(event) => setClimMin(event.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="netcdf-clim-max">Color max (optional)</Label>
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
              Cancel
            </Button>
            <Button type="submit" disabled={!variable || adding}>
              {adding ? "Adding..." : "Add layer"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
