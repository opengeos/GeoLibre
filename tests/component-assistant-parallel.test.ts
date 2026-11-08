import { act, render, useAppStore } from "./helpers/dom";
import assert from "node:assert/strict";
import { createElement } from "react";
import { test } from "node:test";
import { Agent, type FunctionTool } from "@strands-agents/sdk";
const { useRuntimeEnvironmentVariables } =
  await import("../apps/geolibre-desktop/src/hooks/useRuntimeEnvironmentVariables");
const { createHostAssistantTools } =
  await import("../apps/geolibre-desktop/src/lib/assistant/tools");
const { setDeploymentPolicy } = await import("../apps/geolibre-desktop/src/lib/deployment-env");
const { readRuntimeEnv } = await import("../apps/geolibre-desktop/src/lib/assistant/provider");
function Runtime() {
  useRuntimeEnvironmentVariables();
  return null;
}
function configure(value: string, enabled = true, proxy?: string) {
  const state = useAppStore.getState();
  useAppStore.setState({
    preferences: {
      ...state.preferences,
      environmentVariables: [
        { key: "GEOLIBRE_WEB_SEARCH_PROVIDER", value, enabled, secret: false },
        ...(proxy
          ? [
              {
                key: "GEOLIBRE_AI_PROXY_BASE_URL",
                value: proxy,
                enabled: true,
                secret: false,
              },
            ]
          : []),
      ],
    },
  });
}
const registeredSearch = () =>
  createHostAssistantTools({ getMapController: () => null }).find(
    (tool) => tool.name === "web_search",
  ) as FunctionTool;
const search = () => registeredSearch().invoke({ query: "Landsat mission" });

function streamSearch(cancelSignal: AbortSignal) {
  const tool = registeredSearch();
  return tool
    .stream({
      toolUse: { name: tool.name, toolUseId: "cancelled-search", input: { query: "Landsat" } },
      agent: new Agent({ tools: [tool] }),
      invocationState: {},
      interrupt: () => assert.fail("unexpected tool interrupt"),
      cancelSignal,
    })
    .next();
}

test("saved Settings selection goes through runtime loader and registered web_search", async () => {
  Object.assign(window, { __GEOLIBRE_DEPLOYMENT_ENV__: { VITE_GEOLIBRE_AI_URL: "/ai" } });
  configure("parallel");
  const mounted = render(createElement(Runtime));
  const calls: string[] = [];
  globalThis.fetch = async (url, init) => {
    calls.push(String(url));
    assert.equal(init?.redirect, "error");
    assert.equal(new Headers(init?.headers).get("Authorization"), null);
    assert.equal(new Headers(init?.headers).get("X-GeoLibre-Instance-Token"), null);
    return Response.json({
      results: [{ title: "Synthetic", url: "https://example.org/", content: "Synthetic passage" }],
    });
  };
  try {
    assert.equal(readRuntimeEnv().GEOLIBRE_WEB_SEARCH_PROVIDER, "parallel");
    assert.deepEqual(await search(), {
      provider: "parallel",
      answer: null,
      results: [{ title: "Synthetic", url: "https://example.org/", snippet: "Synthetic passage" }],
    });
    assert.deepEqual(calls, ["http://localhost:5173/ai/parallel"]);
    calls.length = 0;
    // Disabled setting retains the original keyless default.
    act(() => configure("parallel", false));
    globalThis.fetch = async (url) => {
      calls.push(String(url));
      return Response.json({});
    };
    assert.equal(((await search()) as { provider: string }).provider, "duckduckgo");
    assert.match(calls[0], /^https:\/\/api.duckduckgo.com\//);
    act(() => configure("parallel"));
    globalThis.fetch = async () => new Response("unavailable", { status: 503 });
    const failed = (await search()) as { error: string; results: unknown[] };
    assert.match(failed.error, /unavailable/);
    assert.deepEqual(failed.results, []);
  } finally {
    mounted.unmount();
    Object.assign(window, {
      __GEOLIBRE_DEPLOYMENT_ENV__: undefined,
      __GEOLIBRE_RUNTIME_ENV__: undefined,
    });
  }
});

test("unselected personal Tavily remains preferred; disabled managed proxy prevents Parallel", async () => {
  const { webSearch } = await import("../apps/geolibre-desktop/src/lib/assistant/web-search");
  const calls: string[] = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return Response.json({ results: [] });
  };
  assert.equal((await webSearch("Landsat", { TAVILY_API_KEY: "dummy" })).provider, "tavily");
  assert.deepEqual(calls, ["https://api.tavily.com/search"]);
  calls.length = 0;
  Object.assign(window, {
    __GEOLIBRE_DEPLOYMENT_ENV__: { VITE_GEOLIBRE_AI_URL: "/ai" },
    __GEOLIBRE_RUNTIME_ENV__: { GEOLIBRE_WEB_SEARCH_PROVIDER: "parallel" },
  });
  setDeploymentPolicy({ version: 1, ai: { enabled: false } });
  try {
    await assert.rejects(webSearch("Landsat"), /requires the managed/);
    assert.deepEqual(calls, []);
    setDeploymentPolicy(null);
    Object.assign(window, {
      __GEOLIBRE_DEPLOYMENT_ENV__: {
        VITE_GEOLIBRE_AI_URL: "https://other.example",
      },
    });
    await assert.rejects(webSearch("Landsat"), /same-origin/);
    assert.deepEqual(calls, []);
  } finally {
    setDeploymentPolicy(null);
    Object.assign(window, {
      __GEOLIBRE_DEPLOYMENT_ENV__: undefined,
      __GEOLIBRE_RUNTIME_ENV__: undefined,
    });
  }
});

