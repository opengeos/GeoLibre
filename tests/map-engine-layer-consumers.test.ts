import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { DEFAULT_LAYER_STYLE, type GeoLibreLayer } from "../packages/core/src/index";
import type { MapLayerPort } from "../packages/map/src/engine/types";
import { readLayerFeatureCollection } from "../apps/geolibre-desktop/src/lib/map-engine-layer-data";

// Browser-only vector dependencies probe the worker-global alias while the app
// module graph initializes under Node.
const globalWithSelf = globalThis as typeof globalThis & { self?: typeof globalThis };
globalWithSelf.self = globalThis;

async function resolveLayerGeojson(target: GeoLibreLayer, port: MapLayerPort) {
  const module = await import("../apps/geolibre-desktop/src/lib/vector-export");
  return module.resolveLayerGeojson(target, port);
}

function layer(patch: Partial<GeoLibreLayer> = {}): GeoLibreLayer {
  return {
    id: "cities",
    name: "Cities",
    type: "geojson",
    source: { type: "geojson" },
    visible: true,
    opacity: 1,
    style: DEFAULT_LAYER_STYLE,
    metadata: {},
    ...patch,
  };
}

const storedCollection = {
  type: "FeatureCollection" as const,
  features: [
    {
      type: "Feature" as const,
      id: "stored",
      properties: { name: "Stored" },
      geometry: { type: "Point" as const, coordinates: [8.55, 47.37] },
    },
  ],
};

const rendererCollection = {
  type: "FeatureCollection" as const,
  features: [
    {
      type: "Feature" as const,
      id: "renderer",
      properties: { name: "Renderer" },
      geometry: { type: "Point" as const, coordinates: [7.45, 46.95] },
    },
  ],
};

function layerPort(readGeoJson: MapLayerPort["readGeoJson"]): MapLayerPort {
  return {
    readGeoJson,
    readRasterSource: () => null,
    queryInView: () => [],
    listRenderTargets: () => [],
    queryAtLngLat: async () => [],
    setHighlight: () => undefined,
    clearHighlight: () => undefined,
  };
}

describe("renderer-held layer recovery", () => {
  it("keeps inline store GeoJSON authoritative and does not consult the renderer", async () => {
    let reads = 0;
    const result = await resolveLayerGeojson(
      layer({ geojson: storedCollection }),
      layerPort(async () => {
        reads += 1;
        return rendererCollection;
      }),
    );

    assert.equal(result, storedCollection);
    assert.equal(reads, 0);
  });

  it("uses the layer port only for an explicitly renderer-held GeoJSON layer", async () => {
    const reads: string[] = [];
    const result = await resolveLayerGeojson(
      layer({
        metadata: {
          sourceKind: "maplibre-gl-vector",
          externalNativeLayer: true,
          sourceIds: ["native-cities"],
        },
      }),
      layerPort(async (layerId) => {
        reads.push(layerId);
        return rendererCollection;
      }),
    );

    assert.equal(result, rendererCollection);
    assert.deepEqual(reads, ["cities"]);
  });

  it("keeps shared scripting/assistant recovery store-first", async () => {
    const reads: string[] = [];
    const port = layerPort(async (layerId) => {
      reads.push(layerId);
      return rendererCollection;
    });

    const stored = await readLayerFeatureCollection(layer({ geojson: storedCollection }), port);
    assert.equal(stored, storedCollection);
    assert.deepEqual(reads, []);

    const recovered = await readLayerFeatureCollection(layer(), port);
    assert.equal(recovered, rendererCollection);
    assert.deepEqual(reads, ["cities"]);
  });
});

it("migrated layer-query consumers contain no native renderer reads", async () => {
  const root = path.resolve(import.meta.dirname, "..");
  const files = [
    "apps/geolibre-desktop/src/lib/vector-export.ts",
    "apps/geolibre-desktop/src/components/panels/AttributeTable.tsx",
    "apps/geolibre-desktop/src/components/panels/LayerPanel.tsx",
    "apps/geolibre-desktop/src/components/panels/RouteAnimationPanel.tsx",
    "apps/geolibre-desktop/src/components/panels/StylePanel.tsx",
    "apps/geolibre-desktop/src/components/storymap/StoryMapPanel.tsx",
    "apps/geolibre-desktop/src/components/layout/LoadFeaturesIntoEditorDialog.tsx",
    "apps/geolibre-desktop/src/components/processing/ModelBuilderDialog.tsx",
    "apps/geolibre-desktop/src/components/processing/StatisticsToolsDialog.tsx",
    "apps/geolibre-desktop/src/components/processing/VectorToolsDialog.tsx",
    "apps/geolibre-desktop/src/hooks/useCommandBridge.ts",
    "apps/geolibre-desktop/src/hooks/useNotebookBridge.ts",
  ];
  const forbidden =
    /\.get(?:Source|Layer|Style)\(|queryRenderedFeatures\(|getLayerGeoJson\(|getLayerRasterSource\(|getBasemapStyleLayerIds\(|identifyFeatures\(/;

  for (const relative of files) {
    const source = await readFile(path.join(root, relative), "utf8");
    assert.doesNotMatch(source, forbidden, relative);
  }
});
