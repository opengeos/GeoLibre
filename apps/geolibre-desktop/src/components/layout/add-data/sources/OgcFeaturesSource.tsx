import { Button, Input, Label, Select } from "@geolibre/ui";
import { ListTree, Loader2 } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  DEFAULT_OGC_FEATURES_MAX_FEATURES,
  fetchOgcFeatureCollections,
  fetchOgcFeatureItems,
  parseOgcFeaturesUrl,
  type OgcFeaturesCollectionOption,
} from "../../../../lib/ogc-api-features";
import { buildOgcFeaturesLayer } from "../apply-service";
import { DEFAULT_OGC_FEATURES_COLLECTION, DEFAULT_OGC_FEATURES_ENDPOINT } from "../constants";
import { serviceRequestErrorMessage } from "../helpers";
import { AddDataSourceForm, SampleDataSelect, useAddDataSource } from "../shared";

/**
 * Retains the form input across dialog close/reopen (in memory, for the
 * session) so a user can add several collections from the same service without
 * re-entering the URL or re-retrieving its collection list each time.
 */
interface OgcFeaturesFormCache {
  endpoint: string;
  collectionId: string;
  maxFeatures: string;
  bbox: string;
  datetime: string;
  options: OgcFeaturesCollectionOption[];
}
let ogcFeaturesFormCache: OgcFeaturesFormCache | null = null;

interface OgcFeaturesSample {
  endpoint: string;
  collectionId: string;
}

/**
 * Adds features from an **OGC API - Features** collection as a GeoJSON layer.
 *
 * The user points at a service (its landing page, or any `/collections/…` URL
 * copied from the service's own HTML browser), retrieves its collections, and
 * picks one. The fetch follows the service's `next` links until the requested
 * feature count is reached, because a single `/items` request returns only one
 * server-sized page.
 */
