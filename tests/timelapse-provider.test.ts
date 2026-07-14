import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  EOX_S2CLOUDLESS_PROVIDER_ID,
  eoxS2CloudlessProvider,
  getTimelapseProvider,
  listTimelapseProviders,
  registerTimelapseProvider,
  type TimelapseFrame,
} from "../packages/plugins/src/plugins/timelapse-providers";

function eoxFrames(): TimelapseFrame[] {
  const frames = eoxS2CloudlessProvider.listFrames();
  assert.ok(Array.isArray(frames), "EOX provider is synchronous");
  return frames;
}

describe("eoxS2CloudlessProvider", () => {
  it("lists the ten annual mosaics 2016–2025 in order", () => {
    const frames = eoxFrames();
    assert.equal(frames.length, 10);
    assert.deepEqual(
      frames.map((frame) => frame.year),
      [2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025],
    );
    assert.deepEqual(
      frames.map((frame) => frame.label),
      frames.map((frame) => String(frame.year)),
    );
  });

  it("uses the unsuffixed layer identifier for 2016 only", () => {
    const frames = eoxFrames();
    const first = frames[0];
    // EOX publishes the very first mosaic without a year suffix.
    assert.equal(
      first.tileUrlTemplate,
      "https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless_3857/default/g/{z}/{y}/{x}.jpg",
    );
    for (const frame of frames.slice(1)) {
      assert.ok(
        frame.tileUrlTemplate.includes(`s2cloudless-${frame.year}_3857`),
        `${frame.year} template carries its year suffix`,
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
    assert.ok(eoxS2CloudlessProvider.attribution.includes("2016–2025"));
    assert.ok(
      eoxS2CloudlessProvider.attribution.includes("EOX IT Services GmbH"),
    );
  });

  it("caps the source maxzoom so the warm stack does not overfetch", () => {
    for (const frame of eoxFrames()) {
      assert.equal(frame.maxzoom, 15);
      assert.equal(frame.tileSize, 256);
    }
  });
});

describe("timelapse provider registry", () => {
  it("returns the EOX provider by id and as the fallback", () => {
    assert.equal(
      getTimelapseProvider(EOX_S2CLOUDLESS_PROVIDER_ID),
      eoxS2CloudlessProvider,
    );
    assert.equal(getTimelapseProvider("no-such-provider"), eoxS2CloudlessProvider);
    assert.equal(getTimelapseProvider(undefined), eoxS2CloudlessProvider);
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
