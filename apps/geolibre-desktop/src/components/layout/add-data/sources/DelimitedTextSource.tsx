import {
  csvRowsToGeocodeRequests,
  geocodeForward,
  geocodeMatchToFeature,
  geocoderMinIntervalMs,
  getGeocodingProvider,
  nextDelayMs,
  resolveGeocoderConfig,
  rowCap,
  unmatchedGeocodeFeature,
  useAppStore,
} from "@geolibre/core";
import { Button, Input, Label, ScrollArea, Select } from "@geolibre/ui";
import type { Feature, FeatureCollection, Point } from "geojson";
import { Columns3, FileUp, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { isGeographicCrs } from "../../../../lib/crs-utils";
import {
  detectCoordinateFields,
  parseDelimitedTextFields,
  parseDelimitedTextLayer,
  parseDelimitedTextRows,
} from "../../../../lib/delimited-text";
import { reprojectFeatureCollectionToWgs84 } from "../../../../lib/duckdb-vector-loader";
import { openLocalDataFileWithFallback } from "../../../../lib/tauri-io";
import {
  COMMON_CRS_PRESETS,
  DEFAULT_DELIMITED_TEXT_LATITUDE_FIELD,
  DEFAULT_DELIMITED_TEXT_LONGITUDE_FIELD,
  DEFAULT_DELIMITED_TEXT_URL,
} from "../constants";
import {
  createBaseLayer,
  errorMessage,
  fileNameFromPath,
  layerNameFromPath,
  normalizeCrs,
  resolveDelimitedTextDelimiter,
} from "../helpers";
import { AddDataSourceForm, SampleDataSelect, useAddDataSource } from "../shared";
import type { DelimitedTextDelimiter, DelimitedTextImportMode, DelimitedTextMode } from "../types";

/** A cancellable delay that rejects with an AbortError when the signal fires. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (ms <= 0) {
      resolve();
      return;
    }
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      cleanup();
      reject(new DOMException("Aborted", "AbortError"));
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort);
  });
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

export function DelimitedTextSource() {
  const { t } = useTranslation();
  // Captured once on mount so the "did the user rename it?" comparisons below
  // stay stable even if the UI language changes while the dialog is open.
  const [defaultName] = useState(() => t("addData.delimitedText.defaultName"));
  const source = useAddDataSource(defaultName);
  const [delimitedTextMode, setDelimitedTextMode] = useState<DelimitedTextMode>("url");
  const [delimitedTextUrl, setDelimitedTextUrl] = useState("");
  const [delimitedTextDelimiter, setDelimitedTextDelimiter] =
    useState<DelimitedTextDelimiter>("comma");
  const [delimitedTextCustomDelimiter, setDelimitedTextCustomDelimiter] = useState("");
  const [delimitedTextLatitudeField, setDelimitedTextLatitudeField] = useState(
    DEFAULT_DELIMITED_TEXT_LATITUDE_FIELD,
  );
  const [delimitedTextLongitudeField, setDelimitedTextLongitudeField] = useState(
    DEFAULT_DELIMITED_TEXT_LONGITUDE_FIELD,
  );
  // Source CRS of the coordinate columns. Blank means WGS84 longitude/latitude
  // (the historical behaviour); a projected EPSG code reprojects the points to
  // WGS84 after parsing so CSVs in any CRS import in the right place (#1338).
  const [delimitedTextCrs, setDelimitedTextCrs] = useState("");
  const [delimitedTextFields, setDelimitedTextFields] = useState<string[]>([]);
  const [delimitedTextColumnsStatus, setDelimitedTextColumnsStatus] = useState<string | null>(null);
  const [isRetrievingDelimitedTextColumns, setIsRetrievingDelimitedTextColumns] = useState(false);
  const [selectedDelimitedText, setSelectedDelimitedText] = useState<{
    path: string;
    text: string;
  } | null>(null);
  // Whether points are built from coordinate columns (default, unchanged
  // behaviour) or by geocoding an address composed from one or more columns.
  const [delimitedTextImportMode, setDelimitedTextImportMode] =
    useState<DelimitedTextImportMode>("coordinates");
  const [delimitedTextAddressColumns, setDelimitedTextAddressColumns] = useState<string[]>([]);
  const [geocodeLog, setGeocodeLog] = useState<string[]>([]);
  const [geocodeRunning, setGeocodeRunning] = useState(false);
  const geocodeAbortRef = useRef<AbortController | null>(null);
  const geocodeLogEndRef = useRef<HTMLDivElement>(null);

  const appendGeocodeLog = useCallback((line: string) => {
    setGeocodeLog((prev) => [...prev, line]);
  }, []);

  useEffect(() => {
    geocodeLogEndRef.current?.scrollIntoView({ block: "end" });
  }, [geocodeLog]);

  const resetDelimitedTextColumns = () => {
    setDelimitedTextFields([]);
    setDelimitedTextColumnsStatus(null);
  };

  // Clear the entered CRS whenever the underlying data source changes (new file,
  // new URL, mode switch, sample). A projected CRS disables the lon/lat bounds
  // check in parseDelimitedTextLayer, so a code left over from a previous file
  // would silently reinterpret the next (possibly WGS84) file's coordinates as
  // easting/northing and reproject them into nonsense with no validation error.
  // Deliberately not called on a delimiter tweak, which keeps the same file.
  const resetDelimitedTextCrs = () => {
    setDelimitedTextCrs("");
  };

  const handleDelimitedTextModeChange = (mode: DelimitedTextMode) => {
    setDelimitedTextMode(mode);
    setSelectedDelimitedText(null);
    resetDelimitedTextColumns();
    resetDelimitedTextCrs();
  };

  const handleImportModeChange = (mode: DelimitedTextImportMode) => {
    setDelimitedTextImportMode(mode);
    setDelimitedTextAddressColumns([]);
    setGeocodeLog([]);
  };

  const toggleAddressColumn = (field: string) => {
    setDelimitedTextAddressColumns((prev) =>
      prev.includes(field) ? prev.filter((f) => f !== field) : [...prev, field],
    );
  };

  const readDelimitedTextSource = async (): Promise<{
    sourcePath: string;
    text: string;
  }> => {
    if (delimitedTextMode === "file") {
      if (!selectedDelimitedText) {
        throw new Error(t("addData.delimitedText.errorChooseFile"));
      }
      return {
        sourcePath: selectedDelimitedText.path,
        text: selectedDelimitedText.text,
      };
    }

    const sourcePath = delimitedTextUrl.trim();
    if (!sourcePath) throw new Error(t("addData.delimitedText.errorUrl"));

    const response = await fetch(sourcePath);
    if (!response.ok) {
      throw new Error(t("addData.common.requestFailed", { status: response.status }));
    }
    return {
      sourcePath,
      text: await response.text(),
    };
  };

  const handleChooseDelimitedText = async () => {
    source.setError(null);
    try {
      const result = await openLocalDataFileWithFallback({
        filters: [
          {
            name: "Delimited text",
            extensions: ["csv", "tsv", "txt", "dat"],
          },
        ],
        accept: ".csv,.tsv,.txt,.dat",
        readText: true,
      });
      if (!result) return;
      if (!result.text) throw new Error(t("addData.delimitedText.errorFileMissing"));
      setSelectedDelimitedText({
        path: result.path,
        text: result.text,
      });
      resetDelimitedTextColumns();
      resetDelimitedTextCrs();
      source.setLayerName((current) =>
        current.trim() && current !== defaultName
          ? current
          : layerNameFromPath(result.path, defaultName),
      );
    } catch (err) {
      source.setError(errorMessage(err, t("addData.delimitedText.readError")));
    }
  };

  const handleRetrieveDelimitedTextColumns = async () => {
    source.setError(null);
    setDelimitedTextColumnsStatus(null);
    setIsRetrievingDelimitedTextColumns(true);

    try {
      const delimiter = resolveDelimitedTextDelimiter(
        delimitedTextDelimiter,
        delimitedTextCustomDelimiter,
      );
      const { text } = await readDelimitedTextSource();
      const fields = parseDelimitedTextFields(text, delimiter);
      setDelimitedTextFields(fields);
      // Resolve the coordinate columns as an all-or-nothing pair so the file is
      // always in a coherent state (both set = points, both blank = attribute
      // table), never the mixed state that parseDelimitedTextLayer rejects.
      // Prefer keeping the current manual choices when both still exist in the
      // freshly retrieved header (e.g. after tweaking the delimiter); otherwise
      // auto-detect; otherwise leave both as "(None)" so the file imports as a
      // non-spatial attribute table instead of misparsing an arbitrary column.
      const keepIfValid = (current: string): string | undefined => {
        const normalized = current.trim().toLowerCase();
        if (!normalized) return undefined;
        return fields.find((field) => field.trim().toLowerCase() === normalized);
      };
      const keptLongitude = keepIfValid(delimitedTextLongitudeField);
      const keptLatitude = keepIfValid(delimitedTextLatitudeField);
      const detected = detectCoordinateFields(fields);
      let nextLongitude = "";
      let nextLatitude = "";
      if (keptLongitude && keptLatitude) {
        nextLongitude = keptLongitude;
        nextLatitude = keptLatitude;
      } else if (detected) {
        nextLongitude = detected.longitudeField;
        nextLatitude = detected.latitudeField;
      }
      setDelimitedTextLongitudeField(nextLongitude);
      setDelimitedTextLatitudeField(nextLatitude);
      setDelimitedTextColumnsStatus(
        nextLongitude && nextLatitude
          ? t("addData.delimitedText.retrievedColumns", { count: fields.length })
          : t("addData.delimitedText.retrievedColumnsTable", {
              count: fields.length,
            }),
      );
    } catch (err) {
      source.setError(errorMessage(err, t("addData.delimitedText.errorRetrieveColumns")));
      setDelimitedTextFields([]);
    } finally {
      setIsRetrievingDelimitedTextColumns(false);
    }
  };

  // Geocodes each row's composed address (one or more concatenated columns),
  // keeping rows that fail to match as null-geometry features (flagged
  // `geocode_status: "unmatched"`) rather than dropping them, so a batch that
  // is mostly-but-not-fully matched still lands as one inspectable layer.
  // Mirrors GeocodeDialog.tsx's paced batch loop (pacing/cap policy from
  // @geolibre/core, log/cancel UX) but is duplicated rather than shared: the
  // two call sites build different output shapes and GeocodeDialog is a
  // separately shipped tool this change should not need to touch.
  const submitAddresses = async (
    name: string,
    delimiter: string,
    sourcePath: string,
    text: string,
  ) => {
    if (delimitedTextAddressColumns.length === 0) {
      throw new Error(t("addData.delimitedText.errorNoAddressColumns"));
    }

    const { fields, rows } = parseDelimitedTextRows(text, delimiter);
    const config = resolveGeocoderConfig(useAppStore.getState().preferences.geocoding);
    const provider = getGeocodingProvider(config.providerId);
    const requests = csvRowsToGeocodeRequests(rows, delimitedTextAddressColumns);
    if (requests.length === 0) {
      throw new Error(t("addData.delimitedText.errorNoAddressesFound"));
    }
    const skippedEmpty = rows.length - requests.length;
    const cap = rowCap(config.forwardEndpoint);
    const toProcess = Number.isFinite(cap) ? requests.slice(0, cap) : requests;
    const interval = geocoderMinIntervalMs(config.forwardEndpoint);

    const controller = new AbortController();
    geocodeAbortRef.current = controller;
    const { signal } = controller;
    setGeocodeRunning(true);
    setGeocodeLog([]);

    appendGeocodeLog(
      t("geocode.usingProvider", { provider: provider.label, endpoint: config.forwardEndpoint }),
    );
    if (skippedEmpty > 0) appendGeocodeLog(t("geocode.skippedEmpty", { count: skippedEmpty }));
    if (requests.length > toProcess.length) appendGeocodeLog(t("geocode.rowCapWarning", { cap }));

    const matchedFeatures: Feature<Point>[] = [];
    const unmatchedFeatures: Feature<null>[] = [];
    let lastStartedAt: number | null = null;
    let cancelled = false;

    try {
      for (let i = 0; i < toProcess.length; i += 1) {
        const request = toProcess[i];
        const wait = nextDelayMs(lastStartedAt, performance.now(), interval);
        if (wait > 0) await sleep(wait, signal);
        lastStartedAt = performance.now();
        appendGeocodeLog(
          t("geocode.progress", {
            current: i + 1,
            total: toProcess.length,
            address: request.address,
          }),
        );
        try {
          const results = await geocodeForward(request.address, { signal, config, limit: 1 });
          const match = results[0];
          const feature = match
            ? geocodeMatchToFeature(match, request.row, { providerId: config.providerId })
            : null;
          if (feature) matchedFeatures.push(feature);
          else unmatchedFeatures.push(unmatchedGeocodeFeature(request.row, config.providerId));
        } catch (requestError) {
          // A cancel propagates to stop the whole batch; any other per-request
          // failure (e.g. an HTTP 429) is logged and the row is kept unmatched
          // so the remaining rows still run.
          if (isAbortError(requestError)) throw requestError;
          appendGeocodeLog(t("geocode.error", { message: (requestError as Error).message }));
          unmatchedFeatures.push(unmatchedGeocodeFeature(request.row, config.providerId));
        }
      }
    } catch (error) {
      if (isAbortError(error)) cancelled = true;
      else appendGeocodeLog(t("geocode.error", { message: (error as Error).message }));
    }

    geocodeAbortRef.current = null;
    setGeocodeRunning(false);
    appendGeocodeLog(
      cancelled
        ? t("geocode.cancelled", { matched: matchedFeatures.length })
        : t("geocode.summary", {
            matched: matchedFeatures.length,
            total: toProcess.length,
            failed: unmatchedFeatures.length,
          }),
    );

    const features = [...matchedFeatures, ...unmatchedFeatures];
    if (features.length === 0) {
      throw new Error(cancelled ? t("geocode.cancelledNoRows") : t("geocode.noMatches"));
    }

    source.addAndClose(
      {
        ...createBaseLayer(
          name,
          "geojson",
          { type: "geojson", url: sourcePath },
          {
            addressColumns: delimitedTextAddressColumns,
            fields,
            geocodeCancelled: cancelled,
            geocodeMatched: matchedFeatures.length,
            geocodeProvider: config.providerId,
            geocodeSkippedEmpty: skippedEmpty,
            geocodeUnmatched: unmatchedFeatures.length,
            isTable: false,
            sourceKind: "delimited-text",
            totalRows: rows.length,
          },
        ),
        // Mixed Point/null geometries (matched/unmatched rows) are a legal
        // GeoJSON FeatureCollection, same as parseDelimitedTextLayer's
        // attribute-table branch; the cast matches that existing precedent.
        geojson: { type: "FeatureCollection", features } as FeatureCollection,
        sourcePath,
      },
      { fit: matchedFeatures.length > 0 },
    );

    // Rows kept but flagged as unmatched are inspectable, not just present: a
    // stale filter from a prior layer should not carry over, so this is only
    // set (never cleared) when this run actually has unmatched rows. Applied
    // after addAndClose so it lands on the layer it just selected, not
    // whatever was selected before this run.
    if (unmatchedFeatures.length > 0) {
      useAppStore.getState().setAttributeFilter("unmatched");
    }
  };

  const handleSubmit = source.runSubmit(async () => {
    const name = source.layerName.trim() || defaultName;
    const delimiter = resolveDelimitedTextDelimiter(
      delimitedTextDelimiter,
      delimitedTextCustomDelimiter,
    );
    const { sourcePath, text } = await readDelimitedTextSource();
    if (!text) throw new Error(t("addData.delimitedText.errorDataMissing"));

    if (delimitedTextImportMode === "addresses") {
      await submitAddresses(name, delimiter, sourcePath, text);
      return;
    }

    const sourceCrs = normalizeCrs(delimitedTextCrs);
    const result = parseDelimitedTextLayer(text, {
      delimiter,
      latitudeField: delimitedTextLatitudeField,
      longitudeField: delimitedTextLongitudeField,
      sourceCrs,
    });
    // A projected source CRS leaves the parsed coordinates in their native units
    // (e.g. UTM metres), so reproject them to WGS84 before the map renders them.
    // Attribute tables (null geometry) have nothing to reproject.
    const geojson =
      result.isTable || isGeographicCrs(sourceCrs)
        ? result.data
        : await reprojectFeatureCollectionToWgs84(result.data, sourceCrs);
    source.addAndClose(
      {
        ...createBaseLayer(
          name,
          "geojson",
          {
            type: "geojson",
            url: sourcePath,
          },
          {
            delimiter,
            featureCount: geojson.features.length,
            fields: result.fields,
            isTable: result.isTable,
            latitudeField: delimitedTextLatitudeField.trim(),
            longitudeField: delimitedTextLongitudeField.trim(),
            skippedRows: result.skippedRows,
            // A non-spatial attribute table has no geometry, so a source CRS is
            // meaningless there; only record it for point layers.
            sourceCrs: result.isTable ? null : sourceCrs || null,
            sourceKind: "delimited-text",
            totalRows: result.totalRows,
          },
          // A non-spatial attribute table draws nothing, so it stays on the flat
          // defaults rather than reserving a palette color no map ever shows.
          { geojson: result.isTable ? undefined : geojson },
        ),
        geojson,
        sourcePath,
      },
      // A non-spatial attribute table has no geometry to fit the map to.
      { fit: !result.isTable },
    );
  });

  const delimitedTextFieldOptions = useMemo(
    () =>
      Array.from(
        new Set(
          [...delimitedTextFields, delimitedTextLongitudeField, delimitedTextLatitudeField].filter(
            (field) => field.trim(),
          ),
        ),
      ),
    [delimitedTextFields, delimitedTextLatitudeField, delimitedTextLongitudeField],
  );

  const missingCustomDelimiter =
    delimitedTextDelimiter === "custom" && !delimitedTextCustomDelimiter.trim();

  return (
    <AddDataSourceForm
      layerName={source.layerName}
      onLayerNameChange={source.setLayerName}
      beforeLayerId={source.beforeLayerId}
      onBeforeLayerIdChange={source.setBeforeLayerId}
      onSubmit={handleSubmit}
      error={source.error}
      submitDisabled={
        source.isSubmitting || isRetrievingDelimitedTextColumns || missingCustomDelimiter
      }
    >
      <div className="space-y-3">
        <div className="space-y-1.5">
          <Label htmlFor="delimited-text-mode">{t("addData.common.sourceType")}</Label>
          <Select
            id="delimited-text-mode"
            value={delimitedTextMode}
            onChange={(event) =>
              handleDelimitedTextModeChange(event.target.value as DelimitedTextMode)
            }
          >
            <option value="url">{t("addData.delimitedText.url")}</option>
            <option value="file">{t("addData.delimitedText.file")}</option>
          </Select>
        </div>

        {delimitedTextMode === "file" ? (
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" variant="outline" onClick={handleChooseDelimitedText}>
              <FileUp className="me-2 h-3.5 w-3.5" />
              {t("addData.common.chooseFile")}
            </Button>
            <span className="min-w-0 truncate text-xs text-muted-foreground">
              {selectedDelimitedText
                ? fileNameFromPath(selectedDelimitedText.path)
                : t("addData.common.noFileSelected")}
            </span>
          </div>
        ) : (
          <div className="space-y-1.5">
            <Label htmlFor="delimited-text-url">{t("addData.delimitedText.url")}</Label>
            <Input
              id="delimited-text-url"
              placeholder={t("addData.delimitedText.urlPlaceholder")}
              value={delimitedTextUrl}
              onChange={(event) => {
                setDelimitedTextUrl(event.target.value);
                resetDelimitedTextColumns();
                resetDelimitedTextCrs();
              }}
            />
          </div>
        )}

        <Button
          type="button"
          variant="outline"
          onClick={handleRetrieveDelimitedTextColumns}
          disabled={
            source.isSubmitting ||
            isRetrievingDelimitedTextColumns ||
            missingCustomDelimiter ||
            (delimitedTextMode === "file" && !selectedDelimitedText) ||
            (delimitedTextMode === "url" && !delimitedTextUrl.trim())
          }
        >
          <Columns3 className="me-2 h-3.5 w-3.5" />
          {isRetrievingDelimitedTextColumns
            ? t("addData.delimitedText.retrieving")
            : t("addData.delimitedText.retrieveColumns")}
        </Button>
        {delimitedTextColumnsStatus ? (
          <p className="text-xs text-muted-foreground">{delimitedTextColumnsStatus}</p>
        ) : null}

        <div className="space-y-1.5">
          <Label htmlFor="delimited-text-import-mode">
            {t("addData.delimitedText.importMode")}
          </Label>
          <Select
            id="delimited-text-import-mode"
            value={delimitedTextImportMode}
            onChange={(event) =>
              handleImportModeChange(event.target.value as DelimitedTextImportMode)
            }
            disabled={source.isSubmitting}
          >
            <option value="coordinates">{t("addData.delimitedText.modeCoordinates")}</option>
            <option value="addresses">{t("addData.delimitedText.modeAddresses")}</option>
          </Select>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="delimited-text-delimiter">{t("addData.delimitedText.delimiter")}</Label>
            <Select
              id="delimited-text-delimiter"
              value={delimitedTextDelimiter}
              onChange={(event) => {
                setDelimitedTextDelimiter(event.target.value as DelimitedTextDelimiter);
                resetDelimitedTextColumns();
              }}
            >
              <option value="comma">{t("addData.delimitedText.delimiterComma")}</option>
              <option value="tab">{t("addData.delimitedText.delimiterTab")}</option>
              <option value="semicolon">{t("addData.delimitedText.delimiterSemicolon")}</option>
              <option value="pipe">{t("addData.delimitedText.delimiterPipe")}</option>
              <option value="custom">{t("addData.delimitedText.delimiterCustom")}</option>
            </Select>
          </div>
          {delimitedTextDelimiter === "custom" ? (
            <div className="space-y-1.5">
              <Label htmlFor="delimited-text-custom-delimiter">
                {t("addData.delimitedText.customDelimiter")}
              </Label>
              <Input
                id="delimited-text-custom-delimiter"
                value={delimitedTextCustomDelimiter}
                onChange={(event) => {
                  setDelimitedTextCustomDelimiter(event.target.value);
                  resetDelimitedTextColumns();
                }}
              />
            </div>
          ) : null}
        </div>

        {delimitedTextImportMode === "coordinates" ? (
          <>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="delimited-text-longitude">
                  {t("addData.delimitedText.longitudeField")}
                </Label>
                <Select
                  id="delimited-text-longitude"
                  value={delimitedTextLongitudeField}
                  onChange={(event) => setDelimitedTextLongitudeField(event.target.value)}
                >
                  <option value="">{t("addData.delimitedText.noneField")}</option>
                  {delimitedTextFieldOptions.map((field) => (
                    <option key={field} value={field}>
                      {field}
                    </option>
                  ))}
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="delimited-text-latitude">
                  {t("addData.delimitedText.latitudeField")}
                </Label>
                <Select
                  id="delimited-text-latitude"
                  value={delimitedTextLatitudeField}
                  onChange={(event) => setDelimitedTextLatitudeField(event.target.value)}
                >
                  <option value="">{t("addData.delimitedText.noneField")}</option>
                  {delimitedTextFieldOptions.map((field) => (
                    <option key={field} value={field}>
                      {field}
                    </option>
                  ))}
                </Select>
              </div>
            </div>
            <p className="text-xs text-muted-foreground">{t("addData.delimitedText.tableHint")}</p>

            <div className="space-y-1.5">
              <Label htmlFor="delimited-text-crs">{t("addData.delimitedText.crs")}</Label>
              <Input
                id="delimited-text-crs"
                placeholder={t("addData.delimitedText.crsPlaceholder")}
                value={delimitedTextCrs}
                onChange={(event) => setDelimitedTextCrs(event.target.value)}
              />
              <Select
                aria-label={t("addData.delimitedText.crsPresetLabel")}
                value=""
                onChange={(event) => {
                  if (event.target.value) setDelimitedTextCrs(event.target.value);
                }}
              >
                <option value="" disabled>
                  {t("addData.delimitedText.crsPresetLabel")}
                </option>
                {COMMON_CRS_PRESETS.map((preset) => (
                  <option key={preset.value} value={preset.value}>
                    {preset.label}
                  </option>
                ))}
              </Select>
              <p className="text-xs text-muted-foreground">{t("addData.delimitedText.crsHelp")}</p>
            </div>
          </>
        ) : (
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label>{t("addData.delimitedText.addressColumns")}</Label>
              <div className="space-y-1 rounded-md border p-2">
                {delimitedTextFieldOptions.length === 0 ? (
                  <p className="text-xs text-muted-foreground">
                    {t("addData.delimitedText.addressColumnsEmptyHint")}
                  </p>
                ) : (
                  delimitedTextFieldOptions.map((field) => (
                    <label key={field} className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={delimitedTextAddressColumns.includes(field)}
                        disabled={source.isSubmitting}
                        onChange={() => toggleAddressColumn(field)}
                      />
                      {field}
                    </label>
                  ))
                )}
              </div>
              <p className="text-xs text-muted-foreground">
                {t("addData.delimitedText.addressColumnsHint")}
              </p>
            </div>

            {geocodeLog.length > 0 ? (
              <div className="space-y-1.5">
                <ScrollArea className="h-32 rounded-md border bg-muted/30 p-2 font-mono text-xs">
                  {geocodeLog.map((line, index) => (
                    <div key={index} className="whitespace-pre-wrap">
                      {line}
                    </div>
                  ))}
                  <div ref={geocodeLogEndRef} />
                </ScrollArea>
                {geocodeRunning ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => geocodeAbortRef.current?.abort()}
                  >
                    <X className="me-2 h-3.5 w-3.5" />
                    {t("geocode.cancel")}
                  </Button>
                ) : null}
              </div>
            ) : null}
          </div>
        )}

        <SampleDataSelect
          samples={[
            { label: t("addData.delimitedText.sampleLabel"), value: DEFAULT_DELIMITED_TEXT_URL },
          ]}
          onSelect={(url) => {
            setDelimitedTextMode("url");
            setSelectedDelimitedText(null);
            resetDelimitedTextColumns();
            // The sample is a comma-delimited CSV, so reset the delimiter too;
            // otherwise a previously chosen delimiter would misparse it.
            setDelimitedTextDelimiter("comma");
            setDelimitedTextCustomDelimiter("");
            // The sample is WGS84 lon/lat, so clear any projected CRS the user
            // may have entered; otherwise it would reproject correct coordinates.
            resetDelimitedTextCrs();
            setDelimitedTextUrl(url);
          }}
        />
      </div>
    </AddDataSourceForm>
  );
}
