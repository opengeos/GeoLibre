import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Evented } from "maplibre-gl";
import {
  installArcgisLayerEvents,
  type NativeLayerPicker,
} from "../packages/map/src/arcgis-layer-events";

const FEATURE = {
  layerId: "store-footprints",
  featureId: "7",
  properties: { name: "scene" },
  geometry: { type: "Point" as const, coordinates: [1, 2] },
};

function setup(picker?: NativeLayerPicker) {
  class Facade extends Evented {}
  const facade = new Facade() as Evented & Record<string, unknown>;
  const picks: [string, string | undefined][] = [];
  let hit = true;
  installArcgisLayerEvents({
    facade,
    pick:
      picker ??
      ((_lngLat, layerId, source) => {
        picks.push([layerId, source]);
        return hit ? [FEATURE] : [];
      }),
    layerSource: (layerId) => (layerId.startsWith("fp-") ? "fp-source" : undefined),
    layerIds: () => ["fp-fill", "fp-line"],
    unproject: (point) => [point.x / 10, point.y / 10],
  });
  const pointer = (type: "click" | "mousemove") =>
    facade.fire(type, { point: { x: 10, y: 20 }, lngLat: { lng: 1, lat: 2 } });
  return { facade, picks, pointer, setHit: (value: boolean) => (hit = value) };
}

describe("ArcGIS control facade layer events", () => {
  it("delivers a layer-scoped click with the mirrored store features", () => {
    const { facade, picks, pointer } = setup();
    const events: Record<string, unknown>[] = [];
    facade.on(
      "click",
      "fp-fill" as never,
      ((event: Record<string, unknown>) => events.push(event)) as never,
    );
    pointer("click");
    assert.equal(events.length, 1);
    const [feature] = events[0].features as {
      id: unknown;
      layer: { id: string };
      source: string;
    }[];
    assert.equal(feature.id, 7, "a numeric feature id comes back as a number");
    assert.equal(feature.layer.id, "fp-fill");
    assert.equal(feature.source, "fp-source");
    assert.deepEqual(picks, [["fp-fill", "fp-source"]]);
  });

  it("stays silent on a miss and leaves plain listeners working", () => {
    const { facade, pointer, setHit } = setup();
    setHit(false);
    let scoped = 0;
    let plain = 0;
    facade.on("click", ["fp-fill"] as never, (() => scoped++) as never);
    facade.on("click", () => plain++);
    pointer("click");
    assert.equal(scoped, 0);
    assert.equal(plain, 1);
  });

  it("fires mouseenter and mouseleave once per crossing", () => {
    const { facade, pointer, setHit } = setup();
    const seen: string[] = [];
    facade.on(
      "mouseenter",
      "fp-fill" as never,
      ((event: { type: string }) => seen.push(event.type)) as never,
    );
    facade.on(
      "mouseleave",
      "fp-fill" as never,
      ((event: { type: string }) => seen.push(event.type)) as never,
    );
    pointer("mousemove");
    pointer("mousemove");
    setHit(false);
    pointer("mousemove");
    pointer("mousemove");
    assert.deepEqual(seen, ["mouseenter", "mouseleave"]);
  });

  it("removes a layer-scoped listener with off, and once fires one time", () => {
    const { facade, pointer } = setup();
    let count = 0;
    const listener = (() => count++) as never;
    facade.on("click", "fp-fill" as never, listener);
    facade.off("click", "fp-fill" as never, listener);
    facade.once("click", "fp-fill" as never, listener);
    pointer("click");
    pointer("click");
    assert.equal(count, 1);
  });

  it("reports a store feature once when a fill and its outline both mirror it", () => {
    const { facade } = setup();
    const query = facade.queryRenderedFeatures as (point: unknown, options?: unknown) => unknown[];
    assert.equal(query([10, 20]).length, 1, "no layers named: every shadow layer, deduplicated");
    assert.equal(query({ x: 10, y: 20 }, { layers: ["fp-line"] }).length, 1);
    assert.deepEqual(
      query([
        [0, 0],
        [5, 5],
      ]),
      [],
      "a box query answers empty",
    );
    assert.deepEqual(query(), [], "a whole-viewport query answers empty");
  });
});
