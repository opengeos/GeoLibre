// Regenerates tests/fixtures/mini.pmtiles: a tiny (~6 KB) PMTiles archive
// built from tests/fixtures/striped.tif via the geolibre-wasm `write_pmtiles`
// WASI tool (z0-4 PNG pyramid, 3 deduplicated tiles). Used by
// tests/pmtiles-extract.test.ts to drive the range-request extract protocol
// against a real archive without committing a large fixture.
//
//   node scripts/gen-pmtiles-fixture.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = new URL("..", import.meta.url);
const { initTools, runTool } = await import(
  new URL("node_modules/geolibre-wasm/tools.mjs", root).href
);
await initTools(
  readFileSync(fileURLToPath(new URL("node_modules/geolibre-wasm/geolibre-cli.wasm", root))),
);

const result = await runTool("write_pmtiles", {
  args: ["--input=/work/dem.tif", "--output=/work/mini.pmtiles", "--min_zoom=0", "--max_zoom=4"],
  input: {
    "dem.tif": readFileSync(fileURLToPath(new URL("tests/fixtures/striped.tif", root))),
  },
});
if (result.exitCode !== 0 || !result.files["mini.pmtiles"]) {
  console.error(result.stdout.join("\n"));
  throw new Error(`write_pmtiles failed with exit code ${result.exitCode}`);
}

const out = fileURLToPath(new URL("tests/fixtures/mini.pmtiles", root));
writeFileSync(out, result.files["mini.pmtiles"]);
console.log(`Wrote ${out} (${result.files["mini.pmtiles"].length} bytes)`);
