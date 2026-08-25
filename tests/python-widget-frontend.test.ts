import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, it } from "node:test";

import {
  KERNEL_CONTENT_RANGE_HEADER,
  KERNEL_RANGE_PROXY_MARKER,
  KERNEL_RANGE_QUERY,
} from "../apps/geolibre-desktop/src/lib/kernel-proxy-range";
import {
  canProxyLocalFiles,
  rewriteProxiedLocalFileUrls,
} from "../python/src/geolibre/_frontend.js";

const readSource = (relative: string) =>
  readFileSync(fileURLToPath(new URL(`../${relative}`, import.meta.url)), "utf8");

describe("rewriteProxiedLocalFileUrls", () => {
  it("routes registered raster files through the Colab proxy without mutating the project", () => {
    const localUrl = "http://127.0.0.1:41123/_geolibre_local/token/geolibre-xarray.tif?download=1";
    const project = {
      layers: [
        {
          id: "raster",
          source: { type: "raster", url: localUrl },
          sourcePath: localUrl,
        },
      ],
    };

    const rewritten = rewriteProxiedLocalFileUrls(
      project,
      "https://session-41123-colab.googleusercontent.com/",
      41123,
    );

    assert.notEqual(rewritten, project);
    assert.equal(project.layers[0].source.url, localUrl);
    assert.equal(
      rewritten.layers[0].source.url,
      "https://session-41123-colab.googleusercontent.com/_geolibre_local/token/" +
        "geolibre-xarray.tif?download=1&__geolibre_range_proxy=1",
    );
    assert.equal(rewritten.layers[0].sourcePath, rewritten.layers[0].source.url);
  });

  it("preserves a Jupyter server proxy path and rewrites sourcePath independently", () => {
    const project = {
      layers: [
        {
          source: { url: "https://example.com/remote.tif" },
          sourcePath: "http://localhost:41123/_geolibre_local/token/local.tif",
        },
      ],
    };

    const rewritten = rewriteProxiedLocalFileUrls(
      project,
      "https://hub.example/user/alice/proxy/41123/",
      41123,
    );

    assert.equal(rewritten.layers[0].source.url, "https://example.com/remote.tif");
    assert.equal(
      rewritten.layers[0].sourcePath,
      "https://hub.example/user/alice/proxy/41123/_geolibre_local/token/local.tif",
    );
  });

  it("rebases a local-file URL synced by another Colab widget view", () => {
    const stale =
      "https://old-view-41123-colab.googleusercontent.com/" +
      "_geolibre_local/token/geolibre-xarray.tif";
    const project = {
      layers: [{ source: { url: stale }, sourcePath: stale }],
    };

    const rewritten = rewriteProxiedLocalFileUrls(
      project,
      "https://current-view-41123-colab.googleusercontent.com/",
      41123,
    );

    assert.equal(
      rewritten.layers[0].source.url,
      "https://current-view-41123-colab.googleusercontent.com/" +
        "_geolibre_local/token/geolibre-xarray.tif?__geolibre_range_proxy=1",
    );
    assert.equal(rewritten.layers[0].sourcePath, rewritten.layers[0].source.url);
  });

  it("routes kernel-rendered XYZ tiles through the Colab proxy", () => {
    const template = "http://127.0.0.1:41123/_geolibre_tiles/token/{z}/{x}/{y}.png";
    const project = {
      layers: [{ source: { tiles: [template], url: template } }],
    };

    const rewritten = rewriteProxiedLocalFileUrls(
      project,
      "https://session-41123-colab.googleusercontent.com/",
      41123,
    );

    const expected =
      "https://session-41123-colab.googleusercontent.com/" +
      "_geolibre_tiles/token/{z}/{x}/{y}.png";
    assert.equal(rewritten.layers[0].source.url, expected);
    assert.deepEqual(rewritten.layers[0].source.tiles, [expected]);
  });

  it("does not rewrite unrelated, wrong-port, or already-remote URLs", () => {
    const project = {
      layers: [
        { source: { url: "http://127.0.0.1:41123/user-data.tif" } },
        { source: { url: "http://127.0.0.1:9999/_geolibre_local/token/a.tif" } },
        { source: { url: "https://example.com/a.tif" } },
      ],
    };

    assert.equal(
      rewriteProxiedLocalFileUrls(project, "https://session-colab.example/", 41123),
      project,
    );
  });

  it("leaves a look-alike Colab host on a foreign port alone", () => {
    const project = {
      layers: [
        {
          source: {
            url:
              "https://old-view-41123-colab.googleusercontent.com:9999/" +
              "_geolibre_local/token/a.tif",
          },
        },
      ],
    };

    assert.equal(
      rewriteProxiedLocalFileUrls(
        project,
        "https://session-41123-colab.googleusercontent.com/",
        41123,
      ),
      project,
    );
  });
});

describe("canProxyLocalFiles", () => {
  const setWindow = (extras: Record<string, unknown> = {}) => {
    (globalThis as Record<string, unknown>).window = {
      location: { href: "https://hub.example/user/alice/lab" },
      ...extras,
    };
    (globalThis as Record<string, unknown>).document = {
      getElementById: () => ({ textContent: JSON.stringify({ baseUrl: "/user/alice/" }) }),
    };
  };

  afterEach(() => {
    delete (globalThis as Record<string, unknown>).window;
    delete (globalThis as Record<string, unknown>).document;
  });

  it("rewrites when the app is itself served by jupyter-server-proxy", () => {
    setWindow();
    assert.equal(canProxyLocalFiles("https://hub.example/user/alice/proxy/41123/", 41123), true);
  });

  it("leaves loopback URLs alone under the Jupyter Server extension", () => {
    setWindow();
    assert.equal(canProxyLocalFiles("https://hub.example/user/alice/geolibre/app/", 41123), false);
    // The proxy route for another port is not this widget's transport either.
    assert.equal(canProxyLocalFiles("https://hub.example/user/alice/proxy/9999/", 41123), false);
  });

  it("rewrites on any base once a Colab kernel is present", () => {
    setWindow({ google: { colab: { kernel: {} } } });
    assert.equal(
      canProxyLocalFiles("https://session-41123-colab.googleusercontent.com/", 41123),
      true,
    );
  });

  it("declines before the app port is known", () => {
    setWindow({ google: { colab: { kernel: {} } } });
    assert.equal(
      canProxyLocalFiles("https://session-41123-colab.googleusercontent.com/", 0),
      false,
    );
  });
});

describe("the Colab range-bridge wire contract", () => {
  it("is spelled the same way on the Python side", () => {
    const frontend = readSource("python/src/geolibre/_frontend.js");
    const server = readSource("python/src/geolibre/_server.py");

    assert.ok(
      frontend.includes(`searchParams.set("${KERNEL_RANGE_PROXY_MARKER}", "1")`),
      "the widget must mark proxied local-file URLs with KERNEL_RANGE_PROXY_MARKER",
    );
    assert.ok(
      server.includes(`.get("${KERNEL_RANGE_QUERY}", [None])`),
      "the local-file route must read the range from KERNEL_RANGE_QUERY",
    );
    assert.ok(
      server.includes(`self.send_header("${KERNEL_CONTENT_RANGE_HEADER}"`),
      "the local-file route must report its span in KERNEL_CONTENT_RANGE_HEADER",
    );
    assert.ok(
      server.includes(`"Access-Control-Expose-Headers", "${KERNEL_CONTENT_RANGE_HEADER}"`),
      "the custom range header must be exposed to cross-origin fetches",
    );
  });
});
