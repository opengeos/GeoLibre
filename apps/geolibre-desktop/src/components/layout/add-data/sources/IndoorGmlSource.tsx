import { shouldZoomToNewLayers, useAppStore, type GeoLibreLayer } from "@geolibre/core";
import { getLayerBounds } from "@geolibre/map";
import { Button, Input, Label, Select } from "@geolibre/ui";
import type { FeatureCollection } from "geojson";
import { FileUp } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { isGeographicCrs } from "../../../../lib/crs-utils";
import {
  adoptIndoorGmlDetectedCrs,
  indoorGmlCellColorExpression,
  type IndoorGmlCrsOrigin,
  type IndoorGmlLocalOrigin,
} from "../../../../lib/indoorgml-layers";
import {
  parseIndoorGml,
  placeLocalCoordinates,
  type IndoorGmlParseResult,
} from "../../../../lib/indoorgml";
import { reprojectLandXmlCollection } from "../../../../lib/landxml";
import {
  FileTooLargeError,
  openLocalDataFileWithFallback,
} from "../../../../lib/file-io/file-dialogs";
import { COMMON_CRS_PRESETS, INDOORGML_SAMPLES } from "../constants";
import {
  createBaseLayer,
  errorMessage,
  fileNameFromPath,
  layerNameFromPath,
  normalizeCrs,
  proxyFeedRequestUrl,
  readLimitedBody,
} from "../helpers";
import { AddDataSourceForm, SampleDataSelect, useAddDataSource } from "../shared";
import type { IndoorGmlMode } from "../types";

interface SelectedIndoorGml {
  path: string;
  parsed: IndoorGmlParseResult;
}

const INDOORGML_MAX_BYTES = 200 * 1024 * 1024;

function reportIndoorGmlWarnings(parsed: IndoorGmlParseResult): void {
  for (const warning of parsed.warnings) console.warn(`[IndoorGML] ${warning}`);
}

/** The floor picker link every IndoorGML layer gets (all floors shown at first). */
const LEVEL_LINK = { field: "level", mode: "all" as const, level: null };

/**
 * Add an IndoorGML building (issue #3341): its cells as rooms extruded to their
 * real heights, and its navigation graph drawn at its own elevations, all
 * linked to the floor picker by `level`.
 */
