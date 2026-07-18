import { getLayerBounds } from "@geolibre/map";
import { Button, Input, Label, Select } from "@geolibre/ui";
import type { FeatureCollection } from "geojson";
import { FileUp } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { parseGpxLayer } from "../../../../lib/gpx";
import { openLocalDataFileWithFallback } from "../../../../lib/tauri-io";
import { DEFAULT_GPX_URL } from "../constants";
import {
  createBaseLayer,
  errorMessage,
  fileNameFromPath,
  layerNameFromPath,
  proxyFeedRequestUrl,
} from "../helpers";
import { AddDataSourceForm, SampleDataSelect, useAddDataSource } from "../shared";
import type { GpxLayerKind, GpxMode } from "../types";

export function GpxSource() {
  const { t } = useTranslation();
  // Captured once on mount so the "did the user rename it?" comparisons below
  // stay stable even if the UI language changes while the dialog is open.
  const [defaultName] = useState(() => t("addData.gpx.defaultName"));
  const source = useAddDataSource(defaultName);
  const [gpxMode, setGpxMode] = useState<GpxMode>("url");
  const [gpxUrl, setGpxUrl] = useState("");
  const [selectedGpx, setSelectedGpx] = useState<{
    path: string;
    text: string;
  } | null>(null);
  const [selectedGpxLayerKinds, setSelectedGpxLayerKinds] = useState<Record<GpxLayerKind, boolean>>(
    {
      routes: true,
      routePoints: false,
      tracks: true,
      trackPoints: false,
      waypoints: true,
    },
  );

  const hasSelectedGpxLayerKind = Object.values(selectedGpxLayerKinds).some(Boolean);

  const handleGpxModeChange = (mode: GpxMode) => {
    setGpxMode(mode);
    setSelectedGpx(null);
  };

  const setGpxLayerKindSelected = (layerKind: GpxLayerKind, selected: boolean) => {
    setSelectedGpxLayerKinds((current) => ({
      ...current,
      [layerKind]: selected,
    }));
  };

  const handleChooseGpx = async () => {
    source.setError(null);
    try {
      const result = await openLocalDataFileWithFallback({
        filters: [
          {
            name: "GPX",
            extensions: ["gpx"],
          },
        ],
        accept: ".gpx",
        readText: true,
      });
      if (!result) return;
      if (!result.text) throw new Error(t("addData.gpx.errorFileMissing"));
      setSelectedGpx({
        path: result.path,
        text: result.text,
      });
      source.setLayerName((current) =>
        current.trim() && current !== defaultName
          ? current
          : layerNameFromPath(result.path, defaultName),
      );
    } catch (err) {
      source.setError(errorMessage(err, t("addData.gpx.readError")));
    }
  };

  const readGpxSource = async (): Promise<{
    sourcePath: string;
    text: string;
  }> => {
    if (gpxMode === "file") {
      if (!selectedGpx) throw new Error(t("addData.gpx.errorChooseFile"));
      return {
        sourcePath: selectedGpx.path,
        text: selectedGpx.text,
      };
    }

    const sourcePath = gpxUrl.trim();
    if (!sourcePath) throw new Error(t("addData.gpx.errorUrl"));

    const response = await fetch(proxyFeedRequestUrl(sourcePath));
    if (!response.ok) {
      throw new Error(t("addData.common.requestFailed", { status: response.status }));
    }
    return {
      sourcePath,
      text: await response.text(),
    };
  };

  const handleSubmit = source.runSubmit(async () => {
    const name = source.layerName.trim() || defaultName;
    if (!hasSelectedGpxLayerKind) {
      throw new Error(t("addData.gpx.errorSelectType"));
    }

    const { sourcePath, text } = await readGpxSource();
    // Building the per-point collections is skipped for unchecked kinds so a
    // large track/route does not pay the cost when its points are not wanted.
    const result = parseGpxLayer(text, {
      includeRoutePoints: selectedGpxLayerKinds.routePoints,
      includeTrackPoints: selectedGpxLayerKinds.trackPoints,
    });
    const gpxLayerGroups: Array<{
      featureCollection: FeatureCollection;
      kind: GpxLayerKind;
      label: string;
    }> = [
      {
        featureCollection: result.waypoints,
        kind: "waypoints",
        label: t("addData.gpx.waypoints"),
      },
      {
        featureCollection: result.tracks,
        kind: "tracks",
        label: t("addData.gpx.tracks"),
      },
      {
        featureCollection: result.trackPoints,
        kind: "trackPoints",
        label: t("addData.gpx.trackPoints"),
      },
      {
        featureCollection: result.routes,
        kind: "routes",
        label: t("addData.gpx.routes"),
      },
      {
        featureCollection: result.routePoints,
        kind: "routePoints",
        label: t("addData.gpx.routePoints"),
      },
    ];
    const layers = gpxLayerGroups
      .filter(
        (group) => selectedGpxLayerKinds[group.kind] && group.featureCollection.features.length > 0,
      )
      .map((group) => ({
        ...createBaseLayer(
          `${name} ${group.label}`,
          "geojson",
          {
            type: "geojson",
            url: sourcePath,
          },
          {
            featureCount: group.featureCollection.features.length,
            gpxLayerKind: group.kind,
            routeCount: result.routeCount,
            routePointCount: result.routePointCount,
            sourceKind: "gpx",
            trackCount: result.trackCount,
            trackPointCount: result.trackPointCount,
            waypointCount: result.waypointCount,
          },
        ),
        geojson: group.featureCollection,
        sourcePath,
      }));

    if (layers.length === 0) {
      throw new Error(t("addData.gpx.errorNotFound"));
    }

    for (const layer of layers) {
      source.shell.addLayer(layer, source.beforeLayer);
    }
    const combinedBounds = layers.reduce<[number, number, number, number] | null>(
      (merged, layer) => {
        const bounds = getLayerBounds(layer);
        if (!bounds) return merged;
        if (!merged) return bounds;
        return [
          Math.min(merged[0], bounds[0]),
          Math.min(merged[1], bounds[1]),
          Math.max(merged[2], bounds[2]),
          Math.max(merged[3], bounds[3]),
        ];
      },
      null,
    );
    if (combinedBounds) {
      source.shell.mapControllerRef.current?.fitBounds(combinedBounds);
    } else {
      source.shell.mapControllerRef.current?.fitLayer(layers[0]);
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
      submitDisabled={source.isSubmitting || !hasSelectedGpxLayerKind}
    >
      <div className="space-y-3">
        <div className="space-y-1.5">
          <Label htmlFor="gpx-mode">{t("addData.common.sourceType")}</Label>
          <Select
            id="gpx-mode"
            value={gpxMode}
            onChange={(event) => handleGpxModeChange(event.target.value as GpxMode)}
          >
            <option value="url">{t("addData.gpx.url")}</option>
            <option value="file">{t("addData.gpx.file")}</option>
          </Select>
        </div>

        {gpxMode === "file" ? (
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" variant="outline" onClick={handleChooseGpx}>
              <FileUp className="me-2 h-3.5 w-3.5" />
              {t("addData.common.chooseFile")}
            </Button>
            <span className="min-w-0 truncate text-xs text-muted-foreground">
              {selectedGpx
                ? fileNameFromPath(selectedGpx.path)
                : t("addData.common.noFileSelected")}
            </span>
          </div>
        ) : (
          <div className="space-y-1.5">
            <Label htmlFor="gpx-url">{t("addData.gpx.url")}</Label>
            <Input
              id="gpx-url"
              placeholder={t("addData.gpx.urlPlaceholder")}
              value={gpxUrl}
              onChange={(event) => setGpxUrl(event.target.value)}
            />
          </div>
        )}

        <div className="space-y-2">
          <Label>{t("addData.gpx.layerTypes")}</Label>
          <div className="grid gap-2 sm:grid-cols-3">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={selectedGpxLayerKinds.waypoints}
                onChange={(event) => setGpxLayerKindSelected("waypoints", event.target.checked)}
              />
              {t("addData.gpx.waypoints")}
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={selectedGpxLayerKinds.tracks}
                onChange={(event) => setGpxLayerKindSelected("tracks", event.target.checked)}
              />
              {t("addData.gpx.tracks")}
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={selectedGpxLayerKinds.trackPoints}
                onChange={(event) => setGpxLayerKindSelected("trackPoints", event.target.checked)}
              />
              {t("addData.gpx.trackPoints")}
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={selectedGpxLayerKinds.routes}
                onChange={(event) => setGpxLayerKindSelected("routes", event.target.checked)}
              />
              {t("addData.gpx.routes")}
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={selectedGpxLayerKinds.routePoints}
                onChange={(event) => setGpxLayerKindSelected("routePoints", event.target.checked)}
              />
              {t("addData.gpx.routePoints")}
            </label>
          </div>
        </div>
        <SampleDataSelect
          samples={[{ label: t("addData.gpx.sampleLabel"), value: DEFAULT_GPX_URL }]}
          onSelect={(url) => {
            setGpxMode("url");
            setSelectedGpx(null);
            setGpxUrl(url);
          }}
        />
      </div>
    </AddDataSourceForm>
  );
}
