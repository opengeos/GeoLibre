import { getLayerBounds } from "@geolibre/map";
import { Button, Input, Label, Select } from "@geolibre/ui";
import type { FeatureCollection } from "geojson";
import { FileUp } from "lucide-react";
import { useState } from "react";
import { parseGpxLayer } from "../../../../lib/gpx";
import { openLocalDataFileWithFallback } from "../../../../lib/tauri-io";
import { DEFAULT_GPX_URL } from "../constants";
import {
  createBaseLayer,
  errorMessage,
  fileNameFromPath,
  layerNameFromPath,
  proxyGpxRequestUrl,
} from "../helpers";
import { AddDataSourceForm, useAddDataSource } from "../shared";
import type { GpxLayerKind, GpxMode } from "../types";

export function GpxSource() {
  const source = useAddDataSource("GPX Layer");
  const [gpxMode, setGpxMode] = useState<GpxMode>("url");
  const [gpxUrl, setGpxUrl] = useState(DEFAULT_GPX_URL);
  const [selectedGpx, setSelectedGpx] = useState<{
    path: string;
    text: string;
  } | null>(null);
  const [selectedGpxLayerKinds, setSelectedGpxLayerKinds] = useState<
    Record<GpxLayerKind, boolean>
  >({
    routes: true,
    tracks: true,
    waypoints: true,
  });

  const hasSelectedGpxLayerKind = Object.values(selectedGpxLayerKinds).some(
    Boolean,
  );

  const handleGpxModeChange = (mode: GpxMode) => {
    setGpxMode(mode);
    setSelectedGpx(null);
    if (mode === "url" && !gpxUrl.trim()) {
      setGpxUrl(DEFAULT_GPX_URL);
    }
  };

  const setGpxLayerKindSelected = (
    layerKind: GpxLayerKind,
    selected: boolean,
  ) => {
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
      if (!result.text) throw new Error("GPX file data is missing.");
      setSelectedGpx({
        path: result.path,
        text: result.text,
      });
      source.setLayerName((current) =>
        current.trim() && current !== "GPX Layer"
          ? current
          : layerNameFromPath(result.path, "GPX Layer"),
      );
    } catch (err) {
      source.setError(errorMessage(err, "Could not read GPX file."));
    }
  };

  const readGpxSource = async (): Promise<{
    sourcePath: string;
    text: string;
  }> => {
    if (gpxMode === "file") {
      if (!selectedGpx) throw new Error("Choose a GPX file.");
      return {
        sourcePath: selectedGpx.path,
        text: selectedGpx.text,
      };
    }

    const sourcePath = gpxUrl.trim();
    if (!sourcePath) throw new Error("Enter a GPX URL.");

    const response = await fetch(proxyGpxRequestUrl(sourcePath));
    if (!response.ok) {
      throw new Error(`Request failed with status ${response.status}`);
    }
    return {
      sourcePath,
      text: await response.text(),
    };
  };

  const handleSubmit = source.runSubmit(async () => {
    const name = source.layerName.trim() || "GPX Layer";
    if (!hasSelectedGpxLayerKind) {
      throw new Error("Select at least one GPX layer type.");
    }

    const { sourcePath, text } = await readGpxSource();
    const result = parseGpxLayer(text);
    const gpxLayerGroups: Array<{
      featureCollection: FeatureCollection;
      kind: GpxLayerKind;
      label: string;
    }> = [
      {
        featureCollection: result.waypoints,
        kind: "waypoints",
        label: "Waypoints",
      },
      {
        featureCollection: result.tracks,
        kind: "tracks",
        label: "Tracks",
      },
      {
        featureCollection: result.routes,
        kind: "routes",
        label: "Routes",
      },
    ];
    const layers = gpxLayerGroups
      .filter(
        (group) =>
          selectedGpxLayerKinds[group.kind] &&
          group.featureCollection.features.length > 0,
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
            sourceKind: "gpx",
            trackCount: result.trackCount,
            waypointCount: result.waypointCount,
          },
        ),
        geojson: group.featureCollection,
        sourcePath,
      }));

    if (layers.length === 0) {
      throw new Error("The selected GPX layer types were not found.");
    }

    for (const layer of layers) {
      source.shell.addLayer(layer, source.beforeLayer);
    }
    const combinedBounds = layers.reduce<
      [number, number, number, number] | null
    >((merged, layer) => {
      const bounds = getLayerBounds(layer);
      if (!bounds) return merged;
      if (!merged) return bounds;
      return [
        Math.min(merged[0], bounds[0]),
        Math.min(merged[1], bounds[1]),
        Math.max(merged[2], bounds[2]),
        Math.max(merged[3], bounds[3]),
      ];
    }, null);
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
          <Label htmlFor="gpx-mode">Source type</Label>
          <Select
            id="gpx-mode"
            value={gpxMode}
            onChange={(event) =>
              handleGpxModeChange(event.target.value as GpxMode)
            }
          >
            <option value="url">GPX URL</option>
            <option value="file">GPX file</option>
          </Select>
        </div>

        {gpxMode === "file" ? (
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" variant="outline" onClick={handleChooseGpx}>
              <FileUp className="mr-2 h-3.5 w-3.5" />
              Choose file
            </Button>
            <span className="min-w-0 truncate text-xs text-muted-foreground">
              {selectedGpx
                ? fileNameFromPath(selectedGpx.path)
                : "No file selected"}
            </span>
          </div>
        ) : (
          <div className="space-y-1.5">
            <Label htmlFor="gpx-url">GPX URL</Label>
            <Input
              id="gpx-url"
              placeholder="https://example.com/route.gpx"
              value={gpxUrl}
              onChange={(event) => setGpxUrl(event.target.value)}
            />
          </div>
        )}

        <div className="space-y-2">
          <Label>Layer types</Label>
          <div className="grid gap-2 sm:grid-cols-3">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={selectedGpxLayerKinds.waypoints}
                onChange={(event) =>
                  setGpxLayerKindSelected("waypoints", event.target.checked)
                }
              />
              Waypoints
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={selectedGpxLayerKinds.tracks}
                onChange={(event) =>
                  setGpxLayerKindSelected("tracks", event.target.checked)
                }
              />
              Tracks
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={selectedGpxLayerKinds.routes}
                onChange={(event) =>
                  setGpxLayerKindSelected("routes", event.target.checked)
                }
              />
              Routes
            </label>
          </div>
        </div>
      </div>
    </AddDataSourceForm>
  );
}
