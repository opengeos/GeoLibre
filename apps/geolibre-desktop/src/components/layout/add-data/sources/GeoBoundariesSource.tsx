import { Label, Select } from "@geolibre/ui";
import type { FeatureCollection } from "geojson";
import { useEffect, useRef, useState } from "react";
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

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

function loadCountries(): Promise<GeoBoundariesCountry[]> {
  countriesRequest ??= fetchJson(geoBoundariesCountriesUrl())
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
    request = fetchJson(geoBoundariesLevelsUrl(iso))
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
  const [loadError, setLoadError] = useState<string | null>(null);
  // The name last filled in from the selection, so a name the user typed is
  // never overwritten when they change the country or level.
  const autoNameRef = useRef(defaultName);

  useEffect(() => {
    let cancelled = false;
    loadCountries()
      .then((list) => {
        if (!cancelled) setCountries(list);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setLoadError(
            serviceRequestErrorMessage(err, t, t("addData.geoBoundaries.errorCountries")),
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, [t]);

  useEffect(() => {
    setLevels(null);
    setLevelId("");
    if (!iso) return;
    let cancelled = false;
    setLoadError(null);
    loadLevels(iso)
      .then((list) => {
        if (cancelled) return;
        setLevels(list);
        // Default to the finest level, the usual reason to open this dialog.
        setLevelId(list.at(-1)?.level ?? "");
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setLoadError(serviceRequestErrorMessage(err, t, t("addData.geoBoundaries.errorLevels")));
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
    let geojson: unknown;
    try {
      geojson = await fetchJson(url);
    } catch (err) {
      throw new Error(serviceRequestErrorMessage(err, t, t("addData.geoBoundaries.errorDownload")));
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
      error={source.error ?? loadError}
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
              {countries === null
                ? t("addData.common.loading")
                : t("addData.geoBoundaries.countryPlaceholder")}
            </option>
            {countries?.map((country) => (
              <option key={country.iso} value={country.iso}>
                {country.name} ({country.iso})
              </option>
            ))}
          </Select>
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
        {selectedLevel?.license ? (
          <p className="text-xs text-muted-foreground">
            {t("addData.geoBoundaries.license", { license: selectedLevel.license })}
          </p>
        ) : null}
      </div>
    </AddDataSourceForm>
  );
}
