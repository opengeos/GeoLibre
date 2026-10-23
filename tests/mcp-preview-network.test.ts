import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { RequestParameters } from "maplibre-gl";
import {
  createNetworkConsent,
  type PreviewToolTransport,
} from "../apps/geolibre-mcp-app/src/network-consent";
import "./helpers/dom";

type WireBytes = { bytes: Uint8Array };
type Call = { name: string; args: Record<string, unknown>; signal?: AbortSignal };
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function harness(
  options: {
    response?: (url: URL) => unknown | Promise<unknown>;
    approve?: () => Promise<unknown> | unknown;
    failFetch?: (url: URL) => unknown;
    origins?: readonly string[];
  } = {},
) {
  const calls: Call[] = [];
  const panel = document.createElement("section");
  document.body.append(panel);
  const notices: string[] = [];
  const transport: PreviewToolTransport = async (params, requestOptions) => {
    const args = params.arguments as Record<string, unknown>;
    calls.push({ name: params.name, args, signal: requestOptions?.signal });
    if (params.name === "approve_map_origin")
      return {
        structuredContent: await (options.approve?.() ?? {
          grant: `grant-${String(args.origin)}`,
          expiresIn: 300,
        }),
      } as never;
    if (params.name === "fetch_map_resource") {
      if (options.failFetch) return options.failFetch(new URL(String(args.url))) as never;
      const value = (await options.response?.(new URL(String(args.url)))) ?? { served: true };
      const bytes =
        value && typeof value === "object" && "bytes" in value
          ? (value as WireBytes).bytes
          : new TextEncoder().encode(typeof value === "string" ? value : JSON.stringify(value));
      let binary = "";
      for (const byte of bytes) binary += String.fromCharCode(byte);
      return {
        structuredContent: { data: btoa(binary), mimeType: "application/octet-stream" },
      } as never;
    }
    return { structuredContent: { closed: true } } as never;
  };
  const consent = createNetworkConsent(
    panel,
    "preview-test",
    transport,
    (notice) => notices.push(notice),
    options.origins ?? [],
  );
  cleanups.push(async () => {
    await consent.dispose();
    panel.remove();
  });
  return {
    panel,
    calls,
    notices,
    consent,
    async load(
      url: string,
      controller = new AbortController(),
      type: "json" | "string" | "arrayBuffer" = "json",
    ) {
      const request = await consent.transformRequest(url);
      return consent.load({ ...request, type } as RequestParameters, controller);
    },
    fetches() {
      return calls.filter(({ name }) => name === "fetch_map_resource");
    },
    grants() {
      return calls.filter(({ name }) => name === "approve_map_origin");
    },
  };
}

async function click(panel: HTMLElement, index = 0): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  const button = panel.querySelector<HTMLButtonElement>(
    `button[data-consent-action="${index === 0 ? "allow" : "block"}"]`,
  );
  assert.ok(button, "consent prompt should be visible");
  button.click();
}

function noBrowserNetwork(): void {
  globalThis.fetch = async () => {
    throw new Error("browser network must remain unavailable");
  };
}

