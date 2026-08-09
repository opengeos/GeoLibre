import {
  addArcGISLayer,
  ARCGIS_MAP_SERVICE_URL_ERROR,
  fetchArcGISMapServiceSublayers,
  parseArcGISLayerType,
  type ArcGISLayerType,
  type ArcGISMapServiceSublayer,
  type ArcGISSourceType,
} from "@geolibre/plugins";
import { Button, Input, Label, Select } from "@geolibre/ui";
import { ListTree, Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { createAppAPI } from "../../../../hooks/usePlugins";
import { DEFAULT_ARCGIS_URLS } from "../constants";
import { ServiceLibrarySection } from "../ServiceLibrarySection";
import { serviceFieldString, type ServiceFields } from "../service-library";
import { AddDataSourceForm, SampleDataSelect, useAddDataSource } from "../shared";

/**
 * Read an optional whole-number field (page size, feature cap) as a count.
 *
 * Blank, zero, and anything unparseable all mean "leave it to the default",
 * which is what `addArcGISLayer` does with `undefined`.
 *
 * @param value - The raw input value.
 * @returns The count, or undefined when the field is empty or not a count.
 */
function positiveCount(value: string): number | undefined {
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) && parsed >= 1 ? Math.floor(parsed) : undefined;
}

/** The example URL shown for each layer type, so the expected endpoint is clear. */
const URL_PLACEHOLDER_KEYS = {
  feature: "addData.arcgis.featureUrlPlaceholder",
  "vector-tile": "addData.arcgis.vectorTileUrlPlaceholder",
  "map-service": "addData.arcgis.mapServiceUrlPlaceholder",
  "image-service": "addData.arcgis.imageServiceUrlPlaceholder",
} as const satisfies Record<ArcGISLayerType, string>;

