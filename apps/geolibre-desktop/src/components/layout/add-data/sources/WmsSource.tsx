import { Button, Input, Label, Select } from "@geolibre/ui";
import { ListTree, Loader2 } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { DEFAULT_WMS_ENDPOINT, DEFAULT_WMS_LAYERS } from "../constants";
import {
  createBaseLayer,
  createWmsTileUrl,
  errorMessage,
  fetchWmsLayers,
  type WmsLayerOption,
} from "../helpers";
import { ServiceLibrarySection } from "../ServiceLibrarySection";
import {
  serviceFieldBoolean,
  serviceFieldString,
  type ServiceFields,
} from "../service-library";
import { AddDataSourceForm, SampleDataSelect, useAddDataSource } from "../shared";

export function WmsSource() {
  const { t } = useTranslation();
  const source = useAddDataSource(t("addData.wms.defaultName"));
  const [wmsEndpoint, setWmsEndpoint] = useState("");
  const [wmsLayers, setWmsLayers] = useState("");
  const [wmsStyles, setWmsStyles] = useState("");
  const [wmsFormat, setWmsFormat] = useState("image/png");
  const [wmsTransparent, setWmsTransparent] = useState(true);
  const [wmsTileSize, setWmsTileSize] = useState("256");
  const [layerOptions, setLayerOptions] = useState<WmsLayerOption[]>([]);
  const [isRetrieving, setIsRetrieving] = useState(false);
  const [retrieveError, setRetrieveError] = useState<string | null>(null);
  const layerListId = useId();
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

  // Abort an in-flight retrieval if the dialog closes mid-request.
  useEffect(() => () => retrieveAbortRef.current?.abort(), []);

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
      const options = await fetchWmsLayers(endpoint, {
        signal: controller.signal,
      });
      if (isStale()) return;
      if (options.length === 0) {
        setLayerOptions([]);
        setRetrieveError(t("addData.wms.noLayersFound"));
        return;
      }
      setLayerOptions(options);
      // Preselect the first layer when the field is empty so a single click
      // leaves the form ready to submit.
      if (!wmsLayers.trim()) setWmsLayers(options[0].name);
    } catch (error) {
      if (isStale()) return;
      setLayerOptions([]);
      setRetrieveError(errorMessage(error, t("addData.wms.retrieveError")));
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
  });

  const applyFields = (fields: ServiceFields) => {
    setWmsEndpoint(serviceFieldString(fields, "endpoint"));
    setWmsLayers(serviceFieldString(fields, "layers"));
    setWmsStyles(serviceFieldString(fields, "styles"));
    setWmsFormat(serviceFieldString(fields, "format", "image/png"));
    setWmsTransparent(serviceFieldBoolean(fields, "transparent", true));
    setWmsTileSize(serviceFieldString(fields, "tileSize", "256"));
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
    const tileUrl = createWmsTileUrl({
      endpoint: wmsEndpoint.trim(),
      layers: wmsLayers.trim(),
      styles: wmsStyles.trim(),
      format: wmsFormat,
      transparent: wmsTransparent,
      tileSize,
    });
    source.addAndClose(
      createBaseLayer(
        name,
        "wms",
        {
          type: "raster",
          tiles: [tileUrl],
          tileSize,
          url: wmsEndpoint.trim(),
          layers: wmsLayers.trim(),
          styles: wmsStyles.trim(),
          format: wmsFormat,
          transparent: wmsTransparent,
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
                setWmsEndpoint(event.target.value);
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
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="wms-layers">{t("addData.wms.layers")}</Label>
            {/* A text input backed by a <datalist> of the retrieved layers: the
                dropdown suggestions cover the common single-layer pick, while
                free text still allows a comma-separated composite LAYERS value
                or manual entry when a service blocks GetCapabilities. */}
            <Input
              id="wms-layers"
              list={layerOptions.length > 0 ? layerListId : undefined}
              placeholder={t("addData.common.workspaceLayerPlaceholder")}
              value={wmsLayers}
              onChange={(event) => setWmsLayers(event.target.value)}
            />
            {layerOptions.length > 0 ? (
              <datalist id={layerListId}>
                {layerOptions.map((option) => (
                  <option key={option.name} value={option.name}>
                    {option.title === option.name
                      ? option.name
                      : `${option.title} (${option.name})`}
                  </option>
                ))}
              </datalist>
            ) : null}
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
