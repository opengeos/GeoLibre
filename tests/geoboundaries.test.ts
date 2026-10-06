import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  corsGeoBoundariesUrl,
  geoBoundariesAttribution,
  geoBoundariesDownloadUrl,
  geoBoundariesLevelsUrl,
  parseGeoBoundariesCountries,
  parseGeoBoundariesLevels,
} from "../apps/geolibre-desktop/src/lib/geoboundaries";

const RAW =
  "https://github.com/wmgeolab/geoBoundaries/raw/9469f09/releaseData/gbOpen/PRT/ADM3/geoBoundaries-PRT-ADM3.geojson";
const RAW_SIMPLIFIED = RAW.replace(".geojson", "_simplified.geojson");

const PRT_ADM3 = {
  boundaryISO: "PRT",
  boundaryName: "Portugal",
  boundaryType: "ADM3",
  boundaryCanonical: "Freguesias",
  boundarySource: "geoBoundaries, DG Territory",
  boundaryLicense: "CC0 1.0 Universal (CC0 1.0) Public Domain Dedication",
  admUnitCount: "2905",
  gjDownloadURL: RAW,
  simplifiedGeometryGeoJSON: RAW_SIMPLIFIED,
};

describe("geoBoundaries helpers", () => {
  it("rewrites github raw links to the CORS-enabled LFS media host", () => {
    assert.equal(
      corsGeoBoundariesUrl(RAW),
      "https://media.githubusercontent.com/media/wmgeolab/geoBoundaries/9469f09/releaseData/gbOpen/PRT/ADM3/geoBoundaries-PRT-ADM3.geojson",
    );
    assert.equal(
      corsGeoBoundariesUrl("https://example.com/a.geojson"),
      "https://example.com/a.geojson",
    );
  });

  it("parses and sorts the country list, dropping blanks and duplicates", () => {
    const countries = parseGeoBoundariesCountries([
      { boundaryISO: "prt", boundaryName: "Portugal" },
      { boundaryISO: "ABW", boundaryName: "Aruba" },
      { boundaryISO: "PRT", boundaryName: "Portugal again" },
      { boundaryName: "No code" },
    ]);
    assert.deepEqual(countries, [
      { iso: "ABW", name: "Aruba" },
      { iso: "PRT", name: "Portugal" },
    ]);
  });

  it("parses a country's levels coarsest first", () => {
    const levels = parseGeoBoundariesLevels([
      PRT_ADM3,
      { ...PRT_ADM3, boundaryType: "ADM0", boundaryCanonical: "nan", admUnitCount: "1" },
      { ...PRT_ADM3, boundaryType: "ADM1", gjDownloadURL: "" },
      { ...PRT_ADM3, boundaryType: "ADM2", boundaryCanonical: "gbOpen" },
      { ...PRT_ADM3, boundaryType: "ADM4", boundaryCanonical: "Unknown" },
    ]);
    assert.deepEqual(
      levels.map((level) => [level.level, level.canonicalName, level.unitCount]),
      [
        ["ADM0", undefined, 1],
        ["ADM2", undefined, 2905],
        ["ADM3", "Freguesias", 2905],
        ["ADM4", undefined, 2905],
      ],
    );
  });

  it("accepts a single-object response", () => {
    assert.equal(parseGeoBoundariesLevels(PRT_ADM3).length, 1);
  });

  it("picks the simplified or full download URL", () => {
    const [level] = parseGeoBoundariesLevels(PRT_ADM3);
    assert.match(
      geoBoundariesDownloadUrl(level!, true),
      /^https:\/\/media\.githubusercontent\.com\/.*_simplified\.geojson$/,
    );
    assert.match(geoBoundariesDownloadUrl(level!, false), /ADM3\.geojson$/);
    const [noSimplified] = parseGeoBoundariesLevels({ ...PRT_ADM3, simplifiedGeometryGeoJSON: "" });
    assert.match(geoBoundariesDownloadUrl(noSimplified!, true), /ADM3\.geojson$/);
  });

  it("credits the source and license without repeating geoBoundaries or allowing markup", () => {
    const [level] = parseGeoBoundariesLevels(PRT_ADM3);
    const attribution = geoBoundariesAttribution(level!);
    assert.match(attribution, /^<a href="https:\/\/www\.geoboundaries\.org"/);
    assert.match(attribution, /\(DG Territory, CC0 1\.0/);
    const [hostile] = parseGeoBoundariesLevels({ ...PRT_ADM3, boundarySource: "<img src=x>" });
    assert.doesNotMatch(geoBoundariesAttribution(hostile!), /<img/);
  });

  it("builds the per-country level listing URL", () => {
    assert.equal(
      geoBoundariesLevelsUrl("prt"),
      "https://www.geoboundaries.org/api/current/gbOpen/PRT/ALL/",
    );
  });
});
