import { Button, Input, Label, Select } from "@geolibre/ui";
import { FileUp, Layers } from "lucide-react";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  type CadLayerInfo,
  type DuckDbVectorFile,
  loadDuckDbVectorFile,
  readCadLayers,
} from "../../../../lib/duckdb-vector-loader";
import { openLocalDataFileWithFallback } from "../../../../lib/tauri-io";
import { CAD_CRS_PRESETS, CAD_SAMPLES } from "../constants";
import {
  createBaseLayer,
  errorMessage,
  fileNameFromPath,
  layerNameFromPath,
  normalizeCrs,
} from "../helpers";
import { AddDataSourceForm, SampleDataSelect, useAddDataSource } from "../shared";

interface SelectedCadFile {
  path: string;
  data: ArrayBuffer;
}

/** The file extension (lowercased, no dot) of a path, or "" when it has none. */
function extensionFromPath(path: string): string {
  const match = /\.([^.\\/]+)$/.exec(fileNameFromPath(path));
  return match ? match[1].toLowerCase() : "";
}

/**
 * True when DuckDB rejected the layer's geometry (a mixed / Geometry Collection
 * layer it cannot decode to WKB). Matches the known DuckDB 1.5.x wording plus
 * close variants so a minor message change does not silently leak the raw error;
 * the caller also logs the original for DevTools.
 */
function isUnsupportedGeometryError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /unsupported geometry|unknown geometry|geometry collection|geometry type in wkb/i.test(
    message,
  );
}

/**
 * Add Data source for AutoCAD DXF/DWG drawings. CAD files carry no coordinate
 * reference system and are usually multi-layer, so this dialog lets the user
 * pick which OGR layer to load and declare its source CRS; the geometry is read
 * with DuckDB-WASM's GDAL `CAD`/`DXF` driver and reprojected to WGS84.
 */
