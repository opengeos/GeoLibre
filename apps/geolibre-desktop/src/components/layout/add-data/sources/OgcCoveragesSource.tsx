import { redactUrlCredentials, useAppStore } from "@geolibre/core";
import { addRasterToMap } from "@geolibre/plugins/maplibre-raster";
import { Button, Input, Label, Select } from "@geolibre/ui";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { createAppAPI } from "../../../../hooks/usePlugins";
import { CoverageError } from "../../../../lib/coverage-json";
import {
  discoverOgcCoverages,
  downloadOgcCoverage,
  ogcCoverageUrl,
  ogcCoverageViewBounds,
  ogcCoverageSupportsFieldSelection,
  type OgcCoverageCollection,
} from "../../../../lib/ogc-api-coverages";
import { serviceRequestErrorMessage } from "../helpers";
import { AddDataSourceForm, SampleDataSelect, useAddDataSource } from "../shared";

const AXES = ["west", "south", "east", "north"] as const;
const SAMPLES = [
  {
    label: "pygeoapi GDPS temperature",
    value: "https://demo.pygeoapi.io/master/",
  },
];

/** Discover a service's coverages and import a bounded numerical snapshot. */
export function OgcCoveragesSource({ initialUrl = "" }: { initialUrl?: string }) {
  const { t } = useTranslation();
  const source = useAddDataSource(t("addData.kind.ogcCoverages.label"));
  const [endpoint, setEndpoint] = useState(initialUrl);
  const [collections, setCollections] = useState<OgcCoverageCollection[]>([]);
  const [selected, setSelected] = useState("");
  const [bounds, setBounds] = useState(["", "", "", ""]);
  const [datetime, setDatetime] = useState("");
  const [subset, setSubset] = useState("");
  const [parameter, setParameter] = useState("");
  const [retrieving, setRetrieving] = useState(false);
  const active = useRef<AbortController | null>(null);
  useEffect(() => {
    const unsubscribe = useAppStore.subscribe((state, previous) => {
      if (state.projectLoadCount !== previous.projectLoadCount) {
        active.current?.abort();
        active.current = null;
        setRetrieving(false);
      }
    });
    return () => {
      unsubscribe();
      active.current?.abort();
    };
  }, []);
  const collection = collections.find((item) => item.id === selected);
  const errorText = (error: unknown) =>
    error instanceof CoverageError
      ? t(`addData.ogcCoverages.errors.${error.code}`)
      : serviceRequestErrorMessage(error, t, t("addData.shared.addError"));

  function resetEndpoint(value: string) {
    active.current?.abort();
    setRetrieving(false);
    setEndpoint(value);
    setCollections([]);
    setSelected("");
    setDatetime("");
    setSubset("");
    setParameter("");
    source.setError(null);
  }
  async function retrieve() {
    active.current?.abort();
    const request = new AbortController();
    active.current = request;
    setRetrieving(true);
    setCollections([]);
    setSelected("");
    source.setError(null);
    try {
      const items = await discoverOgcCoverages(endpoint, request.signal);
      request.signal.throwIfAborted();
      setCollections(items);
      setSelected(items[0].id);
    } catch (error) {
      if (!request.signal.aborted) source.setError(errorText(error));
    } finally {
      if (active.current === request) setRetrieving(false);
    }
  }
  const submit = source.runSubmit(async () => {
    if (!collection) return;
    active.current?.abort();
    const request = new AbortController();
    active.current = request;
    try {
      const area = bounds.map((value) => (value.trim() ? Number(value) : NaN));
      const url = ogcCoverageUrl(collection, area, { datetime, subset });
      const { file, bands } = await downloadOgcCoverage(collection, url, request.signal, parameter);
      request.signal.throwIfAborted();
      const projectLoadCount = useAppStore.getState().projectLoadCount;
      const id = await addRasterToMap(createAppAPI(source.shell.mapControllerRef), file, {
        name: source.layerName.trim() || collection.title,
        beforeId: source.beforeLayer ?? undefined,
        signal: request.signal,
      });
      // A resolved add has committed its raster. Finish its metadata even if
      // the dialog unmounts in the promise continuation, but never touch a
      // replacement project. The raster helper owns cancellation before commit.
      if (useAppStore.getState().projectLoadCount !== projectLoadCount) return;
      const state = useAppStore.getState(),
        layer = state.layers.find((item) => item.id === id);
      if (layer)
        state.updateLayer(id, {
          metadata: {
            ...layer.metadata,
            ogcCoverageSnapshot: true,
            sourceUrl: redactUrlCredentials(url),
            ogcCoverageCollection: collection.id,
            ogcCoverageParameters: bands,
          },
        });
      state.moveLayerToGroup(id, source.shell.targetGroupId, source.beforeLayer);
      if (!request.signal.aborted) source.shell.closeDialog();
    } catch (error) {
      throw new Error(errorText(error));
    }
  });

  return (
    <AddDataSourceForm
      layerName={source.layerName}
      onLayerNameChange={source.setLayerName}
      beforeLayerId={source.beforeLayerId}
      onBeforeLayerIdChange={source.setBeforeLayerId}
      onSubmit={submit}
      error={source.error}
      submitDisabled={source.isSubmitting || retrieving || !collection}
      useServiceIcon
    >
      <fieldset disabled={source.isSubmitting} className="space-y-3">
        <div className="space-y-1.5">
          <Label htmlFor="ogcc-endpoint">{t("addData.common.serviceUrl")}</Label>
          <div className="flex gap-2">
            <Input
              id="ogcc-endpoint"
              value={endpoint}
              onChange={(e) => resetEndpoint(e.target.value)}
              placeholder="https://example.org/ogcapi/"
            />
            <Button
              type="button"
              variant="outline"
              onClick={retrieve}
              disabled={retrieving || !endpoint.trim()}
            >
              {retrieving
                ? t("addData.wms.retrieving")
                : t("addData.ogcFeatures.retrieveCollections")}
            </Button>
          </div>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="ogcc-collection">{t("addData.wcs.coverage")}</Label>
          <Select
            id="ogcc-collection"
            value={selected}
            disabled={!collections.length}
            onChange={(e) => {
              setSelected(e.target.value);
              setSubset("");
              setParameter("");
            }}
          >
            <option value="" disabled>
              {t("addData.wcs.select")}
            </option>
            {collections.map((item) => (
              <option key={item.id} value={item.id}>
                {item.title}
              </option>
            ))}
          </Select>
        </div>
        <div className="flex gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              const extent = source.shell.mapControllerRef.current?.getViewBounds();
              if (!extent) return;
              try {
                setBounds(ogcCoverageViewBounds(extent).map(String));
                source.setError(null);
              } catch (error) {
                source.setError(errorText(error));
              }
            }}
          >
            {t("rasterSubset.useView")}
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={!collection?.bounds}
            onClick={() => {
              if (collection?.bounds) setBounds(collection.bounds.map(String));
            }}
          >
            {t("addData.wcs.extent")}
          </Button>
        </div>
        <div className="grid grid-cols-2 gap-3">
          {AXES.map((axis, i) => (
            <div className="space-y-1.5" key={axis}>
              <Label htmlFor={`ogcc-${axis}`}>{t(`rasterSubset.${axis}`)}</Label>
              <Input
                id={`ogcc-${axis}`}
                type="number"
                step="any"
                value={bounds[i]}
                onChange={(e) =>
                  setBounds(bounds.map((value, index) => (index === i ? e.target.value : value)))
                }
              />
            </div>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">{t("rasterSubset.bboxHint")}</p>
        <div className="space-y-1.5">
          <Label htmlFor="ogcc-datetime">{t("addData.ogcFeatures.datetime")}</Label>
          <Input
            id="ogcc-datetime"
            value={datetime}
            onChange={(e) => setDatetime(e.target.value)}
            placeholder="2026-01-01T00:00:00Z"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="ogcc-subset">{t("addData.ogcCoverages.subset")}</Label>
          <Input
            id="ogcc-subset"
            value={subset}
            onChange={(e) => setSubset(e.target.value)}
            placeholder="height(10)"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="ogcc-parameter">{t("addData.ogcCoverages.parameter")}</Label>
          <Input
            id="ogcc-parameter"
            disabled={!ogcCoverageSupportsFieldSelection(collection)}
            value={parameter}
            onChange={(e) => setParameter(e.target.value)}
            placeholder="TMP"
          />
        </div>
        <p className="text-xs text-muted-foreground">{t("addData.ogcCoverages.hint")}</p>
        <SampleDataSelect
          samples={SAMPLES}
          onSelect={(value) => {
            resetEndpoint(String(value));
            setBounds(["-80", "43", "-79", "44"]);
            setDatetime("");
            setSubset("");
            setParameter("");
          }}
        />
      </fieldset>
    </AddDataSourceForm>
  );
}
