import { Button, Input, Label, Select } from "@geolibre/ui";
import { FileUp, Layers } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  type CadLayerInfo,
  type DuckDbVectorFile,
  loadDuckDbVectorFile,
  readCadLayers,
} from "../../../../lib/duckdb-vector-loader";
import { openLocalDataFileWithFallback } from "../../../../lib/tauri-io";
import { CAD_CRS_PRESETS } from "../constants";
import {
  createBaseLayer,
  errorMessage,
  fileNameFromPath,
  layerNameFromPath,
} from "../helpers";
import { AddDataSourceForm, useAddDataSource } from "../shared";

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
 * Normalize a user-entered CRS into the `AUTHORITY:CODE` form `ST_Transform`
 * expects: a bare number becomes `EPSG:<n>`, an `epsg:4326` is upper-cased, and
 * an already-qualified `ESRI:102100` passes through. A blank stays blank (load
 * the drawing as-is, i.e. assume it is already in lon/lat).
 */
function normalizeCrs(raw: string): string {
  const value = raw.trim();
  if (!value) return "";
  if (/^\d+$/.test(value)) return `EPSG:${value}`;
  return value.toUpperCase();
}

/** True when DuckDB rejected the layer's geometry (mixed / Geometry Collection). */
function isUnsupportedGeometryError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /unsupported geometry type/i.test(message);
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
  const [selectedFile, setSelectedFile] = useState<SelectedCadFile | null>(
    null,
  );
  const [layers, setLayers] = useState<CadLayerInfo[]>([]);
  const [selectedLayer, setSelectedLayer] = useState("");
  const [crs, setCrs] = useState("");
  const [isReadingLayers, setIsReadingLayers] = useState(false);

  // `registerFileBuffer` transfers the bytes to the DuckDB worker, which
  // detaches the backing ArrayBuffer. The file is read twice (the layer probe,
  // then the load), so hand DuckDB a fresh copy each time (`slice(0)`) and keep
  // the original intact for the next call.
  const buildVectorFile = (file: SelectedCadFile): DuckDbVectorFile => ({
    name: fileNameFromPath(file.path),
    extension: extensionFromPath(file.path),
    data: new Uint8Array(file.data.slice(0)),
  });

  const handleChooseFile = async () => {
    source.setError(null);
    try {
      const result = await openLocalDataFileWithFallback({
        filters: [
          { name: t("addData.cad.fileFilter"), extensions: ["dxf", "dwg"] },
        ],
        accept: ".dxf,.dwg",
        readBinary: true,
      });
      if (!result) return;
      if (!result.data) throw new Error(t("addData.cad.readError"));
      const file: SelectedCadFile = { path: result.path, data: result.data };
      setSelectedFile(file);
      setLayers([]);
      setSelectedLayer("");
      source.setLayerName((current) =>
        current.trim() && current !== defaultName
          ? current
          : layerNameFromPath(result.path, defaultName),
      );

      // Read the CAD layer list up front so the picker is populated before the
      // user submits (DXF has a single `entities` layer; DWG is multi-layer).
      setIsReadingLayers(true);
      try {
        const cadLayers = await readCadLayers(buildVectorFile(file));
        if (cadLayers.length === 0) {
          throw new Error(t("addData.cad.errorNoLayers"));
        }
        setLayers(cadLayers);
        setSelectedLayer(cadLayers[0].name);
      } finally {
        setIsReadingLayers(false);
      }
    } catch (err) {
      source.setError(errorMessage(err, t("addData.cad.readError")));
    }
  };

  const handleSubmit = source.runSubmit(async () => {
    if (!selectedFile) throw new Error(t("addData.cad.errorChooseFile"));
    if (!selectedLayer) throw new Error(t("addData.cad.errorNoLayer"));

    const name = source.layerName.trim() || defaultName;
    const overrideSourceCrs = normalizeCrs(crs);

    let featureCollection;
    try {
      featureCollection = await loadDuckDbVectorFile(
        buildVectorFile(selectedFile),
        { layer: selectedLayer, overrideSourceCrs },
      );
    } catch (err) {
      if (isUnsupportedGeometryError(err)) {
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
        source.isSubmitting ||
        isReadingLayers ||
        !selectedFile ||
        !selectedLayer
      }
    >
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="outline" onClick={handleChooseFile}>
            <FileUp className="mr-2 h-3.5 w-3.5" />
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
            <Layers className="mr-1 inline h-3.5 w-3.5 align-text-bottom" />
            {t("addData.cad.layer")}
          </Label>
          <Select
            id="cad-layer"
            value={selectedLayer}
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
          <p className="text-xs text-muted-foreground">
            {t("addData.cad.crsHelp")}
          </p>
        </div>
      </div>
    </AddDataSourceForm>
  );
}
