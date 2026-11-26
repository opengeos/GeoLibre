import { act, fireEvent, render, screen, useAppStore, waitFor } from "./helpers/dom";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createElement, createRef } from "react";
import type { MapEngine } from "@geolibre/map";

const { OgcProcessesDialog } =
  await import("../apps/geolibre-desktop/src/components/processing/OgcProcessesDialog");
const description = () =>
  JSON.parse(
    readFileSync(new URL("./fixtures/ogc-processes/hello-world.json", import.meta.url), "utf8"),
  );
const processPath = "/master/processes/hello-world";

function serve(
  execution: (url: string, init?: RequestInit) => Response | Promise<Response>,
  process = description(),
) {
  globalThis.fetch = async (input, init) => {
    const url = String(input),
      path = new URL(url).pathname;
    if (init?.method !== "POST" && init?.method !== "DELETE" && !path.includes("/jobs/")) {
      const document = path === processPath ? process : { processes: [process] };
      return new Response(JSON.stringify(document), {
        headers: { "Content-Type": "application/json" },
      });
    }
    return execution(url, init);
  };
}
async function form() {
  useAppStore.getState().setOgcProcessesOpen(true);
  const view = render(
    createElement(OgcProcessesDialog, { mapControllerRef: createRef<MapEngine>() }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Retrieve processes" }));
  await waitFor(() => assert.equal(screen.queryByLabelText("Name *") !== null, true));
  await waitFor(() =>
    assert.equal(
      screen.getByRole("button", { name: "Run process" }).hasAttribute("disabled"),
      false,
    ),
  );
  fireEvent.change(screen.getByLabelText("Name *"), { target: { value: "GeoLibre" } });
  return view;
}

test("process dialog submits typed inputs and renders synchronous literal outputs", async () => {
  let submitted: unknown;
  serve(async (_url, init) => {
    assert.equal(init?.method, "POST");
    submitted = JSON.parse(String(init.body));
    return new Response(JSON.stringify({ outputs: [{ id: "echo", value: "Hello GeoLibre!" }] }), {
      headers: { "Content-Type": "application/json" },
    });
  });
  await form();
  fireEvent.change(screen.getByLabelText("Message"), { target: { value: "Temporary" } });
  fireEvent.change(screen.getByLabelText("Message"), { target: { value: "" } });
  fireEvent.click(screen.getByRole("button", { name: "Run process" }));
  await waitFor(() => assert.equal(screen.queryByText("Hello GeoLibre!") !== null, true));
  assert.deepEqual(submitted, {
    inputs: { name: "GeoLibre", as_bytes: false, media_type: "application/json" },
    response: "document",
  });
  assert.equal(screen.queryByRole("button", { name: "Add to map" }) === null, true);
  assert.equal(screen.queryByRole("alert") === null, true);
});

test("import provenance stays attached to the execution after endpoint and job URL edits", async () => {
  const data = {
    type: "FeatureCollection",
    features: [
      { type: "Feature", properties: {}, geometry: { type: "Point", coordinates: [-80, 44] } },
    ],
  };
  serve(
    async () =>
      new Response(JSON.stringify({ echo: { value: data, mediaType: "application/geo+json" } }), {
        headers: { "Content-Type": "application/json" },
      }),
  );
  await form();
  fireEvent.click(screen.getByRole("button", { name: "Run process" }));
  await waitFor(() => assert.ok(screen.queryByRole("button", { name: "Add to map" })));
  fireEvent.change(screen.getByLabelText("Service URL"), {
    target: { value: "https://other.example/new-service" },
  });
  fireEvent.change(screen.getByLabelText("Job status URL"), {
    target: { value: "https://other.example/jobs/wrong" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Add to map" }));
  await waitFor(() => assert.equal(useAppStore.getState().layers.length, 1));
  const layer = useAppStore.getState().layers[0];
  assert.deepEqual(layer.geojson, data);
  assert.match(
    String(layer.metadata?.sourceUrl),
    /^https:\/\/demo\.pygeoapi\.io\/master\/processes\/hello-world/,
  );
});

test("layer FeatureCollections are sent as qualified GeoJSON inputs", async () => {
  const process = description();
  process.inputs.area = { title: "Area", schema: { type: "object" }, minOccurs: 1 };
  const data = { type: "FeatureCollection" as const, features: [] };
  const id = useAppStore.getState().addGeoJsonLayer("Study area", data);
  let submitted: unknown;
  serve(async (_url, init) => {
    submitted = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ echo: "Done" }), {
      headers: { "Content-Type": "application/json" },
    });
  }, process);
  await form();
  fireEvent.change(screen.getByLabelText("Layer input for Area"), {
    target: { value: JSON.stringify([id, "collection"]) },
  });
  fireEvent.click(screen.getByRole("button", { name: "Run process" }));
  await waitFor(() => assert.ok(submitted));
  assert.deepEqual((submitted as { inputs: { area: unknown } }).inputs.area, {
    value: data,
    mediaType: "application/geo+json",
  });
});

test("cleared required strings fail locally and JSON mode can send explicit empty strings", async () => {
  const submissions: Array<{ inputs: Record<string, unknown> }> = [];
  serve(async (_url, init) => {
    submissions.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ echo: "Done" }), {
      headers: { "Content-Type": "application/json" },
    });
  });
  await form();
  fireEvent.change(screen.getByLabelText("Name *"), { target: { value: "" } });
  fireEvent.click(screen.getByRole("button", { name: "Run process" }));
  await waitFor(() =>
    assert.match(screen.getByRole("alert").textContent ?? "", /Missing process input: name/),
  );
  assert.equal(submissions.length, 0);
  fireEvent.click(screen.getByRole("checkbox", { name: "Edit all inputs as JSON" }));
  fireEvent.change(screen.getByLabelText("Inputs JSON"), {
    target: { value: JSON.stringify({ name: "", message: "" }) },
  });
  fireEvent.click(screen.getByRole("button", { name: "Run process" }));
  await waitFor(() => assert.equal(submissions.length, 1));
  assert.deepEqual(submissions[0].inputs, { name: "", message: "" });
});