export function CadSource() {
  const { t } = useTranslation();
  const [defaultName] = useState(() => t("addData.cad.defaultName"));
  const source = useAddDataSource(defaultName);
  const [selectedFile, setSelectedFile] = useState<SelectedCadFile | null>(null);
  const [layers, setLayers] = useState<CadLayerInfo[]>([]);
  // `null` = nothing chosen yet; "" is a real selection (an unnamed OGR layer,
  // which ST_Read reads as the first layer), so the two must stay distinct.
  const [selectedLayer, setSelectedLayer] = useState<string | null>(null);
  const [crs, setCrs] = useState("");
  const [isReadingLayers, setIsReadingLayers] = useState(false);
  // Bumped on every file pick / sample load so a slow probe that resolves after
  // a newer one cannot overwrite the newer file's layers (stale-result guard).
  const loadSeq = useRef(0);

  // `registerFileBuffer` transfers the bytes to the DuckDB worker, which
  // detaches the backing ArrayBuffer. The file is read twice (the layer probe,
  // then the load), so hand DuckDB a fresh copy each time (`slice(0)`) and keep
  // the original intact for the next call.
  const buildVectorFile = (file: SelectedCadFile): DuckDbVectorFile => ({
    name: fileNameFromPath(file.path),
    extension: extensionFromPath(file.path),
    data: new Uint8Array(file.data.slice(0)),
  });

  // Shared by the file picker and the sample loader: stash the bytes, default
  // the layer name, then read the CAD layer list up front so the picker is
  // populated before the user submits (DXF has a single `entities` layer; DWG
  // is multi-layer). `requestId` is captured by the caller; a probe that the
  // user has since superseded bails out before touching state. The caller owns
  // the `isReadingLayers` flag (so the fetch in `handleSelectSample` is covered
  // too) — this helper never toggles it.
  const applyCadBytes = async (requestId: number, path: string, data: ArrayBuffer) => {
    const file: SelectedCadFile = { path, data };
    setSelectedFile(file);
    setLayers([]);
    setSelectedLayer(null);
    source.setLayerName((current) =>
      current.trim() && current !== defaultName ? current : layerNameFromPath(path, defaultName),
    );

    const cadLayers = await readCadLayers(buildVectorFile(file));
    if (requestId !== loadSeq.current) return; // superseded by a newer load
    if (cadLayers.length === 0) {
      throw new Error(t("addData.cad.errorNoLayers"));
    }
    setLayers(cadLayers);
    setSelectedLayer(cadLayers[0].name);
  };

  const handleChooseFile = async () => {
    source.setError(null);
    const result = await openLocalDataFileWithFallback({
      filters: [{ name: t("addData.cad.fileFilter"), extensions: ["dxf", "dwg"] }],
      accept: ".dxf,.dwg",
      readBinary: true,
    }).catch((err: unknown) => {
      source.setError(errorMessage(err, t("addData.cad.readError")));
      return null;
    });
    if (!result) return;

    const requestId = ++loadSeq.current;
    setIsReadingLayers(true);
    try {
      if (!result.data) throw new Error(t("addData.cad.readError"));
      await applyCadBytes(requestId, result.path, result.data);
    } catch (err) {
      if (requestId === loadSeq.current) {
        source.setError(errorMessage(err, t("addData.cad.readError")));
      }
    } finally {
      if (requestId === loadSeq.current) setIsReadingLayers(false);
    }
  };

  const handleSelectSample = async (sample: (typeof CAD_SAMPLES)[number]) => {
    source.setError(null);
    const requestId = ++loadSeq.current;
    setIsReadingLayers(true); // cover the fetch too, not just the layer read
    try {
      const response = await fetch(sample.url);
      if (!response.ok) {
        throw new Error(t("addData.common.requestFailed", { status: response.status }));
      }
      const data = await response.arrayBuffer();
      if (requestId !== loadSeq.current) return; // a newer load started
      setCrs(sample.crs);
      // Parse the path off the URL so a query string/fragment can't leak into
      // the filename (and thus the extension detection).
      const filename = new URL(sample.url).pathname.split("/").pop() || "sample.dxf";
      await applyCadBytes(requestId, filename, data);
    } catch (err) {
      if (requestId === loadSeq.current) {
        source.setError(errorMessage(err, t("addData.cad.readError")));
      }
    } finally {
      if (requestId === loadSeq.current) setIsReadingLayers(false);
    }
  };

  const handleSubmit = source.runSubmit(async () => {
    if (!selectedFile) throw new Error(t("addData.cad.errorChooseFile"));
    // `selectedLayer === ""` is a valid choice (unnamed layer); only `null`
    // means nothing has been picked.
    if (selectedLayer === null) throw new Error(t("addData.cad.errorNoLayer"));

    const name = source.layerName.trim() || defaultName;
    const overrideSourceCrs = normalizeCrs(crs);

    let featureCollection;
    try {
      featureCollection = await loadDuckDbVectorFile(buildVectorFile(selectedFile), {
        layer: selectedLayer,
        overrideSourceCrs,
      });
    } catch (err) {
      if (isUnsupportedGeometryError(err)) {
        // Keep the raw cause in DevTools while showing the friendly message.
        console.warn("[GeoLibre] CAD layer geometry could not be decoded", err);
        throw new Error(t("addData.cad.errorUnsupportedGeometry"));
      }
      throw err;
    }

    source.addAndClose(
      {
        ...createBaseLayer(
          name,
          "geojson",
          { type: "geojson" },
          {
            sourceKind: "cad",
            cadLayer: selectedLayer,
            sourceCrs: overrideSourceCrs || null,
            featureCount: featureCollection.features.length,
          },
        ),
        geojson: featureCollection,
        sourcePath: selectedFile.path,
      },
      { fit: true },
    );
  });

  return (
    <AddDataSourceForm
      layerName={source.layerName}
      onLayerNameChange={source.setLayerName}
      beforeLayerId={source.beforeLayerId}
      onBeforeLayerIdChange={source.setBeforeLayerId}
      onSubmit={handleSubmit}
      error={source.error}
      submitDisabled={
        source.isSubmitting || isReadingLayers || !selectedFile || selectedLayer === null
      }
    >
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={handleChooseFile}
            disabled={isReadingLayers || source.isSubmitting}
          >
            <FileUp className="me-2 h-3.5 w-3.5" />
            {t("addData.common.chooseFile")}
          </Button>
          <span className="min-w-0 truncate text-xs text-muted-foreground">
            {selectedFile
              ? fileNameFromPath(selectedFile.path)
              : t("addData.common.noFileSelected")}
          </span>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="cad-layer">
            <Layers className="me-1 inline h-3.5 w-3.5 align-text-bottom" />
            {t("addData.cad.layer")}
          </Label>
          <Select
            id="cad-layer"
            value={selectedLayer ?? ""}
            disabled={isReadingLayers || layers.length === 0}
            onChange={(event) => setSelectedLayer(event.target.value)}
          >
            {layers.length === 0 ? (
              <option value="">
                {isReadingLayers
                  ? t("addData.cad.readingLayers")
                  : t("addData.cad.layerPlaceholder")}
              </option>
            ) : (
              layers.map((layer) => (
                <option key={layer.name} value={layer.name}>
                  {t("addData.cad.layerOption", {
                    name: layer.name || "(unnamed)",
                    type: layer.geometryType || "?",
                    count: layer.featureCount,
                  })}
                </option>
              ))
            )}
          </Select>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="cad-crs">{t("addData.cad.crs")}</Label>
          <Input
            id="cad-crs"
            placeholder={t("addData.cad.crsPlaceholder")}
            value={crs}
            onChange={(event) => setCrs(event.target.value)}
          />
          <Select
            aria-label={t("addData.cad.crsPresetLabel")}
            value=""
            onChange={(event) => {
              if (event.target.value) setCrs(event.target.value);
            }}
          >
            <option value="" disabled>
              {t("addData.cad.crsPresetLabel")}
            </option>
            {CAD_CRS_PRESETS.map((preset) => (
              <option key={preset.value} value={preset.value}>
                {preset.label}
              </option>
            ))}
          </Select>
          <p className="text-xs text-muted-foreground">{t("addData.cad.crsHelp")}</p>
        </div>

        <SampleDataSelect
          samples={CAD_SAMPLES.map((sample) => ({
            label: sample.label,
            value: sample,
          }))}
          onSelect={handleSelectSample}
        />
      </div>
    </AddDataSourceForm>
  );
}
