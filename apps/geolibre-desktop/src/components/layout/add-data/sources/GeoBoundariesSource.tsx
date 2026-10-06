import { Button, Label, Select } from "@geolibre/ui";
import type { FeatureCollection } from "geojson";
import { useEffect, useRef, useState } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import {
  geoBoundariesAttribution,
  geoBoundariesCountriesUrl,
  geoBoundariesDownloadUrl,
  geoBoundariesLevelsUrl,
  parseGeoBoundariesCountries,
  parseGeoBoundariesLevels,
  type GeoBoundariesCountry,
  type GeoBoundariesLevel,
} from "../../../../lib/geoboundaries";
import { createBaseLayer, serviceRequestErrorMessage } from "../helpers";
import { AddDataSourceForm, useAddDataSource } from "../shared";

const GEOBOUNDARIES_SOURCE_KIND = "geoboundaries";

// The country list is ~400 KB and never changes within a session, and a
// country's level list is reused when the user switches back to it, so both
// are cached for the life of the page. A failed request is evicted so the
// next dialog open retries it.
let countriesRequest: Promise<GeoBoundariesCountry[]> | null = null;
const levelsRequests = new Map<string, Promise<GeoBoundariesLevel[]>>();

// API lists answer in about a second; a full-resolution ADM3+ file can be tens
// of MB, so the download gets more room.
const LIST_TIMEOUT_MS = 30_000;
const DOWNLOAD_TIMEOUT_MS = 120_000;

