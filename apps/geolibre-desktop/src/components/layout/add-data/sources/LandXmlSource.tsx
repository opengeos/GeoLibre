import type { GeoLibreLayer } from "@geolibre/core";
import { getLayerBounds } from "@geolibre/map";
import { Button, Input, Label, Select } from "@geolibre/ui";
import { FileUp } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { isGeographicCrs } from "../../../../lib/crs-utils";
import { reprojectFeatureCollectionToWgs84 } from "../../../../lib/duckdb-vector-loader";
import {
  parseLandXml,
  type LandXmlLayerKind,
  type LandXmlParseResult,
} from "../../../../lib/landxml";
import { openLocalDataFileWithFallback } from "../../../../lib/tauri-io";
import { COMMON_CRS_PRESETS, LANDXML_SAMPLES } from "../constants";
import {
  createBaseLayer,
  errorMessage,
  fileNameFromPath,
  layerNameFromPath,
  normalizeCrs,
  proxyFeedRequestUrl,
} from "../helpers";
import { AddDataSourceForm, SampleDataSelect, useAddDataSource } from "../shared";
import type { LandXmlMode } from "../types";

interface SelectedLandXml {
  path: string;
  parsed: LandXmlParseResult;
}

/** Add native LandXML TIN surfaces, alignments, profiles, and survey points. */
export function LandXmlSource() {
  const { t } = useTranslation();
  const [defaultName] = useState(() => t("addData.landxml.defaultName"));
  const source = useAddDataSource(defaultName);
  const [landXmlMode, setLandXmlMode] = useState<LandXmlMode>("url");
  const [landXmlUrl, setLandXmlUrl] = useState("");
  const [selectedFile, setSelectedFile] = useState<SelectedLandXml | null>(null);
  const [sourceCrs, setSourceCrs] = useState("");
  const [selectedKinds, setSelectedKinds] = useState<Record<LandXmlLayerKind, boolean>>({
    alignment: true,
    points: true,
    surface: true,
  });

  const hasSelectedKind = Object.values(selectedKinds).some(Boolean);

  const handleModeChange = (mode: LandXmlMode) => {
    setLandXmlMode(mode);
    setSelectedFile(null);
    setSourceCrs("");
  };

  const handleChooseFile = async () => {
    source.setError(null);
    try {
      const result = await openLocalDataFileWithFallback({
        filters: [{ name: "LandXML", extensions: ["xml", "landxml"] }],
        accept: ".xml,.landxml",
        readText: true,
      });
      if (!result) return;
      if (!result.text) throw new Error(t("addData.landxml.errorFileMissing"));
      const parsed = parseLandXml(result.text);
      setSelectedFile({ path: result.path, parsed });
      setSourceCrs(parsed.detectedCrs ?? "");
      source.setLayerName((current) =>
        current.trim() && current !== defaultName
          ? current
          : layerNameFromPath(result.path, defaultName),
      );
    } catch (error) {
      source.setError(errorMessage(error, t("addData.landxml.readError")));
    }
  };

  const readLandXmlSource = async (): Promise<SelectedLandXml> => {
    if (landXmlMode === "file") {
      if (!selectedFile) throw new Error(t("addData.landxml.errorChooseFile"));
      return selectedFile;
    }

    const sourcePath = landXmlUrl.trim();
    if (!sourcePath) throw new Error(t("addData.landxml.errorUrl"));
    const response = await fetch(proxyFeedRequestUrl(sourcePath));
    if (!response.ok) {
      throw new Error(t("addData.common.requestFailed", { status: response.status }));
    }
    return { path: sourcePath, parsed: parseLandXml(await response.text()) };
  };

  const handleSubmit = source.runSubmit(async () => {
    const selectedSource = await readLandXmlSource();
    const selectedLayers = selectedSource.parsed.layers.filter(
      (layer) => selectedKinds[layer.kind],
    );
    if (selectedLayers.length === 0) throw new Error(t("addData.landxml.errorSelectType"));

    const normalizedCrs = normalizeCrs(sourceCrs || selectedSource.parsed.detectedCrs || "");
    if (!normalizedCrs && !selectedSource.parsed.coordinatesLookGeographic) {
      throw new Error(t("addData.landxml.errorMissingCrs"));
    }
    const reprojectionCrs = normalizedCrs && !isGeographicCrs(normalizedCrs) ? normalizedCrs : null;
    const baseName = source.layerName.trim() || defaultName;
    const layers: GeoLibreLayer[] = [];

    for (const parsedLayer of selectedLayers) {
      const geojson = reprojectionCrs
        ? await reprojectFeatureCollectionToWgs84(parsedLayer.features, reprojectionCrs)
        : parsedLayer.features;
      const baseLayer = createBaseLayer(
        `${baseName} ${parsedLayer.name}`,
        "geojson",
        { type: "geojson", url: selectedSource.path },
        {
          sourceKind: "landxml",
          landXmlLayerKind: parsedLayer.kind,
          featureCount: geojson.features.length,
          sourceCrs: normalizedCrs || null,
          coordinateSystem: selectedSource.parsed.coordinateSystem,
          surfaceCount: selectedSource.parsed.surfaceCount,
          alignmentCount: selectedSource.parsed.alignmentCount,
          pointCount: selectedSource.parsed.pointCount,
          profileCount: selectedSource.parsed.profileCount,
        },
        { geojson, pendingLayers: layers },
      );
      layers.push({
        ...baseLayer,
        // LandXML is inherently 3D. The flag activates GeoLibre's deck.gl
        // Z-coordinate renderer when the selected objects carry elevations.
        style: { ...baseLayer.style, elevation3dEnabled: true },
        geojson,
        sourcePath: selectedSource.path,
      });
    }

    for (const layer of layers) source.shell.addLayer(layer, source.beforeLayer);
    const combinedBounds = layers.reduce<[number, number, number, number] | null>(
      (merged, layer) => {
        const bounds = getLayerBounds(layer);
        if (!bounds) return merged;
        if (!merged) return bounds;
        return [
          Math.min(merged[0], bounds[0]),
          Math.min(merged[1], bounds[1]),
          Math.max(merged[2], bounds[2]),
          Math.max(merged[3], bounds[3]),
        ];
      },
      null,
    );
    if (combinedBounds) source.shell.mapControllerRef.current?.fitBounds(combinedBounds);
    else source.shell.mapControllerRef.current?.fitLayer(layers[0]);
    source.shell.closeDialog();
  });

  const setKindSelected = (kind: LandXmlLayerKind, checked: boolean) => {
    setSelectedKinds((current) => ({ ...current, [kind]: checked }));
  };

  return (
    <AddDataSourceForm
      layerName={source.layerName}
      onLayerNameChange={source.setLayerName}
      beforeLayerId={source.beforeLayerId}
      onBeforeLayerIdChange={source.setBeforeLayerId}
      onSubmit={handleSubmit}
      error={source.error}
      submitDisabled={source.isSubmitting || !hasSelectedKind}
    >
      <div className="space-y-3">
        <div className="space-y-1.5">
          <Label htmlFor="landxml-mode">{t("addData.common.sourceType")}</Label>
          <Select
            id="landxml-mode"
            value={landXmlMode}
            onChange={(event) => handleModeChange(event.target.value as LandXmlMode)}
          >
            <option value="url">{t("addData.landxml.url")}</option>
            <option value="file">{t("addData.landxml.file")}</option>
          </Select>
        </div>

        {landXmlMode === "file" ? (
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
            <Label htmlFor="landxml-url">{t("addData.landxml.url")}</Label>
            <Input
              id="landxml-url"
              placeholder={t("addData.landxml.urlPlaceholder")}
              value={landXmlUrl}
              onChange={(event) => setLandXmlUrl(event.target.value)}
            />
          </div>
        )}

        {selectedFile ? (
          <div className="rounded-md border border-border/60 bg-muted/30 p-3 text-xs">
            {t("addData.landxml.summary", {
              surfaces: selectedFile.parsed.surfaceCount,
              alignments: selectedFile.parsed.alignmentCount,
              profiles: selectedFile.parsed.profileCount,
              points: selectedFile.parsed.pointCount,
            })}
          </div>
        ) : null}

        <div className="space-y-1.5">
          <Label>{t("addData.landxml.objectTypes")}</Label>
          {(["surface", "alignment", "points"] as const).map((kind) => (
            <label key={kind} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={selectedKinds[kind]}
                onChange={(event) => setKindSelected(kind, event.target.checked)}
              />
              {t(`addData.landxml.${kind}`)}
            </label>
          ))}
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="landxml-crs">{t("addData.landxml.crs")}</Label>
          <Input
            id="landxml-crs"
            value={sourceCrs}
            placeholder={t("addData.landxml.crsPlaceholder")}
            onChange={(event) => setSourceCrs(event.target.value)}
          />
          <Select
            aria-label={t("addData.landxml.crsPresetLabel")}
            value=""
            onChange={(event) => {
              if (event.target.value) setSourceCrs(event.target.value);
            }}
          >
            <option value="">{t("addData.landxml.crsPresetLabel")}</option>
            {COMMON_CRS_PRESETS.map((preset) => (
              <option key={preset.value} value={preset.value}>
                {preset.label}
              </option>
            ))}
          </Select>
          <p className="text-xs text-muted-foreground">
            {selectedFile?.parsed.coordinateSystem
              ? t("addData.landxml.detectedCoordinateSystem", {
                  value: selectedFile.parsed.coordinateSystem,
                })
              : t("addData.landxml.crsHelp")}
          </p>
        </div>

        <SampleDataSelect
          samples={LANDXML_SAMPLES.map((sample) => ({ label: sample.label, value: sample }))}
          onSelect={(sample) => {
            setLandXmlMode("url");
            setSelectedFile(null);
            setLandXmlUrl(sample.url);
            setSourceCrs(sample.crs);
            source.setLayerName((current) =>
              current.trim() && current !== defaultName
                ? current
                : layerNameFromPath(new URL(sample.url).pathname, defaultName),
            );
          }}
        />
      </div>
    </AddDataSourceForm>
  );
}