test("a saved project cannot redirect managed search or enable it against operator policy", async () => {
  Object.assign(window, { __GEOLIBRE_DEPLOYMENT_ENV__: { VITE_GEOLIBRE_AI_URL: "/ai" } });
  configure("parallel", true, "/project-chosen/v1");
  const mounted = render(createElement(Runtime));
  const calls: string[] = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return Response.json({ results: [] });
  };
  try {
    assert.equal(((await search()) as { provider: string }).provider, "parallel");
    assert.deepEqual(calls, ["http://localhost:5173/ai/parallel"]);
    calls.length = 0;
    setDeploymentPolicy({ version: 1, ai: { enabled: false } });
    assert.match(((await search()) as { detail: string }).detail, /requires the managed/);
    assert.deepEqual(calls, []);
  } finally {
    mounted.unmount();
    setDeploymentPolicy(null);
    Object.assign(window, {
      __GEOLIBRE_DEPLOYMENT_ENV__: undefined,
      __GEOLIBRE_RUNTIME_ENV__: undefined,
    });
  }
});

test("search preserves cancellation on older WebViews", async () => {
  const { webSearch } = await import("../apps/geolibre-desktop/src/lib/assistant/web-search");
  const original = { any: AbortSignal.any, timeout: AbortSignal.timeout };
  try {
    Object.assign(AbortSignal, { any: undefined, timeout: undefined });
    const controller = new AbortController();
    globalThis.fetch = async (_url, init) => {
      init?.signal?.throwIfAborted();
      return Response.json({});
    };
    assert.equal((await webSearch("Landsat", {}, controller.signal)).provider, "duckduckgo");
    controller.abort();
    await assert.rejects(webSearch("Landsat", {}, controller.signal), { name: "AbortError" });

    Object.assign(window, {
      __GEOLIBRE_DEPLOYMENT_ENV__: { VITE_GEOLIBRE_AI_URL: "/ai" },
      __GEOLIBRE_RUNTIME_ENV__: { GEOLIBRE_WEB_SEARCH_PROVIDER: "parallel" },
    });
    const running = new AbortController();
    const started = Promise.withResolvers<AbortSignal>();
    const held = Promise.withResolvers<Response>();
    globalThis.fetch = async (url, init) => {
      assert.equal(String(url), "http://localhost:5173/ai/parallel");
      const signal = init?.signal;
      assert.ok(signal);
      signal.addEventListener("abort", () => held.reject(signal.reason), { once: true });
      started.resolve(signal);
      return held.promise;
    };
    const pending = streamSearch(running.signal);
    const active = await Promise.race([
      started.promise,
      pending.then(() => assert.fail("search finished before its fetch started")),
    ]);
    assert.equal(active.aborted, false);
    running.abort();
    assert.equal(active.aborted, true);
    const result = await pending;
    assert.ok(result.done);
    assert.equal(result.value.status, "error");
    assert.equal(result.value.error?.name, "AbortError");

    // A completed response can still resolve after the user presses Stop.
    const late = new AbortController();
    globalThis.fetch = async () => {
      const response = Response.json({
        results: [{ title: "Late", url: "https://example.org", content: "Late passage" }],
      });
      late.abort();
      return response;
    };
    const lateResult = await streamSearch(late.signal);
    assert.ok(lateResult.done);
    assert.equal(lateResult.value.status, "error");
    assert.equal(lateResult.value.error?.name, "AbortError");
  } finally {
    Object.assign(AbortSignal, original);
    Object.assign(window, {
      __GEOLIBRE_DEPLOYMENT_ENV__: undefined,
      __GEOLIBRE_RUNTIME_ENV__: undefined,
    });
  }
});
