import { useRef, useState, type FormEvent } from "react";
import {
  addCloudNetcdfLayer,
  listKerchunkVariables,
  loadKerchunkReference,
  type GeoLibreAppAPI,
  type KerchunkRefs,
  type KerchunkVariable,
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
import { Boxes } from "lucide-react";

// A real sample: NOAA NCEP/NCAR Reanalysis surface air temperature, stored as a
// Cloud-Optimized NetCDF and served from Source Cooperative (CORS-enabled,
// range-request capable). The reference uses a relative chunk URL, so it
// resolves against the manifest's own location.
const SAMPLE_URL =
  "https://data.source.coop/giswqs/opengeos/netcdf/air-temperature.kerchunk.json";

interface AddNetcdfDialogProps {
  open: boolean;
  appApi: GeoLibreAppAPI;
  onOpenChange: (open: boolean) => void;
}

/**
 * Dialog for adding a Cloud-Optimized NetCDF/HDF5 layer via a kerchunk
 * reference. The user supplies the reference URL, loads its renderable
 * variables, picks one (and any leading dimension index), and the layer is
 * rendered through the shared Zarr control with a kerchunk reference store.
 */
export function AddNetcdfDialog({
  open,
  appApi,
  onOpenChange,
}: AddNetcdfDialogProps) {
  const [url, setUrl] = useState(SAMPLE_URL);
  const [variables, setVariables] = useState<KerchunkVariable[]>([]);
  const [variable, setVariable] = useState("");
  // The normalized reference from the last successful load, reused on submit so
  // the (potentially large) manifest is not fetched a second time.
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

  const selectedVar = variables.find((v) => v.name === variable);
  // Dimensions other than the trailing two (lat/lon) need a fixed index.
  const leadingDims = selectedVar
    ? selectedVar.dims.slice(0, Math.max(0, selectedVar.dims.length - 2))
    : [];

  const reset = () => {
    opGen.current += 1;
    setUrl(SAMPLE_URL);
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

  const handleLoadVariables = async () => {
    const gen = opGen.current;
    setError(null);
    setStatus(null);
    // Clear any prior result so the picker hides and "Add layer" disables while
    // a new URL is loading (avoids submitting a variable from the old manifest).
    setVariables([]);
    setVariable("");
    setLoadedRefs(null);
    setLoadingVars(true);
    try {
      const refs = await loadKerchunkReference(url.trim());
      const vars = listKerchunkVariables(refs);
      if (gen !== opGen.current) return; // dialog was closed/reopened
      if (vars.length === 0) {
        throw new Error(
          "No renderable (2-D or higher) variables found in the reference."
        );
      }
      setVariables(vars);
      setVariable(vars[0].name);
      setLoadedRefs(refs);
      setStatus(`Found ${vars.length} variable${vars.length > 1 ? "s" : ""}.`);
    } catch (err) {
      if (gen !== opGen.current) return;
      setVariables([]);
      setVariable("");
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

      await addCloudNetcdfLayer(appApi, {
        url: url.trim(),
        refs: loadedRefs ?? undefined,
        variable,
        selector: leadingDims.length > 0 ? selector : undefined,
        clim,
      });
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
            Add Cloud-Optimized NetCDF / HDF
          </DialogTitle>
          <DialogDescription>
            Render a NetCDF or HDF5 dataset through a kerchunk reference. The
            data is read directly over HTTP range requests, with no conversion.
          </DialogDescription>
        </DialogHeader>

        <form className="space-y-4" onSubmit={handleSubmit}>
          <div className="space-y-1.5">
            <Label htmlFor="netcdf-url">Kerchunk reference URL</Label>
            <div className="grid gap-2 sm:grid-cols-[1fr_auto]">
              <Input
                id="netcdf-url"
                placeholder="https://example.com/data.kerchunk.json"
                value={url}
                onChange={(event) => {
                  setUrl(event.target.value);
                  // Invalidate variables loaded from a different URL.
                  setVariables([]);
                  setVariable("");
                  setLoadedRefs(null);
                  setStatus(null);
                  setError(null);
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
              Pre-filled with a sample NOAA air-temperature dataset. Click Load
              variables to try it, or paste your own kerchunk reference URL.
            </p>
          </div>

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
          {status && !error && (
            <p className="text-sm text-muted-foreground">{status}</p>
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
