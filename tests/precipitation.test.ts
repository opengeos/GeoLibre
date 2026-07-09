import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { radarFramesFromResponse } from "../packages/plugins/src/plugins/maplibre-precipitation";

describe("radarFramesFromResponse", () => {
  const validHost = "https://tilecache.rainviewer.com";

  it("builds one 512-px frame per past entry with the RainViewer tile template", () => {
    const frames = radarFramesFromResponse({
      host: validHost,
      radar: {
        past: [
          { time: 1_700_000_000, path: "/v2/radar/aaaa" },
          { time: 1_700_000_600, path: "/v2/radar/bbbb" },
        ],
      },
    });
    assert.equal(frames.length, 2);
    assert.equal(
      frames[0].tileUrl,
      `${validHost}/v2/radar/aaaa/512/{z}/{x}/{y}/4/1_1.png`,
    );
    // {z}/{y}/{x} is a GIBS quirk; RainViewer is plain {z}/{x}/{y}.
    assert.ok(frames[1].tileUrl.endsWith("/512/{z}/{x}/{y}/4/1_1.png"));
    assert.ok(typeof frames[0].label === "string" && frames[0].label.length > 0);
    assert.equal(frames[0].metadata.provider, "RainViewer");
  });

  it("returns [] when there are no past frames", () => {
    assert.deepEqual(radarFramesFromResponse({ host: validHost, radar: { past: [] } }), []);
    assert.deepEqual(radarFramesFromResponse({ host: validHost }), []);
    assert.deepEqual(radarFramesFromResponse({}), []);
  });

  it("rejects a non-https or missing host (untrusted API response)", () => {
    const past = [{ time: 1_700_000_000, path: "/v2/radar/aaaa" }];
    assert.deepEqual(radarFramesFromResponse({ host: "http://evil.example", radar: { past } }), []);
    assert.deepEqual(radarFramesFromResponse({ host: "ftp://x", radar: { past } }), []);
    assert.deepEqual(radarFramesFromResponse({ radar: { past } }), []);
  });

  it("drops malformed frame entries (missing path/time)", () => {
    const frames = radarFramesFromResponse({
      host: validHost,
      radar: {
        past: [
          { time: 1_700_000_000, path: "/v2/radar/ok" },
          { path: "/v2/radar/no-time" } as never,
          { time: 1_700_000_600 } as never,
        ],
      },
    });
    assert.equal(frames.length, 1);
    assert.ok(frames[0].tileUrl.includes("/v2/radar/ok/"));
  });
});