class HttpStatusError extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`);
  }
}

class InvalidJsonError extends Error {}

async function fetchJson(url: string, signal: AbortSignal): Promise<unknown> {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new HttpStatusError(response.status);
  // Read the body before parsing, so a dropped connection, timeout, or abort
  // mid-body surfaces as a request failure rather than as invalid data.
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    // A proxy or CDN error page can arrive as a 200 HTML body.
    throw new InvalidJsonError("Response was not valid JSON");
  }
}

/** Maps a geoBoundaries request failure to a translated message. */
function requestErrorMessage(err: unknown, t: TFunction, fallback: string): string {
  if (err instanceof HttpStatusError) {
    return t("addData.common.requestFailed", { status: err.status });
  }
  if (err instanceof InvalidJsonError) return t("addData.geoBoundaries.errorInvalid");
  return serviceRequestErrorMessage(err, t, fallback);
}

function loadCountries(): Promise<GeoBoundariesCountry[]> {
  countriesRequest ??= fetchJson(geoBoundariesCountriesUrl(), AbortSignal.timeout(LIST_TIMEOUT_MS))
    .then(parseGeoBoundariesCountries)
    .catch((err: unknown) => {
      countriesRequest = null;
      throw err;
    });
  return countriesRequest;
}

function loadLevels(iso: string): Promise<GeoBoundariesLevel[]> {
  let request = levelsRequests.get(iso);
  if (!request) {
    request = fetchJson(geoBoundariesLevelsUrl(iso), AbortSignal.timeout(LIST_TIMEOUT_MS))
      .then(parseGeoBoundariesLevels)
      .catch((err: unknown) => {
        levelsRequests.delete(iso);
        throw err;
      });
    levelsRequests.set(iso, request);
  }
  return request;
}

function isFeatureCollection(value: unknown): value is FeatureCollection {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "FeatureCollection" &&
    Array.isArray((value as { features?: unknown }).features)
  );
}

export function GeoBoundariesSource() {
  const { t } = useTranslation();
  const [defaultName] = useState(() => t("addData.geoBoundaries.defaultName"));
  const source = useAddDataSource(defaultName);
  const [countries, setCountries] = useState<GeoBoundariesCountry[] | null>(null);
  const [iso, setIso] = useState("");
  const [levels, setLevels] = useState<GeoBoundariesLevel[] | null>(null);
  const [levelId, setLevelId] = useState("");
  const [simplified, setSimplified] = useState(true);
  const [countriesError, setCountriesError] = useState<string | null>(null);
  const [countriesAttempt, setCountriesAttempt] = useState(0);
  const [levelsError, setLevelsError] = useState<string | null>(null);
  // Aborts an in-flight boundary download when the dialog closes.
  const downloadAbortRef = useRef<AbortController | null>(null);
  useEffect(() => () => downloadAbortRef.current?.abort(), []);
  // The name last filled in from the selection, so a name the user typed is
  // never overwritten when they change the country or level.
  const autoNameRef = useRef(defaultName);

  useEffect(() => {
    let cancelled = false;
    setCountriesError(null);
    loadCountries()
      .then((list) => {
        if (!cancelled) setCountries(list);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setCountriesError(requestErrorMessage(err, t, t("addData.geoBoundaries.errorCountries")));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [countriesAttempt, t]);

  useEffect(() => {
    setLevels(null);
    setLevelId("");
    if (!iso) return;
    let cancelled = false;
    setLevelsError(null);
    loadLevels(iso)
      .then((list) => {
        if (cancelled) return;
        setLevels(list);
        // Default to the finest level, the usual reason to open this dialog.
        setLevelId(list.at(-1)?.level ?? "");
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setLevelsError(requestErrorMessage(err, t, t("addData.geoBoundaries.errorLevels")));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [iso, t]);

  const selectedLevel = levels?.find((level) => level.level === levelId) ?? null;

  useEffect(() => {
    if (!selectedLevel) return;
    const autoName = `${selectedLevel.countryName} ${selectedLevel.level}`;
    // Read the ref now: React runs the updater later, after it is reassigned.
    const previousAutoName = autoNameRef.current;
    source.setLayerName((current) =>
      current.trim() && current !== previousAutoName ? current : autoName,
    );
    autoNameRef.current = autoName;
    // source.setLayerName is a stable state setter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedLevel]);

  const levelLabel = (level: GeoBoundariesLevel) => {
    const name = level.canonicalName
      ? t("addData.geoBoundaries.levelNamed", { level: level.level, name: level.canonicalName })
      : level.level;
    return level.unitCount
      ? t("addData.geoBoundaries.levelUnits", {
          label: name,
          count: level.unitCount,
          formattedCount: level.unitCount.toLocaleString(),
        })
      : name;
  };

  const handleSubmit = source.runSubmit(async () => {
    if (!iso) throw new Error(t("addData.geoBoundaries.errorCountry"));
    if (!selectedLevel) throw new Error(t("addData.geoBoundaries.errorLevel"));
    const url = geoBoundariesDownloadUrl(selectedLevel, simplified);
    const controller = new AbortController();
    downloadAbortRef.current = controller;
    let geojson: unknown;
    try {
      geojson = await fetchJson(
        url,
        AbortSignal.any([controller.signal, AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)]),
      );
    } catch (err) {
      throw new Error(requestErrorMessage(err, t, t("addData.geoBoundaries.errorDownload")));
    } finally {
      if (downloadAbortRef.current === controller) downloadAbortRef.current = null;
    }
    if (!isFeatureCollection(geojson)) throw new Error(t("addData.geoBoundaries.errorInvalid"));
    const name = source.layerName.trim() || `${selectedLevel.countryName} ${selectedLevel.level}`;

    source.addAndClose(
      {
        ...createBaseLayer(
          name,
          "geojson",
          { type: "geojson", url, attribution: geoBoundariesAttribution(selectedLevel) },
          {
            sourceKind: GEOBOUNDARIES_SOURCE_KIND,
            featureCount: geojson.features.length,
            iso: selectedLevel.iso,
            adminLevel: selectedLevel.level,
            simplified: simplified && Boolean(selectedLevel.simplifiedGeojsonUrl),
            license: selectedLevel.license,
          },
          { geojson },
        ),
        geojson,
        sourcePath: url,
      },
      { fit: true },
    );
  });

  const noLevels = levels !== null && levels.length === 0;

  return (
    <AddDataSourceForm
      layerName={source.layerName}
      onLayerNameChange={source.setLayerName}
      beforeLayerId={source.beforeLayerId}
      onBeforeLayerIdChange={source.setBeforeLayerId}
      onSubmit={handleSubmit}
      error={source.error ?? levelsError ?? countriesError}
      submitDisabled={source.isSubmitting || !selectedLevel}
      useServiceIcon
    >
      <div className="space-y-3">
        <p className="text-xs text-muted-foreground">{t("addData.geoBoundaries.intro")}</p>
        <div className="space-y-1.5">
          <Label htmlFor="geoboundaries-country">{t("addData.geoBoundaries.country")}</Label>
          <Select
            id="geoboundaries-country"
            value={iso}
            disabled={countries === null}
            onChange={(event) => setIso(event.target.value)}
          >
            <option value="" disabled>
              {countries !== null
                ? t("addData.geoBoundaries.countryPlaceholder")
                : countriesError
                  ? t("addData.geoBoundaries.countriesUnavailable")
                  : t("addData.common.loading")}
            </option>
            {countries?.map((country) => (
              <option key={country.iso} value={country.iso}>
                {country.name} ({country.iso})
              </option>
            ))}
          </Select>
          {countriesError ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setCountriesAttempt((attempt) => attempt + 1)}
            >
              {t("addData.geoBoundaries.retry")}
            </Button>
          ) : null}
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="geoboundaries-level">{t("addData.geoBoundaries.level")}</Label>
          <Select
            id="geoboundaries-level"
            value={levelId}
            disabled={!levels || noLevels}
            onChange={(event) => setLevelId(event.target.value)}
          >
            {!levels ? (
              <option value="" disabled>
                {iso ? t("addData.common.loading") : t("addData.geoBoundaries.levelPlaceholder")}
              </option>
            ) : null}
            {levels?.map((level) => (
              <option key={level.level} value={level.level}>
                {levelLabel(level)}
              </option>
            ))}
          </Select>
          {noLevels ? (
            <p className="text-xs text-muted-foreground">{t("addData.geoBoundaries.noLevels")}</p>
          ) : null}
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={simplified}
            onChange={(event) => setSimplified(event.target.checked)}
          />
          {t("addData.geoBoundaries.simplified")}
        </label>
        {!simplified ? (
          <p className="text-xs text-muted-foreground">
            {t("addData.geoBoundaries.fullGeometryNote")}
          </p>
        ) : null}
        {selectedLevel?.license ? (
          <p className="text-xs text-muted-foreground">
            {t("addData.geoBoundaries.license", { license: selectedLevel.license })}
          </p>
        ) : null}
      </div>
    </AddDataSourceForm>
  );
}
