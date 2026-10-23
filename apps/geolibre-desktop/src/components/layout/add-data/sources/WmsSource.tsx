import { Button, Input, Label, Select } from "@geolibre/ui";
import { ListTree, Loader2 } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { buildWmsLayer } from "../apply-service";
import {
  DEFAULT_WMS_ENDPOINT,
  DEFAULT_WMS_LAYERS,
  GEBCO_WMS_ENDPOINT,
  GEBCO_WMS_LAYERS,
  NLCD_WMS_ENDPOINT,
  NLCD_WMS_LAYERS,
} from "../constants";
import {
  fetchWmsCapabilities,
  isServiceFormUrl,
  normalizeWmsVersion,
  serviceRequestErrorMessage,
  stripOgcOperationParams,
  wmsCrsChoices,
  wmsLayersQueryable,
  pickWmsCrs,
  usableWmsCrs,
  wmsLayersAdvertiseCrs,
  wmsVersionFromEndpoint,
  type WmsLayerOption,
} from "../helpers";
import { routeWmsLayerThroughNativeProtocol } from "../../../../lib/xyz-url";
import { isHttpWmsUrl } from "../../../../lib/native-wms-url";
import { reprojectableWmsCodes, reprojectableWmsCrs } from "../../../../lib/wms-projected";
import { isTauri } from "../../../../lib/tauri-io";
import { ServiceLibrarySection } from "../ServiceLibrarySection";
import { serviceFieldBoolean, serviceFieldString, type ServiceFields } from "../service-library";
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
  crs: string;
  options: WmsLayerOption[];
}
let wmsFormCache: WmsFormCache | null = null;

