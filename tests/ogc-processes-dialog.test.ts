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

test("failed dialog loading offers visible recovery and close controls", async () => {
  const { OgcProcessesLoadError } =
    await import("../apps/geolibre-desktop/src/components/processing/OgcProcessesLoadError");
  useAppStore.getState().setOgcProcessesOpen(true);
  render(createElement(OgcProcessesLoadError));
  assert.match(screen.getByRole("alert").textContent ?? "", /could not load/);
  assert.ok(screen.getByRole("button", { name: "Reload app" }));
  fireEvent.click(screen.getAllByRole("button", { name: "Close" })[0]);
  assert.equal(useAppStore.getState().ui.ogcProcessesOpen, false);
});

test("repeated enum inputs accept an array instead of a single selection", async () => {
  const process = description();
  process.inputs.name.schema.enum = ["red", "blue"];
  process.inputs.name.maxOccurs = 2;
  let submitted: Record<string, unknown> | undefined;
  serve(async (_url, init) => {
    submitted = JSON.parse(String(init?.body)).inputs;
    return new Response(JSON.stringify({ echo: "Done" }));
  }, process);
  await form();
  assert.equal(screen.getByLabelText("Name *").tagName, "TEXTAREA");
  fireEvent.change(screen.getByLabelText("Name *"), { target: { value: '["red","blue"]' } });
  fireEvent.click(screen.getByRole("button", { name: "Run process" }));
  await waitFor(() => assert.deepEqual(submitted?.name, ["red", "blue"]));
});

test("reference inputs remain unchanged when the literal editor cannot represent them", async () => {
  let submitted: Record<string, unknown> | undefined;
  serve(async (_url, init) => {
    submitted = JSON.parse(String(init?.body)).inputs;
    return new Response(JSON.stringify({ echo: "Done" }));
  });
  await form();
  const toggle = screen.getByRole("checkbox", { name: "Edit all inputs as JSON" });
  fireEvent.click(toggle);
  const inputs = { name: { href: "https://data.example/name.txt" } };
  fireEvent.change(screen.getByLabelText("Inputs JSON"), {
    target: { value: JSON.stringify(inputs) },
  });
  fireEvent.click(toggle);
  assert.equal((toggle as HTMLInputElement).checked, true);
  assert.equal(
    (screen.getByLabelText("Inputs JSON") as HTMLTextAreaElement).value,
    JSON.stringify(inputs),
  );
  assert.match(screen.getByRole("alert").textContent ?? "", /JSON/);
  fireEvent.click(screen.getByRole("button", { name: "Run process" }));
  await waitFor(() => assert.deepEqual(submitted, inputs));
});

for (const variant of ["empty default", "explicit empty JSON", "object default"] as const) {
  test(`${variant} survives the typed input editor`, async () => {
    const process = description();
    process.inputs.name.schema =
      variant === "object default"
        ? { type: "object", default: { threshold: 5 } }
        : { type: "string", default: "" };
    let submitted: Record<string, unknown> | undefined;
    serve(async (_url, init) => {
      submitted = JSON.parse(String(init?.body)).inputs;
      return new Response(JSON.stringify({ echo: "Done" }));
    }, process);
    await form();
    // form() enters a sample name; restore the original advertised default.
    fireEvent.click(screen.getByRole("button", { name: "Retrieve processes" }));
    await waitFor(() =>
      assert.equal(
        (screen.getByLabelText("Name *") as HTMLInputElement).value,
        variant === "object default" ? '{"value":{"threshold":5}}' : "",
      ),
    );
    if (variant === "explicit empty JSON") {
      const toggle = screen.getByRole("checkbox", { name: "Edit all inputs as JSON" });
      fireEvent.click(toggle);
      fireEvent.change(screen.getByLabelText("Inputs JSON"), { target: { value: '{"name":""}' } });
      fireEvent.click(toggle);
    }
    fireEvent.click(screen.getByRole("button", { name: "Run process" }));
    await waitFor(() =>
      assert.deepEqual(
        submitted?.name,
        variant === "object default" ? { value: { threshold: 5 } } : "",
      ),
    );
  });
}

