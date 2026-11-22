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
  APP_LAYERS_FILE_HOST,
  buildLayersFileContent,
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
  it("does not strip snapshots from sources that cannot bootstrap on reload", () => {
    const urls = [
      "s3://private-bucket/data.json",
      "s3a://private-bucket/data.json",
      "https://private-bucket.s3.amazonaws.com/data.json",
      "http://localhost/data.json",
      "http://192.168.1.2/data.json",
    ];
    const layers = urls.map((url, index) =>
      layer({
        id: `blocked-${index}`,
        name: url,
        geojson: features,
        source: { type: "geojson", url },
      }),
    );
    useAppStore.setState({ layers });
    for (const entry of layers) assert.equal(APP_LAYERS_FILE_HOST.canRefetch(entry), false);
    const build = buildLayersFileContent(APP_LAYERS_FILE_HOST);
    assert.deepEqual(build.content.layers, []);
    assert.deepEqual(build.skipped, urls);
    assert.ok(useAppStore.getState().layers.every((entry) => entry.geojson === features));
  });

  it("exports public GeoJSON and private-host WFS as bootstrapable references", () => {
    useAppStore.setState({
      layers: [
        layer({
          id: "public",
          name: "Public",
          geojson: features,
          source: { type: "geojson", url: "https://example.test/data.json" },
        }),
        layer({
          id: "wfs",
          name: "WFS",
          geojson: features,
          source: { type: "geojson", url: "http://localhost/wfs" },
          metadata: { sourceKind: "wfs-getfeature" },
        }),
      ],
    });
    const build = buildLayersFileContent(APP_LAYERS_FILE_HOST);
    assert.deepEqual(build.skipped, []);
    assert.equal(build.content.layers.length, 2);
    assert.ok(build.content.layers.every((entry) => entry.geojson === undefined));
  });
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
