import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { useAppStore } from "../packages/core/src/store";
import {
  __setComponentsModuleLoaderForTests,
  type ComponentsModules,
} from "../packages/plugins/src/plugins/components/constructors";
import {
  flatGeobufLayerName,
  openFlatGeobufAddVectorLayerPanel,
  teardownFlatGeobufControl,
} from "../packages/plugins/src/plugins/components/flatgeobuf";
import type { GeoLibreAppAPI } from "../packages/plugins/src/types";

// Regression tests: Add Data -> FlatGeobuf ignored the panel's Layer Name field
// and always named the layer after the URL's file name.

const COUNTIES_URL = "https://data.source.coop/opengeos/data/workshops/ngis-2026/us_counties.fgb";

type LayerInfo = {
  id: string;
  url: string;
  format: string;
  sourceId: string;
  layerIds: string[];
  featureCount: number;
  geometryTypes: string[];
  opacity: number;
  fillColor: string;
  strokeColor: string;
};

type AddEvent = {
  type: string;
  layerId?: string;
  state: { layerName: string; layers: LayerInfo[] };
};

let lastControl: FakeAddVectorControl | null = null;

// Mirrors the parts of maplibre-gl-components' AddVectorControl the panel uses.
// Upstream uses the trimmed Layer Name as the layer id, falling back to the
// URL's file name, and does not clear the field after the add.
class FakeAddVectorControl {
  layerName = "";
  private layers: LayerInfo[] = [];
  private handlers = new Map<string, Array<(event: AddEvent) => void>>();

  constructor() {
    lastControl = this;
  }

  on(event: string, handler: (event: AddEvent) => void): void {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
  }

  show(): void {}
  expand(): void {}
  removeLayer(): void {}

  getLayerIds(): string[] {
    return this.layers.flatMap((layer) => layer.layerIds);
  }

  add(url: string): string {
    const id =
      this.layerName.trim() ||
      (new URL(url).pathname.split("/").pop() ?? "").replace(/\.[^.]+$/, "");
    this.layers.push({
      id,
      url,
      format: "flatgeobuf",
      sourceId: `${id}-source`,
      layerIds: [`${id}-fill`, `${id}-outline`],
      featureCount: 3,
      geometryTypes: ["MultiPolygon"],
      opacity: 1,
      fillColor: "#3388ff",
      strokeColor: "#000000",
    });
    const event: AddEvent = {
      type: "layeradd",
      layerId: id,
      state: { layerName: this.layerName, layers: [...this.layers] },
    };
    for (const handler of this.handlers.get("layeradd") ?? []) handler(event);
    return id;
  }
}

const app = {
  addMapControl: () => true,
  removeMapControl: () => {},
  getMapRenderer: () => "maplibre",
} as unknown as GeoLibreAppAPI;

async function openPanel(): Promise<FakeAddVectorControl> {
  openFlatGeobufAddVectorLayerPanel(app);
  for (let i = 0; i < 20 && !lastControl; i += 1) await new Promise((r) => setTimeout(r, 0));
  assert.ok(lastControl, "the FlatGeobuf control was created");
  return lastControl;
}

describe("FlatGeobuf panel layer name", () => {
  beforeEach(() => {
    lastControl = null;
    __setComponentsModuleLoaderForTests(async () => [
      { AddVectorControl: FakeAddVectorControl } as unknown as NonNullable<ComponentsModules[0]>,
      null,
    ]);
    useAppStore.setState({ layers: [] });
  });

  afterEach(() => {
    teardownFlatGeobufControl(app);
    __setComponentsModuleLoaderForTests(null);
    useAppStore.setState({ layers: [] });
  });

  it("names the layer from the Layer Name field", async () => {
    const control = await openPanel();
    control.layerName = "  US counties (FlatGeobuf) ";
    const id = control.add(COUNTIES_URL);

    const layer = useAppStore.getState().layers.find((item) => item.id === id);
    assert.ok(layer);
    assert.equal(layer.name, "US counties (FlatGeobuf)");
    assert.equal(layer.type, "flatgeobuf");
    assert.equal(layer.sourcePath, COUNTIES_URL);
  });

  it("falls back to the URL's file name when the field is empty", async () => {
    const control = await openPanel();
    const id = control.add(COUNTIES_URL);

    const layer = useAppStore.getState().layers.find((item) => item.id === id);
    assert.equal(layer?.name, "us_counties");
  });
});

describe("flatGeobufLayerName", () => {
  it("keeps the typed name when the field changed while loading", () => {
    // The id is the name typed at Add time; the field now holds something else.
    assert.equal(
      flatGeobufLayerName({ id: "US counties (FlatGeobuf)", url: COUNTIES_URL }, "edited"),
      "US counties (FlatGeobuf)",
    );
  });

  it("keeps a typed name that equals the URL-derived id verbatim", () => {
    assert.equal(
      flatGeobufLayerName(
        { id: "air%20temp", url: "https://example.com/air%20temp.fgb" },
        "air%20temp",
      ),
      "air%20temp",
    );
  });

  it("uses the URL's file name when the id came from it", () => {
    assert.equal(flatGeobufLayerName({ id: "us_counties", url: COUNTIES_URL }), "us_counties");
  });

  it("decodes a percent-encoded file name when no name was typed", () => {
    assert.equal(
      flatGeobufLayerName({ id: "air%20temp", url: "https://example.com/air%20temp.fgb" }),
      "air temp",
    );
  });

  it("shows a generated id for inline GeoJSON as before", () => {
    assert.equal(flatGeobufLayerName({ id: "addvec-abc1234", url: "" }), "addvec-abc1234");
  });
});