test("an empty accepted response keeps its job recoverable after a failed status read", async () => {
  let posts = 0,
    recovered = false;
  const deleted: string[] = [];
  serve(async (url, init) => {
    if (init?.method === "POST") {
      posts++;
      return new Response(null, {
        status: 202,
        headers: { Location: "/master/jobs/retained", "Retry-After": "0" },
      });
    }
    if (init?.method === "DELETE") {
      deleted.push(url);
      return new Response(null, { status: 204 });
    }
    if (!recovered) return new Response("unavailable", { status: 503 });
    return new Response(
      JSON.stringify(
        new URL(url).pathname.endsWith("/results")
          ? { echo: "Recovered" }
          : { jobID: "retained", status: "successful" },
      ),
      { headers: { "Content-Type": "application/json" } },
    );
  });
  await form();
  fireEvent.click(screen.getByRole("button", { name: "Run process" }));
  await waitFor(() => assert.match(screen.getByRole("alert").textContent ?? "", /503/));
  assert.match(
    (screen.getByLabelText("Job status URL") as HTMLInputElement).value,
    /jobs\/retained/,
  );
  assert.ok(screen.getByRole("button", { name: "Run process" }).hasAttribute("disabled"));
  recovered = true;
  fireEvent.click(screen.getByRole("button", { name: "Resume monitoring" }));
  await waitFor(() => assert.ok(screen.queryByText("Recovered")), { timeout: 3000 });
  assert.equal(posts, 1);
  fireEvent.click(screen.getByRole("button", { name: "Dismiss job" }));
  await waitFor(() => assert.ok(screen.queryByText("Dismissed")));
  fireEvent.change(screen.getByLabelText("Job status URL"), {
    target: { value: "https://demo.pygeoapi.io/master/jobs/other" },
  });
  assert.equal(screen.getByRole("button", { name: "Dismiss job" }).hasAttribute("disabled"), false);
  fireEvent.click(screen.getByRole("button", { name: "Dismiss job" }));
  await waitFor(() => assert.equal(deleted.length, 2));
  assert.equal(new URL(deleted[1]).pathname, "/master/jobs/other");
});

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

test("advertised execution destinations are visible before inputs leave the dialog", async () => {
  const process = description();
  process.links.find((link: { rel: string }) => link.rel.endsWith("/execute")).href =
    "https://worker.example/execution?api_key=private";
  let destination = "";
  serve(async (url) => {
    destination = url;
    return new Response(JSON.stringify({ echo: "Done" }), {
      headers: { "Content-Type": "application/json" },
    });
  }, process);
  await form();
  const notice = screen.getByText(/^Execution endpoint:/).textContent ?? "";
  assert.match(notice, /https:\/\/worker\.example\/execution/);
  assert.ok(!notice.includes("private"));
  assert.equal(destination, "");
  fireEvent.click(screen.getByRole("button", { name: "Run process" }));
  await waitFor(() => assert.equal(new URL(destination).hostname, "worker.example"));
});

test("malformed JSON stays in the editor and produces a catalog-backed error", async () => {
  let posts = 0;
  serve(async () => {
    posts++;
    return new Response("{}");
  });
  await form();
  const toggle = screen.getByRole("checkbox", { name: "Edit all inputs as JSON" });
  fireEvent.click(toggle);
  fireEvent.change(screen.getByLabelText("Inputs JSON"), { target: { value: "{" } });
  fireEvent.click(screen.getByRole("button", { name: "Run process" }));
  await waitFor(() =>
    assert.equal(screen.getByRole("alert").textContent, "Inputs must contain valid JSON."),
  );
  fireEvent.click(toggle);
  assert.equal((toggle as HTMLInputElement).checked, true);
  assert.equal(posts, 0);
});

test("closing an unacknowledged submission retains its uncertainty notice on reopening", async () => {
  let posts = 0;
  let signal: AbortSignal | undefined;
  const pending: { resolve?: (value: Response) => void } = {};
  serve(async (_url, init) => {
    posts++;
    signal = init?.signal ?? undefined;
    return new Promise<Response>((resolve) => {
      pending.resolve = resolve;
    });
  });
  await form();
  fireEvent.click(screen.getByRole("button", { name: "Run process" }));
  await waitFor(() => assert.ok(signal));
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  assert.equal(
    signal?.aborted,
    false,
    "closing must keep the submission alive to receive its job reference",
  );
  await act(async () => useAppStore.getState().setOgcProcessesOpen(true));
  await waitFor(() =>
    assert.match(screen.getByRole("alert").textContent ?? "", /Retrying submits a new execution/),
  );
  assert.equal(posts, 1);
  assert.equal(screen.getByRole("button", { name: "Run process" }).hasAttribute("disabled"), true);
  await act(async () =>
    pending.resolve?.(
      new Response(null, { status: 202, headers: { Location: "/master/jobs/late" } }),
    ),
  );
  await waitFor(() =>
    assert.match(
      (screen.getByLabelText("Job status URL") as HTMLInputElement).value,
      /\/jobs\/late/,
    ),
  );
  assert.equal(
    screen.getByRole("button", { name: "Resume monitoring" }).hasAttribute("disabled"),
    false,
  );
  assert.equal(posts, 1);
});

