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
  const layers: { id: string }[] = [];
  const control = {
    addData: async (url: string) => {
      const load = loads[String(url)];
      await new Promise((resolve) => setTimeout(resolve, load.delayMs));
      layers.push(...load.ids.map((id) => ({ id })));
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
    // The slow load starts first and finishes last: with a shared "before"
    // snapshot it would report the fast load's layer as its own, and the STAC
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

  it("lets a queued load run after the one before it failed", async () => {
    const layers: { id: string }[] = [];
    const control = {
      addData: async (url: string) => {
        if (String(url).includes("broken")) throw new Error("load failed");
        layers.push({ id: "later" });
        return {} as never;
      },
      getLayers: () => layers.slice(),
    } as unknown as VectorUrlSink;

    await assert.rejects(
      addVectorLayersThroughControl(control, "https://example.com/broken.parquet"),
      /load failed/,
    );
    assert.deepEqual(
      await addVectorLayersThroughControl(control, "https://example.com/ok.parquet"),
      ["later"],
    );
  });
});
