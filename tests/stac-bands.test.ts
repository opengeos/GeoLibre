import assert from "node:assert/strict";
import test from "node:test";
import type { StacItem } from "../packages/plugins/src/plugins/stac-api";
import {
  availableCombinations,
  availableIndices,
  bandsForFormula,
  compileFormula,
  findBand,
  formulaNames,
  isValidFormula,
  itemBands,
} from "../packages/plugins/src/plugins/stac-bands";

const tif = "image/tiff; application=geotiff; profile=cloud-optimized";
const asset = (href: string, extra: Record<string, unknown> = {}) => ({
  href,
  type: tif,
  ...extra,
});

/** An Earth Search style Sentinel-2 item: one single-band asset per band, named by common name. */
const sentinel = {
  type: "Feature",
  id: "s2",
  geometry: null,
  properties: {},
  assets: {
    red: asset("https://x.test/B04.tif", {
      "eo:bands": [{ name: "B04", common_name: "red" }],
      "raster:bands": [{ scale: 0.0001, offset: -0.1 }],
    }),
    green: asset("https://x.test/B03.tif", { "eo:bands": [{ common_name: "green" }] }),
    blue: asset("https://x.test/B02.tif", { "eo:bands": [{ common_name: "blue" }] }),
    nir: asset("https://x.test/B08.tif", { "eo:bands": [{ common_name: "nir" }] }),
    swir16: asset("https://x.test/B11.tif"),
    metadata: { href: "https://x.test/meta.xml", type: "application/xml" },
  },
} as unknown as StacItem;

test("itemBands lists the drawable bands with their common names and scale", () => {
  const bands = itemBands(sentinel);
  assert.deepEqual(
    bands.map((band) => band.common),
    ["red", "green", "blue", "nir", "swir16"],
  );
  const red = bands.find((band) => band.common === "red")!;
  assert.equal(red.scale, 0.0001);
  assert.equal(red.offset, -0.1);
  // An asset with no band metadata falls back to its key, and a file that is no COG is skipped.
  assert.equal(bands.find((band) => band.asset === "swir16")?.scale, 1);
  assert.equal(
    bands.some((band) => band.asset === "metadata"),
    false,
  );
});

test("itemBands reads each band of a multi-band asset", () => {
  const naip = {
    type: "Feature",
    id: "naip",
    geometry: null,
    properties: {},
    assets: {
      image: asset("https://x.test/naip.tif", {
        "eo:bands": [
          { common_name: "red" },
          { common_name: "green" },
          { common_name: "blue" },
          { common_name: "nir" },
        ],
      }),
    },
  } as unknown as StacItem;
  const bands = itemBands(naip);
  assert.deepEqual(
    bands.map((band) => [band.common, band.index]),
    [
      ["red", 1],
      ["green", 2],
      ["blue", 3],
      ["nir", 4],
    ],
  );
  assert.ok(availableCombinations(bands).includes("Color infrared (vegetation)"));
});

test("findBand tries the usual stand-ins for a name", () => {
  const item = {
    ...sentinel,
    assets: { nir08: asset("https://x.test/n.tif"), swir1: asset("https://x.test/s.tif") },
  } as unknown as StacItem;
  const bands = itemBands(item);
  assert.equal(findBand(bands, "nir")?.asset, "nir08");
  assert.equal(findBand(bands, "swir16")?.asset, "swir1");
  assert.equal(findBand(bands, "red"), undefined);
});

test("only the combinations and indices an item has the bands for are offered", () => {
  const bands = itemBands(sentinel);
  const combinations = availableCombinations(bands);
  assert.ok(combinations.includes("True color"));
  assert.ok(combinations.includes("Color infrared (vegetation)"));
  assert.equal(combinations.includes("Shortwave infrared"), false);
  const indices = availableIndices(bands);
  assert.ok(indices.includes("NDVI (vegetation)"));
  assert.ok(indices.includes("NDMI (moisture)"));
  assert.equal(indices.includes("NBR (burn ratio)"), false);
});

test("formulaNames lists band names in order, leaving function names out", () => {
  assert.deepEqual(formulaNames("(nir - red) / (nir + red)"), ["nir", "red"]);
  assert.deepEqual(formulaNames("sqrt(abs(green)) + max(red, blue)"), ["green", "red", "blue"]);
});

test("compileFormula evaluates arithmetic with the right precedence", () => {
  assert.equal(compileFormula("(nir - red) / (nir + red)")([3, 1]), 0.5);
  assert.equal(compileFormula("a + b * 2")([1, 3]), 7);
  assert.equal(compileFormula("-a ^ 2")([3]), -9);
  assert.equal(compileFormula("a ^ 2 ^ 3")([2]), 256);
  assert.equal(compileFormula("sqrt(a) + min(a, b)")([16, 2]), 6);
  assert.ok(compileFormula("1.5 * (nir - red) / (nir + red + 0.5)")([0.5, 0.1]) > 0);
});

test("compileFormula rejects what is not plain arithmetic", () => {
  for (const bad of [
    "",
    "   ",
    "1 + 2",
    "red +",
    "(red",
    "red red",
    "red; alert(1)",
    "alert(red)",
  ]) {
    assert.equal(isValidFormula(bad), false, `rejects ${JSON.stringify(bad)}`);
  }
  assert.equal(isValidFormula("red / nir"), true);
});

test("bandsForFormula follows the order of the names", () => {
  const bands = itemBands(sentinel);
  assert.deepEqual(
    bandsForFormula("(nir - red) / (nir + red)", bands).map((band) => band.common),
    ["nir", "red"],
  );
});