export function OgcFeaturesSource() {
  const { t } = useTranslation();
  const source = useAddDataSource(t("addData.ogcFeatures.defaultName"));
  const [endpoint, setEndpoint] = useState(ogcFeaturesFormCache?.endpoint ?? "");
  const [collectionId, setCollectionId] = useState(ogcFeaturesFormCache?.collectionId ?? "");
  const [maxFeatures, setMaxFeatures] = useState(
    ogcFeaturesFormCache?.maxFeatures ?? String(DEFAULT_OGC_FEATURES_MAX_FEATURES),
  );
  const [bbox, setBbox] = useState(ogcFeaturesFormCache?.bbox ?? "");
  const [datetime, setDatetime] = useState(ogcFeaturesFormCache?.datetime ?? "");
  const [collectionOptions, setCollectionOptions] = useState<OgcFeaturesCollectionOption[]>(
    ogcFeaturesFormCache?.options ?? [],
  );
  const [isRetrieving, setIsRetrieving] = useState(false);
  const [retrieveError, setRetrieveError] = useState<string | null>(null);
  const collectionListId = useId();

  // Persist the form input so reopening the dialog restores the URL, the
  // fields, and the retrieved collection list.
  useEffect(() => {
    ogcFeaturesFormCache = {
      endpoint,
      collectionId,
      maxFeatures,
      bbox,
      datetime,
      options: collectionOptions,
    };
  }, [endpoint, collectionId, maxFeatures, bbox, datetime, collectionOptions]);

  // See WfsSource: guards a stale in-flight retrieval from overwriting the form.
  const retrieveTokenRef = useRef(0);
  const retrieveAbortRef = useRef<AbortController | null>(null);
  // Aborts an items fetch still running when the dialog closes, so a slow
  // service cannot add a layer after the user has left.
  const submitAbortRef = useRef<AbortController | null>(null);

  const cancelRetrieve = () => {
    retrieveAbortRef.current?.abort();
    retrieveAbortRef.current = null;
  };

  // Abort anything in flight if the dialog closes mid-request, and advance the
  // token so a finally block cannot set state after unmount.
  useEffect(
    () => () => {
      retrieveTokenRef.current += 1;
      retrieveAbortRef.current?.abort();
      submitAbortRef.current?.abort();
    },
    [],
  );

  /** Drops a collection list that belongs to a previous service URL. */
  const clearCollections = () => {
    if (collectionOptions.length > 0 || isRetrieving) {
      cancelRetrieve();
      setCollectionOptions([]);
      setIsRetrieving(false);
    }
    if (retrieveError) setRetrieveError(null);
  };

  const handleRetrieveCollections = async () => {
    retrieveAbortRef.current?.abort();
    const controller = new AbortController();
    retrieveAbortRef.current = controller;
    const token = ++retrieveTokenRef.current;
    const isStale = () => token !== retrieveTokenRef.current || controller.signal.aborted;
    setIsRetrieving(true);
    setRetrieveError(null);
    try {
      const parsed = parseOgcFeaturesUrl(endpoint);
      const options = await fetchOgcFeatureCollections(parsed, {
        signal: controller.signal,
      });
      if (isStale()) return;
      if (options.length === 0) {
        setCollectionOptions([]);
        setRetrieveError(t("addData.ogcFeatures.noCollectionsFound"));
        return;
      }
      setCollectionOptions(options);
      // A URL pasted from the service's own browser already names a collection;
      // otherwise preselect the first so a single click leaves the form ready.
      const pasted = parsed.collectionId;
      if (pasted && options.some((option) => option.id === pasted)) {
        setCollectionId(pasted);
      } else if (!collectionId.trim()) {
        setCollectionId(options[0].id);
      }
    } catch (error) {
      if (isStale()) return;
      setCollectionOptions([]);
      setRetrieveError(
        serviceRequestErrorMessage(error, t, t("addData.ogcFeatures.retrieveError")),
      );
    } finally {
      if (token === retrieveTokenRef.current) setIsRetrieving(false);
    }
  };

  const applySample = (sample: OgcFeaturesSample) => {
    setEndpoint(sample.endpoint);
    setCollectionId(sample.collectionId);
    setBbox("");
    setDatetime("");
    setMaxFeatures(String(DEFAULT_OGC_FEATURES_MAX_FEATURES));
    // The new service's collections must be re-retrieved.
    cancelRetrieve();
    setCollectionOptions([]);
    setIsRetrieving(false);
    setRetrieveError(null);
  };

  const handleSubmit = source.runSubmit(async () => {
    // Throws a field-level message for an empty or non-absolute URL.
    const parsed = parseOgcFeaturesUrl(endpoint);
    // A URL pasted straight from the service's HTML browser already names the
    // collection, so an empty field is only an error when neither carries one.
    const collection = collectionId.trim() || parsed.collectionId;
    if (!collection) {
      throw new Error(t("addData.ogcFeatures.errorCollection"));
    }
    const requestedMax = Number(maxFeatures.trim());
    if (!Number.isFinite(requestedMax) || requestedMax < 1) {
      throw new Error(t("addData.ogcFeatures.errorMaxFeatures"));
    }
    const trimmedBbox = bbox.trim();
    if (trimmedBbox) {
      const parts = trimmedBbox.split(",").map((part) => part.trim());
      // OGC API accepts a 4-value (2D) or 6-value (3D) bounding box.
      if (
        (parts.length !== 4 && parts.length !== 6) ||
        parts.some((part) => part === "" || !Number.isFinite(Number(part)))
      ) {
        throw new Error(t("addData.ogcFeatures.errorBbox"));
      }
    }

    submitAbortRef.current?.abort();
    const controller = new AbortController();
    submitAbortRef.current = controller;
    const result = await fetchOgcFeatureItems(
      {
        baseUrl: parsed.baseUrl,
        collectionId: collection,
        extraQuery: parsed.extraQuery,
        maxFeatures: Math.floor(requestedMax),
        bbox: trimmedBbox || undefined,
        datetime: datetime.trim() || undefined,
      },
      { signal: controller.signal },
    );
    // A superseded/cancelled request must not add a layer after the fact.
    if (controller.signal.aborted) return;
    if (result.data.features.length === 0) {
      throw new Error(t("addData.ogcFeatures.errorNoFeatures"));
    }
    if (result.truncated) {
      // Not an error: the layer holds the requested slice of a larger
      // collection. Note it so a user comparing counts against the service is
      // not left wondering where the rest went.
      console.info(
        `OGC API - Features: loaded ${result.data.features.length} of ${
          result.numberMatched ?? "more"
        } features from "${collection}". Raise "Max features" to load more.`,
      );
    }

    const name = source.layerName.trim() || collection || t("addData.ogcFeatures.defaultName");
    source.addAndClose(
      buildOgcFeaturesLayer({
        name,
        itemsUrl: result.url,
        data: result.data,
        baseUrl: parsed.baseUrl,
        collectionId: collection,
        maxFeatures: Math.floor(requestedMax),
        bbox: trimmedBbox || undefined,
        datetime: datetime.trim() || undefined,
        extraQuery: parsed.extraQuery || undefined,
        numberMatched: result.numberMatched,
        truncated: result.truncated,
      }),
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
        <div className="space-y-1.5">
          <Label htmlFor="ogc-features-endpoint">{t("addData.common.serviceUrl")}</Label>
          <div className="flex gap-2">
            <Input
              id="ogc-features-endpoint"
              placeholder={t("addData.ogcFeatures.urlPlaceholder")}
              value={endpoint}
              onChange={(event) => {
                setEndpoint(event.target.value);
                // Collections belong to the previous service; clear them (and
                // cancel any retrieval in flight) so the list never reflects a
                // different one.
                clearCollections();
              }}
            />
            <Button
              type="button"
              variant="outline"
              onClick={handleRetrieveCollections}
              disabled={isRetrieving || !endpoint.trim()}
              className="shrink-0"
            >
              {isRetrieving ? (
                <Loader2 className="me-2 h-3.5 w-3.5 animate-spin" />
              ) : (
                <ListTree className="me-2 h-3.5 w-3.5" />
              )}
              {isRetrieving
                ? t("addData.ogcFeatures.retrieving")
                : t("addData.ogcFeatures.retrieveCollections")}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">{t("addData.ogcFeatures.urlHint")}</p>
          {retrieveError ? <p className="text-xs text-destructive">{retrieveError}</p> : null}
          {collectionOptions.length > 0 ? (
            <div className="space-y-1.5">
              <Label htmlFor={collectionListId}>
                {t("addData.ogcFeatures.retrievedCollections")}
              </Label>
              {/* Picker listing every retrieved collection; fills the field
                  below on select. Value stays empty (action menu), so it always
                  shows the full list and can never mismatch the free-text field. */}
              <Select
                id={collectionListId}
                value=""
                onChange={(event) => {
                  if (event.target.value) setCollectionId(event.target.value);
                }}
              >
                <option value="" disabled>
                  {t("addData.ogcFeatures.selectCollection", {
                    count: collectionOptions.length,
                  })}
                </option>
                {collectionOptions.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.title === option.id ? option.id : `${option.title} (${option.id})`}
                  </option>
                ))}
              </Select>
            </div>
          ) : null}
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="ogc-features-collection">{t("addData.ogcFeatures.collection")}</Label>
            {/* Plain free-text field: holds the submitted collection id and
                stays editable for manual entry. The picker above fills it. */}
            <Input
              id="ogc-features-collection"
              placeholder={t("addData.ogcFeatures.collectionPlaceholder")}
              value={collectionId}
              onChange={(event) => setCollectionId(event.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ogc-features-max">{t("addData.ogcFeatures.maxFeatures")}</Label>
            <Input
              id="ogc-features-max"
              inputMode="numeric"
              value={maxFeatures}
              onChange={(event) => setMaxFeatures(event.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ogc-features-bbox">{t("addData.ogcFeatures.bbox")}</Label>
            <Input
              id="ogc-features-bbox"
              placeholder={t("addData.common.optional")}
              value={bbox}
              onChange={(event) => setBbox(event.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ogc-features-datetime">{t("addData.ogcFeatures.datetime")}</Label>
            <Input
              id="ogc-features-datetime"
              placeholder={t("addData.common.optional")}
              value={datetime}
              onChange={(event) => setDatetime(event.target.value)}
            />
          </div>
        </div>
        <SampleDataSelect
          samples={[
            {
              label: t("addData.ogcFeatures.sampleLabel"),
              value: {
                endpoint: DEFAULT_OGC_FEATURES_ENDPOINT,
                collectionId: DEFAULT_OGC_FEATURES_COLLECTION,
              },
            },
          ]}
          onSelect={applySample}
        />
      </div>
    </AddDataSourceForm>
  );
}
