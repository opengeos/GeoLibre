import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import widget, {
  canProxyLocalFiles,
  rewriteProxiedLocalFileUrls,
} from "../python/src/geolibre/_frontend.js";

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
        "geolibre-xarray.tif?download=1",
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
        "_geolibre_local/token/geolibre-xarray.tif",
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

describe("widget control replay (GeoLibre#3241)", () => {
  type Message = { type: string; method?: string; params?: Record<string, unknown> };
  const appUrl = "http://127.0.0.1:8765/";
  let onMessage: ((event: unknown) => void) | undefined;
  const posted: Message[] = [];
  const contentWindow = { postMessage: (message: Message) => posted.push(message) };

  function fakeModel(values: Record<string, unknown>) {
    const handlers = new Map<string, () => void>();
    return {
      get: (key: string) => values[key],
      set: (key: string, value: unknown) => {
        values[key] = value;
      },
      save_changes: () => {},
      on: (event: string, handler: () => void) => handlers.set(event, handler),
      off: (event: string) => handlers.delete(event),
      send: () => {},
      update(key: string, value: unknown) {
        values[key] = value;
        handlers.get(`change:${key}`)?.();
      },
    };
  }

  const controlCommands = () =>
    posted.filter((message) => message.method === "setControlVisible").map((m) => m.params);
  const ready = () =>
    onMessage?.({
      source: contentWindow,
      origin: new URL(appUrl).origin,
      data: { type: "geolibre:ready" },
    });

  afterEach(() => {
    delete (globalThis as Record<string, unknown>).window;
    delete (globalThis as Record<string, unknown>).document;
    posted.length = 0;
    onMessage = undefined;
  });

  it("does not re-send collapsed options on unrelated _ui changes, but does after a reload", async () => {
    (globalThis as Record<string, unknown>).window = {
      location: { href: "http://localhost:8888/lab" },
      addEventListener: (_type: string, handler: (event: unknown) => void) => {
        onMessage = handler;
      },
      removeEventListener: () => {},
    };
    (globalThis as Record<string, unknown>).document = {
      createElement: () => ({ style: {}, contentWindow }),
      getElementById: () => null,
    };
    const model = fakeModel({
      _app_url: appUrl,
      project: { layers: [] },
      _ui: { controls: { measure: { visible: true, collapsed: true }, search: true } },
    });
    await widget.render({ model, el: { replaceChildren: () => {} } } as never);
    ready();
    assert.deepEqual(controlCommands(), [
      { control: "measure", visible: true, options: { collapsed: true } },
      { control: "search", visible: true },
    ]);

    posted.length = 0;
    model.update("_ui", { ...(model.get("_ui") as object), identify: "all" });
    assert.deepEqual(controlCommands(), [{ control: "search", visible: true }]);

    posted.length = 0;
    model.update("_ui", { controls: { measure: { visible: true, collapsed: false } } });
    assert.deepEqual(controlCommands(), [
      { control: "measure", visible: true, options: { collapsed: false } },
    ]);

    posted.length = 0;
    ready();
    assert.deepEqual(controlCommands(), [
      { control: "measure", visible: true, options: { collapsed: false } },
    ]);
  });
});
