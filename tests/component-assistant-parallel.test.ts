import { act, render, useAppStore } from "./helpers/dom";
import assert from "node:assert/strict";
import { createElement } from "react";
import { test } from "node:test";
import type { FunctionTool } from "@strands-agents/sdk";
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
function configure(value: string, enabled = true) {
  const state = useAppStore.getState();
  useAppStore.setState({
    preferences: {
      ...state.preferences,
      environmentVariables: [
        { key: "GEOLIBRE_WEB_SEARCH_PROVIDER", value, enabled, secret: false },
      ],
    },
  });
}
const search = () =>
  (
    createHostAssistantTools({ getMapController: () => null }).find(
      (tool) => tool.name === "web_search",
    ) as FunctionTool
  ).invoke({ query: "Landsat mission" });

test("saved Settings selection goes through runtime loader and registered web_search", async () => {
  Object.assign(window, { __GEOLIBRE_DEPLOYMENT_ENV__: { VITE_GEOLIBRE_AI_URL: "/ai" } });
  configure("parallel");
  const mounted = render(createElement(Runtime));
  const calls: string[] = [];
  globalThis.fetch = async (url, init) => {
    calls.push(String(url));
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
    await assert.rejects(
      webSearch("Landsat", {
        GEOLIBRE_WEB_SEARCH_PROVIDER: "parallel",
        GEOLIBRE_AI_PROXY_BASE_URL: "https://other.example/v1",
      }),
      /same-origin/,
    );
  } finally {
    setDeploymentPolicy(null);
    Object.assign(window, {
      __GEOLIBRE_DEPLOYMENT_ENV__: undefined,
      __GEOLIBRE_RUNTIME_ENV__: undefined,
    });
  }
});
