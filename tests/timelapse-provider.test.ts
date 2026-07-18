import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  EOX_S2CLOUDLESS_PROVIDER_ID,
  eoxS2CloudlessProvider,
  getTimelapseProvider,
  listTimelapseProviders,
  MODIS_LANDCOVER_PROVIDER_ID,
  modisLandCoverProvider,
  NASA_GIBS_WELD_NDVI_PROVIDER_ID,
  nasaGibsWeldNdviProvider,
  NASA_GIBS_WELD_PROVIDER_ID,
  nasaGibsWeldProvider,
  registerTimelapseProvider,
  type TimelapseFrame,
} from "../packages/plugins/src/plugins/timelapse-providers";

function eoxFrames(): TimelapseFrame[] {
  const frames = eoxS2CloudlessProvider.listFrames();
  assert.ok(Array.isArray(frames), "EOX provider is synchronous");
  return frames;
}

function gibsFrames(): TimelapseFrame[] {
  const frames = nasaGibsWeldProvider.listFrames();
  assert.ok(Array.isArray(frames), "NASA GIBS provider is synchronous");
  return frames;
}

describe("eoxS2CloudlessProvider", () => {
  it("lists the eight annual mosaics 2018–2025 in order", () => {
    const frames = eoxFrames();
    assert.equal(frames.length, 8);
    assert.deepEqual(
      frames.map((frame) => frame.year),
      [2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025],
    );
    assert.deepEqual(
      frames.map((frame) => frame.label),
      frames.map((frame) => String(frame.year)),
    );
  });

  it("uses the year-suffixed layer identifier for every frame", () => {
    // The range starts at 2018: the unsuffixed s2cloudless_3857 layer is the
    // 2016 mosaic and the 2017 layer serves blank placeholder tiles.
    for (const frame of eoxFrames()) {
      assert.equal(
        frame.tileUrlTemplate,
        `https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-${frame.year}_3857/default/g/{z}/{y}/{x}.jpg`,
      );
    }
  });

  it("credits EOX with the mosaic year in each frame attribution", () => {
    for (const frame of eoxFrames()) {
      assert.ok(frame.attribution.includes(String(frame.year)));
      assert.ok(frame.attribution.includes("https://s2maps.eu"));
      assert.ok(frame.attribution.includes("EOX IT Services GmbH"));
    }
  });

  it("shares one provider-level attribution for the map control", () => {
    assert.ok(eoxS2CloudlessProvider.attribution.includes("2018–2025"));
    assert.ok(eoxS2CloudlessProvider.attribution.includes("EOX IT Services GmbH"));
  });

  it("caps the source maxzoom so the warm stack does not overfetch", () => {
    for (const frame of eoxFrames()) {
      assert.equal(frame.maxzoom, 15);
      assert.equal(frame.tileSize, 256);
    }
  });
});

describe("nasaGibsWeldProvider", () => {
  it("lists only the nine sparse WELD annual mosaics in order", () => {
    // GIBS publishes the global WELD layer for three disjoint spans only —
    // 1983–1985, 1988–1990, 1998–2000 — so the frame list steps over the gaps.
    const frames = gibsFrames();
    assert.deepEqual(
      frames.map((frame) => frame.year),
      [1983, 1984, 1985, 1988, 1989, 1990, 1998, 1999, 2000],
    );
    assert.deepEqual(
      frames.map((frame) => frame.label),
      frames.map((frame) => String(frame.year)),
    );
  });

  it("targets the true-color WMTS layer with the mosaic's December date", () => {
    for (const frame of gibsFrames()) {
      assert.equal(
        frame.tileUrlTemplate,
        "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/" +
          "Landsat_WELD_CorrectedReflectance_TrueColor_Global_Annual/default/" +
          `${frame.year}-12-01/GoogleMapsCompatible_Level12/{z}/{y}/{x}.jpeg`,
      );
    }
  });

  it("credits NASA EOSDIS GIBS with the mosaic year in each frame", () => {
    for (const frame of gibsFrames()) {
      assert.ok(frame.attribution.includes(String(frame.year)));
      assert.ok(frame.attribution.includes("NASA EOSDIS GIBS"));
    }
  });

  it("caps the source maxzoom at the Level12 matrix set's native depth", () => {
    for (const frame of gibsFrames()) {
      assert.equal(frame.maxzoom, 12);
      assert.equal(frame.tileSize, 256);
    }
  });
});

