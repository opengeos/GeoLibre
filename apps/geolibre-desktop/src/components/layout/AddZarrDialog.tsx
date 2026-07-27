import { useRef, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import {
  ZarrDirectoryStore,
  ZARR_SAMPLE_DATASETS,
  addZarrRasterLayer,
  createDirectoryZarrLister,
  createDirectoryZarrMetadataReader,
  createHttpZarrMetadataReader,
  createHttpZarrStore,
  localZarrStoreUrl,
  parseZarrSelectorValue,
  readZarrCoordinateValues,
  readZarrStoreMetadata,
  type GeoLibreAppAPI,
  type ZarrCoordinateStore,
  type ZarrCoordinateValues,
  type ZarrDirectoryReader,
  type ZarrStoreVariable,
  type ZarrTimeAttributes,
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
import { Boxes, FolderOpen } from "lucide-react";
import { pickZarrDirectory, zarrDirectoryPickerSupported } from "../../lib/zarr-directory-picker";
import { SampleDataSelect } from "./add-data/shared";

interface AddZarrDialogProps {
  open: boolean;
  appApi: GeoLibreAppAPI;
  onOpenChange: (open: boolean) => void;
}

/** Everything the form learned about the store the user picked. */
interface LoadedStore {
  /** Identifier the layer is added under: the URL, or a `local-zarr:` marker. */
  url: string;
  /** Zarr metadata version, passed to the renderer. */
  version: 2 | 3;
  /** The store's renderable arrays. */
  variables: ZarrStoreVariable[];
  /** A zarrita store for reading coordinate values. */
  coordinateStore: ZarrCoordinateStore;
  /** Present only for a local folder: the store the renderer reads through. */
  reader?: ZarrDirectoryReader;
}

/**
 * Dialog for adding a Zarr layer. Two sources are supported: a remote store over
 * HTTP, or a store in a folder on local disk (the desktop app's folder dialog,
 * or a browser that implements the File System Access API).
 *
 * Once the store is loaded the user picks a variable, and each of its non-spatial
 * dimensions gets its own picker. Those offer the dimension's real coordinate
 * values rather than indices, because that is what the renderer matches on: for
 * a `month` axis of 1-12, December is the *value* 12, not the index 12.
 *
 * The on-map Zarr panel (Controls -> Zarr Layer) remains the place to tweak a
 * layer after the fact; this dialog only opens the store.
 */
export function AddZarrDialog({ open, appApi, onOpenChange }: AddZarrDialogProps) {
  const { t } = useTranslation();
  const [source, setSource] = useState<"url" | "folder">("url");
  const [url, setUrl] = useState("");
  const [folderName, setFolderName] = useState("");
  const [loaded, setLoaded] = useState<LoadedStore | null>(null);
  const [variable, setVariable] = useState("");
  const [coordinates, setCoordinates] = useState<ZarrCoordinateValues>({});
  const [selection, setSelection] = useState<Record<string, string>>({});
  const [climMin, setClimMin] = useState("");
  const [climMax, setClimMax] = useState("");
  const [loading, setLoading] = useState(false);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  // Incremented on every reset; lets an in-flight async handler notice that the
  // dialog was closed or the source replaced, and bail before stomping state.
  const opGen = useRef(0);

  const folderPickerAvailable = zarrDirectoryPickerSupported();
  const selectedVariable = loaded?.variables.find((item) => item.name === variable);
  // Only the trailing two dimensions are spatial, and only a store that declares
  // its dimension names can say which the others are.
  const leadingDims =
    selectedVariable && selectedVariable.dims.length === selectedVariable.shape.length
      ? selectedVariable.dims.slice(0, Math.max(0, selectedVariable.dims.length - 2))
      : [];

  const reset = () => {
    opGen.current += 1;
    setSource("url");
    setUrl("");
    setFolderName("");
    setLoaded(null);
    setVariable("");
    setCoordinates({});
    setSelection({});
    setClimMin("");
    setClimMax("");
    setError(null);
    setStatus(null);
    setLoading(false);
    setAdding(false);
  };

  /** Drop everything tied to the previously loaded store, keeping the typed URL. */
  const invalidateLoadedStore = () => {
    opGen.current += 1;
    setLoaded(null);
    setVariable("");
    setCoordinates({});
    setSelection({});
    setError(null);
    setStatus(null);
    setLoading(false);
    setAdding(false);
  };

  /**
   * Adopt a freshly read store: show its variables, select the first, and read
   * that variable's coordinate values so the dimension pickers can offer them.
   */
  const applyLoadedStore = async (store: LoadedStore, gen: number, preferred?: string) => {
    const first = store.variables.find((item) => item.name === preferred) ?? store.variables[0];
    setLoaded(store);
    setVariable(first.name);
    setStatus(t("addData.zarr.foundVariables", { count: store.variables.length }));
    await loadCoordinates(store, first, gen);
  };

  const loadCoordinates = async (
    store: LoadedStore,
    item: ZarrStoreVariable,
    gen: number,
  ): Promise<void> => {
    const dims =
      item.dims.length === item.shape.length
        ? item.dims.slice(0, Math.max(0, item.dims.length - 2))
        : [];
    if (dims.length === 0) {
      if (gen === opGen.current) {
        setCoordinates({});
        setSelection({});
      }
      return;
    }
    const values = await readZarrCoordinateValues(store.coordinateStore, item.path, dims);
    if (gen !== opGen.current) return;
    setCoordinates(values);
    // Default every dimension to its first coordinate, which is the slice the
    // renderer would have drawn anyway; an unreadable axis starts blank.
    setSelection(
      Object.fromEntries(
        dims.map((dim) => [dim, values[dim]?.length ? String(values[dim][0]) : ""]),
      ),
    );
  };

  const handleVariableChange = (next: string) => {
    setVariable(next);
    const item = loaded?.variables.find((entry) => entry.name === next);
    if (!loaded || !item) return;
    void loadCoordinates(loaded, item, opGen.current);
  };

  const handleLoadUrl = async () => {
    invalidateLoadedStore();
    const gen = opGen.current;
    const trimmed = url.trim();
    setLoading(true);
    try {
      const metadata = await readZarrStoreMetadata(createHttpZarrMetadataReader(trimmed));
      if (gen !== opGen.current) return;
      await applyLoadedStore(
        {
          url: trimmed,
          version: metadata.version,
          variables: metadata.variables,
          coordinateStore: await createHttpZarrStore(trimmed),
        },
        gen,
        // A sample store names the variable worth showing; a pasted URL does not.
        ZARR_SAMPLE_DATASETS.find((sample) => sample.url === trimmed)?.variable,
      );
    } catch (err) {
      if (gen !== opGen.current) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (gen === opGen.current) setLoading(false);
    }
  };

  const handleChooseFolder = async () => {
    let reader: ZarrDirectoryReader | null;
    try {
      reader = await pickZarrDirectory();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return;
    }
    if (!reader) return; // dialog dismissed

    invalidateLoadedStore();
    const gen = opGen.current;
    setFolderName(reader.name);
    setLoading(true);
    try {
      const metadata = await readZarrStoreMetadata(createDirectoryZarrMetadataReader(reader), {
        listEntries: createDirectoryZarrLister(reader),
      });
      if (gen !== opGen.current) return;
      await applyLoadedStore(
        {
          url: localZarrStoreUrl(reader.name),
          version: metadata.version,
          variables: metadata.variables,
          coordinateStore: new ZarrDirectoryStore(reader),
          reader,
        },
        gen,
      );
    } catch (err) {
      if (gen !== opGen.current) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (gen === opGen.current) setLoading(false);
    }
  };

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!loaded || !variable) return;
    const gen = opGen.current;
    setError(null);
    setAdding(true);
    try {
      const selector: Record<string, number | string> = {};
      for (const dim of leadingDims) {
        const value = parseZarrSelectorValue(selection[dim] ?? "");
        if (value !== null) selector[dim] = value;
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
      const sample = ZARR_SAMPLE_DATASETS.find((item) => item.url === loaded.url);

      await addZarrRasterLayer(appApi, {
        url: loaded.url,
        variable,
        zarrVersion: loaded.version,
        ...(Object.keys(selector).length > 0 ? { selector } : {}),
        ...(clim ? { clim } : sample?.clim ? { clim: sample.clim } : {}),
        ...(sample?.colormap ? { colormap: sample.colormap } : {}),
        ...(loaded.reader
          ? {
              store: new ZarrDirectoryStore(loaded.reader),
              // The store never leaves the machine, so the Time Slider's usual
              // metadata walk over HTTP has nothing to fetch; read the CF units
              // out of the folder instead so a local cube still binds.
              readTimeAttributes: (dimension: string) => readLocalTimeAttributes(loaded, dimension),
            }
          : {}),
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
            {t("addData.zarr.title")}
          </DialogTitle>
          <DialogDescription>{t("addData.zarr.description")}</DialogDescription>
        </DialogHeader>

        <form className="space-y-4" onSubmit={handleSubmit}>
          <div className="space-y-1.5">
            <Label htmlFor="zarr-source">{t("addData.zarr.sourceLabel")}</Label>
            <Select
              id="zarr-source"
              value={source}
              onChange={(event) => {
                // Keep any typed URL, so switching to Local folder and back does
                // not discard it.
                invalidateLoadedStore();
                setFolderName("");
                setSource(event.target.value as "url" | "folder");
              }}
            >
              <option value="url">{t("addData.zarr.sourceRemote")}</option>
              <option value="folder">{t("addData.zarr.sourceFolder")}</option>
            </Select>
          </div>

          {source === "url" ? (
            <>
              <SampleDataSelect
                samples={ZARR_SAMPLE_DATASETS.map((sample) => ({
                  label: t(`addData.zarr.sample.${sample.id}`, sample.label),
                  value: sample.url,
                }))}
                onSelect={(sampleUrl) => {
                  invalidateLoadedStore();
                  setUrl(sampleUrl);
                }}
              />
              <div className="space-y-1.5">
                <Label htmlFor="zarr-url">{t("addData.zarr.urlLabel")}</Label>
                <div className="grid gap-2 sm:grid-cols-[1fr_auto]">
                  <Input
                    id="zarr-url"
                    placeholder="https://example.com/data.zarr"
                    value={url}
                    onChange={(event) => {
                      invalidateLoadedStore();
                      setUrl(event.target.value);
                    }}
                  />
                  <Button
                    type="button"
                    variant="outline"
                    onClick={handleLoadUrl}
                    disabled={!url.trim() || loading}
                  >
                    {loading ? t("addData.zarr.loading") : t("addData.zarr.loadVariables")}
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">{t("addData.zarr.urlHelp")}</p>
              </div>
            </>
          ) : (
            <div className="space-y-1.5">
              <Label>{t("addData.zarr.folderLabel")}</Label>
              <Button
                type="button"
                variant="outline"
                onClick={handleChooseFolder}
                disabled={loading || !folderPickerAvailable}
              >
                <FolderOpen className="me-2 h-3.5 w-3.5" />
                {loading
                  ? t("addData.zarr.readingFolder")
                  : folderName
                    ? t("addData.zarr.chooseDifferentFolder")
                    : t("addData.zarr.chooseFolder")}
              </Button>
              {folderName && <p className="text-xs text-muted-foreground">{folderName}</p>}
              <p className="text-xs text-muted-foreground">
                {folderPickerAvailable
                  ? t("addData.zarr.folderHelp")
                  : t("addData.zarr.folderUnsupported")}
              </p>
            </div>
          )}

          {loaded && (
            <div className="space-y-1.5">
              <Label htmlFor="zarr-variable">{t("addData.zarr.variableLabel")}</Label>
              <Select
                id="zarr-variable"
                value={variable}
                onChange={(event) => handleVariableChange(event.target.value)}
              >
                {loaded.variables.map((item) => (
                  <option key={item.name} value={item.name}>
                    {item.dims.length > 0
                      ? `${item.name} (${item.dims.join(", ")})`
                      : `${item.name} [${item.shape.join("×")}]`}
                  </option>
                ))}
              </Select>
            </div>
          )}

          {leadingDims.map((dim) => {
            const values = coordinates[dim];
            return (
              <div className="space-y-1.5" key={dim}>
                <Label htmlFor={`zarr-dim-${dim}`}>{t("addData.zarr.dimLabel", { dim })}</Label>
                {values && values.length > 0 ? (
                  <Select
                    id={`zarr-dim-${dim}`}
                    value={selection[dim] ?? ""}
                    onChange={(event) =>
                      setSelection((prev) => ({ ...prev, [dim]: event.target.value }))
                    }
                  >
                    {values.map((value) => (
                      <option key={String(value)} value={String(value)}>
                        {String(value)}
                      </option>
                    ))}
                  </Select>
                ) : (
                  <>
                    <Input
                      id={`zarr-dim-${dim}`}
                      value={selection[dim] ?? ""}
                      onChange={(event) =>
                        setSelection((prev) => ({ ...prev, [dim]: event.target.value }))
                      }
                    />
                    <p className="text-xs text-muted-foreground">
                      {t("addData.zarr.dimValueHelp")}
                    </p>
                  </>
                )}
              </div>
            );
          })}

          {loaded && (
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="zarr-clim-min">{t("addData.zarr.colorMin")}</Label>
                <Input
                  id="zarr-clim-min"
                  inputMode="decimal"
                  value={climMin}
                  onChange={(event) => setClimMin(event.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="zarr-clim-max">{t("addData.zarr.colorMax")}</Label>
                <Input
                  id="zarr-clim-max"
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
            <Button type="submit" disabled={!loaded || !variable || adding}>
              {adding ? t("addData.zarr.adding") : t("addData.zarr.addLayer")}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Read a local store's CF `units`/`calendar` for one coordinate, so a cube on
 * disk can still be bound to the Time Slider.
 *
 * @param store - The loaded local store.
 * @param dimension - The coordinate's name, e.g. `"time"`.
 * @returns Its attributes, or null when it declares neither.
 */
async function readLocalTimeAttributes(
  store: LoadedStore,
  dimension: string,
): Promise<ZarrTimeAttributes | null> {
  if (!store.reader) return null;
  const read = createDirectoryZarrMetadataReader(store.reader);
  // Coordinates sit beside the variables, which in a pyramid is one level down.
  for (const prefix of ["", "0/"]) {
    for (const key of [`${prefix}${dimension}/.zattrs`, `${prefix}${dimension}/zarr.json`]) {
      const document = await read(key);
      const attributes = key.endsWith("zarr.json")
        ? (document as { attributes?: unknown } | undefined)?.attributes
        : document;
      if (!attributes || typeof attributes !== "object") continue;
      const record = attributes as Record<string, unknown>;
      const units = typeof record.units === "string" ? record.units : undefined;
      const calendar = typeof record.calendar === "string" ? record.calendar : undefined;
      if (units !== undefined || calendar !== undefined) return { units, calendar };
    }
  }
  return null;
}