test("a completed synchronous job retains its advertised output context when resumed", async () => {
  let posts = 0;
  serve(async (url, init) => {
    if (init?.method === "POST") {
      posts++;
      return new Response(JSON.stringify({ outputs: [{ id: "echo", value: "Initial echo" }] }), {
        headers: {
          "Content-Type": "application/json",
          Location: "https://demo.pygeoapi.io/master/jobs/sync",
        },
      });
    }
    return new Response(
      JSON.stringify(
        url.includes("/results")
          ? { outputs: [{ id: "echo", value: "Resumed echo" }] }
          : { jobID: "sync", status: "successful" },
      ),
      { headers: { "Content-Type": "application/json" } },
    );
  });
  await form();
  fireEvent.click(screen.getByRole("button", { name: "Run process" }));
  await waitFor(() => assert.ok(screen.queryByText("Initial echo")));
  await waitFor(() =>
    assert.equal(
      screen.getByRole("button", { name: "Resume monitoring" }).hasAttribute("disabled"),
      false,
    ),
  );
  fireEvent.click(screen.getByRole("button", { name: "Resume monitoring" }));
  await waitFor(() => assert.ok(screen.queryByText("Resumed echo")));
  assert.equal(posts, 1);
});

test("paused jobs lock their own processes and remain resumable after switching", async () => {
  const first = description();
  const second = JSON.parse(JSON.stringify(first).replaceAll("hello-world", "second"));
  second.title = "Second process";
  const posts: string[] = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (init?.method === "POST") {
      const id = url.pathname.includes("/second/") ? "b" : "a";
      posts.push(id);
      return new Response(JSON.stringify({ jobID: id, status: "accepted" }), {
        status: 201,
        headers: { "Content-Type": "application/json", Location: `/master/jobs/${id}` },
      });
    }
    if (init?.method === "DELETE") return new Response(null, { status: 204 });
    return new Response(
      JSON.stringify(
        url.pathname.endsWith("/hello-world")
          ? first
          : url.pathname.endsWith("/second")
            ? second
            : url.pathname.includes("/jobs/")
              ? { jobID: url.pathname.split("/").pop(), status: "running" }
              : { processes: [first, second] },
      ),
      { headers: { "Content-Type": "application/json" } },
    );
  };
  await form();
  const run = () => screen.getByRole("button", { name: "Run process" });
  const pause = async (id: string) => {
    await waitFor(() =>
      assert.match(
        (screen.getByLabelText("Job status URL") as HTMLInputElement).value,
        new RegExp(`/jobs/${id}`),
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Stop waiting" }));
  };
  fireEvent.click(run());
  await pause("a");
  fireEvent.change(screen.getByLabelText("Process"), { target: { value: "second" } });
  await waitFor(() => assert.equal(run().hasAttribute("disabled"), false));
  fireEvent.change(screen.getByLabelText("Name *"), { target: { value: "B" } });
  fireEvent.click(run());
  await pause("b");
  fireEvent.change(screen.getByLabelText("Process"), { target: { value: "hello-world" } });
  await waitFor(() =>
    assert.match((screen.getByLabelText("Job status URL") as HTMLInputElement).value, /\/jobs\/a/),
  );
  assert.equal(run().hasAttribute("disabled"), true);
  assert.deepEqual(posts, ["a", "b"]);
  fireEvent.click(screen.getByRole("button", { name: "Dismiss job" }));
  await waitFor(() => assert.equal(run().hasAttribute("disabled"), false));
  fireEvent.change(screen.getByLabelText("Process"), { target: { value: "second" } });
  await waitFor(() =>
    assert.match((screen.getByLabelText("Job status URL") as HTMLInputElement).value, /\/jobs\/b/),
  );
  assert.equal(run().hasAttribute("disabled"), true);
});

test("JSON input editing preserves types when returning to schema fields", async () => {
  serve(async () => new Response("{}"));
  await form();
  const checkbox = screen.getByRole("checkbox", { name: "Edit all inputs as JSON" });
  fireEvent.click(checkbox);
  fireEvent.change(screen.getByLabelText("Inputs JSON"), {
    target: {
      value: JSON.stringify({ name: "Changed", as_bytes: true, media_type: "text/plain" }),
    },
  });
  fireEvent.click(checkbox);
  assert.equal((screen.getByLabelText("Name *") as HTMLInputElement).value, "Changed");
  assert.equal((screen.getByLabelText("As bytes") as HTMLSelectElement).value, "true");
  assert.equal((screen.getByLabelText("Media type") as HTMLInputElement).value, "text/plain");
});

for (const action of ["project switch", "unmount"] as const) {
  test(`${action} cancels pending submission without publishing stale results or errors`, async () => {
    let signal: AbortSignal | undefined;
    serve(async (_url, init) => {
      assert.equal(init?.method, "POST");
      signal = init.signal ?? undefined;
      assert.ok(signal);
      return new Promise<Response>((_resolve, reject) =>
        signal?.addEventListener("abort", () => reject(signal?.reason), { once: true }),
      );
    });
    const view = await form();
    fireEvent.click(screen.getByRole("button", { name: "Run process" }));
    await waitFor(() => assert.ok(signal));
    await act(async () => {
      if (action === "unmount") view.unmount();
      else useAppStore.setState((state) => ({ projectLoadCount: state.projectLoadCount + 1 }));
    });
    assert.ok(signal?.aborted);
    assert.equal(useAppStore.getState().layers.length, 0);
    assert.equal(screen.queryByRole("alert") === null, true);
  });
}

test("asynchronous jobs expose progress, import GeoJSON and dismiss only their own job", async () => {
  const methods: string[] = [];
  serve(async (url, init) => {
    methods.push(init?.method ?? "GET");
    if (init?.method === "POST")
      return new Response(JSON.stringify({ jobID: "one", status: "accepted" }), {
        status: 201,
        headers: {
          "Content-Type": "application/json",
          Location: "/master/jobs/one",
          "Retry-After": "0",
        },
      });
    assert.ok(new URL(url).pathname.startsWith("/master/jobs/one"));
    if (init?.method === "DELETE") return new Response(null, { status: 204 });
    const document = new URL(url).pathname.endsWith("/results")
      ? {
          geometry: {
            value: {
              type: "FeatureCollection",
              features: [
                {
                  type: "Feature",
                  properties: { result: 3 },
                  geometry: { type: "Point", coordinates: [-79.5, 43.5] },
                },
              ],
            },
            mediaType: "application/geo+json",
          },
        }
      : { jobID: "one", status: "successful", progress: 100 };
    return new Response(JSON.stringify(document), {
      headers: { "Content-Type": "application/json" },
    });
  });
  await form();
  fireEvent.change(screen.getByLabelText("Execution mode"), { target: { value: "async" } });
  fireEvent.click(screen.getByRole("button", { name: "Run process" }));
  await waitFor(() => assert.equal(screen.queryByText("Successful") !== null, true));
  await waitFor(() =>
    assert.equal(
      screen.getByRole("button", { name: "Add to map" }).hasAttribute("disabled"),
      false,
    ),
  );
  fireEvent.click(screen.getByRole("button", { name: "Add to map" }));
  await waitFor(() => assert.equal(useAppStore.getState().layers.length, 1));
  const layer = useAppStore.getState().layers[0];
  assert.equal(layer.metadata.ogcProcessSnapshot, true);
  assert.equal(layer.metadata.ogcProcessOutput, "geometry");
  assert.equal(layer.geojson?.features[0].properties?.result, 3);
  fireEvent.click(screen.getByRole("button", { name: "Dismiss job" }));
  await waitFor(() => assert.equal(screen.queryByText("Dismissed") !== null, true));
  assert.deepEqual(methods, ["POST", "GET", "GET", "DELETE"]);
});
