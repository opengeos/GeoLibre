import { useAppStore } from "@geolibre/core";
import { addRasterToMap } from "@geolibre/plugins";
import { Button, Input, Label, Select } from "@geolibre/ui";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { createAppAPI } from "../../../../hooks/usePlugins";
import { describeWcs, discoverWcs, downloadWcs } from "../../../../lib/wcs-fetch";
import {
  WCS_CRSES,
  WcsError,
  wcsCoverageUrl,
  type WcsBounds,
  type WcsCoverage,
  type WcsCrs,
} from "../../../../lib/wcs";
import { serviceRequestErrorMessage } from "../helpers";
import { AddDataSourceForm, SampleDataSelect, useAddDataSource } from "../shared";

const SAMPLES = [
  {
    label: "USGS 3DEP elevation",
    value: {
      endpoint:
        "https://elevation.nationalmap.gov/arcgis/services/3DEPElevation/ImageServer/WCSServer",
      bounds: [-89.5, 40, -89.48, 40.02],
    },
  },
  {
    label: "Illinois LiDAR DEM",
    value: {
      endpoint:
        "https://data.isgs.illinois.edu/arcgis/services/Elevation/IL_Statewide_Lidar_DEM_WGS/ImageServer/WCSServer",
      bounds: [-89.5, 40, -89.48, 40.02],
    },
  },
];
const AXES = ["west", "south", "east", "north"] as const;

/** An already-localized message that the submit handler must not re-classify. */
class WcsMessageError extends Error {}

