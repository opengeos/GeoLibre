import { Button, Input, Label, Select } from "@geolibre/ui";
import { ListTree, Loader2 } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { fetchWfsGeoJson } from "../../../../lib/layer-refresh";
import { buildWfsGeoJsonLayer } from "../apply-service";
import { settleNamedRequests } from "../batch-requests";
import { DEFAULT_WFS_ENDPOINT, DEFAULT_WFS_TYPE_NAME } from "../constants";
import {
  fetchWfsFeatureTypes,
  serviceRequestErrorMessage,
  stripOgcOperationParams,
  type WfsFeatureTypeOption,
} from "../helpers";
import { ServiceLibrarySection } from "../ServiceLibrarySection";
import { serviceFieldString, type ServiceFields } from "../service-library";
import { AddDataSourceForm, SampleDataSelect, useAddDataSource } from "../shared";

/**
 * Retains the WFS form input across dialog close/reopen (in memory, for the
 * session) so a user can add several feature types from the same service
 * without re-entering the URL or re-retrieving its type list each time.
 */
interface WfsFormCache {
  endpoint: string;
  typeName: string;
  version: string;
  outputFormat: string;
  srsName: string;
  maxFeatures: string;
  options: WfsFeatureTypeOption[];
  selectedTypeNames: string[];
}
let wfsFormCache: WfsFormCache | null = null;