export function IndoorGmlSource() {
  const { t } = useTranslation();
  const [defaultName] = useState(() => t("addData.indoorgml.defaultName"));
  const source = useAddDataSource(defaultName);
  const [mode, setMode] = useState<IndoorGmlMode>("url");
  const [url, setUrl] = useState("");
  const [selectedFile, setSelectedFile] = useState<SelectedIndoorGml | null>(null);
  const [sourceCrs, setSourceCrs] = useState("");
  const [sourceCrsOrigin, setSourceCrsOrigin] = useState<IndoorGmlCrsOrigin>(null);
  const [local, setLocal] = useState(false);
  const [localOrigin, setLocalOrigin] = useState<IndoorGmlLocalOrigin>(null);

  /** Switch between URL and file mode and clear file-specific CRS state. */
  const handleModeChange = (next: IndoorGmlMode) => {
    setMode(next);
    setSelectedFile(null);
    setSourceCrs("");
    setSourceCrsOrigin(null);
    setLocal(false);
    setLocalOrigin(null);
  };

  /** Fill the CRS field (or the local option) from what a parsed file says. */
  const adoptDetected = (parsed: IndoorGmlParseResult) => {
    const next = adoptIndoorGmlDetectedCrs(
      { sourceCrs, sourceCrsOrigin, local, localOrigin },
      parsed,
    );
    setSourceCrs(next.sourceCrs);
    setSourceCrsOrigin(next.sourceCrsOrigin);
    setLocal(next.local);
    setLocalOrigin(next.localOrigin ?? null);
  };

  const handleChooseFile = async () => {
    source.setError(null);
    try {
      const result = await openLocalDataFileWithFallback({
        filters: [{ name: "IndoorGML", extensions: ["gml", "xml", "igml"] }],
        accept: ".gml,.xml,.igml",
        readText: true,
        // Refused before reading where the size is known.
        maxBytes: INDOORGML_MAX_BYTES,
      });
      if (!result) return;
      if (!result.text) throw new Error(t("addData.indoorgml.errorFileMissing"));
      const parsed = parseIndoorGml(result.text);
      reportIndoorGmlWarnings(parsed);
      setSelectedFile({ path: result.path, parsed });
      adoptDetected(parsed);
      source.setLayerName((current) =>
        current.trim() && current !== defaultName
          ? current
          : layerNameFromPath(result.path, defaultName),
      );
    } catch (error) {
      source.setError(
        error instanceof FileTooLargeError
          ? t("addData.indoorgml.errorTooLarge")
          : errorMessage(error, t("addData.indoorgml.readError")),
      );
    }
  };

  const readSource = async (): Promise<SelectedIndoorGml> => {
    if (mode === "file") {
      if (!selectedFile) throw new Error(t("addData.indoorgml.errorChooseFile"));
      return selectedFile;
    }
    let sourceUrl: URL;
    try {
      sourceUrl = new URL(url.trim());
    } catch {
      throw new Error(t("addData.indoorgml.errorUrl"));
    }
    if (sourceUrl.protocol !== "http:" && sourceUrl.protocol !== "https:") {
      throw new Error(t("addData.indoorgml.errorUrl"));
    }
    const path = sourceUrl.toString();
    const response = await fetch(proxyFeedRequestUrl(path));
    if (!response.ok) {
      throw new Error(t("addData.common.requestFailed", { status: response.status }));
    }
    let bytes: Uint8Array;
    try {
      bytes = await readLimitedBody(response, INDOORGML_MAX_BYTES);
    } catch (error) {
      if (error instanceof Error && error.message.includes("download limit")) {
        throw new Error(t("addData.indoorgml.errorTooLarge"));
      }
      throw error;
    }
    const parsed = parseIndoorGml(new TextDecoder().decode(bytes));
    reportIndoorGmlWarnings(parsed);
    return { path, parsed };
  };

  const handleSubmit = source.runSubmit(async () => {
    const selected = await readSource();
    const { parsed } = selected;
    const crs = normalizeCrs(sourceCrs || parsed.detectedCrs || "");
    if (!local && !crs && !parsed.coordinatesLookGeographic) {
      throw new Error(t("addData.indoorgml.errorMissingCrs"));
    }
    const collections = [parsed.cells, parsed.transitions, parsed.states];
    let placed: FeatureCollection[];
    if (local) {
      placed = placeLocalCoordinates(collections, useAppStore.getState().mapView.center);
    } else if (crs && !isGeographicCrs(crs)) {
      // Imported only when reprojecting, so the DuckDB loader stays off the
      // startup path. The LandXML helper transforms each distinct vertex once
      // and keeps 2D and 3D positions apart.
      const { reprojectPositionsToWgs84 } = await import("../../../../lib/duckdb-vector-loader");
      placed = await Promise.all(
        collections.map((collection) =>
          reprojectLandXmlCollection(collection, (positions) =>
            reprojectPositionsToWgs84(positions, crs),
          ),
        ),
      );
    } else {
      placed = collections;
    }
    const [cells, transitions, states] = placed;

    const baseName = source.layerName.trim() || defaultName;
    const metadata = {
      sourceKind: "indoorgml",
      sourceCrs: local ? "local" : crs || null,
      levelSource: parsed.levelSource,
      levels: parsed.levels,
    };
    const layers: GeoLibreLayer[] = [];
    const add = (
      name: string,
      geojson: FeatureCollection,
      style: Partial<GeoLibreLayer["style"]>,
      extra: Partial<GeoLibreLayer> = {},
    ) => {
      if (geojson.features.length === 0) return;
      const base = createBaseLayer(
        name,
        "geojson",
        { type: "geojson", url: selected.path },
        { ...metadata, featureCount: geojson.features.length },
        { geojson, pendingLayers: layers },
      );
      layers.push({
        ...base,
        ...extra,
        style: { ...base.style, ...style },
        geojson,
        sourcePath: selected.path,
        ...(parsed.levels.length ? { levelFilter: { ...LEVEL_LINK } } : {}),
      });
    };

    add(t("addData.indoorgml.layer.cells", { name: baseName }), cells, {
      extrusionEnabled: true,
      extrusionHeightProperty: "top_z",
      extrusionHeightScale: 1,
      extrusionBase: 0,
      extrusionBaseProperty: "base_z",
      extrusionBaseScale: 1,
      extrusionFloorHeight: 0,
      extrusionColor: "#93c5fd",
      extrusionOpacity: 0.6,
      extrusionAdvancedStyleEnabled: true,
      extrusionColorExpression: JSON.stringify(indoorGmlCellColorExpression("#93c5fd")),
    });
    add(t("addData.indoorgml.layer.transitions", { name: baseName }), transitions, {
      strokeColor: "#dc2626",
      strokeWidth: 2.5,
      elevation3dEnabled: true,
    });
    add(
      t("addData.indoorgml.layer.states", { name: baseName }),
      states,
      { fillColor: "#dc2626", strokeColor: "#ffffff", circleRadius: 4, elevation3dEnabled: true },
      { visible: false },
    );

    for (const layer of layers) source.shell.addLayer(layer, source.beforeLayer);
    if (shouldZoomToNewLayers()) {
      const bounds = layers
        .map((layer) => getLayerBounds(layer))
        .filter((item): item is [number, number, number, number] => !!item)
        .reduce<[number, number, number, number] | null>(
          (merged, item) =>
            merged
              ? [
                  Math.min(merged[0], item[0]),
                  Math.min(merged[1], item[1]),
                  Math.max(merged[2], item[2]),
                  Math.max(merged[3], item[3]),
                ]
              : item,
          null,
        );
      if (bounds) source.shell.mapControllerRef.current?.fitBounds(bounds);
    }
    source.shell.closeDialog();
  });

  return (
    <AddDataSourceForm
      layerName={source.layerName}
      onLayerNameChange={source.setLayerName}
      beforeLayerId={source.beforeLayerId}
      onBeforeLayerIdChange={source.setBeforeLayerId}
      onSubmit={handleSubmit}
      error={source.error}
      submitDisabled={source.isSubmitting}
    >
      <div className="space-y-3">
        <div className="space-y-1.5">
          <Label htmlFor="indoorgml-mode">{t("addData.common.sourceType")}</Label>
          <Select
            id="indoorgml-mode"
            value={mode}
            onChange={(event) => handleModeChange(event.target.value as IndoorGmlMode)}
          >
            <option value="url">{t("addData.indoorgml.url")}</option>
            <option value="file">{t("addData.indoorgml.file")}</option>
          </Select>
        </div>

        {mode === "file" ? (
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" variant="outline" onClick={handleChooseFile}>
              <FileUp className="me-2 h-3.5 w-3.5" />
              {t("addData.common.chooseFile")}
            </Button>
            <span className="min-w-0 truncate text-xs text-muted-foreground">
              {selectedFile
                ? fileNameFromPath(selectedFile.path)
                : t("addData.common.noFileSelected")}
            </span>
          </div>
        ) : (
          <div className="space-y-1.5">
            <Label htmlFor="indoorgml-url">{t("addData.indoorgml.url")}</Label>
            <Input
              id="indoorgml-url"
              placeholder={t("addData.indoorgml.urlPlaceholder")}
              value={url}
              onChange={(event) => {
                setUrl(event.target.value);
                if (sourceCrsOrigin === "sample") {
                  setSourceCrs("");
                  setSourceCrsOrigin(null);
                }
              }}
            />
          </div>
        )}

        {selectedFile ? (
          <div className="rounded-md border border-border/60 bg-muted/30 p-3 text-xs">
            {t("addData.indoorgml.summary", {
              cells: selectedFile.parsed.cells.features.length,
              floors: selectedFile.parsed.levels.length,
              transitions: selectedFile.parsed.transitions.features.length,
            })}
          </div>
        ) : null}

        <div className="space-y-1.5">
          <Label htmlFor="indoorgml-crs">{t("addData.indoorgml.crs")}</Label>
          <Input
            id="indoorgml-crs"
            value={sourceCrs}
            disabled={local}
            placeholder={t("addData.indoorgml.crsPlaceholder")}
            onChange={(event) => {
              setSourceCrs(event.target.value);
              setSourceCrsOrigin("explicit");
            }}
          />
          <Select
            aria-label={t("addData.indoorgml.crsPresetLabel")}
            value=""
            disabled={local}
            onChange={(event) => {
              if (event.target.value) {
                setSourceCrs(event.target.value);
                setSourceCrsOrigin("explicit");
              }
            }}
          >
            <option value="">{t("addData.indoorgml.crsPresetLabel")}</option>
            {COMMON_CRS_PRESETS.map((preset) => (
              <option key={preset.value} value={preset.value}>
                {preset.label}
              </option>
            ))}
          </Select>
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={local}
              onChange={(event) => {
                setLocal(event.target.checked);
                setLocalOrigin("explicit");
              }}
            />
            <span>{t("addData.indoorgml.local")}</span>
          </label>
          <p className="text-xs text-muted-foreground">{t("addData.indoorgml.crsHelp")}</p>
        </div>

        <SampleDataSelect
          samples={INDOORGML_SAMPLES.map((sample) => ({ label: sample.label, value: sample }))}
          onSelect={(sample) => {
            setMode("url");
            setSelectedFile(null);
            setUrl(sample.url);
            setSourceCrs(sample.crs);
            setSourceCrsOrigin("sample");
            setLocal(false);
            setLocalOrigin(null);
            source.setLayerName((current) =>
              current.trim() && current !== defaultName ? current : sample.name,
            );
          }}
        />
      </div>
    </AddDataSourceForm>
  );
}