export function WcsSource({ initialUrl = "" }: { initialUrl?: string }) {
  const { t } = useTranslation();
  const source = useAddDataSource(t("addData.kind.wcs.label"));
  const [endpoint, setEndpoint] = useState(initialUrl);
  const [coverages, setCoverages] = useState<WcsCoverage[]>([]);
  const [coverage, setCoverage] = useState("");
  const [bounds, setBounds] = useState<string[]>(["", "", "", ""]);
  const [width, setWidth] = useState("1024");
  const [height, setHeight] = useState("1024");
  // "auto" negotiates from DescribeCoverage; an explicit choice is sent even
  // when the coverage does not advertise it, since many services under-report.
  const [crs, setCrs] = useState<WcsCrs | "auto">("auto");
  const [retrieving, setRetrieving] = useState(false);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);

  function resetEndpoint(value: string) {
    controller.current?.abort();
    setRetrieving(false);
    setEndpoint(value);
    setCoverages([]);
    setCoverage("");
    source.setError(null);
  }
  const errorMessage = (error: unknown) =>
    error instanceof WcsError
      ? t(`addData.wcs.errors.${error.code}`) +
        (error.code === "response" && error.message !== error.code ? `: ${error.message}` : "")
      : // A network, CORS, or timeout failure arrives as an opaque TypeError or
        // DOMException; route it through the shared classifier so this panel
        // shows the same localized hint as its WMS/WFS siblings.
        serviceRequestErrorMessage(error, t, t("addData.shared.addError"));

  async function retrieve() {
    controller.current?.abort();
    const request = new AbortController();
    controller.current = request;
    setRetrieving(true);
    source.setError(null);
    setCoverages([]);
    setCoverage("");
    try {
      const items = await discoverWcs(endpoint, request.signal);
      if (request.signal.aborted) return;
      setCoverages(items);
      setCoverage(items[0].name);
    } catch (error) {
      if (!request.signal.aborted) source.setError(errorMessage(error));
    } finally {
      if (!request.signal.aborted) setRetrieving(false);
    }
  }

  const submit = source.runSubmit(async () => {
    const request = new AbortController();
    controller.current?.abort();
    controller.current = request;
    try {
      // Validate the form before making any network request. Empty fields are
      // NaN rather than Number("") == 0, which could select the wrong area.
      const area = bounds.map((value) => (value.trim() ? Number(value) : NaN)) as WcsBounds;
      wcsCoverageUrl(endpoint, coverage, area, Number(width), Number(height), {
        crs: "EPSG:4326",
        format: "GeoTIFF",
      });
      const described = await describeWcs(endpoint, coverage, request.signal);
      const description = crs === "auto" ? described : { ...described, crs };
      const url = wcsCoverageUrl(
        endpoint,
        coverage,
        area,
        Number(width),
        Number(height),
        description,
      );
      const file = await downloadWcs(url, coverage, request.signal).catch((error: unknown) => {
        // Point at the CRS choice when the server refused one it never listed.
        // Only a refusal qualifies (an exception report or non-raster body, or
        // an HTTP 4xx); size, timeout, and conversion failures keep their own
        // message.
        const refused =
          (error instanceof WcsError && error.code === "response") ||
          (error instanceof Error && /^WCS HTTP 4\d\d$/.test(error.message));
        const advertised = described.crses ?? [];
        if (!refused || !advertised.length || advertised.includes(description.crs)) throw error;
        throw new WcsMessageError(
          `${errorMessage(error)} ${t("addData.wcs.unadvertisedCrs", {
            crs: description.crs,
            list: advertised.join(", "),
          })}`,
        );
      });
      request.signal.throwIfAborted();
      const app = createAppAPI(source.shell.mapControllerRef);
      const before = new Set(useAppStore.getState().layers.map((layer) => layer.id));
      let id: string;
      try {
        id = await addRasterToMap(app, file, {
          name: source.layerName.trim() || coverage,
          beforeId: source.beforeLayer ?? undefined,
        });
      } catch (error) {
        // The raster control adds its store record before decoding the file.
        // A failed decode must not leave a broken layer behind on each retry.
        const state = useAppStore.getState();
        for (const layer of state.layers) {
          if (!before.has(layer.id) && layer.sourcePath === file.name) state.removeLayer(layer.id);
        }
        throw error;
      }
      // Decoding outlives an abort, so a dialog closed mid-decode would other-
      // wise leave the layer it cancelled behind. Removing it also releases the
      // raster control's resources and its retained file URL.
      if (request.signal.aborted) {
        useAppStore.getState().removeLayer(id);
        request.signal.throwIfAborted();
      }
      useAppStore.getState().moveLayerToGroup(id, source.shell.targetGroupId, source.beforeLayer);
      source.shell.closeDialog();
    } catch (error) {
      throw error instanceof WcsMessageError ? error : new Error(errorMessage(error));
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
      submitDisabled={source.isSubmitting || retrieving || !coverage}
      useServiceIcon
    >
      <fieldset disabled={source.isSubmitting} className="space-y-3">
        <div className="space-y-1.5">
          <Label htmlFor="wcs-endpoint">{t("addData.common.serviceUrl")}</Label>
          <div className="flex gap-2">
            <Input
              id="wcs-endpoint"
              value={endpoint}
              onChange={(event) => resetEndpoint(event.target.value)}
              placeholder="https://example.com/geoserver/wcs"
            />
            <Button
              type="button"
              variant="outline"
              onClick={retrieve}
              disabled={retrieving || !endpoint.trim()}
            >
              {retrieving ? t("addData.wms.retrieving") : t("addData.wcs.retrieve")}
            </Button>
          </div>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="wcs-coverage">{t("addData.wcs.coverage")}</Label>
          <Select
            id="wcs-coverage"
            value={coverage}
            onChange={(event) => setCoverage(event.target.value)}
            disabled={!coverages.length}
          >
            <option value="" disabled>
              {t("addData.wcs.select")}
            </option>
            {coverages.map((item) => (
              <option key={item.name} value={item.name}>
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
              if (extent) setBounds(extent.map(String));
            }}
          >
            {t("rasterSubset.useView")}
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={!coverages.find((item) => item.name === coverage)?.bounds}
            onClick={() => {
              const extent = coverages.find((item) => item.name === coverage)?.bounds;
              if (extent) setBounds(extent.map(String));
            }}
          >
            {t("addData.wcs.extent")}
          </Button>
        </div>
        <div className="grid grid-cols-2 gap-3">
          {AXES.map((axis, index) => (
            <div className="space-y-1.5" key={axis}>
              <Label htmlFor={`wcs-${axis}`}>{t(`rasterSubset.${axis}`)}</Label>
              <Input
                id={`wcs-${axis}`}
                type="number"
                step="any"
                value={bounds[index]}
                onChange={(event) =>
                  setBounds(bounds.map((v, i) => (i === index ? event.target.value : v)))
                }
              />
            </div>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">{t("rasterSubset.bboxHint")}</p>
        <div className="space-y-1.5">
          <Label htmlFor="wcs-crs">{t("addData.wcs.crs")}</Label>
          <Select
            id="wcs-crs"
            value={crs}
            onChange={(event) => setCrs(event.target.value as WcsCrs | "auto")}
          >
            <option value="auto">{t("addData.wcs.crsAuto")}</option>
            {WCS_CRSES.map((value) => (
              <option key={value} value={value}>
                {t(value === "EPSG:4326" ? "addData.wcs.crs4326" : "addData.wcs.crs3857")}
              </option>
            ))}
          </Select>
          <p className="text-xs text-muted-foreground">{t("addData.wcs.crsHint")}</p>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="wcs-width">{t("addData.wcs.width")}</Label>
            <Input
              id="wcs-width"
              type="number"
              min="1"
              max="4096"
              value={width}
              onChange={(event) => setWidth(event.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="wcs-height">{t("addData.wcs.height")}</Label>
            <Input
              id="wcs-height"
              type="number"
              min="1"
              max="4096"
              value={height}
              onChange={(event) => setHeight(event.target.value)}
            />
          </div>
        </div>
        <p className="text-xs text-muted-foreground">{t("addData.wcs.hint")}</p>
        <SampleDataSelect
          samples={SAMPLES}
          onSelect={(sample) => {
            resetEndpoint(sample.endpoint);
            setBounds(sample.bounds.map(String));
          }}
        />
      </fieldset>
    </AddDataSourceForm>
  );
}
