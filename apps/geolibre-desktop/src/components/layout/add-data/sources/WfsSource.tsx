import { Button, Input, Label, Select } from "@geolibre/ui";
import { ListTree, Loader2 } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  createWfsGetFeatureUrl,
  fetchGeoJsonFeatureCollection,
} from "../../../../lib/layer-refresh";
import { DEFAULT_WFS_ENDPOINT, DEFAULT_WFS_TYPE_NAME } from "../constants";
import {
  createBaseLayer,
  errorMessage,
  fetchWfsFeatureTypes,
  type WfsFeatureTypeOption,
} from "../helpers";
import { ServiceLibrarySection } from "../ServiceLibrarySection";
import {
  serviceFieldString,
  type ServiceFields,
} from "../service-library";
import { AddDataSourceForm, SampleDataSelect, useAddDataSource } from "../shared";

export function WfsSource() {
  const { t } = useTranslation();
  const source = useAddDataSource(t("addData.wfs.defaultName"));
  const [wfsEndpoint, setWfsEndpoint] = useState("");
  const [wfsTypeName, setWfsTypeName] = useState("");
  const [wfsVersion, setWfsVersion] = useState("2.0.0");
  const [wfsOutputFormat, setWfsOutputFormat] = useState("application/json");
  const [wfsSrsName, setWfsSrsName] = useState("EPSG:4326");
  const [wfsMaxFeatures, setWfsMaxFeatures] = useState("1000");
  const [typeOptions, setTypeOptions] = useState<WfsFeatureTypeOption[]>([]);
  const [isRetrieving, setIsRetrieving] = useState(false);
  const [retrieveError, setRetrieveError] = useState<string | null>(null);
  const typeListId = useId();
  // See WmsSource: guards a stale in-flight retrieval from overwriting the form.
  const retrieveTokenRef = useRef(0);
  const retrieveAbortRef = useRef<AbortController | null>(null);

  const cancelRetrieve = () => {
    retrieveAbortRef.current?.abort();
    retrieveAbortRef.current = null;
  };

  // Abort an in-flight retrieval if the dialog closes mid-request.
  useEffect(() => () => retrieveAbortRef.current?.abort(), []);

  const handleRetrieveTypes = async () => {
    const endpoint = wfsEndpoint.trim();
    if (!endpoint) {
      setRetrieveError(t("addData.wfs.errorUrl"));
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
      const options = await fetchWfsFeatureTypes(endpoint, {
        version: wfsVersion,
        signal: controller.signal,
      });
      if (isStale()) return;
      if (options.length === 0) {
        setTypeOptions([]);
        setRetrieveError(t("addData.wfs.noTypesFound"));
        return;
      }
      setTypeOptions(options);
      // Preselect the first type when the field is empty so a single click
      // leaves the form ready to submit.
      if (!wfsTypeName.trim()) setWfsTypeName(options[0].name);
    } catch (error) {
      if (isStale()) return;
      setTypeOptions([]);
      setRetrieveError(errorMessage(error, t("addData.wfs.retrieveError")));
    } finally {
      if (token === retrieveTokenRef.current) setIsRetrieving(false);
    }
  };

  const getFields = (): ServiceFields => ({
    endpoint: wfsEndpoint,
    typeName: wfsTypeName,
    version: wfsVersion,
    outputFormat: wfsOutputFormat,
    srsName: wfsSrsName,
    maxFeatures: wfsMaxFeatures,
  });

  const applyFields = (fields: ServiceFields) => {
    setWfsEndpoint(serviceFieldString(fields, "endpoint"));
    setWfsTypeName(serviceFieldString(fields, "typeName"));
    setWfsVersion(serviceFieldString(fields, "version", "2.0.0"));
    setWfsOutputFormat(
      serviceFieldString(fields, "outputFormat", "application/json"),
    );
    setWfsSrsName(serviceFieldString(fields, "srsName", "EPSG:4326"));
    setWfsMaxFeatures(serviceFieldString(fields, "maxFeatures", "1000"));
    // The new endpoint's feature types must be re-retrieved, so drop the list
    // and cancel any retrieval still in flight for the previous endpoint.
    cancelRetrieve();
    setTypeOptions([]);
    setRetrieveError(null);
  };

  const handleSubmit = source.runSubmit(async () => {
    const name = source.layerName.trim() || t("addData.wfs.defaultName");
    if (!wfsEndpoint.trim()) throw new Error(t("addData.wfs.errorUrl"));
    if (!wfsTypeName.trim()) {
      throw new Error(t("addData.wfs.errorTypeName"));
    }
    if (!wfsOutputFormat.trim()) {
      throw new Error(t("addData.wfs.errorOutputFormat"));
    }
    if (wfsMaxFeatures.trim() && !Number.isFinite(Number(wfsMaxFeatures))) {
      throw new Error(t("addData.wfs.errorMaxFeaturesNumeric"));
    }

    const featureUrl = createWfsGetFeatureUrl({
      endpoint: wfsEndpoint.trim(),
      typeName: wfsTypeName.trim(),
      version: wfsVersion,
      outputFormat: wfsOutputFormat.trim(),
      srsName: wfsSrsName.trim(),
      maxFeatures: wfsMaxFeatures.trim() || undefined,
    });
    const data = await fetchGeoJsonFeatureCollection(featureUrl, {
      useWfsProxy: true,
    });
    source.addAndClose(
      {
        ...createBaseLayer(
          name,
          "geojson",
          {
            type: "geojson",
            url: featureUrl,
            service: "wfs",
            typeName: wfsTypeName.trim(),
            version: wfsVersion,
            outputFormat: wfsOutputFormat.trim(),
            srsName: wfsSrsName.trim() || undefined,
          },
          {
            featureCount: data.features.length,
            service: "wfs",
            sourceKind: "wfs-getfeature",
            typeName: wfsTypeName.trim(),
          },
        ),
        geojson: data,
        sourcePath: featureUrl,
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
      useServiceIcon
    >
      <div className="space-y-3">
        <ServiceLibrarySection
          kind="wfs"
          layerName={source.layerName}
          getFields={getFields}
          onApply={(entry) => {
            source.setLayerName(entry.name);
            applyFields(entry.fields);
          }}
        />
        <div className="space-y-1.5">
          <Label htmlFor="wfs-endpoint">{t("addData.common.serviceUrl")}</Label>
          <div className="flex gap-2">
            <Input
              id="wfs-endpoint"
              placeholder={t("addData.wfs.urlPlaceholder")}
              value={wfsEndpoint}
              onChange={(event) => {
                setWfsEndpoint(event.target.value);
                // Feature types belong to the previous endpoint; clear them (and
                // cancel any in-flight retrieval) so the list never reflects a
                // different service.
                if (typeOptions.length > 0 || isRetrieving) {
                  cancelRetrieve();
                  setTypeOptions([]);
                  setIsRetrieving(false);
                }
                if (retrieveError) setRetrieveError(null);
              }}
            />
            <Button
              type="button"
              variant="outline"
              onClick={handleRetrieveTypes}
              disabled={isRetrieving || !wfsEndpoint.trim()}
              className="shrink-0"
            >
              {isRetrieving ? (
                <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
              ) : (
                <ListTree className="mr-2 h-3.5 w-3.5" />
              )}
              {isRetrieving
                ? t("addData.wfs.retrieving")
                : t("addData.wfs.retrieveTypes")}
            </Button>
          </div>
          {retrieveError ? (
            <p className="text-xs text-destructive">{retrieveError}</p>
          ) : null}
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="wfs-type-name">{t("addData.wfs.featureType")}</Label>
            {/* Text input backed by a <datalist> of retrieved types: dropdown
                suggestions for the common pick, free text preserved for manual
                entry when a service blocks GetCapabilities. */}
            <Input
              id="wfs-type-name"
              list={typeOptions.length > 0 ? typeListId : undefined}
              placeholder={t("addData.common.workspaceLayerPlaceholder")}
              value={wfsTypeName}
              onChange={(event) => setWfsTypeName(event.target.value)}
            />
            {typeOptions.length > 0 ? (
              <datalist id={typeListId}>
                {typeOptions.map((option) => (
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
            <Label htmlFor="wfs-version">{t("addData.wfs.version")}</Label>
            <Select
              id="wfs-version"
              value={wfsVersion}
              onChange={(event) => setWfsVersion(event.target.value)}
            >
              <option value="2.0.0">2.0.0</option>
              <option value="1.1.0">1.1.0</option>
              <option value="1.0.0">1.0.0</option>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="wfs-output-format">
              {t("addData.wfs.outputFormat")}
            </Label>
            <Input
              id="wfs-output-format"
              value={wfsOutputFormat}
              onChange={(event) => setWfsOutputFormat(event.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="wfs-srs-name">{t("addData.wfs.srsName")}</Label>
            <Input
              id="wfs-srs-name"
              placeholder={t("addData.common.optional")}
              value={wfsSrsName}
              onChange={(event) => setWfsSrsName(event.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="wfs-max-features">
              {t("addData.wfs.maxFeatures")}
            </Label>
            <Input
              id="wfs-max-features"
              inputMode="numeric"
              placeholder={t("addData.common.optional")}
              value={wfsMaxFeatures}
              onChange={(event) => setWfsMaxFeatures(event.target.value)}
            />
          </div>
        </div>
        <SampleDataSelect
          samples={[
            {
              label: t("addData.wfs.sampleLabel"),
              value: { endpoint: DEFAULT_WFS_ENDPOINT, typeName: DEFAULT_WFS_TYPE_NAME },
            },
          ]}
          onSelect={applyFields}
        />
      </div>
    </AddDataSourceForm>
  );
}
