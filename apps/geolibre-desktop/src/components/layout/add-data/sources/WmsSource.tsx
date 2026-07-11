import { Button, Input, Label, Select } from "@geolibre/ui";
import { ListTree, Loader2 } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { DEFAULT_WMS_ENDPOINT, DEFAULT_WMS_LAYERS } from "../constants";
import {
  createBaseLayer,
  createWmsTileUrl,
  fetchWmsCapabilities,
  normalizeWmsVersion,
  serviceRequestErrorMessage,
  stripOgcOperationParams,
  wmsVersionFromEndpoint,
  type WmsLayerOption,
} from "../helpers";
import { ServiceLibrarySection } from "../ServiceLibrarySection";
import {
  serviceFieldBoolean,
  serviceFieldString,
  type ServiceFields,
} from "../service-library";
import { AddDataSourceForm, SampleDataSelect, useAddDataSource } from "../shared";

/**
 * Retains the WMS form input across dialog close/reopen (in memory, for the
 * session) so a user can add several layers from the same service without
 * re-entering the URL or re-retrieving its layer list each time.
 */
interface WmsFormCache {
  endpoint: string;
  layers: string;
  styles: string;
  format: string;
  transparent: boolean;
  tileSize: string;
  version: string;
  versionTouched: boolean;
  options: WmsLayerOption[];
}
let wmsFormCache: WmsFormCache | null = null;