export function WmsSource({
  initialUrl = "",
  initialLayers = "",
}: {
  initialUrl?: string;
  initialLayers?: string;
}) {
  const { t } = useTranslation();
  const source = useAddDataSource(t("addData.wms.defaultName"));
  const [wmsEndpoint, setWmsEndpoint] = useState(initialUrl || wmsFormCache?.endpoint || "");
  // A deep link brings its own service, so everything the cache holds *about a
  // service* belongs to a different one: its layers, styles, retrieved layer
  // list and negotiated version. Pairing a fresh endpoint with any of those
  // would describe a service this form is no longer pointed at. Generic
  // preferences (image format, transparency, tile size) still carry over.
  const serviceCache = initialUrl ? null : wmsFormCache;
  const [wmsLayers, setWmsLayers] = useState(initialLayers || (serviceCache?.layers ?? ""));
  const [wmsStyles, setWmsStyles] = useState(serviceCache?.styles ?? "");
  const [wmsFormat, setWmsFormat] = useState(wmsFormCache?.format ?? "image/png");
  const [wmsTransparent, setWmsTransparent] = useState(wmsFormCache?.transparent ?? true);
  const [wmsTileSize, setWmsTileSize] = useState(wmsFormCache?.tileSize ?? "256");
  const [wmsVersion, setWmsVersion] = useState(serviceCache?.version ?? "1.1.1");
  // True while the version has an explicit source — the selector, a pasted
  // URL's VERSION parameter, or a saved service entry. Capabilities
  // auto-detection only fills the version in when no explicit source exists.
  // Mirrored in a ref so the async retrieve handler reads the value current at
  // response time, not the one captured when the button was clicked.
  const [versionTouched, setVersionTouched] = useState(serviceCache?.versionTouched ?? false);
  const versionTouchedRef = useRef(versionTouched);
  const markVersionTouched = (touched: boolean) => {
    versionTouchedRef.current = touched;
    setVersionTouched(touched);
  };
  const [layerOptions, setLayerOptions] = useState<WmsLayerOption[]>(serviceCache?.options ?? []);
  // The CRS picked in the selector or restored from a saved service; empty for
  // the default. It applies only while the layers offer it (see wmsCrs below).
  const [wmsCrsPick, setWmsCrsPick] = useState(serviceCache?.crs ?? "");
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
      crs: wmsCrsPick,
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
    wmsCrsPick,
    layerOptions,
  ]);

  // The CRS codes every selected layer advertises. The desktop tile protocol
  // reprojects them into Web Mercator, so there the user can request a layer
  // in a CRS of its own; the web build cannot, and keeps EPSG:3857.
  const advertisedCrs = useMemo(
    () => wmsCrsChoices(layerOptions, wmsLayers, wmsVersion),
    [layerOptions, wmsLayers, wmsVersion],
  );
  // Of those, and of the user's own pick (a saved service may carry one), the
  // ones the tile protocol can reproject: an EPSG code missing from its tables
  // cannot be. The web build checks too, so its note promises only CRSs the
  // desktop app can draw.
  const usablePick = usableWmsCrs(wmsCrsPick, wmsVersion);
  const checkedKey = [...new Set([...advertisedCrs, ...(usablePick ? [usablePick] : [])])].join(
    ",",
  );
  // Keyed by the list it was computed for, so a stale result never applies.
  const [reprojectable, setReprojectable] = useState<{ key: string; codes: ReadonlySet<string> }>({
    key: "",
    codes: new Set(),
  });
  useEffect(() => {
    if (!checkedKey) return;
    let cancelled = false;
    void reprojectableWmsCodes(checkedKey.split(",")).then((codes) => {
      if (!cancelled) setReprojectable({ key: checkedKey, codes: new Set(codes) });
    });
    return () => {
      cancelled = true;
    };
  }, [checkedKey]);
  const reprojectableReady = reprojectable.key === checkedKey;
  const canDraw = (code: string) => reprojectableReady && reprojectable.codes.has(code);
  const reprojectableChoices = advertisedCrs.filter(canDraw);
  const crsChoices = isTauri() ? reprojectableChoices : advertisedCrs;
  const layersAdvertiseCrs = wmsLayersAdvertiseCrs(layerOptions, wmsLayers);
  // A pick the tile protocol turned out unable to draw is dropped, so the form
  // never claims a reprojection the submit would not do.
  const pickUndrawable =
    isTauri() && reprojectableReady && usablePick !== undefined && !canDraw(usablePick);
  const pickedCrs = pickWmsCrs(
    crsChoices,
    pickUndrawable ? "" : wmsCrsPick,
    wmsVersion,
    layersAdvertiseCrs,
  );
  const wmsCrs = isTauri() ? pickedCrs : "EPSG:3857";
  // Without retrieved layers (typed by hand, or a saved service) the selector
  // still shows the saved CRS and lets the user go back to EPSG:3857.
  const crsOptions = crsChoices.length > 0 ? crsChoices : [...new Set([wmsCrs, "EPSG:3857"])];
  const showCrs = isTauri() && crsOptions.some((code) => code !== "EPSG:3857");
  const showCrsWebNote =
    !isTauri() && reprojectableChoices.length > 0 && !reprojectableChoices.includes("EPSG:3857");
  // The selected layers offer only CRSs this build cannot reproject: say so
  // rather than silently requesting Web Mercator, which they do not offer.
  const showCrsUnsupportedNote =
    isTauri() && reprojectableReady && advertisedCrs.length > 0 && crsChoices.length === 0;
  // The saved or picked CRS cannot be drawn and the layers offer nothing else.
  const showPickUnsupportedNote = pickUndrawable && advertisedCrs.length === 0;
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
    // Relative endpoints are a web-origin deployment feature: in the desktop
    // app they would resolve against the app origin, and the native HTTP path
    // needs an absolute URL, so require http(s) there with the translated error.
    if (!isServiceFormUrl(endpoint) || (isTauri() && !isHttpWmsUrl(endpoint))) {
      setRetrieveError(t("addData.wms.errorUrl"));
      return;
    }
    retrieveAbortRef.current?.abort();
    const controller = new AbortController();
    retrieveAbortRef.current = controller;
    const token = ++retrieveTokenRef.current;
    const isStale = () => token !== retrieveTokenRef.current || controller.signal.aborted;
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
      setRetrieveError(serviceRequestErrorMessage(error, t, t("addData.wms.retrieveError")));
    } finally {
      if (token === retrieveTokenRef.current) setIsRetrieving(false);
    }
  };

  // The web build cannot pick a CRS but keeps one set on desktop, so saving a
  // service there again does not drop it.
  const savedCrs = isTauri() ? wmsCrs : wmsCrsPick;
  const getFields = (): ServiceFields => ({
    endpoint: wmsEndpoint,
    layers: wmsLayers,
    styles: wmsStyles,
    format: wmsFormat,
    transparent: wmsTransparent,
    tileSize: wmsTileSize,
    // Only persist the version when it has an explicit source; an untouched
    // default stays eligible for URL/capabilities auto-detection on reload.
    // CRS:84 exists only in WMS 1.3.0, so it keeps the version it needs even
    // when the version came from capabilities auto-detection.
    ...(versionTouched || savedCrs === "CRS:84" ? { version: wmsVersion } : {}),
    ...(savedCrs && savedCrs !== "EPSG:3857" ? { crs: savedCrs } : {}),
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
    setWmsCrsPick(serviceFieldString(fields, "crs").trim().toUpperCase());
    // The new endpoint's layers must be re-retrieved, so drop the old list and
    // cancel any retrieval still in flight for the previous endpoint.
    cancelRetrieve();
    setLayerOptions([]);
    setRetrieveError(null);
  };

  // The CRS to submit, resolved against the reprojection check even when the
  // one behind the selector has not finished yet, so an early submit never
  // requests a CRS the selected layers do not offer.
  const submittedCrs = async (): Promise<string | undefined> => {
    if (!isTauri()) return undefined;
    const choices = reprojectableReady ? crsChoices : await reprojectableWmsCodes(advertisedCrs);
    return reprojectableWmsCrs(pickWmsCrs(choices, wmsCrsPick, wmsVersion, layersAdvertiseCrs));
  };

  const handleSubmit = source.runSubmit(async () => {
    const name = source.layerName.trim() || t("addData.wms.defaultName");
    if (!isServiceFormUrl(wmsEndpoint.trim()) || (isTauri() && !isHttpWmsUrl(wmsEndpoint.trim()))) {
      throw new Error(t("addData.wms.errorUrl"));
    }
    if (!wmsLayers.trim()) {
      throw new Error(t("addData.wms.errorLayers"));
    }
    // buildWmsLayer strips any leftover operation params (a pasted
    // GetCapabilities URL), normalizes the version, and credits known keyless
    // services (e.g. GEBCO) in the map's attribution control.
    source.addAndClose(
      routeWmsLayerThroughNativeProtocol(
        buildWmsLayer({
          name,
          endpoint: wmsEndpoint,
          layers: wmsLayers,
          styles: wmsStyles,
          format: wmsFormat,
          transparent: wmsTransparent,
          tileSize: wmsTileSize,
          version: wmsVersion,
          crs: await submittedCrs(),
          queryable: wmsLayersQueryable(layerOptions, wmsLayers),
        }),
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
                  value.trim().split(/[?#]/)[0] !== previous.trim().split(/[?#]/)[0];
                if (serviceChanged) {
                  setWmsVersion(detected ?? "1.1.1");
                  markVersionTouched(detected != null);
                } else if (detected && detected !== wmsVersionFromEndpoint(previous)) {
                  setWmsVersion(detected);
                  markVersionTouched(true);
                }
                // The CRS belongs to the service, and a query parameter can
                // select a different one on the same path (MapServer's `map=`):
                // compare everything but the WMS operation parameters.
                if (
                  stripOgcOperationParams(value.trim(), "WMS") !==
                  stripOgcOperationParams(previous.trim(), "WMS")
                ) {
                  setWmsCrsPick("");
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
                <Loader2 className="me-2 h-3.5 w-3.5 animate-spin" />
              ) : (
                <ListTree className="me-2 h-3.5 w-3.5" />
              )}
              {isRetrieving ? t("addData.wms.retrieving") : t("addData.wms.retrieveLayers")}
            </Button>
          </div>
          {retrieveError ? <p className="text-xs text-destructive">{retrieveError}</p> : null}
          {layerOptions.length > 0 ? (
            <div className="space-y-1.5">
              <Label htmlFor={layerListId}>{t("addData.wms.retrievedLayers")}</Label>
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
          {showCrs ? (
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="wms-crs">{t("addData.wms.crs")}</Label>
              <Select
                id="wms-crs"
                value={wmsCrs}
                onChange={(event) => setWmsCrsPick(event.target.value)}
              >
                {crsOptions.map((code) => (
                  <option key={code} value={code}>
                    {code}
                  </option>
                ))}
              </Select>
              {wmsCrs !== "EPSG:3857" ? (
                <p className="text-xs text-muted-foreground">{t("addData.wms.crsReprojected")}</p>
              ) : null}
            </div>
          ) : null}
        </div>
        {showCrsWebNote ? (
          <p className="text-xs text-muted-foreground">{t("addData.wms.crsDesktopOnly")}</p>
        ) : null}
        {showCrsUnsupportedNote ? (
          <p className="text-xs text-muted-foreground">{t("addData.wms.crsUnsupported")}</p>
        ) : null}
        {showPickUnsupportedNote ? (
          <p className="text-xs text-muted-foreground">
            {t("addData.wms.crsPickUnsupported", { crs: usablePick })}
          </p>
        ) : null}
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
            {
              label: t("addData.wms.sampleLabelGebco"),
              value: {
                endpoint: GEBCO_WMS_ENDPOINT,
                layers: GEBCO_WMS_LAYERS,
                version: "1.3.0",
              },
            },
            {
              label: t("addData.wms.sampleLabelNlcd"),
              value: { endpoint: NLCD_WMS_ENDPOINT, layers: NLCD_WMS_LAYERS },
            },
          ]}
          onSelect={applyFields}
        />
      </div>
    </AddDataSourceForm>
  );
}
