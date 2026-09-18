import assert from "node:assert/strict";
import test from "node:test";
import { parseHTML } from "linkedom";
import { maplibrePortolanPlugin } from "../packages/plugins/src/plugins/maplibre-stac";
import { loadPortolanIndex, PORTOLAN_REGISTRY_URL } from "../packages/plugins/src/plugins/stac-api";
import type { GeoLibreAppAPI } from "../packages/plugins/src/types";

test("Portolan discovery reads only catalog links and resolves relative URLs", async () => {
  const controller = new AbortController();
  const catalogs = await loadPortolanIndex(async (input, init) => {
    assert.equal(input, PORTOLAN_REGISTRY_URL);
    assert.equal(init?.signal, controller.signal);
    return Response.json({
      type: "Catalog",
      links: [
        { rel: "self", href: PORTOLAN_REGISTRY_URL },
        {
          rel: "child",
          href: "https://utrecht.blob.core.windows.net/catalog/catalog.json",
          title: "Utrecht",
        },
        { rel: "child", href: "./example/catalog.json", title: "Example" },
        { rel: "child", href: "javascript:alert(1)", title: "Invalid" },
        { rel: "child", href: "https://example.org/catalog.json" },
        { rel: "item", href: "./item.json", title: "Not a catalog" },
        null,
      ],
    });
  }, controller.signal);
  assert.equal(catalogs.length, 3);
  assert.equal(catalogs[0].title, "Example");
  assert.equal(catalogs[0].url, new URL("./example/catalog.json", PORTOLAN_REGISTRY_URL).href);
  assert.ok(catalogs.every((catalog) => catalog.access === "public" && !catalog.isApi));
  assert.ok(catalogs.some((catalog) => catalog.title === "https://example.org/catalog.json"));
});

test("Portolan discovery reports HTTP and invalid registry responses", async () => {
  await assert.rejects(
    loadPortolanIndex(async () => new Response("", { status: 503 })),
    /503/,
  );
  for (const value of [null, [], {}, { type: "Catalog", links: null }]) {
    await assert.rejects(
      loadPortolanIndex(async () => Response.json(value)),
      /invalid catalog list/,
    );
  }
  assert.deepEqual(
    await loadPortolanIndex(async () => Response.json({ type: "Catalog", links: [] })),
    [],
  );
});

/**
 * The Portolan panel connects to the registry as its preset catalog and lists the same document in
 * the discovery dropdown, so it must reuse the connection instead of fetching the registry twice,
 * and fall back to its own fetch only when that connection failed.
 */
async function mountPortolanPanel(
  responses: Array<() => Response>,
): Promise<{ requests: string[]; options: () => string[]; teardown: () => void }> {
  const { document, window } = parseHTML("<!doctype html><html><body></body></html>");
  const globals = globalThis as Record<string, unknown>;
  const saved = {
    document: globals.document,
    window: globals.window,
    Event: globals.Event,
    fetch: globals.fetch,
  };
  const requests: string[] = [];
  // The panel assigns `select.value`, which linkedom exposes as a getter only. Mirror the
  // browser by selecting the matching option so the discovery dropdown can render.
  const selectValue = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value");
  Object.defineProperty(window.HTMLSelectElement.prototype, "value", {
    configurable: true,
    get: selectValue?.get,
    set(this: HTMLSelectElement, next: string) {
      for (const option of this.querySelectorAll("option")) {
        if (option.value === next) option.setAttribute("selected", "");
        else option.removeAttribute("selected");
      }
    },
  });
  globals.document = document;
  globals.window = window;
  globals.Event = window.Event;
  globals.fetch = async (input: RequestInfo | URL) => {
    requests.push(String(input));
    const next = responses.shift();
    if (!next) throw new Error(`Unexpected request: ${String(input)}`);
    return next();
  };
  const container = document.createElement("div") as unknown as HTMLElement;
  let disposePanel: (() => void) | undefined;
  const app = {
    getMap: () => null,
    registerRightPanel: (panel: { render: (element: HTMLElement) => () => void }) => {
      disposePanel = panel.render(container);
      return () => undefined;
    },
    openRightPanel: () => true,
  } as unknown as GeoLibreAppAPI;
  const options = (): string[] =>
    Array.from(
      container.querySelector("select")?.querySelectorAll("option") ?? [],
      (option) => (option as HTMLOptionElement).value || option.textContent || "",
    );
  const teardown = (): void => {
    disposePanel?.();
    maplibrePortolanPlugin.deactivate?.(app);
    Object.assign(globalThis, saved);
  };
  try {
    maplibrePortolanPlugin.activate(app);
    // Connect and discovery settle over a few microtask turns; wait until the select leaves its
    // "Loading…" placeholder or the queued responses have all been consumed and processed.
    for (let attempt = 0; attempt < 20 && options().length < 2 && responses.length; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  } catch (error) {
    teardown();
    throw error;
  }
  return { requests, options, teardown };
}

const registryDocument = () =>
  Response.json({
    type: "Catalog",
    id: "portolan",
    title: "Portolan Registry",
    links: [
      { rel: "self", href: PORTOLAN_REGISTRY_URL },
      { rel: "child", href: "https://a.example/catalog.json", title: "Alpha" },
      { rel: "child", href: "./beta/catalog.json", title: "Beta" },
    ],
  });
const registryChildren = [
  "https://a.example/catalog.json",
  new URL("./beta/catalog.json", PORTOLAN_REGISTRY_URL).href,
];

test("Portolan panel reuses the preset connection for discovery", async () => {
  const panel = await mountPortolanPanel([registryDocument]);
  try {
    assert.deepEqual(panel.requests, [PORTOLAN_REGISTRY_URL]);
    assert.deepEqual(panel.options().slice(1), registryChildren);
  } finally {
    panel.teardown();
  }
});

test("Portolan panel fetches discovery itself when the preset connection fails", async () => {
  const panel = await mountPortolanPanel([
    () => new Response("", { status: 503 }),
    registryDocument,
  ]);
  try {
    assert.deepEqual(panel.requests, [PORTOLAN_REGISTRY_URL, PORTOLAN_REGISTRY_URL]);
    assert.deepEqual(panel.options().slice(1), registryChildren);
  } finally {
    panel.teardown();
  }
});

test("Portolan panel keeps URL entry when both registry requests fail", async () => {
  const panel = await mountPortolanPanel([
    () => new Response("", { status: 503 }),
    () => new Response("", { status: 503 }),
  ]);
  try {
    assert.equal(panel.requests.length, 2);
    assert.deepEqual(panel.options(), ["Portolan Registry unavailable: enter a URL"]);
  } finally {
    panel.teardown();
  }
});
