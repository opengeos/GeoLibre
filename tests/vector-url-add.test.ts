import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  addVectorLayersThroughControl,
  type VectorUrlSink,
} from "../packages/plugins/src/plugins/maplibre-vector";

/**
 * A control whose `addData` takes as long as the caller says before it
 * registers the layers that load created, so two loads can be put in flight at
 * once the way two "Add" clicks in the STAC panel would.
 */
function createSlowControl(loads: Record<string, { ids: string[]; delayMs: number }>) {
  const layers: { id: string; source: { kind: "url"; url: string } }[] = [];
  const control = {
    addData: async (url: string) => {
      const load = loads[String(url)];
      await new Promise((resolve) => setTimeout(resolve, load.delayMs));
      layers.push(
        ...load.ids.map((id) => ({
          id: layers.some((layer) => layer.id === id) ? `${id}-again` : id,
          source: { kind: "url" as const, url },
        })),
      );
      return {} as never;
    },
    getLayers: () => layers.slice(),
  } as unknown as VectorUrlSink;
  return { control, layers };
}

describe("addVectorLayersThroughControl", () => {
  it("reports every layer a multi-layer container created", async () => {
    const { control } = createSlowControl({
      "https://example.com/tables.gpkg": { ids: ["roads", "rivers"], delayMs: 0 },
    });

    assert.deepEqual(
      await addVectorLayersThroughControl(control, "https://example.com/tables.gpkg"),
      ["roads", "rivers"],
    );
  });

  it("keeps overlapping loads from claiming each other's layers", async () => {
    // The slow load starts first and finishes last: on a bare before/after
    // diff it would report the fast load's layer as its own, and the STAC
    // panel would then stamp one asset's access record onto the other's layer.
    const { control } = createSlowControl({
      "https://example.com/slow.parquet": { ids: ["slow-1"], delayMs: 20 },
      "https://example.com/fast.parquet": { ids: ["fast-1"], delayMs: 0 },
    });

    const [slow, fast] = await Promise.all([
      addVectorLayersThroughControl(control, "https://example.com/slow.parquet"),
      addVectorLayersThroughControl(control, "https://example.com/fast.parquet"),
    ]);

    assert.deepEqual(slow, ["slow-1"]);
    assert.deepEqual(fast, ["fast-1"]);
  });

  it("still reports new layers when the control rewrites the url it records", async () => {
    // The control stores a url source verbatim today. If it ever stopped, an
    // add that worked must not be reported as one that added nothing.
    const layers: { id: string; source: { kind: "url"; url: string } }[] = [];
    const control = {
      addData: async (url: string) => {
        layers.push({ id: "rewritten", source: { kind: "url" as const, url: `${url}/` } });
        return {} as never;
      },
      getLayers: () => layers.slice(),
    } as unknown as VectorUrlSink;

    assert.deepEqual(
      await addVectorLayersThroughControl(control, "https://example.com/places.parquet"),
      ["rewritten"],
    );
  });

  it("ignores layers the control already held for the same url", async () => {
    const { control } = createSlowControl({
      "https://example.com/places.parquet": { ids: ["places-1"], delayMs: 0 },
    });

    await addVectorLayersThroughControl(control, "https://example.com/places.parquet");

    // The first load's layer is still there and still matches the url, so only
    // the "before" snapshot tells the second load's layer apart from it.
    assert.deepEqual(
      await addVectorLayersThroughControl(control, "https://example.com/places.parquet"),
      ["places-1-again"],
    );
  });
});
