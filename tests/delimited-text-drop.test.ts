import assert from "node:assert/strict";
import { before, describe, it } from "node:test";

// tauri-io statically pulls in shpjs, whose bundle reads the browser `self`
// global at module-eval time; shim it before the dynamic import.
(globalThis as { self?: unknown }).self ??= globalThis;

type LoadDroppedVectorFiles = (
  files: File[],
) => Promise<
  { data: { features: { properties: Record<string, unknown> | null }[] }; path: string }[]
>;

let loadDroppedVectorFiles: LoadDroppedVectorFiles;

before(async () => {
  const mod = await import("../apps/geolibre-desktop/src/lib/tauri-io");
  loadDroppedVectorFiles = mod.loadDroppedVectorFiles as unknown as LoadDroppedVectorFiles;
});

/** Mirrors `DELIMITED_TEXT_HEADER_PROBE_BYTES`, which is module-private. */
const HEADER_PROBE_BYTES = 1024 * 1024;

/**
 * Builds a CSV whose header is wider than the header probe, with the
 * coordinate columns last so that a truncated probe could not find them.
 */
function wideHeaderCsv(leading: string): { text: string; headerLength: number } {
  const padding: string[] = [];
  // 21 bytes per name including its comma, so 55k names clears the 1 MB probe.
  for (let index = 0; index < 55_000; index += 1) {
    padding.push(`column_${String(index).padStart(6, "0")}_padded`);
  }
  const header = `${padding.join(",")},longitude,latitude`;
  const row = `${padding.map(() => "x").join(",")},-78.638,35.779`;
  return { text: `${leading}${header}\n${row}\n`, headerLength: header.length };
}

describe("dropped delimited text: header probe", () => {
  it("reads past the probe when the header itself is wider than it", async () => {
    const { text, headerLength } = wideHeaderCsv("");
    assert.ok(headerLength > HEADER_PROBE_BYTES, "the header must exceed the probe to be a test");

    const layers = await loadDroppedVectorFiles([new File([text], "wide.csv")]);

    // Truncating the probe would drop the trailing longitude/latitude columns,
    // coordinate detection would return null, and the file would fall through
    // to DuckDB instead of loading as points.
    assert.equal(layers.length, 1);
    assert.equal(layers[0].data.features.length, 1);
    assert.equal(layers[0].data.features[0].properties?.longitude, "-78.638");
  });

  it("still reads past the probe when blank lines precede that header", async () => {
    // The blank lines put a line break inside the probe, so a check for "any
    // newline" would call the probe complete and hand back a truncated header.
    const { text } = wideHeaderCsv("\n\n");

    const layers = await loadDroppedVectorFiles([new File([text], "wide-after-blanks.csv")]);

    assert.equal(layers.length, 1);
    assert.equal(layers[0].data.features.length, 1);
    assert.equal(layers[0].data.features[0].properties?.latitude, "35.779");
  });

  it("loads an ordinary small CSV, which is read whole rather than probed", async () => {
    const layers = await loadDroppedVectorFiles([
      new File(["name,longitude,latitude\nRaleigh,-78.638,35.779\n"], "small.csv"),
    ]);

    assert.equal(layers.length, 1);
    assert.equal(layers[0].data.features.length, 1);
    assert.equal(layers[0].data.features[0].properties?.name, "Raleigh");
  });
});
