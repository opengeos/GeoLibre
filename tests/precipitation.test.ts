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
    assert.equal(frames[0].tileUrl, `${validHost}/v2/radar/aaaa/512/{z}/{x}/{y}/4/1_1.png`);
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

  it("rejects a non-https, non-rainviewer, or missing host (untrusted API response)", () => {
    const past = [{ time: 1_700_000_000, path: "/v2/radar/aaaa" }];
    assert.deepEqual(
      radarFramesFromResponse({ host: "http://tilecache.rainviewer.com", radar: { past } }),
      [],
    );
    assert.deepEqual(
      radarFramesFromResponse({ host: "https://evil.example", radar: { past } }),
      [],
    );
    assert.deepEqual(radarFramesFromResponse({ host: "ftp://x", radar: { past } }), []);
    assert.deepEqual(radarFramesFromResponse({ radar: { past } }), []);
    // Userinfo trick: real authority is evil.example, not rainviewer.com.
    assert.deepEqual(
      radarFramesFromResponse({
        host: "https://tilecache.rainviewer.com@evil.example",
        radar: { past },
      }),
      [],
    );
  });

  it("accepts any rainviewer.com subdomain over https", () => {
    const past = [{ time: 1_700_000_000, path: "/v2/radar/aaaa" }];
    assert.equal(
      radarFramesFromResponse({ host: "https://rainviewer.com", radar: { past } }).length,
      1,
    );
    assert.equal(
      radarFramesFromResponse({ host: "https://cdn.rainviewer.com", radar: { past } }).length,
      1,
    );
  });

  it("sorts frames oldest → newest even if the API returns them out of order", () => {
    const frames = radarFramesFromResponse({
      host: validHost,
      radar: {
        past: [
          { time: 300, path: "/v2/radar/c" },
          { time: 100, path: "/v2/radar/a" },
          { time: 200, path: "/v2/radar/b" },
        ],
      },
    });
    assert.deepEqual(
      frames.map((f) => f.tileUrl.match(/radar\/(\w)/)?.[1]),
      ["a", "b", "c"],
    );
  });

  it("drops frames whose path would redirect off the rainviewer host", () => {
    const frames = radarFramesFromResponse({
      host: validHost,
      radar: {
        past: [
          { time: 1, path: "/v2/radar/ok" },
          // `@evil.example` turns the validated host into userinfo.
          { time: 2, path: "@evil.example/v2/radar/x" },
        ],
      },
    });
    assert.equal(frames.length, 1);
    assert.ok(frames[0].tileUrl.includes("/v2/radar/ok/"));
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