describe("nasaGibsWeldNdviProvider", () => {
  function frames(): TimelapseFrame[] {
    const result = nasaGibsWeldNdviProvider.listFrames();
    assert.ok(Array.isArray(result), "WELD NDVI provider is synchronous");
    return result;
  }

  it("shares the WELD sparse annual years (1983–2000 with gaps)", () => {
    assert.deepEqual(
      frames().map((frame) => frame.year),
      [1983, 1984, 1985, 1988, 1989, 1990, 1998, 1999, 2000],
    );
  });

  it("targets the WELD NDVI WMTS layer with the December date", () => {
    for (const frame of frames()) {
      assert.equal(
        frame.tileUrlTemplate,
        "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/" +
          "Landsat_WELD_NDVI_Global_Annual/default/" +
          `${frame.year}-12-01/GoogleMapsCompatible_Level12/{z}/{y}/{x}.jpeg`,
      );
      assert.equal(frame.maxzoom, 12);
      assert.equal(frame.tileSize, 256);
    }
  });

  it("carries a binned NDVI legend as rgb swatches", () => {
    const legend = nasaGibsWeldNdviProvider.legend;
    assert.ok(legend, "provider has a legend");
    assert.ok(legend.length >= 4);
    for (const item of legend) {
      assert.match(item.color, /^rgb\(\d+,\d+,\d+\)$/);
      assert.ok(item.label.length > 0);
    }
  });

  it("credits NASA EOSDIS GIBS with the mosaic year in each frame", () => {
    for (const frame of frames()) {
      assert.ok(frame.attribution.includes(String(frame.year)));
      assert.ok(frame.attribution.includes("NDVI"));
      assert.ok(frame.attribution.includes("NASA EOSDIS GIBS"));
    }
  });
});

describe("modisLandCoverProvider", () => {
  function frames(): TimelapseFrame[] {
    const result = modisLandCoverProvider.listFrames();
    assert.ok(Array.isArray(result), "MODIS land cover provider is synchronous");
    return result;
  }

  it("lists the 24 continuous annual mosaics 2001–2024 in order", () => {
    const years = frames().map((frame) => frame.year);
    assert.equal(years.length, 24);
    assert.equal(years[0], 2001);
    assert.equal(years[years.length - 1], 2024);
    // Continuous — no gaps, unlike the WELD provider.
    for (let i = 1; i < years.length; i += 1) {
      assert.equal(years[i] - years[i - 1], 1);
    }
  });

  it("targets the IGBP land-cover WMTS layer as PNG with the January date", () => {
    for (const frame of frames()) {
      assert.equal(
        frame.tileUrlTemplate,
        "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/" +
          "MODIS_Combined_L3_IGBP_Land_Cover_Type_Annual/default/" +
          `${frame.year}-01-01/GoogleMapsCompatible_Level8/{z}/{y}/{x}.png`,
      );
      assert.equal(frame.maxzoom, 8);
      assert.equal(frame.tileSize, 256);
    }
  });

  it("carries the IGBP class legend as rgb swatches", () => {
    const legend = modisLandCoverProvider.legend;
    assert.ok(legend, "provider has a legend");
    assert.equal(legend.length, 17);
    for (const item of legend) {
      assert.match(item.color, /^rgb\(\d+,\d+,\d+\)$/);
      assert.ok(item.label.length > 0);
    }
    assert.ok(legend.some((item) => item.label === "Urban and built-up"));
  });

  it("credits NASA EOSDIS GIBS with the mosaic year in each frame", () => {
    for (const frame of frames()) {
      assert.ok(frame.attribution.includes(String(frame.year)));
      assert.ok(frame.attribution.includes("NASA EOSDIS GIBS"));
    }
  });
});

describe("timelapse provider registry", () => {
  it("returns the EOX provider by id and as the fallback", () => {
    assert.equal(getTimelapseProvider(EOX_S2CLOUDLESS_PROVIDER_ID), eoxS2CloudlessProvider);
    assert.equal(getTimelapseProvider("no-such-provider"), eoxS2CloudlessProvider);
    assert.equal(getTimelapseProvider(undefined), eoxS2CloudlessProvider);
  });

  it("returns each NASA GIBS provider by id and lists all built-ins", () => {
    assert.equal(getTimelapseProvider(NASA_GIBS_WELD_PROVIDER_ID), nasaGibsWeldProvider);
    assert.equal(getTimelapseProvider(NASA_GIBS_WELD_NDVI_PROVIDER_ID), nasaGibsWeldNdviProvider);
    assert.equal(getTimelapseProvider(MODIS_LANDCOVER_PROVIDER_ID), modisLandCoverProvider);
    const all = listTimelapseProviders();
    assert.ok(all.includes(eoxS2CloudlessProvider));
    assert.ok(all.includes(nasaGibsWeldProvider));
    assert.ok(all.includes(nasaGibsWeldNdviProvider));
    assert.ok(all.includes(modisLandCoverProvider));
  });

  it("lists registered providers and resolves them by id", () => {
    const custom = {
      id: "test-provider",
      name: "Test",
      attribution: "Test attribution",
      listFrames: () => [],
    };
    registerTimelapseProvider(custom);
    assert.equal(getTimelapseProvider("test-provider"), custom);
    assert.ok(listTimelapseProviders().includes(custom));
  });
});
