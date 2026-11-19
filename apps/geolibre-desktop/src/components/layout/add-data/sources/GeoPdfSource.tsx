import { shouldZoomToNewLayers } from "@geolibre/core";
import { resolveEpsgProjection } from "@geolibre/map/epsg-proj4";
import { Button, Label, Select } from "@geolibre/ui";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { primaryViewport } from "../../../../lib/geopdf/georef";
import { subscribePendingGeoPdf, takePendingGeoPdf } from "../../../../lib/geopdf/pending";
import { PdfReadError } from "../../../../lib/geopdf/pdf-objects";
import {
  GeoPdfNotGeoreferencedError,
  openGeoPdf,
  renderGeoPdfPage,
  type OpenedGeoPdf,
} from "../../../../lib/geopdf/render";
import { openLocalDataFileWithFallback } from "../../../../lib/tauri-io";
import { createBaseLayer, fileNameFromPath, layerNameFromPath } from "../helpers";
import { AddDataSourceForm, useAddDataSource } from "../shared";

/** Resolve an EPSG code to a PROJ definition through the bundled tables. */
async function epsgDefinition(code: number): Promise<string | null> {
  return (await resolveEpsgProjection(code))?.definition ?? null;
}

/**
 * GeoPDF: a georeferenced PDF map sheet (Avenza, USGS, GDAL/QGIS, ArcGIS, or a
 * GeoLibre Print Layout export) becomes an image layer placed by its map
 * frame. When the PDF has layers, the user picks which to include (GH #3523).
 */
