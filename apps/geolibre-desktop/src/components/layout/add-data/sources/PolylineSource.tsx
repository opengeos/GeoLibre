import { batchDecodePolylines, decodePolyline, unescapePolyline } from "@geolibre/core";
import { Button, Input, Label, Select } from "@geolibre/ui";
import type { FeatureCollection, LineString, MultiLineString } from "geojson";
import { ChevronDown, ChevronUp, FileUp } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { SAMPLE_POLYLINES } from "../../../../lib/polyline-samples";
import { openLocalDataFileWithFallback } from "../../../../lib/tauri-io";
import { createBaseLayer, errorMessage, fileNameFromPath, layerNameFromPath } from "../helpers";
import { AddDataSourceForm, SampleDataSelect, useAddDataSource } from "../shared";

export type PolylineMode = "paste" | "file";
export type DelimiterType = "newline" | "semicolon" | "comma" | "tab" | "custom";
export type GeometryOutputType = "single" | "multi";

/** Haversine distance in kilometers between two [lon, lat] coordinates. */
function haversineDistanceKm(c1: [number, number], c2: [number, number]): number {
  const R = 6371.0088;
  const dLat = ((c2[1] - c1[1]) * Math.PI) / 180;
  const deltaLon = ((c2[0] - c1[0] + 540) % 360) - 180;
  const dLon = (deltaLon * Math.PI) / 180;
  const lat1 = (c1[1] * Math.PI) / 180;
  const lat2 = (c2[1] * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function formatDistance(km: number): string {
  return km < 1 ? `${(km * 1000).toFixed(0)} m` : `${km.toFixed(2)} km`;
}

export function PolylineSource() {
  const { t } = useTranslation();
  const [defaultName] = useState(() => t("addData.polyline.defaultName"));
  const source = useAddDataSource(defaultName);
  const [polylineMode, setPolylineMode] = useState<PolylineMode>("paste");
  const [rawText, setRawText] = useState("");
  const [precision, setPrecision] = useState<number>(5);
  const [unescapeBackslashes, setUnescapeBackslashes] = useState<boolean>(true);
  const [delimiterType, setDelimiterType] = useState<DelimiterType>("newline");
  const [customDelimiter, setCustomDelimiter] = useState<string>("");
  const [outputGeometry, setOutputGeometry] = useState<GeometryOutputType>("single");
  const [showCoordinateTable, setShowCoordinateTable] = useState<boolean>(false);
  const [selectedFile, setSelectedFile] = useState<{
    path: string;
    text: string;
  } | null>(null);

  const handleModeChange = (mode: PolylineMode) => {
    setPolylineMode(mode);
    setSelectedFile(null);
  };

  const handleChooseFile = async () => {
    source.setError(null);
    try {
      const result = await openLocalDataFileWithFallback({
        filters: [
          {
            name: "Encoded Polyline",
            extensions: ["polyline", "txt"],
          },
        ],
        accept: ".polyline,.txt",
        readText: true,
      });
      if (!result) return;
      if (!result.text) throw new Error(t("addData.polyline.errorFileMissing"));
      setSelectedFile({
        path: result.path,
        text: result.text,
      });
      source.setLayerName((current) =>
        current.trim() && current !== defaultName
          ? current
          : layerNameFromPath(result.path, defaultName),
      );
    } catch (err) {
      source.setError(errorMessage(err, t("addData.polyline.readError")));
    }
  };

  const currentContent = polylineMode === "file" ? (selectedFile?.text ?? "") : rawText;

  const activeDelimiter = useMemo(() => {
    switch (delimiterType) {
      case "newline":
        return /\r?\n/;
      case "semicolon":
        return ";";
      case "comma":
        return ",";
      case "tab":
        return "\t";
      case "custom":
        return customDelimiter || /\r?\n/;
    }
  }, [delimiterType, customDelimiter]);

  const parsedData = useMemo(() => {
    const textToProcess = currentContent.trim();
    if (!textToProcess) return null;
    try {
      const fc = batchDecodePolylines(textToProcess, {
        precision,
        unescape: unescapeBackslashes,
        delimiter: activeDelimiter,
        asMultiLine: outputGeometry === "multi",
        baseProperties: {
          source:
            polylineMode === "file"
              ? selectedFile
                ? fileNameFromPath(selectedFile.path)
                : "file"
              : "polyline",
        },
      });

      if (!fc.features.length) return null;

      let totalPoints = 0;
      let totalLengthKm = 0;
      let minLon = Infinity;
      let minLat = Infinity;
      let maxLon = -Infinity;
      let maxLat = -Infinity;

      const linesInfo: Array<{
        index: number;
        pointsCount: number;
        lengthKm: number;
        start: [number, number];
        end: [number, number];
        coords: [number, number][];
      }> = [];

      for (let i = 0; i < fc.features.length; i++) {
        const feature = fc.features[i];
        if (feature.geometry.type === "LineString") {
          const coords = feature.geometry.coordinates as [number, number][];
          let lineLen = 0;
          for (let j = 0; j < coords.length; j++) {
            const [lon, lat] = coords[j];
            minLon = Math.min(minLon, lon);
            maxLon = Math.max(maxLon, lon);
            minLat = Math.min(minLat, lat);
            maxLat = Math.max(maxLat, lat);
            if (j > 0) lineLen += haversineDistanceKm(coords[j - 1], coords[j]);
          }
          totalPoints += coords.length;
          totalLengthKm += lineLen;
          if (coords.length > 0) {
            linesInfo.push({
              index: i + 1,
              pointsCount: coords.length,
              lengthKm: lineLen,
              start: coords[0],
              end: coords[coords.length - 1],
              coords,
            });
          }
        } else if (feature.geometry.type === "MultiLineString") {
          const multiCoords = feature.geometry.coordinates as [number, number][][];
          multiCoords.forEach((coords, partIdx) => {
            let lineLen = 0;
            for (let j = 0; j < coords.length; j++) {
              const [lon, lat] = coords[j];
              minLon = Math.min(minLon, lon);
              maxLon = Math.max(maxLon, lon);
              minLat = Math.min(minLat, lat);
              maxLat = Math.max(maxLat, lat);
              if (j > 0) lineLen += haversineDistanceKm(coords[j - 1], coords[j]);
            }
            totalPoints += coords.length;
            totalLengthKm += lineLen;
            if (coords.length > 0) {
              linesInfo.push({
                index: partIdx + 1,
                pointsCount: coords.length,
                lengthKm: lineLen,
                start: coords[0],
                end: coords[coords.length - 1],
                coords,
              });
            }
          });
        }
      }

      return {
        featureCollection: fc,
        featuresCount: fc.features.length,
        linesCount: linesInfo.length,
        totalPoints,
        totalLengthKm,
        bbox: [minLon, minLat, maxLon, maxLat] as [number, number, number, number],
        linesInfo,
      };
    } catch {
      return null;
    }
  }, [
    currentContent,
    precision,
    unescapeBackslashes,
    activeDelimiter,
    outputGeometry,
    polylineMode,
    selectedFile,
  ]);

  const handleSubmit = source.runSubmit(async () => {
    const textToProcess = currentContent.trim();
    if (!textToProcess) {
      throw new Error(
        polylineMode === "file"
          ? t("addData.polyline.errorChooseFile")
          : t("addData.polyline.errorEmptyInput"),
      );
    }

    if (!parsedData || !parsedData.featureCollection.features.length) {
      throw new Error(t("addData.polyline.errorNoValidLines"));
    }

    const name = source.layerName.trim() || defaultName;
    const geojson = parsedData.featureCollection;
    const sourcePath = polylineMode === "file" ? (selectedFile?.path ?? "") : "encoded-polyline";

    source.addAndClose(
      {
        ...createBaseLayer(
          name,
          "geojson",
          {
            type: "geojson",
            data: geojson,
          },
          {
            featureCount: geojson.features.length,
            sourceKind: "polyline",
            polylinePrecision: precision,
          },
          { geojson },
        ),
        geojson,
        sourcePath,
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
      submitDisabled={source.isSubmitting}
    >
      <div className="space-y-3">
        {/* Row 1: Source Mode & Precision */}
        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-1.5">
            <Label htmlFor="polyline-mode">{t("addData.common.sourceType")}</Label>
            <Select
              id="polyline-mode"
              value={polylineMode}
              onChange={(event) => handleModeChange(event.target.value as PolylineMode)}
            >
              <option value="paste">{t("addData.polyline.modePaste")}</option>
              <option value="file">{t("addData.polyline.modeFile")}</option>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="polyline-precision">{t("addData.polyline.precisionLabel")}</Label>
            <Select
              id="polyline-precision"
              value={String(precision)}
              onChange={(event) => setPrecision(Number(event.target.value))}
            >
              <option value="5">{t("addData.polyline.precision5")}</option>
              <option value="6">{t("addData.polyline.precision6")}</option>
            </Select>
          </div>
        </div>

        {/* Row 2: Delimiter & Output Geometry */}
        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-1.5">
            <Label htmlFor="polyline-delimiter">{t("addData.polyline.delimiterLabel")}</Label>
            <Select
              id="polyline-delimiter"
              value={delimiterType}
              onChange={(event) => setDelimiterType(event.target.value as DelimiterType)}
            >
              <option value="newline">{t("addData.polyline.delimNewline")}</option>
              <option value="semicolon">{t("addData.polyline.delimSemicolon")}</option>
              <option value="comma">{t("addData.polyline.delimComma")}</option>
              <option value="tab">{t("addData.polyline.delimTab")}</option>
              <option value="custom">{t("addData.polyline.delimCustom")}</option>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="polyline-output-geometry">
              {t("addData.polyline.outputGeometryLabel")}
            </Label>
            <Select
              id="polyline-output-geometry"
              value={outputGeometry}
              onChange={(event) => setOutputGeometry(event.target.value as GeometryOutputType)}
            >
              <option value="single">{t("addData.polyline.separateLines")}</option>
              <option value="multi">{t("addData.polyline.multiLineString")}</option>
            </Select>
          </div>
        </div>

        {delimiterType === "custom" && (
          <div className="space-y-1.5">
            <Input
              id="polyline-custom-delimiter"
              placeholder={t("addData.polyline.customDelimPlaceholder")}
              value={customDelimiter}
              onChange={(e) => setCustomDelimiter(e.target.value)}
            />
          </div>
        )}

        {/* Unescape Backslashes checkbox */}
        <div className="flex items-center gap-2 pt-0.5">
          <input
            type="checkbox"
            id="polyline-unescape"
            className="h-4 w-4 rounded border-gray-300 text-primary focus:ring-primary"
            checked={unescapeBackslashes}
            onChange={(e) => setUnescapeBackslashes(e.target.checked)}
          />
          <Label htmlFor="polyline-unescape" className="cursor-pointer text-xs font-normal">
            {t("addData.polyline.unescapeLabel")}
          </Label>
        </div>

        {/* File Picker or Textarea */}
        {polylineMode === "file" ? (
          <div className="space-y-2">
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
          </div>
        ) : (
          <div className="space-y-1.5">
            <Label htmlFor="polyline-text">{t("addData.polyline.textLabel")}</Label>
            <textarea
              id="polyline-text"
              rows={4}
              className="flex min-h-[90px] w-full rounded-md border border-input bg-background px-3 py-2 text-xs ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 font-mono"
              placeholder={t("addData.polyline.placeholder")}
              value={rawText}
              onChange={(event) => setRawText(event.target.value)}
            />
          </div>
        )}

        {/* Interactive Decoded Geometry Preview */}
        {parsedData && (
          <div className="space-y-2 rounded-md border bg-muted/30 p-2.5 text-xs">
            <div className="flex items-center justify-between font-medium text-foreground">
              <span>{t("addData.polyline.previewTitle")}</span>
              <span className="text-[11px] text-muted-foreground">
                {t("addData.polyline.previewInfo", {
                  lines: parsedData.linesCount,
                  points: parsedData.totalPoints,
                })}
              </span>
            </div>

            <div className="grid grid-cols-2 gap-2 text-muted-foreground text-[11px]">
              <div>
                <span className="font-semibold text-foreground">
                  {t("addData.polyline.previewLength")}:{" "}
                </span>
                {formatDistance(parsedData.totalLengthKm)}
              </div>
              <div className="truncate">
                <span className="font-semibold text-foreground">
                  {t("addData.polyline.previewExtent")}:{" "}
                </span>
                [{parsedData.bbox.map((v) => v.toFixed(3)).join(", ")}]
              </div>
            </div>

            {/* Expandable Coordinate Inspector */}
            <div className="border-t pt-1.5">
              <button
                type="button"
                className="flex items-center justify-between w-full text-[11px] text-primary hover:underline"
                onClick={() => setShowCoordinateTable(!showCoordinateTable)}
              >
                <span>{t("addData.polyline.previewCoordinates")}</span>
                {showCoordinateTable ? (
                  <ChevronUp className="h-3.5 w-3.5" />
                ) : (
                  <ChevronDown className="h-3.5 w-3.5" />
                )}
              </button>

              {showCoordinateTable && (
                <div className="mt-2 max-h-36 overflow-y-auto space-y-1.5 text-[11px] font-mono bg-background/80 p-1.5 rounded border">
                  {parsedData.linesInfo.map((l) => (
                    <div key={l.index} className="border-b pb-1 last:border-b-0">
                      <div className="flex justify-between text-muted-foreground font-sans">
                        <span className="font-semibold text-foreground">
                          {t("addData.polyline.previewLine")} #{l.index}
                        </span>
                        <span>
                          {l.pointsCount} {t("addData.polyline.previewPoints")} ·{" "}
                          {formatDistance(l.lengthKm)}
                        </span>
                      </div>
                      <div className="flex gap-2 text-[10px] text-muted-foreground">
                        <span>
                          {t("addData.polyline.previewStart")}: [{l.start[0].toFixed(5)},{" "}
                          {l.start[1].toFixed(5)}]
                        </span>
                        <span>→</span>
                        <span>
                          {t("addData.polyline.previewEnd")}: [{l.end[0].toFixed(5)},{" "}
                          {l.end[1].toFixed(5)}]
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {/* Sample data selector */}
        {polylineMode === "paste" && (
          <SampleDataSelect
            samples={SAMPLE_POLYLINES.map((s) => ({
              label: t(s.key),
              value: s.value,
            }))}
            onSelect={(val) => {
              const sample = SAMPLE_POLYLINES.find((s) => s.value === val);
              if (sample) {
                setDelimiterType("newline");
                setCustomDelimiter("");
                setPrecision(sample.precision);
                setUnescapeBackslashes(sample.unescape ?? true);
                setRawText(sample.value);
              }
            }}
          />
        )}
      </div>
    </AddDataSourceForm>
  );
}