test("equivalent resumed status URLs update the tracked process and unlock Run", async () => {
  let complete = false,
    posts = 0;
  serve(async (url, init) => {
    if (init?.method === "POST") {
      posts++;
      return new Response(null, {
        status: 202,
        headers: { Location: "/master/jobs/one", "Retry-After": "0" },
      });
    }
    return new Response(
      JSON.stringify(
        new URL(url).pathname.endsWith("/results")
          ? { echo: "Completed" }
          : { jobID: "one", status: complete ? "successful" : "running" },
      ),
      { headers: { "Content-Type": "application/json" } },
    );
  });
  await form();
  fireEvent.click(screen.getByRole("button", { name: "Run process" }));
  await waitFor(() =>
    assert.match((screen.getByLabelText("Job status URL") as HTMLInputElement).value, /jobs\/one/),
  );
  fireEvent.click(screen.getByRole("button", { name: "Stop waiting" }));
  complete = true;
  const url = new URL((screen.getByLabelText("Job status URL") as HTMLInputElement).value);
  url.searchParams.set("f", "json");
  fireEvent.change(screen.getByLabelText("Job status URL"), { target: { value: url.href } });
  fireEvent.click(screen.getByRole("button", { name: "Resume monitoring" }));
  await waitFor(() => assert.ok(screen.queryByText("Completed")), { timeout: 3000 });
  assert.equal(screen.getByRole("button", { name: "Run process" }).hasAttribute("disabled"), false);
  assert.equal(posts, 1);
  fireEvent.change(screen.getByLabelText("Job status URL"), {
    target: { value: url.href.replace("https://demo.pygeoapi.io", "https://DEMO.PYGEOAPI.IO:443") },
  });
  fireEvent.click(screen.getByRole("button", { name: "Dismiss job" }));
  await waitFor(() => assert.ok(screen.queryByText("Dismissed")));
  assert.equal(screen.getByRole("button", { name: "Dismiss job" }).hasAttribute("disabled"), true);
});

test("submission timeouts report uncertain remote completion without retrying", async () => {
  let posts = 0;
  serve(async () => {
    posts++;
    throw new DOMException("deadline", "TimeoutError");
  });
  await form();
  fireEvent.click(screen.getByRole("button", { name: "Run process" }));
  await waitFor(() =>
    assert.match(screen.getByRole("alert").textContent ?? "", /service may still be running/),
  );
  assert.equal(posts, 1);
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
  assert.ok(!(screen.getByLabelText("Area *") as HTMLTextAreaElement).value.includes("\n"));
  fireEvent.click(screen.getByRole("button", { name: "Run process" }));
  await waitFor(() => assert.ok(submitted));
  assert.deepEqual((submitted as { inputs: { area: unknown } }).inputs.area, {
    value: data,
    mediaType: "application/geo+json",
  });
});

test("base64 JSON geodata is importable while ordinary JSON messages stay download-only", async () => {
  const collection = {
    type: "FeatureCollection" as const,
    features: [
      {
        type: "Feature" as const,
        properties: {},
        geometry: { type: "Point" as const, coordinates: [3, 4] },
      },
    ],
  };
  serve(
    async () =>
      new Response(
        JSON.stringify({
          geometry: {
            value: btoa(JSON.stringify(collection)),
            encoding: "base64",
            mediaType: "application/json",
          },
          message: { value: "Ordinary message", mediaType: "application/json" },
        }),
        { headers: { "Content-Type": "application/json" } },
      ),
  );
  await form();
  fireEvent.click(screen.getByRole("button", { name: "Run process" }));
  await waitFor(() =>
    assert.equal(screen.getAllByRole("button", { name: "Add to map" }).length, 1),
  );
  fireEvent.click(screen.getByRole("button", { name: "Add to map" }));
  await waitFor(() => assert.equal(useAppStore.getState().layers.length, 1));
  assert.deepEqual(useAppStore.getState().layers[0].geojson, collection);
});

test("invalid process geometry never enters the layer store", async () => {
  serve(
    async () =>
      new Response(
        JSON.stringify({
          geometry: {
            value: { type: "Point", coordinates: ["bad", 0] },
            mediaType: "application/geo+json",
          },
        }),
        { headers: { "Content-Type": "application/json" } },
      ),
  );
  await form();
  fireEvent.click(screen.getByRole("button", { name: "Run process" }));
  await waitFor(() => assert.ok(screen.queryByRole("button", { name: "Add to map" })));
  fireEvent.click(screen.getByRole("button", { name: "Add to map" }));
  await waitFor(() =>
    assert.match(screen.getByRole("alert").textContent ?? "", /invalid GeoJSON geometry/),
  );
  assert.equal(useAppStore.getState().layers.length, 0);
});

test("oversized layer inputs are rejected before replacing the editor value", async () => {
  const process = description();
  process.inputs.area = { title: "Area", schema: { type: "object" }, minOccurs: 0 };
  const id = useAppStore.getState().addGeoJsonLayer("Large area", {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: { label: "é".repeat(600000) },
        geometry: { type: "Point", coordinates: [0, 0] },
      },
    ],
  });
  let posts = 0;
  serve(async () => {
    posts++;
    return new Response("{}");
  }, process);
  await form();
  fireEvent.change(screen.getByLabelText("Area"), { target: { value: '{"value":{}}' } });
  fireEvent.change(screen.getByLabelText("Layer input for Area"), {
    target: { value: JSON.stringify([id, "collection"]) },
  });
  assert.match(screen.getByRole("alert").textContent ?? "", /1 MiB/);
  assert.equal((screen.getByLabelText("Area") as HTMLTextAreaElement).value, '{"value":{}}');
  assert.equal(posts, 0);
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