export function GeoPdfSource() {
  const { t } = useTranslation();
  const source = useAddDataSource(t("addData.geopdf.defaultName"));
  const [opened, setOpened] = useState<OpenedGeoPdf | null>(null);
  const [fileName, setFileName] = useState("");
  const [pageIndex, setPageIndex] = useState(0);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  // Other PDFs dropped with this one: the form opens one at a time.
  const [skipped, setSkipped] = useState<string[]>([]);
  const openedRef = useRef<OpenedGeoPdf | null>(null);
  // The document an Add is rendering: it must outlive being replaced until the
  // render finishes, or destroying it aborts the import.
  const renderingRef = useRef<OpenedGeoPdf | null>(null);
  // Bumped per load, so a load overtaken by a newer file releases its document.
  const loadGenerationRef = useRef(0);
  // False once the form unmounts, so a load finishing later releases its
  // document. Set again on mount: StrictMode remounts the form in development.
  const mountedRef = useRef(true);
  const { setLayerName, setError } = source;

  // Release pdf.js when another file replaces this one or the form unmounts.
  useEffect(() => {
    const previous = openedRef.current;
    openedRef.current = opened;
    if (previous && previous !== opened && previous !== renderingRef.current) {
      void previous.destroy();
    }
  }, [opened]);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (openedRef.current !== renderingRef.current) void openedRef.current?.destroy();
      // A render still running destroys its document when it finishes.
      openedRef.current = null;
    };
  }, []);

  const describeError = (error: unknown): string => {
    if (error instanceof GeoPdfNotGeoreferencedError)
      return t("addData.geopdf.errorNotGeoreferenced");
    if (error instanceof PdfReadError)
      return t("addData.geopdf.errorRead", { message: error.message });
    return error instanceof Error ? error.message : String(error);
  };

  const load = async (bytes: Uint8Array, path: string) => {
    const generation = ++loadGenerationRef.current;
    setLoading(true);
    setError(null);
    try {
      const next = await openGeoPdf(bytes);
      if (generation !== loadGenerationRef.current || !mountedRef.current) {
        void next.destroy();
        return;
      }
      setOpened(next);
      setFileName(fileNameFromPath(path));
      setLayerName(layerNameFromPath(path, t("addData.geopdf.defaultName")));
      setPageIndex(next.firstGeoreferencedPage);
      setHidden(new Set(next.layers.filter((layer) => !layer.visible).map((layer) => layer.id)));
    } catch (error) {
      if (generation !== loadGenerationRef.current) return;
      setOpened(null);
      setFileName("");
      setError(describeError(error));
    } finally {
      if (generation === loadGenerationRef.current) setLoading(false);
    }
  };

  // A PDF dropped on the map opens this form with the file already chosen;
  // one dropped while the form is open replaces the current file.
  const loadRef = useRef(load);
  loadRef.current = load;
  useEffect(() => {
    const takePending = () => {
      const pending = takePendingGeoPdf();
      if (!pending) return;
      setSkipped(pending.skipped ?? []);
      void loadRef.current(pending.bytes, pending.name);
    };
    takePending();
    return subscribePendingGeoPdf(takePending);
  }, []);

  const pickFile = async () => {
    try {
      const file = await openLocalDataFileWithFallback({
        filters: [{ name: "GeoPDF", extensions: ["pdf"] }],
        accept: ".pdf,application/pdf",
        binaryExtensions: ["pdf"],
      });
      if (!file?.data) return;
      setSkipped([]);
      await load(new Uint8Array(file.data), file.path);
    } catch (error) {
      setError(describeError(error));
    }
  };

  const handleSubmit = source.runSubmit(async () => {
    if (!opened) throw new Error(t("addData.geopdf.errorNoFile"));
    let rendered;
    renderingRef.current = opened;
    try {
      rendered = await renderGeoPdfPage(opened, pageIndex, hidden, epsgDefinition);
    } catch (error) {
      throw new Error(describeError(error));
    } finally {
      renderingRef.current = null;
      // Replaced (or the form closed) while rendering: release it now.
      if (openedRef.current !== opened) void opened.destroy();
    }
    const name = source.layerName.trim() || t("addData.geopdf.defaultName");
    const layer = createBaseLayer(
      name,
      "image",
      { type: "image", url: rendered.url, coordinates: rendered.coordinates },
      {
        sourceKind: "geopdf",
        sourceFileName: fileName,
        bounds: rendered.bounds,
        geopdfCrs: rendered.crsLabel,
        geopdfPage: pageIndex + 1,
        ...(hidden.size
          ? { geopdfHiddenLayers: opened.layers.filter((l) => hidden.has(l.id)).map((l) => l.name) }
          : {}),
      },
    );
    source.shell.addLayer(layer, source.beforeLayer);
    if (shouldZoomToNewLayers()) source.shell.mapControllerRef.current?.fitBounds(rendered.bounds);
    source.shell.closeDialog();
  });

  const georeferencedPages = opened
    ? opened.pages.filter((page) => primaryViewport(page) !== null).map((page) => page.index)
    : [];

  return (
    <AddDataSourceForm
      layerName={source.layerName}
      onLayerNameChange={source.setLayerName}
      beforeLayerId={source.beforeLayerId}
      onBeforeLayerIdChange={source.setBeforeLayerId}
      onSubmit={handleSubmit}
      error={source.error}
      submitDisabled={source.isSubmitting || loading || !opened}
    >
      <div className="space-y-3">
        <div className="space-y-1.5">
          <Label>{t("addData.geopdf.file")}</Label>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              disabled={loading || source.isSubmitting}
              onClick={() => void pickFile()}
            >
              {t("addData.geopdf.chooseFile")}
            </Button>
            <span className="min-w-0 truncate text-sm text-muted-foreground">
              {loading ? t("addData.geopdf.reading") : fileName || t("addData.geopdf.noFile")}
            </span>
          </div>
          <p className="text-xs text-muted-foreground">{t("addData.geopdf.hint")}</p>
          {skipped.length > 0 && (
            <p className="text-xs text-muted-foreground">
              {t("addData.geopdf.skipped", { names: skipped.join(", ") })}
            </p>
          )}
        </div>

        {opened && georeferencedPages.length > 1 && (
          <div className="space-y-1.5">
            <Label htmlFor="geopdf-page">{t("addData.geopdf.page")}</Label>
            <Select
              id="geopdf-page"
              value={String(pageIndex)}
              onChange={(event) => setPageIndex(Number(event.target.value))}
            >
              {georeferencedPages.map((index) => (
                <option key={index} value={index}>
                  {t("addData.geopdf.pageOption", { page: index + 1, total: opened.pages.length })}
                </option>
              ))}
            </Select>
          </div>
        )}

        {opened && opened.layers.length > 0 && (
          <fieldset className="space-y-1.5">
            <legend className="text-sm font-medium">{t("addData.geopdf.layers")}</legend>
            <div className="max-h-48 space-y-1 overflow-y-auto rounded-md border p-2">
              {opened.layers.map((layer) => (
                <label key={layer.id} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={!hidden.has(layer.id)}
                    onChange={(event) =>
                      setHidden((current) => {
                        const next = new Set(current);
                        if (event.target.checked) next.delete(layer.id);
                        else next.add(layer.id);
                        return next;
                      })
                    }
                  />
                  <span className="min-w-0 truncate">{layer.name}</span>
                </label>
              ))}
            </div>
          </fieldset>
        )}
      </div>
    </AddDataSourceForm>
  );
}