export function ArcGISSource() {
  const { t } = useTranslation();
  const source = useAddDataSource(t("addData.arcgis.defaultName"));
  const [arcgisLayerType, setArcgisLayerType] = useState<ArcGISLayerType>("feature");
  const [arcgisSourceType, setArcgisSourceType] = useState<ArcGISSourceType>("url");
  const [arcgisUrl, setArcgisUrl] = useState("");
  const [arcgisItemId, setArcgisItemId] = useState("");
  const [arcgisPortalUrl, setArcgisPortalUrl] = useState("");
  const [arcgisAccessToken, setArcgisAccessToken] = useState("");
  const [arcgisPageSize, setArcgisPageSize] = useState("");
  const [arcgisMaxFeatures, setArcgisMaxFeatures] = useState("");
  const [arcgisSublayers, setArcgisSublayers] = useState("");
  const [sublayerOptions, setSublayerOptions] = useState<ArcGISMapServiceSublayer[]>([]);
  const [isRetrievingSublayers, setIsRetrievingSublayers] = useState(false);
  const [sublayerError, setSublayerError] = useState<string | null>(null);
  const retrieveAbortRef = useRef<AbortController | null>(null);
  const retrievedSublayerUrlRef = useRef<string | null>(null);
  const [arcgisRenderingRule, setArcgisRenderingRule] = useState("");
  const [progress, setProgress] = useState<{ loaded: number; total: number | null } | null>(null);

  useEffect(() => () => retrieveAbortRef.current?.abort(), []);

  const resetSublayerCatalog = (clearSelection = false) => {
    retrieveAbortRef.current?.abort();
    retrieveAbortRef.current = null;
    retrievedSublayerUrlRef.current = null;
    setSublayerOptions([]);
    setSublayerError(null);
    setIsRetrievingSublayers(false);
    if (clearSelection) setArcgisSublayers("");
  };

  const handleRetrieveSublayers = async () => {
    resetSublayerCatalog();
    const controller = new AbortController();
    retrieveAbortRef.current = controller;
    setIsRetrievingSublayers(true);
    setSublayerError(null);
    try {
      const layers = await fetchArcGISMapServiceSublayers({
        url: arcgisUrl,
        token: arcgisAccessToken || undefined,
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      setSublayerOptions(layers);
      retrievedSublayerUrlRef.current = arcgisUrl.trim();
      if (layers.length === 0) setSublayerError(t("addData.arcgis.noSublayersFound"));
    } catch (error) {
      if (controller.signal.aborted) return;
      setSublayerOptions([]);
      setSublayerError(
        error instanceof Error && error.message === ARCGIS_MAP_SERVICE_URL_ERROR
          ? t("addData.arcgis.errorMapServiceUrl")
          : error instanceof Error
            ? error.message
            : t("addData.arcgis.retrieveError"),
      );
    } finally {
      if (!controller.signal.aborted) setIsRetrievingSublayers(false);
    }
  };

  const selectedSublayerIds = new Set(
    arcgisSublayers.split(/[\s,]+/).filter((id) => /^\d+$/.test(id)),
  );
  const toggleSublayer = (id: number, selected: boolean) => {
    const next = new Set(selectedSublayerIds);
    if (selected) next.add(String(id));
    else next.delete(String(id));
    setArcgisSublayers([...next].sort((a, b) => Number(a) - Number(b)).join(","));
  };

  // The access token is intentionally excluded from saved fields — credentials
  // must not be persisted to the shared, exportable service library.
  const getFields = (): ServiceFields => ({
    layerType: arcgisLayerType,
    sourceType: arcgisSourceType,
    url: arcgisUrl,
    itemId: arcgisItemId,
    portalUrl: arcgisPortalUrl,
    pageSize: arcgisPageSize,
    maxFeatures: arcgisMaxFeatures,
    sublayers: arcgisSublayers,
    renderingRule: arcgisRenderingRule,
  });

  const applyFields = (fields: ServiceFields) => {
    resetSublayerCatalog(true);
    setArcgisLayerType(parseArcGISLayerType(serviceFieldString(fields, "layerType")));
    setArcgisSourceType(
      serviceFieldString(fields, "sourceType") === "portal-item" ? "portal-item" : "url",
    );
    setArcgisUrl(serviceFieldString(fields, "url"));
    setArcgisItemId(serviceFieldString(fields, "itemId"));
    setArcgisPortalUrl(serviceFieldString(fields, "portalUrl"));
    setArcgisPageSize(serviceFieldString(fields, "pageSize"));
    setArcgisMaxFeatures(serviceFieldString(fields, "maxFeatures"));
    setArcgisSublayers(serviceFieldString(fields, "sublayers"));
    setArcgisRenderingRule(serviceFieldString(fields, "renderingRule"));
    // Tokens are never saved, so clear any token typed for a previous entry to
    // avoid sending it to the newly selected service's endpoint.
    setArcgisAccessToken("");
  };

  const handleArcgisLayerTypeChange = (nextLayerType: ArcGISLayerType) => {
    resetSublayerCatalog();
    const currentUrl = arcgisUrl.trim();
    setArcgisLayerType(nextLayerType);
    // Keep a loaded sample URL in sync with the layer type, but leave an
    // empty input (or the user's own URL) untouched so nothing is prefilled.
    if (currentUrl && Object.values(DEFAULT_ARCGIS_URLS).includes(currentUrl)) {
      setArcgisUrl(DEFAULT_ARCGIS_URLS[nextLayerType]);
    }
  };

  const handleSubmit = source.runSubmit(async () => {
    const name = source.layerName.trim() || t("addData.arcgis.defaultName");
    setProgress(null);
    try {
      await addArcGISLayer(createAppAPI(source.shell.mapControllerRef), {
        beforeLayerId: source.beforeLayer,
        itemId: arcgisItemId.trim() || undefined,
        layerType: arcgisLayerType,
        maxFeatures: positiveCount(arcgisMaxFeatures),
        name,
        // A feature layer can take dozens of requests to download, so keep the
        // running count in front of the user instead of an inert spinner.
        onProgress: (loaded, total) => setProgress({ loaded, total }),
        pageSize: positiveCount(arcgisPageSize),
        portalUrl: arcgisPortalUrl.trim() || undefined,
        renderingRule: arcgisRenderingRule.trim() || undefined,
        sourceType: arcgisSourceType,
        sublayers: arcgisSublayers.trim() || undefined,
        token: arcgisAccessToken.trim() || undefined,
        url: arcgisUrl.trim() || undefined,
      });
    } finally {
      setProgress(null);
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
        <ServiceLibrarySection
          kind="arcgis"
          layerName={source.layerName}
          getFields={getFields}
          onApply={(entry) => {
            source.setLayerName(entry.name);
            applyFields(entry.fields);
          }}
        />
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="arcgis-layer-type">{t("addData.common.layerType")}</Label>
            <Select
              id="arcgis-layer-type"
              value={arcgisLayerType}
              onChange={(event) =>
                handleArcgisLayerTypeChange(event.target.value as ArcGISLayerType)
              }
            >
              <option value="feature">{t("addData.arcgis.featureLayer")}</option>
              <option value="vector-tile">{t("addData.arcgis.vectorTileLayer")}</option>
              <option value="map-service">{t("addData.arcgis.mapServiceLayer")}</option>
              <option value="image-service">{t("addData.arcgis.imageServiceLayer")}</option>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="arcgis-source-type">{t("addData.common.sourceType")}</Label>
            <Select
              id="arcgis-source-type"
              value={arcgisSourceType}
              onChange={(event) => {
                resetSublayerCatalog();
                setArcgisSourceType(event.target.value as ArcGISSourceType);
              }}
            >
              <option value="url">{t("addData.common.serviceUrl")}</option>
              <option value="portal-item">{t("addData.arcgis.portalItemId")}</option>
            </Select>
          </div>
        </div>
        {arcgisSourceType === "url" ? (
          <div className="space-y-1.5">
            <Label htmlFor="arcgis-url">{t("addData.common.serviceUrl")}</Label>
            <Input
              id="arcgis-url"
              placeholder={t(URL_PLACEHOLDER_KEYS[arcgisLayerType])}
              value={arcgisUrl}
              onChange={(event) => {
                const nextUrl = event.target.value;
                const clearSelection =
                  retrievedSublayerUrlRef.current !== null &&
                  nextUrl.trim() !== retrievedSublayerUrlRef.current;
                resetSublayerCatalog(clearSelection);
                setArcgisUrl(nextUrl);
              }}
            />
          </div>
        ) : (
          <div className="space-y-1.5">
            <Label htmlFor="arcgis-item-id">{t("addData.arcgis.portalItemId")}</Label>
            <Input
              id="arcgis-item-id"
              value={arcgisItemId}
              onChange={(event) => setArcgisItemId(event.target.value)}
            />
          </div>
        )}
        <div className="space-y-1.5">
          <Label htmlFor="arcgis-portal-url">{t("addData.arcgis.portalUrl")}</Label>
          <Input
            id="arcgis-portal-url"
            placeholder={t("addData.arcgis.portalUrlPlaceholder")}
            value={arcgisPortalUrl}
            onChange={(event) => setArcgisPortalUrl(event.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="arcgis-access-token">{t("addData.arcgis.accessToken")}</Label>
          <Input
            id="arcgis-access-token"
            type="password"
            autoComplete="off"
            placeholder={t("addData.common.optional")}
            value={arcgisAccessToken}
            onChange={(event) => {
              resetSublayerCatalog();
              setArcgisAccessToken(event.target.value);
            }}
          />
        </div>
        {arcgisLayerType === "feature" ? (
          <div className="space-y-1.5">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="arcgis-page-size">{t("addData.arcgis.pageSize")}</Label>
                <Input
                  id="arcgis-page-size"
                  type="number"
                  min={1}
                  step={1}
                  inputMode="numeric"
                  placeholder={t("addData.arcgis.pageSizePlaceholder")}
                  value={arcgisPageSize}
                  onChange={(event) => setArcgisPageSize(event.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="arcgis-max-features">{t("addData.arcgis.maxFeatures")}</Label>
                <Input
                  id="arcgis-max-features"
                  type="number"
                  min={1}
                  step={1}
                  inputMode="numeric"
                  placeholder={t("addData.arcgis.maxFeaturesPlaceholder")}
                  value={arcgisMaxFeatures}
                  onChange={(event) => setArcgisMaxFeatures(event.target.value)}
                />
              </div>
            </div>
            <p className="text-xs text-muted-foreground">{t("addData.arcgis.pagingHint")}</p>
          </div>
        ) : null}
        {arcgisLayerType === "map-service" ? (
          <div className="space-y-1.5">
            <Label htmlFor="arcgis-sublayers">{t("addData.arcgis.sublayers")}</Label>
            <div className="flex gap-2">
              <Input
                id="arcgis-sublayers"
                placeholder={t("addData.arcgis.sublayersPlaceholder")}
                value={arcgisSublayers}
                onChange={(event) => setArcgisSublayers(event.target.value)}
              />
              <Button
                type="button"
                variant="outline"
                className="shrink-0"
                disabled={isRetrievingSublayers || arcgisSourceType !== "url" || !arcgisUrl.trim()}
                onClick={handleRetrieveSublayers}
              >
                {isRetrievingSublayers ? (
                  <Loader2 className="me-2 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <ListTree className="me-2 h-3.5 w-3.5" />
                )}
                {isRetrievingSublayers
                  ? t("addData.arcgis.retrievingSublayers")
                  : t("addData.arcgis.retrieveSublayers")}
              </Button>
            </div>
            {sublayerError ? <p className="text-xs text-destructive">{sublayerError}</p> : null}
            {sublayerOptions.length > 0 ? (
              <fieldset className="max-h-48 space-y-1 overflow-y-auto rounded-md border p-2">
                <legend className="sr-only">{t("addData.arcgis.availableSublayers")}</legend>
                {sublayerOptions.map((layer) => (
                  <label
                    key={layer.id}
                    className="flex cursor-pointer items-start gap-2 rounded px-1 py-1 text-sm hover:bg-muted"
                  >
                    <input
                      type="checkbox"
                      className="mt-0.5 h-4 w-4 accent-primary"
                      checked={selectedSublayerIds.has(String(layer.id))}
                      onChange={(event) => toggleSublayer(layer.id, event.target.checked)}
                    />
                    <span>
                      {layer.name} <span className="text-muted-foreground">({layer.id})</span>
                    </span>
                  </label>
                ))}
              </fieldset>
            ) : null}
            <p className="text-xs text-muted-foreground">{t("addData.arcgis.sublayersHint")}</p>
          </div>
        ) : null}
        {arcgisLayerType === "image-service" ? (
          <div className="space-y-1.5">
            <Label htmlFor="arcgis-rendering-rule">{t("addData.arcgis.renderingRule")}</Label>
            <Input
              id="arcgis-rendering-rule"
              placeholder={t("addData.arcgis.renderingRulePlaceholder")}
              value={arcgisRenderingRule}
              onChange={(event) => setArcgisRenderingRule(event.target.value)}
            />
            <p className="text-xs text-muted-foreground">{t("addData.arcgis.renderingRuleHint")}</p>
          </div>
        ) : null}
        {/* Mounted for the life of the panel, not only while a download runs:
            several screen readers ignore a live region that appears together
            with its first text. `sr-only` keeps the empty state out of the
            visual layout (it is positioned, so it adds no gap) while leaving
            the region in the accessibility tree. */}
        <p className={progress ? "text-sm text-muted-foreground" : "sr-only"} aria-live="polite">
          {progress === null
            ? ""
            : progress.total === null
              ? t("addData.arcgis.loadingProgressUnknown", {
                  loaded: progress.loaded.toLocaleString(),
                })
              : t("addData.arcgis.loadingProgress", {
                  loaded: progress.loaded.toLocaleString(),
                  total: progress.total.toLocaleString(),
                })}
        </p>
        <SampleDataSelect
          samples={[
            {
              label: t("addData.arcgis.sampleFeatureLabel"),
              value: {
                layerType: "feature",
                sourceType: "url",
                url: DEFAULT_ARCGIS_URLS.feature,
              },
            },
            {
              label: t("addData.arcgis.sampleVectorTileLabel"),
              value: {
                layerType: "vector-tile",
                sourceType: "url",
                url: DEFAULT_ARCGIS_URLS["vector-tile"],
              },
            },
            {
              label: t("addData.arcgis.sampleMapServiceLabel"),
              value: {
                layerType: "map-service",
                sourceType: "url",
                url: DEFAULT_ARCGIS_URLS["map-service"],
              },
            },
            {
              label: t("addData.arcgis.sampleImageServiceLabel"),
              value: {
                layerType: "image-service",
                sourceType: "url",
                url: DEFAULT_ARCGIS_URLS["image-service"],
                // 3DEP is a single-band elevation service, so the default
                // grayscale stretch reads as a flat gray sheet. The hillshade
                // rule is what makes the sample look like terrain.
                renderingRule: '{"rasterFunction":"Hillshade"}',
              },
            },
          ]}
          onSelect={applyFields}
        />
      </div>
    </AddDataSourceForm>
  );
}