export function WmsSource() {
  const { t } = useTranslation();
  const source = useAddDataSource(t("addData.wms.defaultName"));
  const [wmsEndpoint, setWmsEndpoint] = useState(wmsFormCache?.endpoint ?? "");
  const [wmsLayers, setWmsLayers] = useState(wmsFormCache?.layers ?? "");
  const [wmsStyles, setWmsStyles] = useState(wmsFormCache?.styles ?? "");
  const [wmsFormat, setWmsFormat] = useState(wmsFormCache?.format ?? "image/png");
  const [wmsTransparent, setWmsTransparent] = useState(
    wmsFormCache?.transparent ?? true,
  );
  const [wmsTileSize, setWmsTileSize] = useState(wmsFormCache?.tileSize ?? "256");
  const [wmsVersion, setWmsVersion] = useState(wmsFormCache?.version ?? "1.1.1");
  // True while the version has an explicit source — the selector, a pasted
  // URL's VERSION parameter, or a saved service entry. Capabilities
  // auto-detection only fills the version in when no explicit source exists.
  // Mirrored in a ref so the async retrieve handler reads the value current at
  // response time, not the one captured when the button was clicked.
  const [versionTouched, setVersionTouched] = useState(
    wmsFormCache?.versionTouched ?? false,
  );
  const versionTouchedRef = useRef(versionTouched);
  const markVersionTouched = (touched: boolean) => {
    versionTouchedRef.current = touched;
    setVersionTouched(touched);
  };
  const [layerOptions, setLayerOptions] = useState<WmsLayerOption[]>(
    wmsFormCache?.options ?? [],
  );
  const [isRetrieving, setIsRetrieving] = useState(false);
  const [retrieveError, setRetrieveError] = useState<string | null>(null);
  const layerListId = useId();

  // Persist the form input so reopening the dialog restores the URL, the fields,
  // and the retrieved layer list.
  useEffect(() => {
    wmsFormCache = {
      endpoint: wmsEndpoint,
      layers: wmsLayers,
      styles: wmsStyles,
      format: wmsFormat,
      transparent: wmsTransparent,
      tileSize: wmsTileSize,
      version: wmsVersion,
      versionTouched,
      options: layerOptions,
    };
  }, [
    wmsEndpoint,
    wmsLayers,
    wmsStyles,
    wmsFormat,
    wmsTransparent,
    wmsTileSize,
    wmsVersion,
    versionTouched,
    layerOptions,
  ]);
  // Guards against a stale in-flight retrieval overwriting the form after the
  // user has moved on: a monotonic token identifies the latest request, and the
  // AbortController cancels the previous one when a new request or an endpoint
  // edit supersedes it.
  const retrieveTokenRef = useRef(0);
  const retrieveAbortRef = useRef<AbortController | null>(null);

  const cancelRetrieve = () => {
    retrieveAbortRef.current?.abort();
    retrieveAbortRef.current = null;
  };

  // Abort an in-flight retrieval if the dialog closes mid-request, and advance
  // the token so its finally block cannot set state after unmount.
  useEffect(
    () => () => {
      retrieveTokenRef.current += 1;
      retrieveAbortRef.current?.abort();
    },
    [],
  );

  const handleRetrieveLayers = async () => {
    const endpoint = wmsEndpoint.trim();
    if (!endpoint) {
      setRetrieveError(t("addData.wms.errorUrl"));
      return;
    }
    retrieveAbortRef.current?.abort();
    const controller = new AbortController();
    retrieveAbortRef.current = controller;
    const token = ++retrieveTokenRef.current;
    const isStale = () =>
      token !== retrieveTokenRef.current || controller.signal.aborted;
    setIsRetrieving(true);
    setRetrieveError(null);
    try {
      const { layers: options, version } = await fetchWmsCapabilities(endpoint, {
        signal: controller.signal,
      });
      if (isStale()) return;
      if (options.length === 0) {
        setLayerOptions([]);
        setRetrieveError(t("addData.wms.noLayersFound"));
        return;
      }
      setLayerOptions(options);
      // Adopt the service's negotiated version so a 1.3.0-only server (e.g.
      // the IGN Géoplateforme raster endpoint) gets a GetMap it accepts —
      // unless the user already picked a version explicitly, since a server
      // can negotiate GetCapabilities and GetMap differently. Read the ref,
      // not the state: the user may have touched the selector while this
      // request was in flight.
      if (version && !versionTouchedRef.current) {
        setWmsVersion(normalizeWmsVersion(version));
      }
      // Preselect the first layer when the field is empty so a single click
      // leaves the form ready to submit.
      if (!wmsLayers.trim()) setWmsLayers(options[0].name);
    } catch (error) {
      if (isStale()) return;
      setLayerOptions([]);
      setRetrieveError(
        serviceRequestErrorMessage(error, t, t("addData.wms.retrieveError")),
      );
    } finally {
      if (token === retrieveTokenRef.current) setIsRetrieving(false);
    }
  };

  const getFields = (): ServiceFields => ({
    endpoint: wmsEndpoint,
    layers: wmsLayers,
    styles: wmsStyles,
    format: wmsFormat,
    transparent: wmsTransparent,
    tileSize: wmsTileSize,
    // Only persist the version when it has an explicit source; an untouched
    // default stays eligible for URL/capabilities auto-detection on reload.
    ...(versionTouched ? { version: wmsVersion } : {}),
  });

  const applyFields = (fields: ServiceFields) => {
    const endpoint = serviceFieldString(fields, "endpoint");
    setWmsEndpoint(endpoint);
    setWmsLayers(serviceFieldString(fields, "layers"));
    setWmsStyles(serviceFieldString(fields, "styles"));
    setWmsFormat(serviceFieldString(fields, "format", "image/png"));
    setWmsTransparent(serviceFieldBoolean(fields, "transparent", true));
    setWmsTileSize(serviceFieldString(fields, "tileSize", "256"));
    // A saved service predating the version field falls back to the endpoint's
    // own VERSION parameter (if any) rather than silently resetting to 1.1.1.
    // Normalize whatever was stored so a hand-edited value (e.g. "1.3") still
    // matches the selector's option pair. Either source is an explicit prior
    // choice, so capabilities auto-detection must not override it later.
    const savedVersion = serviceFieldString(fields, "version");
    const detectedVersion = wmsVersionFromEndpoint(endpoint);
    setWmsVersion(normalizeWmsVersion(savedVersion || detectedVersion || "1.1.1"));
    markVersionTouched(Boolean(savedVersion || detectedVersion));
    // The new endpoint's layers must be re-retrieved, so drop the old list and
    // cancel any retrieval still in flight for the previous endpoint.
    cancelRetrieve();
    setLayerOptions([]);
    setRetrieveError(null);
  };

  const handleSubmit = source.runSubmit(() => {
    const name = source.layerName.trim() || t("addData.wms.defaultName");
    if (!wmsEndpoint.trim()) throw new Error(t("addData.wms.errorUrl"));
    if (!wmsLayers.trim()) {
      throw new Error(t("addData.wms.errorLayers"));
    }
    const tileSize = Number(wmsTileSize) || 256;
    // Strip any leftover operation params (a pasted GetCapabilities URL) so the
    // GetMap request is not built with a conflicting duplicate REQUEST.
    const endpoint = stripOgcOperationParams(wmsEndpoint.trim(), "WMS");
    const version = normalizeWmsVersion(wmsVersion);
    const tileUrl = createWmsTileUrl({
      endpoint,
      layers: wmsLayers.trim(),
      styles: wmsStyles.trim(),
      format: wmsFormat,
      transparent: wmsTransparent,
      tileSize,
      version,
    });
    source.addAndClose(
      createBaseLayer(
        name,
        "wms",
        {
          type: "raster",
          tiles: [tileUrl],
          tileSize,
          url: endpoint,
          layers: wmsLayers.trim(),
          styles: wmsStyles.trim(),
          format: wmsFormat,
          transparent: wmsTransparent,
          version,
        },
        { service: "wms" },
      ),
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
      useServiceIcon
    >
      <div className="space-y-3">
        <ServiceLibrarySection
          kind="wms"
          layerName={source.layerName}
          getFields={getFields}
          onApply={(entry) => {
            source.setLayerName(entry.name);
            applyFields(entry.fields);
          }}
        />
        <div className="space-y-1.5">
          <Label htmlFor="wms-endpoint">{t("addData.common.serviceUrl")}</Label>
          <div className="flex gap-2">
            <Input
              id="wms-endpoint"
              placeholder={t("addData.wms.urlPlaceholder")}
              value={wmsEndpoint}
              onChange={(event) => {
                const value = event.target.value;
                const previous = wmsEndpoint;
                setWmsEndpoint(value);
                // A pasted URL often carries the service's VERSION (stripped
                // before the GetMap is built); adopt it so a 1.3.0-only server
                // works without a manual version change, and treat it as an
                // explicit source that capabilities auto-detection must not
                // override. A different service (origin + path changed) always
                // re-derives the version from its own URL — or the default —
                // so a choice made for the previous service cannot leak onto
                // it. Within the same service, only an actual change to the
                // URL's declared VERSION is adopted; fixing an unrelated typo
                // must not clobber a manual selection.
                const detected = wmsVersionFromEndpoint(value);
                const serviceChanged =
                  value.trim().split(/[?#]/)[0] !==
                  previous.trim().split(/[?#]/)[0];
                if (serviceChanged) {
                  setWmsVersion(detected ?? "1.1.1");
                  markVersionTouched(detected != null);
                } else if (
                  detected &&
                  detected !== wmsVersionFromEndpoint(previous)
                ) {
                  setWmsVersion(detected);
                  markVersionTouched(true);
                }
                // Layers belong to the previous endpoint; clear them (and cancel
                // any in-flight retrieval) so the list never reflects a
                // different service.
                if (layerOptions.length > 0 || isRetrieving) {
                  cancelRetrieve();
                  setLayerOptions([]);
                  setIsRetrieving(false);
                }
                if (retrieveError) setRetrieveError(null);
              }}
            />
            <Button
              type="button"
              variant="outline"
              onClick={handleRetrieveLayers}
              disabled={isRetrieving || !wmsEndpoint.trim()}
              className="shrink-0"
            >
              {isRetrieving ? (
                <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
              ) : (
                <ListTree className="mr-2 h-3.5 w-3.5" />
              )}
              {isRetrieving
                ? t("addData.wms.retrieving")
                : t("addData.wms.retrieveLayers")}
            </Button>
          </div>
          {retrieveError ? (
            <p className="text-xs text-destructive">{retrieveError}</p>
          ) : null}
          {layerOptions.length > 0 ? (
            <div className="space-y-1.5">
              <Label htmlFor={layerListId}>
                {t("addData.wms.retrievedLayers")}
              </Label>
              {/* A picker that lists every retrieved layer and fills the Layers
                  field below on select. Its own value stays empty (an action
                  menu, like Load sample data), so it always shows the full list
                  and can never mismatch the free-text field. */}
              <Select
                id={layerListId}
                value=""
                onChange={(event) => {
                  if (event.target.value) setWmsLayers(event.target.value);
                }}
              >
                <option value="" disabled>
                  {t("addData.wms.selectLayer", { count: layerOptions.length })}
                </option>
                {layerOptions.map((option) => (
                  <option key={option.name} value={option.name}>
                    {option.title === option.name
                      ? option.name
                      : `${option.title} (${option.name})`}
                  </option>
                ))}
              </Select>
            </div>
          ) : null}
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="wms-layers">{t("addData.wms.layers")}</Label>
            {/* Plain free-text field: holds the submitted LAYERS value and stays
                editable for a comma-separated composite value or manual entry.
                The retrieved-layers picker above fills it. */}
            <Input
              id="wms-layers"
              placeholder={t("addData.common.workspaceLayerPlaceholder")}
              value={wmsLayers}
              onChange={(event) => setWmsLayers(event.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="wms-styles">{t("addData.wms.styles")}</Label>
            <Input
              id="wms-styles"
              value={wmsStyles}
              onChange={(event) => setWmsStyles(event.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="wms-format">{t("addData.common.format")}</Label>
            <Select
              id="wms-format"
              value={wmsFormat}
              onChange={(event) => setWmsFormat(event.target.value)}
            >
              <option value="image/png">PNG</option>
              <option value="image/jpeg">JPEG</option>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="wms-tile-size">{t("addData.common.tileSize")}</Label>
            <Input
              id="wms-tile-size"
              inputMode="numeric"
              value={wmsTileSize}
              onChange={(event) => setWmsTileSize(event.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="wms-version">{t("addData.wms.version")}</Label>
            <Select
              id="wms-version"
              value={wmsVersion}
              onChange={(event) => {
                setWmsVersion(event.target.value);
                markVersionTouched(true);
              }}
            >
              <option value="1.1.1">1.1.1</option>
              <option value="1.3.0">1.3.0</option>
            </Select>
          </div>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={wmsTransparent}
            onChange={(event) => setWmsTransparent(event.target.checked)}
          />
          {t("addData.wms.transparent")}
        </label>
        <SampleDataSelect
          samples={[
            {
              label: t("addData.wms.sampleLabel"),
              value: { endpoint: DEFAULT_WMS_ENDPOINT, layers: DEFAULT_WMS_LAYERS },
            },
          ]}
          onSelect={applyFields}
        />
      </div>
    </AddDataSourceForm>
  );
}
