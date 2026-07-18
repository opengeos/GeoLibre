import {
  csvRowsToGeocodeRequests,
  geocodeForward,
  geocodeMatchToFeature,
  geocoderMinIntervalMs,
  geocoderNeedsApiKey,
  GEOCODING_PROVIDERS,
  getGeocodingProvider,
  nextDelayMs,
  normalizeGeocodingProviderId,
  resolveGeocoderConfig,
  rowCap,
  useAppStore,
} from "@geolibre/core";
import type { MapController } from "@geolibre/map";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Label,
  ScrollArea,
  Select,
} from "@geolibre/ui";
import type { Feature, FeatureCollection, Point } from "geojson";
import { Loader2, MapPin, Upload, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { parseDelimitedTextRows } from "../../lib/delimited-text";
import { sniffDelimiter } from "../../lib/deck-viz-input";
import { openLocalDataFileWithFallback } from "../../lib/tauri-io";

interface GeocodeDialogProps {
  mapControllerRef: React.RefObject<MapController | null>;
}

interface ParsedCsv {
  fileName: string;
  fields: string[];
  rows: Record<string, string>[];
}

/** Resolve a layer name from a CSV file name, dropping the extension. */
function layerNameFromFile(fileName: string): string {
  const leaf = fileName.split(/[\\/]/).pop() ?? fileName;
  const base = leaf.replace(/\.[^.]+$/, "");
  return `${base || "addresses"} (geocoded)`;
}

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

/**
 * Batch-geocode a CSV of addresses into a point layer.
 *
 * A CSV of addresses has no coordinates, so it cannot be loaded as a layer the
 * way the Vector tools operate; this dialog therefore reads the file directly
 * (mirroring the app's importTextFile path), lets the user pick the address
 * column, geocodes each row, and adds the matched points as a new layer.
 *
 * Requests are paced to one per ~1.1s and capped to respect Nominatim's public
 * usage policy; an overridden self-hosted endpoint relaxes both. The run is
 * cancellable via an AbortController, and any rows matched before a cancel are
 * still added to the map.
 */
export function GeocodeDialog({ mapControllerRef }: GeocodeDialogProps): ReactElement {
  const { t } = useTranslation();
  const open = useAppStore((s) => s.ui.geocodeOpen);
  const setGeocodeOpen = useAppStore((s) => s.setGeocodeOpen);
  const addGeoJsonLayer = useAppStore((s) => s.addGeoJsonLayer);
  const geocodingPrefs = useAppStore((s) => s.preferences.geocoding);

  const [csv, setCsv] = useState<ParsedCsv | null>(null);
  const [addressColumn, setAddressColumn] = useState<string>("");
  const [providerId, setProviderId] = useState<string>(() =>
    normalizeGeocodingProviderId(geocodingPrefs.providerId),
  );
  const [log, setLog] = useState<string[]>([]);
  const [running, setRunning] = useState(false);
  const [picking, setPicking] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const logEndRef = useRef<HTMLDivElement>(null);

  // Default the run to the configured provider: reset on open (so a prior
  // one-off choice does not persist into the next session) and follow a
  // settings change while the dialog is open and idle.
  useEffect(() => {
    if (open && !running) {
      setProviderId(normalizeGeocodingProviderId(geocodingPrefs.providerId));
    }
  }, [open, geocodingPrefs.providerId, running]);

  const config = useMemo(
    () => resolveGeocoderConfig({ ...geocodingPrefs, providerId }),
    [geocodingPrefs, providerId],
  );
  const provider = getGeocodingProvider(providerId);
  const missingApiKey = geocoderNeedsApiKey(config) && !config.apiKey;
  const cap = rowCap(config.forwardEndpoint);
  // Count only rows that will actually be geocoded (non-empty address), so the
  // cap warning matches the requests sent rather than the raw CSV row count.
  const geocodableCount =
    csv && addressColumn ? csvRowsToGeocodeRequests(csv.rows, [addressColumn]).length : 0;
  const willCap = Number.isFinite(cap) && geocodableCount > cap;

  const appendLog = useCallback((line: string) => {
    setLog((prev) => [...prev, line]);
  }, []);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ block: "end" });
  }, [log]);

  // Abort any in-flight run when the dialog closes so a paced loop does not keep
  // firing requests in the background.
  useEffect(() => {
    if (!open) abortRef.current?.abort();
  }, [open]);

  const handleChooseFile = useCallback(async () => {
    setPicking(true);
    try {
      const result = await openLocalDataFileWithFallback({
        filters: [{ name: "CSV", extensions: ["csv", "tsv", "txt"] }],
        accept: ".csv,.tsv,.txt",
        readText: true,
      });
      if (!result?.text) return;
      const delimiter = sniffDelimiter(result.text);
      const { fields, rows } = parseDelimitedTextRows(result.text, delimiter);
      setCsv({ fileName: result.path, fields, rows });
      setAddressColumn(fields[0] ?? "");
      setLog([]);
    } catch (error) {
      appendLog(t("geocode.error", { message: (error as Error).message }));
    } finally {
      setPicking(false);
    }
  }, [appendLog, t]);

  const handleRun = useCallback(async () => {
    if (!csv || !addressColumn) return;
    const controller = new AbortController();
    abortRef.current = controller;
    const { signal } = controller;
    setRunning(true);
    setLog([]);

    const requests = csvRowsToGeocodeRequests(csv.rows, [addressColumn]);
    const skippedEmpty = csv.rows.length - requests.length;
    const toProcess = Number.isFinite(cap) ? requests.slice(0, cap) : requests;
    const interval = geocoderMinIntervalMs(config.forwardEndpoint);

    appendLog(
      t("geocode.usingProvider", {
        provider: provider.label,
        endpoint: config.forwardEndpoint,
      }),
    );
    if (skippedEmpty > 0) {
      appendLog(t("geocode.skippedEmpty", { count: skippedEmpty }));
    }
    if (willCap) appendLog(t("geocode.rowCapWarning", { cap }));

    const features: Feature<Point>[] = [];
    const failed: number[] = [];
    let lastStartedAt: number | null = null;
    let cancelled = false;

    try {
      for (let i = 0; i < toProcess.length; i += 1) {
        const request = toProcess[i];
        const wait = nextDelayMs(lastStartedAt, performance.now(), interval);
        if (wait > 0) await sleep(wait, signal);
        lastStartedAt = performance.now();
        appendLog(
          t("geocode.progress", {
            current: i + 1,
            total: toProcess.length,
            address: request.address,
          }),
        );
        try {
          const results = await geocodeForward(request.address, {
            signal,
            config,
            limit: 1,
          });
          const feature = results[0] ? geocodeMatchToFeature(results[0], request.row) : null;
          if (feature) features.push(feature);
          else failed.push(request.index + 1);
        } catch (requestError) {
          // A cancel propagates to stop the whole batch; any other per-request
          // failure (e.g. an HTTP 429) is logged and the row is recorded as a
          // miss so the remaining rows still run.
          if (isAbortError(requestError)) throw requestError;
          appendLog(t("geocode.error", { message: (requestError as Error).message }));
          failed.push(request.index + 1);
        }
      }
    } catch (error) {
      if (isAbortError(error)) cancelled = true;
      else appendLog(t("geocode.error", { message: (error as Error).message }));
    }

    if (features.length > 0) {
      const fc: FeatureCollection = {
        type: "FeatureCollection",
        features,
      };
      const layerId = addGeoJsonLayer(layerNameFromFile(csv.fileName), fc);
      const layer = useAppStore.getState().layers.find((item) => item.id === layerId);
      if (layer) mapControllerRef.current?.fitLayer(layer);
    }

    if (cancelled) {
      appendLog(t("geocode.cancelled", { matched: features.length }));
    } else if (features.length === 0) {
      appendLog(t("geocode.noMatches"));
    } else {
      appendLog(
        t("geocode.summary", {
          matched: features.length,
          total: toProcess.length,
          failed: failed.length,
        }),
      );
    }
    if (!cancelled && failed.length > 0) {
      appendLog(t("geocode.failedRows", { rows: failed.join(", ") }));
    }

    abortRef.current = null;
    setRunning(false);
  }, [
    csv,
    addressColumn,
    cap,
    willCap,
    config,
    provider,
    appendLog,
    addGeoJsonLayer,
    mapControllerRef,
    t,
  ]);

  return (
    <Dialog
      open={open}
      onOpenChange={(next: boolean) => {
        if (!next) setGeocodeOpen(false);
      }}
    >
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <MapPin className="h-5 w-5" /> {t("geocode.title")}
          </DialogTitle>
          <DialogDescription>{t("geocode.description")}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              onClick={handleChooseFile}
              disabled={running || picking}
              className="gap-2"
            >
              {picking ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Upload className="h-4 w-4" />
              )}
              {t("geocode.chooseFile")}
            </Button>
            {csv ? (
              <span className="truncate text-sm text-muted-foreground">
                {t("geocode.fileLoaded", {
                  name: csv.fileName.split(/[\\/]/).pop() ?? csv.fileName,
                  count: csv.rows.length,
                })}
              </span>
            ) : (
              <span className="text-sm text-muted-foreground">{t("geocode.noFile")}</span>
            )}
          </div>

          <div className="flex flex-col gap-1">
            <Label className="text-xs">{t("geocode.provider")}</Label>
            <Select
              value={providerId}
              onChange={(e) => setProviderId(e.target.value)}
              disabled={running}
            >
              {GEOCODING_PROVIDERS.filter((p) => p.forward).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </Select>
            {/* `config.apiKey` check avoids doubling up with the amber missing-key warning below */}
            {geocoderNeedsApiKey(config) && !!config.apiKey ? (
              <p className="text-xs text-muted-foreground">{t("geocode.providerHint")}</p>
            ) : null}
          </div>

          {missingApiKey ? (
            <p className="text-xs text-amber-600 dark:text-amber-500">
              {t("geocode.apiKeyRequired", { provider: provider.label })}
            </p>
          ) : null}

          {provider.browserCorsRestricted ? (
            <p className="text-xs text-amber-600 dark:text-amber-500">{t("geocode.corsNote")}</p>
          ) : null}

          {csv ? (
            <div className="flex flex-col gap-1">
              <Label className="text-xs">{t("geocode.addressColumn")}</Label>
              <Select
                value={addressColumn}
                onChange={(e) => setAddressColumn(e.target.value)}
                disabled={running}
              >
                {csv.fields.map((field) => (
                  <option key={field} value={field}>
                    {field}
                  </option>
                ))}
              </Select>
            </div>
          ) : null}

          {csv && willCap ? (
            <p className="text-xs text-amber-600 dark:text-amber-500">
              {t("geocode.rowCapWarning", { cap })}
            </p>
          ) : null}

          <div className="flex gap-2">
            <Button
              onClick={handleRun}
              disabled={running || !csv || !addressColumn || missingApiKey}
              className="gap-2"
            >
              {running ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <MapPin className="h-4 w-4" />
              )}
              {t("geocode.run")}
            </Button>
            {running ? (
              <Button variant="outline" onClick={() => abortRef.current?.abort()} className="gap-2">
                <X className="h-4 w-4" />
                {t("geocode.cancel")}
              </Button>
            ) : null}
          </div>

          <ScrollArea className="h-40 rounded-md border bg-muted/30 p-2 font-mono text-xs">
            {log.length === 0 ? (
              <span className="text-muted-foreground">{t("geocode.outputPlaceholder")}</span>
            ) : (
              log.map((line, index) => (
                <div key={index} className="whitespace-pre-wrap">
                  {line}
                </div>
              ))
            )}
            <div ref={logEndRef} />
          </ScrollArea>
        </div>
      </DialogContent>
    </Dialog>
  );
}