export function WfsSource({
  initialUrl = "",
  initialTypeName = "",
}: {
  initialUrl?: string;
  initialTypeName?: string;
}) {
  const { t } = useTranslation();
  const source = useAddDataSource(t("addData.wfs.defaultName"));
  const [wfsEndpoint, setWfsEndpoint] = useState(initialUrl || wfsFormCache?.endpoint || "");
  // See WmsSource: a deep link's endpoint must not inherit the feature type or
  // the retrieved type list cached from an unrelated service.
  const serviceCache = initialUrl ? null : wfsFormCache;
  const [wfsTypeName, setWfsTypeName] = useState(initialTypeName || (serviceCache?.typeName ?? ""));
  const [wfsVersion, setWfsVersion] = useState(wfsFormCache?.version ?? "2.0.0");
  const [wfsOutputFormat, setWfsOutputFormat] = useState(
    wfsFormCache?.outputFormat ?? "application/json",
  );
  const [wfsSrsName, setWfsSrsName] = useState(wfsFormCache?.srsName ?? "EPSG:4326");
  const [wfsMaxFeatures, setWfsMaxFeatures] = useState(wfsFormCache?.maxFeatures ?? "1000");
  const [typeOptions, setTypeOptions] = useState<WfsFeatureTypeOption[]>(
    serviceCache?.options ?? [],
  );
  const [selectedTypeNames, setSelectedTypeNames] = useState<string[]>(
    serviceCache?.selectedTypeNames ?? [],
  );
  const [isRetrieving, setIsRetrieving] = useState(false);
  const [retrieveError, setRetrieveError] = useState<string | null>(null);
  const typeListId = useId();

  // Persist the form input so reopening the dialog restores the URL, the fields,
  // and the retrieved feature-type list.
  useEffect(() => {
    wfsFormCache = {
      endpoint: wfsEndpoint,
      typeName: wfsTypeName,
      version: wfsVersion,
      outputFormat: wfsOutputFormat,
      srsName: wfsSrsName,
      maxFeatures: wfsMaxFeatures,
      options: typeOptions,
      selectedTypeNames,
    };
  }, [
    wfsEndpoint,
    wfsTypeName,
    wfsVersion,
    wfsOutputFormat,
    wfsSrsName,
    wfsMaxFeatures,
    typeOptions,
    selectedTypeNames,
  ]);
  // See WmsSource: guards a stale in-flight retrieval from overwriting the form.
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
    const isStale = () => token !== retrieveTokenRef.current || controller.signal.aborted;
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
        setSelectedTypeNames([]);
        setRetrieveError(t("addData.wfs.noTypesFound"));
        return;
      }
      setTypeOptions(options);
      const availableNames = new Set(options.map((option) => option.name));
      const retainedSelection = selectedTypeNames.filter((name) => availableNames.has(name));
      const typedName = wfsTypeName.trim();
      const nextSelection =
        retainedSelection.length > 0
          ? retainedSelection
          : typedName && availableNames.has(typedName)
            ? [typedName]
            : typedName
              ? []
              : [options[0].name];
      setSelectedTypeNames(nextSelection);
      if (!typedName) setWfsTypeName(options[0].name);
    } catch (error) {
      if (isStale()) return;
      setTypeOptions([]);
      setSelectedTypeNames([]);
      setRetrieveError(serviceRequestErrorMessage(error, t, t("addData.wfs.retrieveError")));
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
    setWfsOutputFormat(serviceFieldString(fields, "outputFormat", "application/json"));
    setWfsSrsName(serviceFieldString(fields, "srsName", "EPSG:4326"));
    setWfsMaxFeatures(serviceFieldString(fields, "maxFeatures", "1000"));
    // The new endpoint's feature types must be re-retrieved, so drop the list
    // and cancel any retrieval still in flight for the previous endpoint.
    cancelRetrieve();
    setTypeOptions([]);
    setSelectedTypeNames([]);
    setRetrieveError(null);
  };

  const handleSubmit = source.runSubmit(async () => {
    if (!wfsEndpoint.trim()) throw new Error(t("addData.wfs.errorUrl"));
    const typeNames =
      selectedTypeNames.length > 0 ? selectedTypeNames : [wfsTypeName.trim()].filter(Boolean);
    if (typeNames.length === 0) {
      throw new Error(t("addData.wfs.errorTypeName"));
    }
    if (!wfsOutputFormat.trim()) {
      throw new Error(t("addData.wfs.errorOutputFormat"));
    }
    if (wfsMaxFeatures.trim() && !Number.isFinite(Number(wfsMaxFeatures))) {
      throw new Error(t("addData.wfs.errorMaxFeaturesNumeric"));
    }

    // Strip any leftover operation params (a pasted GetCapabilities URL) so the
    // GetFeature request is not built with a conflicting duplicate REQUEST,
    // which would make the server return capabilities XML instead of features.
    // fetchWfsGeoJson retries alternate GeoJSON output formats when the server
    // answers the requested one with XML (e.g. an ArcGIS WFS that advertises
    // GeoJSON as "GEOJSON" rather than "application/json"), so it returns the
    // URL and output format that actually worked.
    const endpoint = stripOgcOperationParams(wfsEndpoint.trim(), "WFS");
    const { successes, failures } = await settleNamedRequests(
      typeNames.map((typeName) => ({
        key: typeName,
        run: () =>
          fetchWfsGeoJson(
            {
              endpoint,
              typeName,
              version: wfsVersion,
              outputFormat: wfsOutputFormat.trim(),
              srsName: wfsSrsName.trim(),
              maxFeatures: wfsMaxFeatures.trim() || undefined,
            },
            { useWfsProxy: true },
          ),
      })),
    );
    const results = successes.map(({ key: typeName, value: result }) => ({ typeName, result }));
    const failureMessage = failures
      .map(
        ({ key, reason }) =>
          `${key}: ${serviceRequestErrorMessage(reason, t, t("addData.wfs.retrieveError"))}`,
      )
      .join("\n");
    if (results.length === 0) throw new Error(failureMessage);
    // The fallback may have loaded the layer under a different output format
    // than the user entered (e.g. "GEOJSON" instead of "application/json"). The
    // resolved value is what gets persisted to source.outputFormat, so note the
    // substitution (in case a user later inspects the saved project and finds a
    // format they did not type) and adopt it as the form's output format. That
    // updates wfsFormCache too, so adding another feature type from the same
    // service this session skips straight to the working token instead of
    // re-paying the retry cost.
    const requestedOutputFormat = wfsOutputFormat.trim();
    for (const { typeName, result } of results) {
      if (
        requestedOutputFormat &&
        result.outputFormat.toLowerCase() !== requestedOutputFormat.toLowerCase()
      ) {
        console.info(
          `WFS: "${requestedOutputFormat}" returned XML for "${typeName}"; loaded it with "${result.outputFormat}" instead.`,
        );
      }
    }
    const firstResolvedFormat = results[0].result.outputFormat;
    if (firstResolvedFormat.toLowerCase() !== requestedOutputFormat.toLowerCase()) {
      setWfsOutputFormat(firstResolvedFormat);
    }
    const multiple = typeNames.length > 1;
    const layers = results.map(({ typeName, result }) => {
      const option = typeOptions.find((candidate) => candidate.name === typeName);
      const name = multiple
        ? option?.title || typeName
        : source.layerName.trim() || t("addData.wfs.defaultName");
      return buildWfsGeoJsonLayer({
        name,
        featureUrl: result.url,
        data: result.data,
        typeName,
        version: wfsVersion,
        outputFormat: result.outputFormat,
        srsName: wfsSrsName.trim(),
      });
    });
    if (failures.length > 0) {
      source.addMany(layers, { fit: true });
      const failedTypeNames = failures.map(({ key }) => key);
      setSelectedTypeNames(failedTypeNames);
      setWfsTypeName(failedTypeNames[0] ?? "");
      if (failedTypeNames.length === 1) {
        const failedOption = typeOptions.find((option) => option.name === failedTypeNames[0]);
        source.setLayerName(failedOption?.title || failedTypeNames[0]);
      }
      source.setError(failureMessage);
      return;
    }
    source.addManyAndClose(layers, { fit: true });
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
      hideLayerName={selectedTypeNames.length > 1}
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
                  setSelectedTypeNames([]);
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
                <Loader2 className="me-2 h-3.5 w-3.5 animate-spin" />
              ) : (
                <ListTree className="me-2 h-3.5 w-3.5" />
              )}
              {isRetrieving ? t("addData.wfs.retrieving") : t("addData.wfs.retrieveTypes")}
            </Button>
          </div>
          {retrieveError ? <p className="text-xs text-destructive">{retrieveError}</p> : null}
          {typeOptions.length > 0 ? (
            <div className="space-y-1.5">
              <Label htmlFor={typeListId}>{t("addData.wfs.retrievedTypes")}</Label>
              <p className="text-xs text-muted-foreground">
                {t("addData.wfs.selectType", { count: typeOptions.length })}
              </p>
              {/* Native multi-select preserves familiar Ctrl/Cmd toggle and
                  Shift range behavior while keeping manual entry available. */}
              <Select
                id={typeListId}
                multiple
                size={Math.min(typeOptions.length, 8)}
                value={selectedTypeNames}
                onChange={(event) => {
                  const names = Array.from(event.target.selectedOptions, (option) => option.value);
                  setSelectedTypeNames(names);
                  setWfsTypeName(names[0] ?? "");
                }}
              >
                {typeOptions.map((option) => (
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
            <Label htmlFor="wfs-type-name">{t("addData.wfs.featureType")}</Label>
            {/* Plain free-text field: holds the submitted typeName and stays
                editable for manual entry. The picker above fills it. */}
            <Input
              id="wfs-type-name"
              placeholder={t("addData.common.workspaceLayerPlaceholder")}
              value={wfsTypeName}
              onChange={(event) => {
                setWfsTypeName(event.target.value);
                setSelectedTypeNames([]);
              }}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="wfs-version">{t("addData.wfs.version")}</Label>
            <Select
              id="wfs-version"
              value={wfsVersion}
              onChange={(event) => {
                setWfsVersion(event.target.value);
                // Capabilities are fetched per version, so a version change can
                // stale the retrieved list; drop it (and cancel any retrieval in
                // flight) so it is re-fetched for the newly chosen version.
                if (typeOptions.length > 0 || isRetrieving) {
                  cancelRetrieve();
                  setTypeOptions([]);
                  setSelectedTypeNames([]);
                  setIsRetrieving(false);
                }
                if (retrieveError) setRetrieveError(null);
              }}
            >
              <option value="2.0.0">2.0.0</option>
              <option value="1.1.0">1.1.0</option>
              <option value="1.0.0">1.0.0</option>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="wfs-output-format">{t("addData.wfs.outputFormat")}</Label>
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
            <Label htmlFor="wfs-max-features">{t("addData.wfs.maxFeatures")}</Label>
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
              value: {
                endpoint: DEFAULT_WFS_ENDPOINT,
                typeName: DEFAULT_WFS_TYPE_NAME,
              },
            },
          ]}
          onSelect={applyFields}
        />
      </div>
    </AddDataSourceForm>
  );
}
