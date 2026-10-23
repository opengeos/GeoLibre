import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import {
  createEmptyProject,
  DEFAULT_LAYER_STYLE,
  parseLayersFile,
  serializeLayersFile,
  useAppStore,
  type GeoLibreLayer,
} from "@geolibre/core";
import {
  normalizeDesktopSettings,
  useDesktopSettingsStore,
} from "../apps/geolibre-desktop/src/hooks/useDesktopSettings";
import {
  buildLayersFileContent,
  fetchStartupLayerFeatures,
  withStartupLayers,
  type LayersFileHost,
} from "../apps/geolibre-desktop/src/lib/startup-layers";

const features = {
  type: "FeatureCollection" as const,
  features: [
    {
      type: "Feature" as const,
      geometry: { type: "Point" as const, coordinates: [0, 0] },
      properties: {},
    },
  ],
};

function layer(patch: Partial<GeoLibreLayer>): GeoLibreLayer {
  return {
    id: "id",
    name: "Layer",
    type: "geojson",
    source: { type: "geojson" },
    visible: true,
    opacity: 1,
    style: { ...DEFAULT_LAYER_STYLE },
    metadata: {},
    ...patch,
  };
}

const tiles = layer({
  id: "tiles",
  name: "Tiles",
  type: "xyz",
  source: { type: "raster", tiles: ["https://t.example.com/{z}/{x}/{y}.png?api_key=SECRET"] },
});
const fromUrl = layer({
  id: "url",
  name: "From URL",
  geojson: features,
  sourcePath: "https://data.example.com/a.geojson",
});
const fromDisk = layer({
  id: "disk",
  name: "From disk",
  geojson: features,
  sourcePath: "/data/roads.geojson",
});
const drawn = layer({ id: "drawn", name: "Drawn", geojson: features });

const host: LayersFileHost = {
  isReloadableLocalFile: (entry) => entry.id === "disk",
  canRefetch: (entry) => entry.id === "url",
};

beforeEach(() => {
  useAppStore.getState().newProject();
  useDesktopSettingsStore.getState().setDesktopSettings(normalizeDesktopSettings({}));
});

describe("buildLayersFileContent", () => {
  it("writes references without features or credentials, and reports the rest", () => {
    useAppStore.setState({ layers: [tiles, fromUrl, fromDisk, drawn] });
    const build = buildLayersFileContent(host);
    assert.deepEqual(
      build.content.layers.map((entry) => entry.id),
      ["tiles", "url", "disk"],
    );
    assert.deepEqual(build.skipped, ["Drawn"]);
    assert.ok(build.redactedCount > 0);
    const json = serializeLayersFile(build.content);
    assert.doesNotMatch(json, /SECRET/);
    assert.doesNotMatch(json, /"coordinates"/);
    // The file parses back to the same layers.
    assert.equal(parseLayersFile(json).layers.length, 3);
  });

  it("limits the file to the given layers", () => {
    useAppStore.setState({ layers: [tiles, fromUrl] });
    const build = buildLayersFileContent(host, new Set(["url"]));
    assert.deepEqual(
      build.content.layers.map((entry) => entry.id),
      ["url"],
    );
  });
});

describe("startup layers", () => {
  it("are added to a new project only when set", () => {
    const empty = createEmptyProject();
    assert.equal(withStartupLayers(empty), empty);

    useAppStore.setState({ layers: [tiles, fromDisk] });
    const { content } = buildLayersFileContent(host);
    const current = useDesktopSettingsStore.getState().desktopSettings;
    useDesktopSettingsStore.getState().setDesktopSettings({
      ...current,
      startup: { ...current.startup, layers: { fileName: "a.json", path: "a.json", ...content } },
    });
    assert.deepEqual(
      withStartupLayers(createEmptyProject()).layers.map((entry) => entry.name),
      ["Tiles", "From disk"],
    );
  });

  it("fetch URL features into a clean workspace and keep it clean", async () => {
    const bare = { ...fromUrl, geojson: undefined };
    useAppStore.getState().loadProject({ ...createEmptyProject(), layers: [bare] }, null);
    assert.equal(useAppStore.getState().isDirty, false);
    await fetchStartupLayerFeatures(
      (entry) => !entry.geojson,
      async () => features,
    );
    const state = useAppStore.getState();
    assert.equal(state.layers[0].geojson?.features.length, 1);
    assert.equal(state.isDirty, false);
    // The fetch is not an undo step.
    assert.equal(useAppStore.temporal.getState().pastStates.length, 0);
  });

  it("drop a fetch that lands after the workspace changed", async () => {
    const bare = { ...fromUrl, geojson: undefined };
    useAppStore.getState().loadProject({ ...createEmptyProject(), layers: [bare] }, null);
    await fetchStartupLayerFeatures(
      (entry) => !entry.geojson,
      async () => {
        useAppStore.getState().newProject();
        return features;
      },
    );
    assert.equal(useAppStore.getState().layers.length, 0);
  });
});

describe("newProject with seed layers", () => {
  it("starts a clean project holding them and resets the previous one's state", () => {
    useAppStore.setState({ attributeFilter: "name = 'x'" });
    useAppStore.getState().newProject({ name: "Seeded", layers: [tiles] });
    const state = useAppStore.getState();
    assert.deepEqual(
      state.layers.map((entry) => entry.id),
      ["tiles"],
    );
    assert.equal(state.attributeFilter, "");
    assert.equal(state.selectedLayerId, null);
    assert.equal(state.isDirty, false);
  });
});