describe("MCP preview network consent", () => {
  it("requires exact-origin consent before Python tools and never uses browser fetch", async () => {
    noBrowserNetwork();
    const view = harness();
    const first = view.load("https://tiles.example.test/style.json");
    const second = view.load("https://tiles.example.test/tile.pbf");
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(view.calls, []);
    assert.ok(view.panel.textContent?.includes("https://tiles.example.test"));
    await click(view.panel);
    await Promise.all([first, second]);
    assert.equal(view.grants().length, 1);
    assert.equal(view.fetches().length, 2);
    assert.deepEqual(
      view
        .fetches()
        .map(({ args }) => args.url)
        .sort(),
      ["https://tiles.example.test/style.json", "https://tiles.example.test/tile.pbf"],
    );
  });
  it("does not carry an origin decision into a reopened preview", async () => {
    const first = harness();
    const initial = first.load("https://persist.example.test/style");
    await click(first.panel);
    await initial;
    const reopened = harness();
    const next = reopened.load("https://persist.example.test/style");
    const rejected = assert.rejects(next, /declined/);
    await click(reopened.panel, 1);
    await rejected;
    assert.equal(reopened.grants().length, 0);
    assert.equal(reopened.fetches().length, 0);
  });

  it("declining sends neither grant nor resource calls, including later attempts", async () => {
    const view = harness();
    const request = view.load("https://declined.example.test/map");
    const rejected = assert.rejects(request, /declined/);
    await click(view.panel, 1);
    await rejected;
    await assert.rejects(view.load("https://declined.example.test/tile"), /declined/);
    assert.equal(view.grants().length, 0);
    assert.equal(view.fetches().length, 0);
  });

  it(
    "shows declared origins together and approves a source that starts after the style loads",
    { timeout: 2000 },
    async () => {
      noBrowserNetwork();
      const view = harness({
        origins: ["https://styles.example.test", "https://imagery.example.test"],
      });
      const style = view.load("https://styles.example.test/style.json");
      await new Promise<void>((resolve) => setImmediate(resolve));
      const displayed = [...view.panel.querySelectorAll("code")].map((item) => item.textContent);
      assert.deepEqual(displayed, ["https://styles.example.test", "https://imagery.example.test"]);
      assert.deepEqual(view.calls, []);
      await click(view.panel);
      await style;
      await view.load("https://imagery.example.test/tile.png");
      assert.equal(view.panel.hidden, true);
      assert.deepEqual(
        view.grants().map(({ args }) => args.origin),
        ["https://styles.example.test", "https://imagery.example.test"],
      );
      assert.deepEqual(
        view.fetches().map(({ args }) => args.url),
        ["https://styles.example.test/style.json", "https://imagery.example.test/tile.png"],
      );
    },
  );

  it("approves concurrent origins with one decision", { timeout: 2000 }, async () => {
    const view = harness();
    const first = view.load("https://one.example.test/tile");
    const second = view.load("https://two.example.test/tile");
    await click(view.panel);
    await Promise.all([first, second]);
    assert.deepEqual(
      view
        .grants()
        .map(({ args }) => args.origin)
        .sort(),
      ["https://one.example.test", "https://two.example.test"],
    );
    assert.equal(view.panel.hidden, true);
  });

  it("blocks all declared origins, including sources not requested until later", async () => {
    const view = harness({
      origins: ["https://styles.example.test", "https://imagery.example.test"],
    });
    const rejected = assert.rejects(
      view.load("https://styles.example.test/style.json"),
      /declined/,
    );
    await click(view.panel, 1);
    await rejected;
    await assert.rejects(view.load("https://imagery.example.test/tile.png"), /declined/);
    assert.equal(view.panel.hidden, true);
    assert.deepEqual(view.calls, []);
  });

  it("does not let a cancelled request discard another origin's pending consent", async () => {
    const view = harness();
    const controller = new AbortController();
    const rejected = assert.rejects(view.load("https://cancel.example.test/tile", controller), {
      name: "AbortError",
    });
    const remaining = view.load("https://keep.example.test/tile");
    await new Promise<void>((resolve) => setImmediate(resolve));
    controller.abort();
    await rejected;
    assert.equal(view.panel.hidden, false);
    await click(view.panel);
    await remaining;
    assert.deepEqual(
      view.fetches().map(({ args }) => args.url),
      ["https://keep.example.test/tile"],
    );
  });

  it("requires another batch only for newly discovered origins and binds calls to the preview", async () => {
    const view = harness();
    const style = view.load("https://styles.example.test/style.json");
    await click(view.panel);
    await style;
    const tile = view.load("https://tiles.example.test/tile");
    const rejected = assert.rejects(tile, /declined/);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.ok(view.panel.textContent?.includes("https://tiles.example.test"));
    await click(view.panel, 1);
    await rejected;
    assert.equal(view.grants().length, 1);
    assert.equal(view.fetches().length, 1);
  });

  it("rejects credential-bearing URLs before any approval or fetch tool call", async () => {
    const view = harness();
    assert.throws(
      () => view.consent.transformRequest("https://user:secret@private.example.test/style"),
      /credential-bearing/,
    );
    assert.equal(view.grants().length, 0);
    assert.equal(view.fetches().length, 0);
  });

  it("cancels before consent without server requests and removes an orphan prompt", async () => {
    const view = harness();
    const controller = new AbortController();
    const request = view.load("https://cancel.example.test/style", controller);
    const rejected = assert.rejects(request, { name: "AbortError" });
    await new Promise<void>((resolve) => setImmediate(resolve));
    controller.abort();
    await rejected;
    assert.equal(view.panel.hidden, true);
    assert.deepEqual(view.calls, []);
  });

  it("does not fetch when cancelled while shared grant acquisition is pending", async () => {
    const approval = deferred<unknown>();
    const view = harness({ approve: () => approval.promise });
    const controller = new AbortController();
    const request = view.load("https://cancel-grant.example.test/style", controller);
    await click(view.panel);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(view.grants().length, 1);
    controller.abort();
    await assert.rejects(request, { name: "AbortError" });
    approval.resolve({ grant: "unused", expiresIn: 300 });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(view.fetches().length, 0);
  });

  it("shares concurrent grant calls, caches live grants, and renews near expiry", async () => {
    let grantNumber = 0;
    const view = harness({
      approve: () => ({ grant: `grant-${++grantNumber}`, expiresIn: grantNumber === 1 ? 1 : 300 }),
    });
    const first = view.load("https://expiry.example.test/one");
    const second = view.load("https://expiry.example.test/two");
    await click(view.panel);
    await Promise.all([first, second]);
    assert.equal(view.grants().length, 1);
    await view.load("https://expiry.example.test/three");
    assert.equal(view.grants().length, 2);
    assert.equal(view.fetches()[2].args.grant, "grant-2");
    await view.load("https://expiry.example.test/four");
    assert.equal(view.grants().length, 2);
  });

  it("decodes binary, text, and JSON resource bytes", async () => {
    const binary = new Uint8Array([0, 128, 255]);
    const view = harness({
      response: (url) =>
        url.pathname.endsWith(".txt")
          ? "hello map"
          : url.pathname.endsWith(".pbf")
            ? { bytes: binary }
            : { value: url.pathname },
    });
    const text = view.load("https://decode.example.test/map.txt", new AbortController(), "string");
    await click(view.panel);
    assert.equal((await text).data, "hello map");
    assert.deepEqual((await view.load("https://decode.example.test/map.json")).data, {
      value: "/map.json",
    });
    const result = await view.load(
      "https://decode.example.test/tile.pbf",
      new AbortController(),
      "arrayBuffer",
    );
    assert.deepEqual([...new Uint8Array(result.data as ArrayBuffer)], [...binary]);
  });

  it("decodes a 4 MiB binary resource and rejects one byte over the limit", async () => {
    const bytes = Buffer.alloc(4 * 1024 * 1024, 0x80);
    const view = harness({
      failFetch: (url) => ({
        structuredContent: {
          data: (url.pathname === "/oversized"
            ? Buffer.concat([bytes, Buffer.from([0])])
            : bytes
          ).toString("base64"),
          mimeType: "application/octet-stream",
        },
      }),
    });
    const request = view.load(
      "https://large.example.test/tile",
      new AbortController(),
      "arrayBuffer",
    );
    await click(view.panel);
    assert.deepEqual(Buffer.from((await request).data as ArrayBuffer), bytes);
    await assert.rejects(
      view.load("https://large.example.test/oversized", new AbortController(), "arrayBuffer"),
      /4 MiB limit/,
    );
  });
  it("aborts an in-flight resource call with its MapLibre request signal", async () => {
    const response = deferred<unknown>();
    const view = harness({ response: () => response.promise });
    const requestController = new AbortController();
    const request = view.load("https://abort-resource.example.test/style", requestController);
    await click(view.panel);
    await new Promise<void>((resolve) => setImmediate(resolve));
    const fetchCall = view.fetches()[0];
    assert.ok(fetchCall?.signal);
    requestController.abort();
    await assert.rejects(request, { name: "AbortError" });
    assert.equal(fetchCall.signal.aborted, true);
    response.resolve({ type: "FeatureCollection", features: [] });
  });

  it("rejects malformed cached and error results with origin-only actionable messages", async () => {
    const malformed = harness({ approve: () => ({ grant: "", expiresIn: 999 }) });
    const pending = malformed.load("https://bad.example.test/style");
    const rejected = assert.rejects(pending, /invalid origin grant/);
    await click(malformed.panel);
    await rejected;
    assert.equal(malformed.fetches().length, 0);
    const badBytes = harness({
      failFetch: () => ({ structuredContent: { data: "not base64!", mimeType: "image/png" } }),
    });
    const badRequest = badBytes.load("https://bad.example.test/image.png");
    const badResponse = assert.rejects(badRequest, /invalid base64 resource data/);
    await click(badBytes.panel);
    await badResponse;
    assert.equal(badBytes.fetches().length, 1);

    const failing = harness({
      failFetch: () => ({
        isError: true,
        content: [
          { type: "text", text: "blocked https://bad.example.test/private/style?key=secret" },
        ],
      }),
    });
    const request = failing.load("https://bad.example.test/private/style?key=secret");
    const failed = assert.rejects(request, (error: Error) => {
      assert.match(error.message, /https:\/\/bad.example.test/);
      assert.doesNotMatch(error.message, /\/private\/style|secret/);
      return true;
    });
    await click(failing.panel);
    await failed;
  });

  it("removes fetched-style video sources before MapLibre can create ungated media", async () => {
    const style = {
      version: 8,
      sources: {
        video: {
          type: "video",
          urls: ["https://video.example.test/movie.mp4"],
          coordinates: [
            [0, 1],
            [1, 1],
            [1, 0],
            [0, 0],
          ],
        },
        points: { type: "geojson", data: { type: "FeatureCollection", features: [] } },
      },
      layers: [
        { id: "video-layer", type: "raster", source: "video" },
        { id: "points-layer", type: "circle", source: "points" },
      ],
    };
    const view = harness({ response: () => style });
    const request = view.load("https://style.example.test/style.json");
    await click(view.panel);
    const result = (await request).data as typeof style;
    assert.equal(result.sources.video, undefined);
    assert.ok(result.sources.points);
    assert.deepEqual(
      result.layers.map((layer) => layer.id),
      ["points-layer"],
    );
    assert.ok(view.notices.some((notice) => notice.includes("“video”")));
    assert.equal(view.grants().length, 1);
    assert.equal(view.fetches().length, 1);
  });

  it("disposes consent and revokes the preview session", async () => {
    const view = harness();
    const request = view.load("https://dispose.example.test/style");
    const rejected = assert.rejects(request, { name: "AbortError" });
    await new Promise<void>((resolve) => setImmediate(resolve));
    await view.consent.dispose();
    await rejected;
    assert.equal(view.panel.hidden, true);
    assert.ok(
      view.calls.some(
        ({ name, args }) => name === "close_map_preview" && args.preview_id === "preview-test",
      ),
    );
    assert.equal(view.fetches().length, 0);
  });
});
