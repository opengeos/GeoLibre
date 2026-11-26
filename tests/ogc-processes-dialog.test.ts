import { act, fireEvent, render, screen, useAppStore, waitFor } from "./helpers/dom";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createElement, createRef } from "react";
import type { MapEngine } from "@geolibre/map";
import i18next from "i18next";

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
async function form(enterName = true) {
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
  if (enterName)
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

test("a resumed running job stays locked when a later description uses a JSON format query", async () => {
  const process = description();
  process.links = process.links.filter((link: { rel: string }) => link.rel !== "self");
  let available = false,
    attempts = 0,
    posts = 0;
  globalThis.fetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (init?.method === "POST") {
      posts++;
      throw Error("Running job must remain locked");
    }
    if (path.includes("/jobs/"))
      return new Response(
        JSON.stringify({
          jobID: "existing",
          status: "running",
          links: [
            { rel: "process", href: "https://demo.pygeoapi.io/master/processes/hello-world" },
          ],
        }),
        { headers: { "Content-Type": "application/json" } },
      );
    if (path.endsWith("/hello-world")) {
      attempts++;
      if (!available) return new Response("{}", { status: 404 });
    }
    return new Response(
      JSON.stringify(path.endsWith("/hello-world") ? process : { processes: [process] }),
      { headers: { "Content-Type": "application/json" } },
    );
  };
  useAppStore.getState().setOgcProcessesOpen(true);
  render(createElement(OgcProcessesDialog, { mapControllerRef: createRef<MapEngine>() }));
  fireEvent.change(screen.getByLabelText("Job status URL"), {
    target: { value: "https://demo.pygeoapi.io/master/jobs/existing" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Resume monitoring" }));
  await waitFor(() => assert.ok(attempts > 0 && screen.queryByText("Running")));
  fireEvent.click(screen.getByRole("button", { name: "Stop waiting" }));
  available = true;
  fireEvent.change(screen.getByLabelText("Service URL"), {
    target: { value: "https://demo.pygeoapi.io/master/processes" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Retrieve processes" }));
  await waitFor(() => assert.ok(screen.queryByLabelText("Name *")));
  await waitFor(() =>
    assert.equal(
      screen.getByRole("button", { name: "Resume monitoring" }).hasAttribute("disabled"),
      false,
    ),
  );
  assert.equal(screen.getByRole("button", { name: "Run process" }).hasAttribute("disabled"), true);
  assert.match(
    (screen.getByLabelText("Job status URL") as HTMLInputElement).value,
    /\/jobs\/existing/,
  );
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Run process" }));
  });
  assert.equal(posts, 0);
});

test("Dismiss cannot interrupt an active process description", async () => {
  const first = description(),
    second = JSON.parse(JSON.stringify(first).replaceAll("hello-world", "second"));
  let release: ((response: Response) => void) | undefined,
    deletes = 0;
  globalThis.fetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (init?.method === "POST")
      return new Response(null, {
        status: 202,
        headers: { Location: "/master/jobs/one", "Retry-After": "0" },
      });
    if (init?.method === "DELETE") {
      deletes++;
      return new Response(null, { status: 204 });
    }
    if (path.includes("/jobs/"))
      return new Response(JSON.stringify({ status: "running" }), {
        headers: { "Content-Type": "application/json" },
      });
    if (path.endsWith("/second"))
      return new Promise<Response>((resolve) => {
        release = resolve;
      });
    return new Response(
      JSON.stringify(path.endsWith("/hello-world") ? first : { processes: [first, second] }),
      { headers: { "Content-Type": "application/json" } },
    );
  };
  await form();
  fireEvent.click(screen.getByRole("button", { name: "Run process" }));
  await waitFor(() => assert.ok(screen.queryByText("Running")));
  fireEvent.click(screen.getByRole("button", { name: "Stop waiting" }));
  fireEvent.change(screen.getByLabelText("Process"), { target: { value: "second" } });
  await waitFor(() => assert.ok(release));
  assert.equal(screen.getByRole("button", { name: "Dismiss job" }).hasAttribute("disabled"), true);
  fireEvent.click(screen.getByRole("button", { name: "Dismiss job" }));
  assert.equal(deletes, 0);
  await act(async () =>
    release?.(
      new Response(JSON.stringify(second), { headers: { "Content-Type": "application/json" } }),
    ),
  );
  await waitFor(() => assert.ok(screen.queryByLabelText("Name *")));
  assert.equal(screen.getByRole("button", { name: "Run process" }).hasAttribute("disabled"), false);
});

for (const count of [0, 1, 3]) {
  test(`layer insertion respects occurrence limits for ${count} features`, async () => {
    const process = description();
    process.inputs.area = { title: "Area", minOccurs: 1, maxOccurs: 2, schema: { type: "object" } };
    const data = {
      type: "FeatureCollection" as const,
      features: Array.from({ length: count }, (_, id) => ({
        type: "Feature" as const,
        properties: {},
        geometry: { type: "Point" as const, coordinates: [id, id] },
      })),
    };
    const id = useAppStore.getState().addGeoJsonLayer("Input", data);
    let submitted: { inputs: { area: unknown } } | undefined;
    serve(async (_url, init) => {
      submitted = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ echo: "Done" }));
    }, process);
    await form();
    const editor = screen.getByLabelText("Area *") as HTMLTextAreaElement;
    const previous = '[{"value":{},"mediaType":"application/geo+json"}]';
    fireEvent.change(editor, { target: { value: previous } });
    fireEvent.change(screen.getByLabelText("Layer input for Area"), {
      target: { value: JSON.stringify([id, "features"]) },
    });
    if (count === 1) {
      fireEvent.click(screen.getByRole("button", { name: "Run process" }));
      await waitFor(() => assert.ok(submitted));
      assert.deepEqual(submitted?.inputs.area, [
        { value: data.features[0], mediaType: "application/geo+json" },
      ]);
    } else {
      assert.equal(editor.value, previous);
      assert.equal(editor.getAttribute("aria-invalid"), "true");
      assert.match(screen.getByRole("alert").textContent ?? "", /accepts 1 to 2/);
    }
  });
}

for (const type of ["object", "array", "integer"]) {
  test(`layer representations match a repeated ${type} schema`, async () => {
    const process = description();
    process.inputs.area = { title: "Area", minOccurs: 0, maxOccurs: 2, schema: { type } };
    const data = {
      type: "FeatureCollection" as const,
      features: [
        {
          type: "Feature" as const,
          properties: {},
          geometry: { type: "Point" as const, coordinates: [3, 4] },
        },
      ],
    };
    const id = useAppStore.getState().addGeoJsonLayer("Input", data);
    let submitted: { inputs: { area: unknown } } | undefined;
    serve(async (_url, init) => {
      submitted = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ echo: "Done" }));
    }, process);
    await form();
    const picker = screen.queryByLabelText("Layer input for Area");
    if (type === "integer") {
      assert.equal(picker === null, true);
      return;
    }
    assert.ok(picker);
    const choices = [...picker.querySelectorAll("option")]
      .filter((option) => option.value)
      .map((option) => JSON.parse(option.value)[1]);
    assert.deepEqual(
      choices,
      type === "object" ? ["collection", "features", "geometries"] : ["features", "geometries"],
    );
    if (type === "array") {
      fireEvent.change(picker, { target: { value: JSON.stringify([id, "features"]) } });
      fireEvent.click(screen.getByRole("button", { name: "Run process" }));
      await waitFor(() => assert.ok(submitted));
      assert.deepEqual(submitted?.inputs.area, [data.features]);
    }
  });
}

test("a single object layer input offers no bare array representations", async () => {
  const process = description();
  process.inputs.area = { title: "Area", minOccurs: 0, schema: { type: "object" } };
  useAppStore.getState().addGeoJsonLayer("Input", { type: "FeatureCollection", features: [] });
  serve(async () => new Response("{}"), process);
  await form();
  const choices = [...screen.getByLabelText("Layer input for Area").querySelectorAll("option")]
    .filter((option) => option.value)
    .map((option) => JSON.parse(option.value)[1]);
  assert.deepEqual(choices, ["collection"]);
});

test("raw JSON validation is associated with its editor and transport errors do not mark it invalid", async () => {
  serve(async () => new Response("{}", { status: 503 }));
  await form();
  fireEvent.click(screen.getByRole("checkbox", { name: "Edit all inputs as JSON" }));
  const field = screen.getByLabelText("Inputs JSON");
  fireEvent.change(field, { target: { value: "{broken" } });
  fireEvent.click(screen.getByRole("button", { name: "Run process" }));
  await waitFor(() => assert.equal(field.getAttribute("aria-invalid"), "true"));
  const errorId = field.getAttribute("aria-describedby");
  assert.ok(errorId);
  assert.match(document.getElementById(errorId)?.textContent ?? "", /valid JSON/);
  fireEvent.change(field, { target: { value: '{"name":"Valid"}' } });
  fireEvent.click(screen.getByRole("button", { name: "Run process" }));
  await waitFor(() => assert.match(screen.getByRole("alert").textContent ?? "", /503/));
  assert.equal(field.hasAttribute("aria-invalid"), false);
  assert.equal(field.hasAttribute("aria-describedby"), false);
});

test("schema JSON validation identifies the affected field", async () => {
  const process = description();
  process.inputs.area = { title: "Area", schema: { type: "object" }, minOccurs: 0 };
  serve(async () => {
    throw Error("Validation must prevent submission");
  }, process);
  await form();
  const area = screen.getByLabelText("Area");
  fireEvent.change(area, { target: { value: "{broken" } });
  fireEvent.click(screen.getByRole("button", { name: "Run process" }));
  await waitFor(() => assert.equal(area.getAttribute("aria-invalid"), "true"));
  const errorId = area.getAttribute("aria-describedby");
  assert.ok(errorId);
  assert.match(document.getElementById(errorId)?.textContent ?? "", /area.*valid JSON/);
  assert.equal(screen.getByLabelText("Name *").hasAttribute("aria-invalid"), false);
});

test("ambiguous JSON reports expose a labeled complete response download", async () => {
  serve(
    async () =>
      new Response('{"count":{"value":3},"mean":7}', {
        headers: { "Content-Type": "application/json" },
      }),
  );
  await form();
  fireEvent.click(screen.getByRole("button", { name: "Run process" }));
  await waitFor(() => assert.ok(screen.queryByText("Complete JSON response", { exact: true })));
  assert.equal(screen.getAllByRole("button", { name: "Download" }).length, 3);
  assert.equal(screen.queryByRole("button", { name: "Add to map" }) === null, true);
});

test("dismissing another URL preserves the original job's displayed status and lock", async () => {
  serve(async (_url, init) => {
    if (init?.method === "POST")
      return new Response(null, {
        status: 202,
        headers: { Location: "/master/jobs/original", "Retry-After": "0" },
      });
    if (init?.method === "DELETE") return new Response(null, { status: 204 });
    return new Response(JSON.stringify({ status: "running" }), {
      headers: { "Content-Type": "application/json" },
    });
  });
  await form();
  fireEvent.click(screen.getByRole("button", { name: "Run process" }));
  await waitFor(() => assert.ok(screen.queryByText("Running", { exact: true })));
  fireEvent.click(screen.getByRole("button", { name: "Stop waiting" }));
  const field = screen.getByLabelText("Job status URL") as HTMLInputElement;
  const original = field.value;
  fireEvent.change(field, { target: { value: "https://demo.pygeoapi.io/master/jobs/other" } });
  fireEvent.click(screen.getByRole("button", { name: "Dismiss job" }));
  await waitFor(() =>
    assert.equal(screen.queryByRole("button", { name: "Stop waiting" }) === null, true),
  );
  fireEvent.change(field, { target: { value: original } });
  assert.ok(screen.queryByText("Running", { exact: true }));
  assert.equal(screen.getByRole("button", { name: "Run process" }).hasAttribute("disabled"), true);
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
        : {
            type: "string",
            default: variant === "explicit empty JSON" ? "advertised default" : "",
          };
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
        variant === "object default"
          ? '{"value":{"threshold":5}}'
          : variant === "explicit empty JSON"
            ? "advertised default"
            : "",
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

test("closing an unacknowledged submission retains its pending notice on reopening", async () => {
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
    assert.match(
      screen.getByRole("alert").textContent ?? "",
      /previous submission is still awaiting/,
    ),
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

for (const action of ["Stop", "close", "replace project"] as const) {
  test(`an acknowledged native dismissal survives ${action} within its project boundary`, async () => {
    let posts = 0;
    serve(async (_url, init) => {
      if (init?.method === "POST") {
        posts++;
        return new Response(null, {
          status: 202,
          headers: { Location: "/master/jobs/one", "Retry-After": "0" },
        });
      }
      return new Response(JSON.stringify({ jobID: "one", status: "running" }), {
        headers: { "Content-Type": "application/json" },
      });
    });
    await form();
    fireEvent.click(screen.getByRole("button", { name: "Run process" }));
    await waitFor(() =>
      assert.match(
        (screen.getByLabelText("Job status URL") as HTMLInputElement).value,
        /\/jobs\/one/,
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Stop waiting" }));
    const descriptor = Object.getOwnPropertyDescriptor(window, "__TAURI_INTERNALS__");
    const pending: { resolve?: (value: unknown) => void } = {};
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {
        invoke: async (_command: string, args: Record<string, unknown>) => {
          assert.equal(args.method, "DELETE");
          return new Promise((resolve) => {
            pending.resolve = resolve;
          });
        },
      },
    });
    try {
      fireEvent.click(screen.getByRole("button", { name: "Dismiss job" }));
      await waitFor(() => assert.ok(pending.resolve));
      if (action === "Stop") fireEvent.click(screen.getByRole("button", { name: "Stop waiting" }));
      else if (action === "close") fireEvent.click(screen.getByRole("button", { name: "Close" }));
      else
        await act(async () =>
          useAppStore.setState((state) => ({ projectLoadCount: state.projectLoadCount + 1 })),
        );
      await act(async () =>
        pending.resolve?.({
          status: 200,
          final_url: "https://demo.pygeoapi.io/master/jobs/one",
          content_type: "application/json",
          location: null,
          retry_after: null,
          link: null,
          body_base64: "e30=",
        }),
      );
      if (action === "close")
        await act(async () => useAppStore.getState().setOgcProcessesOpen(true));
      if (action === "replace project") {
        assert.equal((screen.getByLabelText("Job status URL") as HTMLInputElement).value, "");
        assert.equal(screen.queryByText("Dismissed"), null);
      } else {
        await waitFor(() => assert.ok(screen.queryByText("Dismissed")));
        assert.equal(
          screen.getByRole("button", { name: "Run process" }).hasAttribute("disabled"),
          false,
        );
      }
      assert.equal(posts, 1);
      assert.equal(screen.queryByRole("alert"), null);
    } finally {
      if (descriptor) Object.defineProperty(window, "__TAURI_INTERNALS__", descriptor);
      else Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
    }
  });
}

test("input names matching inherited object properties start empty and can be submitted", async () => {
  const process = description();
  process.inputs = {
    ...process.inputs,
    constructor: { title: "Constructor input", schema: { type: "string" } },
    toString: { title: "String input", schema: { type: "object" } },
    valueOf: { title: "Boolean input", schema: { type: "boolean" } },
  };
  let inputs: unknown;
  serve(async (_url, init) => {
    inputs = JSON.parse(String(init?.body)).inputs;
    return new Response("{}", { headers: { "Content-Type": "application/json" } });
  }, process);
  await form();
  assert.equal((screen.getByLabelText("Constructor input *") as HTMLInputElement).value, "");
  assert.equal((screen.getByLabelText("String input *") as HTMLTextAreaElement).value, "");
  assert.equal((screen.getByLabelText("Boolean input *") as HTMLSelectElement).value, "");
  fireEvent.change(screen.getByLabelText("Constructor input *"), { target: { value: "literal" } });
  fireEvent.change(screen.getByLabelText("String input *"), { target: { value: '{"hello":1}' } });
  fireEvent.change(screen.getByLabelText("Boolean input *"), { target: { value: "false" } });
  fireEvent.click(screen.getByRole("button", { name: "Run process" }));
  await waitFor(() =>
    assert.deepEqual(inputs, {
      name: "GeoLibre",
      as_bytes: false,
      media_type: "application/json",
      constructor: "literal",
      toString: { hello: 1 },
      valueOf: false,
    }),
  );
});

test("required state is exposed for every schema control without native empty-string rejection", async () => {
  const process = description();
  process.inputs.choice = { title: "Choice", schema: { type: "string", enum: ["a", "b"] } };
  process.inputs.flag = { title: "Flag", schema: { type: "boolean" } };
  process.inputs.data = { title: "Data", schema: { type: "object" } };
  serve(async () => new Response("{}"), process);
  await form();
  for (const label of ["Name *", "Choice *", "Flag *", "Data *"])
    assert.equal(screen.getByLabelText(label).getAttribute("aria-required"), "true");
  assert.equal(screen.getByLabelText("Message").getAttribute("aria-required"), "false");
  assert.equal(screen.getByLabelText("Name *").hasAttribute("required"), false);
});

for (const canonicalBeforeDismissal of [false, true]) {
  test(`a delayed running poll cannot resurrect a dismissal (${canonicalBeforeDismissal ? "canonical URL first" : "acknowledgement first"})`, async () => {
    let posts = 0;
    serve(async (_url, init) => {
      if (init?.method === "POST") {
        posts++;
        return new Response(null, {
          status: 202,
          headers: { Location: `/master/jobs/${posts === 1 ? "one" : "two"}`, "Retry-After": "0" },
        });
      }
      return new Response(JSON.stringify({ status: "running" }), {
        headers: { "Content-Type": "application/json", "Retry-After": "0" },
      });
    });
    await form();
    fireEvent.click(screen.getByRole("button", { name: "Run process" }));
    await waitFor(() =>
      assert.match(
        (screen.getByLabelText("Job status URL") as HTMLInputElement).value,
        /\/jobs\/one/,
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Stop waiting" }));
    const descriptor = Object.getOwnPropertyDescriptor(window, "__TAURI_INTERNALS__");
    const pending: {
      dismiss?: (value: unknown) => void;
      poll?: (value: unknown) => void;
      followup?: (value: unknown) => void;
    } = {};
    let reads = 0;
    const wire = (status: number, body: string) => ({
      status,
      final_url: "https://demo.pygeoapi.io/master/jobs/one",
      content_type: "application/json",
      location: null,
      retry_after: "0",
      link: null,
      body_base64: btoa(body),
    });
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {
        invoke: async (_command: string, args: Record<string, unknown>) => {
          if (args.method === "DELETE")
            return new Promise((resolve) => {
              pending.dismiss = resolve;
            });
          assert.equal(args.method, "GET");
          if (++reads === 1)
            return new Promise((resolve) => {
              pending.poll = resolve;
            });
          return new Promise((resolve) => {
            pending.followup = resolve;
          });
        },
      },
    });
    try {
      fireEvent.click(screen.getByRole("button", { name: "Dismiss job" }));
      await waitFor(() => assert.ok(pending.dismiss));
      fireEvent.click(screen.getByRole("button", { name: "Stop waiting" }));
      fireEvent.click(screen.getByRole("button", { name: "Resume monitoring" }));
      await waitFor(() => assert.ok(pending.poll), { timeout: 2500 });
      if (canonicalBeforeDismissal) {
        await act(async () =>
          pending.poll?.({
            ...wire(200, '{"status":"running"}'),
            final_url: "https://demo.pygeoapi.io/master/jobs/one/",
          }),
        );
        await waitFor(() =>
          assert.match(
            (screen.getByLabelText("Job status URL") as HTMLInputElement).value,
            /\/jobs\/one\/$/,
          ),
        );
      }
      await act(async () => pending.dismiss?.(wire(200, "{}")));
      if (!canonicalBeforeDismissal)
        await act(async () => pending.poll?.(wire(200, '{"status":"running"}')));
      // Check the first late response before any subsequent response can repair it.
      assert.ok(screen.queryByText("Dismissed"));
      assert.equal(
        screen.getByRole("button", { name: "Run process" }).hasAttribute("disabled"),
        false,
      );
      const stop = screen.queryByRole("button", { name: "Stop waiting" });
      if (stop) fireEvent.click(stop);
      await act(async () => pending.followup?.(wire(404, "{}")));
    } finally {
      if (descriptor) Object.defineProperty(window, "__TAURI_INTERNALS__", descriptor);
      else Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
    }
    fireEvent.click(screen.getByRole("button", { name: "Run process" }));
    await waitFor(() =>
      assert.match(
        (screen.getByLabelText("Job status URL") as HTMLInputElement).value,
        /\/jobs\/two/,
      ),
    );
    assert.equal(posts, 2, "a new execution identity remains allowed");
  });
}

test("unsupported generic binary content is rejected before a layer is added", async () => {
  serve(
    async () =>
      new Response("not a TIFF or GeoJSON", {
        headers: { "Content-Type": "application/octet-stream" },
      }),
  );
  await form();
  fireEvent.click(screen.getByRole("button", { name: "Run process" }));
  await waitFor(() => assert.ok(screen.queryByRole("button", { name: "Add to map" })));
  fireEvent.click(screen.getByRole("button", { name: "Add to map" }));
  await waitFor(() => assert.ok(screen.queryByRole("alert")));
  assert.equal(useAppStore.getState().layers.length, 0);
});

test("stopped synchronous results retain their job association across process selection", async () => {
  const first = description();
  const second = JSON.parse(JSON.stringify(first).replaceAll("hello-world", "second"));
  second.title = "Second process";
  let posts = 0;
  const pending: { resolve?: (response: Response) => void } = {};
  globalThis.fetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (init?.method === "POST") {
      posts++;
      return new Promise<Response>((resolve) => {
        pending.resolve = resolve;
      });
    }
    return new Response(
      JSON.stringify(
        path.endsWith("/hello-world")
          ? first
          : path.endsWith("/second")
            ? second
            : path.includes("/results")
              ? { echo: "Resumed snapshot" }
              : path.includes("/jobs/")
                ? { status: "successful" }
                : { processes: [first, second] },
      ),
      { headers: { "Content-Type": "application/json" } },
    );
  };
  await form();
  fireEvent.click(screen.getByRole("button", { name: "Run process" }));
  await waitFor(() => assert.ok(pending.resolve));
  fireEvent.click(screen.getByRole("button", { name: "Stop waiting" }));
  await act(async () =>
    pending.resolve?.(
      new Response(JSON.stringify({ echo: "Late snapshot" }), {
        headers: { "Content-Type": "application/json", Link: '</master/jobs/sync>; rel="monitor"' },
      }),
    ),
  );
  await waitFor(() => assert.ok(screen.queryByText("Late snapshot")));
  fireEvent.change(screen.getByLabelText("Process"), { target: { value: "second" } });
  await waitFor(() =>
    assert.equal((screen.getByLabelText("Process") as HTMLSelectElement).value, "second"),
  );
  await waitFor(() => assert.ok(screen.queryByLabelText("Name *")));
  fireEvent.change(screen.getByLabelText("Process"), { target: { value: "hello-world" } });
  await waitFor(() =>
    assert.match(
      (screen.getByLabelText("Job status URL") as HTMLInputElement).value,
      /\/jobs\/sync/,
    ),
  );
  fireEvent.click(screen.getByRole("button", { name: "Resume monitoring" }));
  await waitFor(() => assert.ok(screen.queryByText("Resumed snapshot")));
  assert.equal(posts, 1);
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

test("completed outputs remain visible when one advertised reference is unusable", async () => {
  let posts = 0;
  serve(async () => {
    posts++;
    return new Response(
      JSON.stringify({
        bad: { href: "mailto:operator@example.org", type: "image/tiff" },
        echo: "Usable result",
      }),
      { headers: { "Content-Type": "application/json" } },
    );
  });
  await form();
  fireEvent.click(screen.getByRole("button", { name: "Run process" }));
  await waitFor(() => assert.ok(screen.queryByText("Usable result")));
  assert.ok(screen.queryByText(/returned an unusable output link/));
  assert.equal(screen.queryByRole("alert"), null);
  assert.equal(screen.getAllByRole("button", { name: "Download" }).length, 2);
  assert.equal(posts, 1);
});

test("a malformed completed response offers its original download with an execution warning", async () => {
  let posts = 0;
  serve(async () => {
    posts++;
    return new Response("{broken", { headers: { "Content-Type": "application/json" } });
  });
  await form();
  fireEvent.click(screen.getByRole("button", { name: "Run process" }));
  await waitFor(() => assert.ok(screen.queryByRole("button", { name: "Download" })));
  assert.ok(screen.queryByText(/Retrying the process starts a new execution/));
  assert.equal(screen.queryByRole("alert"), null);
  assert.equal(screen.queryByRole("button", { name: "Add to map" }), null);
  assert.equal(posts, 1);
});

test("editing imported inline GeoJSON leaves the retained output snapshot unchanged", async () => {
  const { importOgcProcessOutput } =
    await import("../apps/geolibre-desktop/src/lib/ogc-process-results");
  const { downloadOgcProcessOutput } =
    await import("../apps/geolibre-desktop/src/lib/ogc-api-processes");
  const value = {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: { label: "original" },
        geometry: { type: "Point", coordinates: [1, 2] },
      },
    ],
  };
  const output = { id: "map", value, mediaType: "application/geo+json" };
  const signal = new AbortController().signal;
  const previousLanguage = i18next.language;
  i18next.addResourceBundle(
    "fr",
    "translation",
    { processing: { ogcProcesses: { layerName: "Résultat {{id}}" } } },
    true,
    true,
  );
  await i18next.changeLanguage("fr");
  const id = await importOgcProcessOutput(
    output,
    "https://example.org/jobs/one",
    {
      setBasemap() {},
      addGeoJsonLayer: (name, data) => useAppStore.getState().addGeoJsonLayer(name, data),
      getActiveBasemap: () => "",
      onBasemapChange: () => () => {},
      addMapControl: () => false,
      removeMapControl() {},
      setBuiltInMapControlVisible: () => false,
      getBuiltInMapControlPosition: () => "top-right",
      setBuiltInMapControlPosition: () => false,
    },
    signal,
  ).finally(() => i18next.changeLanguage(previousLanguage));
  const layer = useAppStore.getState().layers.find((layer) => layer.id === id)!;
  assert.equal(layer.name, "Résultat map");
  const imported = layer.geojson!;
  imported.features[0].properties!.label = "edited";
  assert.equal(value.features[0].properties.label, "original");
  assert.deepEqual(
    JSON.parse(await (await downloadOgcProcessOutput(output, signal)).text()),
    value,
  );
});

for (const layout of ["striped", "tiled"])
  for (const type of ["uint64", "int64"]) {
    test(`${layout} ${type} process rasters are rejected before lossy conversion or layer publication`, async () => {
      const { initCogWasm, readGeoTiffInfo } = await import("@geolibre/processing");
      await initCogWasm(
        new Uint8Array(
          readFileSync(
            new URL("../node_modules/geolibre-wasm/geolibre_wasm_bg.wasm", import.meta.url),
          ),
        ),
      );
      const bytes = new Uint8Array(
        readFileSync(new URL(`./fixtures/ogc-processes/${layout}-${type}.tif`, import.meta.url)),
      );
      const info = await readGeoTiffInfo(bytes);
      assert.equal(info.bits_per_sample, 64);
      assert.equal(info.tiled, layout === "tiled");
      assert.notEqual(info.sample_format, "ieeefloat");
      serve(async () => new Response(bytes, { headers: { "Content-Type": "image/tiff" } }));
      await form();
      fireEvent.click(screen.getByRole("button", { name: "Run process" }));
      await waitFor(() => assert.ok(screen.queryByRole("button", { name: "Add to map" })));
      fireEvent.click(screen.getByRole("button", { name: "Add to map" }));
      await waitFor(() => assert.match(screen.getByRole("alert").textContent ?? "", /precision/));
      assert.equal(useAppStore.getState().layers.length, 0);
    });
  }

for (const repeated of [false, true])
  for (const representation of ["collection", "features", "geometries"] as const) {
    test(`layer ${representation} inputs preserve ${repeated ? "repeated" : "single"} occurrence qualification`, async () => {
      const process = description();
      process.inputs.area = {
        title: "Area",
        schema: { type: representation === "collection" || repeated ? "object" : "array" },
        minOccurs: 1,
        maxOccurs: repeated ? 2 : 1,
      };
      const data = {
        type: "FeatureCollection" as const,
        features: [
          {
            type: "Feature" as const,
            properties: { id: 1 },
            geometry: { type: "Point" as const, coordinates: [3, 4] },
          },
        ],
      };
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
        target: { value: JSON.stringify([id, representation]) },
      });
      assert.ok(!(screen.getByLabelText("Area *") as HTMLTextAreaElement).value.includes("\n"));
      fireEvent.click(screen.getByRole("button", { name: "Run process" }));
      await waitFor(() => assert.ok(submitted));
      const qualify = (value: unknown) => ({ value, mediaType: "application/geo+json" });
      const values =
        representation === "features"
          ? data.features
          : data.features.map((feature) => feature.geometry);
      const expected =
        representation === "collection"
          ? repeated
            ? [qualify(data)]
            : qualify(data)
          : repeated
            ? values.map(qualify)
            : values;
      assert.deepEqual((submitted as { inputs: { area: unknown } }).inputs.area, expected);
    });
  }

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
  const field = screen.getByLabelText("Area");
  assert.equal(field.getAttribute("aria-invalid"), "true");
  assert.match(
    document.getElementById(field.getAttribute("aria-describedby")!)?.textContent ?? "",
    /1 MiB/,
  );
  assert.equal((screen.getByLabelText("Area") as HTMLTextAreaElement).value, '{"value":{}}');
  assert.equal(posts, 0);
});

test("explicitly clearing a required string sends an empty string and omits cleared optional text", async () => {
  let inputs: unknown;
  serve(async (_url, init) => {
    inputs = JSON.parse(String(init?.body)).inputs;
    return new Response(JSON.stringify({ echo: "Done" }), {
      headers: { "Content-Type": "application/json" },
    });
  });
  await form();
  fireEvent.change(screen.getByLabelText("Name *"), { target: { value: "" } });
  fireEvent.change(screen.getByLabelText("Message"), { target: { value: "temporary" } });
  fireEvent.change(screen.getByLabelText("Message"), { target: { value: "" } });
  fireEvent.click(screen.getByRole("button", { name: "Run process" }));
  await waitFor(() =>
    assert.deepEqual(inputs, { name: "", as_bytes: false, media_type: "application/json" }),
  );
});

test("untouched required strings fail locally and JSON mode can send explicit empty strings", async () => {
  const submissions: Array<{ inputs: Record<string, unknown> }> = [];
  serve(async (_url, init) => {
    submissions.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ echo: "Done" }), {
      headers: { "Content-Type": "application/json" },
    });
  });
  await form(false);
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
  const process = description();
  process.outputs.echo.schema = {
    type: "string",
    contentEncoding: "base64",
    contentMediaType: "application/geo+json",
  };
  const data = {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: { resumed: true },
        geometry: { type: "Point", coordinates: [1, 2] },
      },
    ],
  };
  const encoded = btoa(JSON.stringify(data));
  const initialEncoded = btoa(JSON.stringify({ type: "FeatureCollection", features: [] }));
  serve(async (url, init) => {
    if (init?.method === "POST") {
      posts++;
      return new Response(JSON.stringify({ outputs: [{ id: "echo", value: initialEncoded }] }), {
        headers: {
          "Content-Type": "application/json",
          Location: "https://demo.pygeoapi.io/master/jobs/sync",
        },
      });
    }
    return new Response(
      JSON.stringify(
        url.includes("/results")
          ? { outputs: [{ id: "echo", value: encoded }] }
          : { jobID: "sync", status: "successful" },
      ),
      { headers: { "Content-Type": "application/json" } },
    );
  }, process);
  await form();
  fireEvent.click(screen.getByRole("button", { name: "Run process" }));
  await waitFor(() => assert.ok(screen.queryByText(initialEncoded)));
  await waitFor(() =>
    assert.equal(
      screen.getByRole("button", { name: "Resume monitoring" }).hasAttribute("disabled"),
      false,
    ),
  );
  fireEvent.click(screen.getByRole("button", { name: "Resume monitoring" }));
  await waitFor(() => assert.ok(screen.queryByText(encoded)));
  fireEvent.click(screen.getByRole("button", { name: "Add to map" }));
  await waitFor(() => assert.equal(useAppStore.getState().layers.length, 1));
  assert.deepEqual(useAppStore.getState().layers[0].geojson, data);
  assert.equal(posts, 1);
});

for (const outcome of ["failure", "stop"] as const) {
  test(`resuming the same job preserves accepted outputs after ${outcome}`, async () => {
    let posts = 0,
      refresh = false,
      pending = false;
    const data = {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: { retained: true },
          geometry: { type: "Point", coordinates: [3, 4] },
        },
      ],
    };
    serve(async (url, init) => {
      if (init?.method === "POST") {
        posts++;
        return new Response(
          JSON.stringify({ echo: { value: data, mediaType: "application/geo+json" } }),
          { headers: { "Content-Type": "application/json", Location: "/master/jobs/snapshot" } },
        );
      }
      if (refresh) {
        if (outcome === "failure" || url.includes("/other"))
          return new Response("{}", { status: 503 });
        pending = true;
        return new Promise<Response>((_resolve, reject) =>
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
            once: true,
          }),
        );
      }
      return new Response(JSON.stringify({ jobID: "snapshot", status: "successful" }), {
        headers: { "Content-Type": "application/json" },
      });
    });
    await form();
    fireEvent.click(screen.getByRole("button", { name: "Run process" }));
    await waitFor(() => assert.ok(screen.queryByRole("button", { name: "Add to map" })));
    await waitFor(() =>
      assert.equal(
        screen.getByRole("button", { name: "Resume monitoring" }).hasAttribute("disabled"),
        false,
      ),
    );
    refresh = true;
    fireEvent.click(screen.getByRole("button", { name: "Resume monitoring" }));
    if (outcome === "stop") {
      await waitFor(() => assert.equal(pending, true));
      fireEvent.click(screen.getByRole("button", { name: "Stop waiting" }));
    } else await waitFor(() => assert.match(screen.getByRole("alert").textContent ?? "", /503/));
    await waitFor(() =>
      assert.equal(
        screen.getByRole("button", { name: "Add to map" }).hasAttribute("disabled"),
        false,
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Add to map" }));
    await waitFor(() => assert.equal(useAppStore.getState().layers.length, 1));
    assert.deepEqual(useAppStore.getState().layers[0].geojson, data);
    assert.match(String(useAppStore.getState().layers[0].metadata.sourceUrl), /\/jobs\/snapshot/);
    fireEvent.change(screen.getByLabelText("Job status URL"), {
      target: { value: "https://demo.pygeoapi.io/master/jobs/other" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Resume monitoring" }));
    await waitFor(() => assert.match(screen.getByRole("alert").textContent ?? "", /503/));
    assert.equal(screen.queryByRole("button", { name: "Add to map" }) === null, true);
    assert.equal(posts, 1);
  });
}

test("the owning monitor can replace its status URL with the canonical redirect target", async () => {
  let deleted = "";
  let posts = 0;
  serve(async (url, init) => {
    if (init?.method === "POST") {
      posts++;
      return new Response(null, { status: 202, headers: { Location: "/master/jobs/one" } });
    }
    if (init?.method === "DELETE") {
      deleted = url;
      return new Response(null, { status: 204 });
    }
    if (url.includes("/results"))
      return new Response(JSON.stringify({ echo: "Canonical result" }), {
        headers: { "Content-Type": "application/json" },
      });
    const response = new Response(JSON.stringify({ jobID: "one", status: "successful" }));
    Object.defineProperty(response, "url", { value: "https://demo.pygeoapi.io/master/jobs/one/" });
    return response;
  });
  await form();
  fireEvent.click(screen.getByRole("button", { name: "Run process" }));
  await waitFor(() => assert.ok(screen.queryByText("Canonical result")), { timeout: 3000 });
  assert.equal(screen.getByRole("button", { name: "Run process" }).hasAttribute("disabled"), false);
  fireEvent.click(screen.getByRole("button", { name: "Dismiss job" }));
  await waitFor(() => assert.match(deleted, /\/jobs\/one\//));
  assert.equal(posts, 1);
});

test("resumed jobs keep the selected process locked when its advertised description is unavailable", async () => {
  serve(async () => new Response("{}"));
  await form();
  let descriptions = 0;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (!url.pathname.includes("/jobs/")) {
      descriptions++;
      return new Response(null, { status: 503 });
    }
    return new Response(
      JSON.stringify({
        jobID: "resumed",
        status: "running",
        links: [{ rel: "process", href: "https://demo.pygeoapi.io/master/processes/hello-world" }],
      }),
    );
  };
  fireEvent.change(screen.getByLabelText("Job status URL"), {
    target: { value: "https://demo.pygeoapi.io/master/jobs/resumed" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Resume monitoring" }));
  await waitFor(() => assert.ok(screen.queryByText("Running")));
  fireEvent.click(screen.getByRole("button", { name: "Stop waiting" }));
  assert.equal(descriptions, 1);
  assert.equal(screen.getByRole("button", { name: "Run process" }).hasAttribute("disabled"), true);
});

test("a malformed default cannot retain another process's asynchronous execution mode", async () => {
  const first = description();
  first.jobControlOptions = ["async-execute"];
  const second = JSON.parse(JSON.stringify(first).replaceAll("hello-world", "second"));
  second.jobControlOptions = ["sync-execute"];
  second.inputs.name.schema = { type: "number", default: "bad" };
  let submitted: unknown;
  let prefer: string | null = null;
  globalThis.fetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (init?.method === "POST") {
      submitted = JSON.parse(String(init.body)).inputs.name;
      prefer = new Headers(init.headers).get("Prefer");
      return new Response(JSON.stringify({ echo: "Fixed" }), {
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(
      JSON.stringify(
        path.endsWith("/hello-world")
          ? first
          : path.endsWith("/second")
            ? second
            : { processes: [first, second] },
      ),
      { headers: { "Content-Type": "application/json" } },
    );
  };
  await form();
  assert.equal((screen.getByLabelText("Execution mode") as HTMLSelectElement).value, "async");
  fireEvent.change(screen.getByLabelText("Process"), { target: { value: "second" } });
  await waitFor(() => assert.ok(screen.queryByRole("alert")));
  assert.equal((screen.getByLabelText("Execution mode") as HTMLSelectElement).value, "sync");
  fireEvent.change(screen.getByLabelText("Name *"), { target: { value: "5" } });
  await waitFor(() =>
    assert.equal(
      screen.getByRole("button", { name: "Run process" }).hasAttribute("disabled"),
      false,
    ),
  );
  fireEvent.click(screen.getByRole("button", { name: "Run process" }));
  await waitFor(() => assert.equal(submitted, 5));
  assert.equal(prefer, null);
});

test("job status follows the URL being displayed without losing its retained identity", async () => {
  serve(
    async () =>
      new Response(JSON.stringify({ jobID: "one", status: "running" }), {
        status: 201,
        headers: { Location: "/master/jobs/one", "Content-Type": "application/json" },
      }),
  );
  await form();
  fireEvent.click(screen.getByRole("button", { name: "Run process" }));
  await waitFor(() => assert.ok(screen.queryByText("Running")));
  fireEvent.click(screen.getByRole("button", { name: "Stop waiting" }));
  const original = (screen.getByLabelText("Job status URL") as HTMLInputElement).value;
  fireEvent.change(screen.getByLabelText("Job status URL"), {
    target: { value: "https://example.org/jobs/other" },
  });
  assert.equal(screen.queryByText("Running"), null);
  fireEvent.change(screen.getByLabelText("Job status URL"), { target: { value: original } });
  assert.ok(screen.queryByText("Running"));
  assert.equal(screen.getByRole("button", { name: "Run process" }).hasAttribute("disabled"), true);
});

test("a pending process description restores a dismissal acknowledged after selection began", async () => {
  const first = description();
  const second = JSON.parse(JSON.stringify(first).replaceAll("hello-world", "second"));
  globalThis.fetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (init?.method === "POST")
      return new Response(JSON.stringify({ jobID: "one", status: "running" }), {
        status: 201,
        headers: { Location: "/master/jobs/one", "Content-Type": "application/json" },
      });
    return new Response(
      JSON.stringify(
        path.endsWith("/hello-world")
          ? first
          : path.endsWith("/second")
            ? second
            : { processes: [first, second] },
      ),
      { headers: { "Content-Type": "application/json" } },
    );
  };
  await form();
  fireEvent.click(screen.getByRole("button", { name: "Run process" }));
  await waitFor(() => assert.ok(screen.queryByText("Running")));
  fireEvent.click(screen.getByRole("button", { name: "Stop waiting" }));
  const prior = Object.getOwnPropertyDescriptor(window, "__TAURI_INTERNALS__");
  const pending: {
    dismiss?: (value: unknown) => void;
    description?: (value: unknown) => void;
    url?: string;
  } = {};
  const native = (url: string, body: unknown, status = 200) => ({
    status,
    final_url: url,
    content_type: "application/json",
    location: null,
    retry_after: null,
    link: null,
    body_base64: body === undefined ? "" : btoa(JSON.stringify(body)),
  });
  Object.defineProperty(window, "__TAURI_INTERNALS__", {
    configurable: true,
    value: {
      invoke: async (_command: string, args: { url: string; method: string }) => {
        if (args.method === "DELETE")
          return new Promise((resolve) => {
            pending.dismiss = resolve;
          });
        if (new URL(args.url).pathname.endsWith("/second")) return native(args.url, second);
        pending.url = args.url;
        return new Promise((resolve) => {
          pending.description = resolve;
        });
      },
    },
  });
  try {
    fireEvent.click(screen.getByRole("button", { name: "Dismiss job" }));
    await waitFor(() => assert.ok(pending.dismiss));
    fireEvent.click(screen.getByRole("button", { name: "Stop waiting" }));
    fireEvent.change(screen.getByLabelText("Process"), { target: { value: "second" } });
    await waitFor(() =>
      assert.equal((screen.getByLabelText("Job status URL") as HTMLInputElement).value, ""),
    );
    await waitFor(() => assert.ok(screen.queryByLabelText("Name *")));
    fireEvent.change(screen.getByLabelText("Process"), { target: { value: "hello-world" } });
    await waitFor(() => assert.ok(pending.description));
    await act(async () => {
      pending.dismiss?.(native("https://demo.pygeoapi.io/master/jobs/one", undefined, 204));
    });
    await act(async () => {
      pending.description?.(native(pending.url!, first));
    });
    await waitFor(() => assert.ok(screen.queryByText("Dismissed")));
    assert.equal(screen.queryByText("Running"), null);
    assert.equal(
      screen.getByRole("button", { name: "Run process" }).hasAttribute("disabled"),
      false,
    );
  } finally {
    if (prior) Object.defineProperty(window, "__TAURI_INTERNALS__", prior);
    else Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
  }
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
    if (url.pathname === "/master/jobs/older/results")
      return new Response(JSON.stringify({ echo: "Older output" }), {
        headers: { "Content-Type": "application/json" },
      });
    return new Response(
      JSON.stringify(
        url.pathname.endsWith("/hello-world")
          ? first
          : url.pathname.endsWith("/second")
            ? second
            : url.pathname.includes("/jobs/")
              ? {
                  jobID: url.pathname.split("/").pop(),
                  status: url.pathname.endsWith("/older") ? "successful" : "running",
                  processID: "hello-world",
                }
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
  fireEvent.change(screen.getByLabelText("Job status URL"), {
    target: { value: "https://demo.pygeoapi.io/master/jobs/older" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Resume monitoring" }));
  await waitFor(() => assert.ok(screen.queryByText("Older output")));
  assert.equal(run().hasAttribute("disabled"), true);
  fireEvent.change(screen.getByLabelText("Process"), { target: { value: "second" } });
  await waitFor(() =>
    assert.match((screen.getByLabelText("Job status URL") as HTMLInputElement).value, /\/jobs\/b/),
  );
  fireEvent.change(screen.getByLabelText("Process"), { target: { value: "hello-world" } });
  await waitFor(() =>
    assert.match((screen.getByLabelText("Job status URL") as HTMLInputElement).value, /\/jobs\/a/),
  );
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

test("unmount cancels pending submission without publishing stale results or errors", async () => {
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
    view.unmount();
  });
  assert.ok(signal?.aborted);
  assert.equal(useAppStore.getState().layers.length, 0);
  assert.equal(screen.queryByRole("alert") === null, true);
});
for (const outcome of ["accepted job", "synchronous result"] as const) {
  test(`a late successful ${outcome} cannot cross a project replacement`, async () => {
    let signal: AbortSignal | undefined;
    let posts = 0;
    const pending: { resolve?: (response: Response) => void } = {};
    serve(async (_url, init) => {
      posts++;
      signal = init?.signal ?? undefined;
      return new Promise<Response>((resolve, reject) => {
        pending.resolve = resolve;
        signal?.addEventListener("abort", () => reject(signal?.reason), { once: true });
      });
    });
    await form();
    fireEvent.click(screen.getByRole("button", { name: "Run process" }));
    await waitFor(() => assert.ok(pending.resolve));
    await act(async () => {
      useAppStore.setState((state) => ({ projectLoadCount: state.projectLoadCount + 1 }));
    });
    assert.equal(
      screen.getByRole("button", { name: "Retrieve processes" }).hasAttribute("disabled"),
      true,
    );
    assert.equal((screen.getByLabelText("Job status URL") as HTMLInputElement).value, "");
    await act(async () => {
      // Browser fetch remains alive until its bounded response settles.
      pending.resolve?.(
        outcome === "accepted job"
          ? new Response(null, { status: 202, headers: { Location: "/master/jobs/old-project" } })
          : new Response(
              JSON.stringify({
                echo: {
                  value: { type: "FeatureCollection", features: [] },
                  mediaType: "application/geo+json",
                },
              }),
              {
                headers: {
                  "Content-Type": "application/json",
                  Link: '</master/jobs/old-project>; rel="monitor"',
                },
              },
            ),
      );
    });
    assert.equal(signal?.aborted, false);
    await waitFor(() =>
      assert.equal(
        screen.getByRole("button", { name: "Retrieve processes" }).hasAttribute("disabled"),
        false,
      ),
    );
    assert.equal(posts, 1);
    assert.equal((screen.getByLabelText("Job status URL") as HTMLInputElement).value, "");
    assert.equal(screen.queryByRole("button", { name: "Add to map" }), null);
    assert.equal(screen.queryByRole("alert"), null);
    assert.equal(useAppStore.getState().layers.length, 0);
    assert.equal(screen.queryByText("Successful"), null);
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
    if (init?.method === "DELETE") {
      assert.equal(new URL(url).pathname, "/master/jobs/one");
      return new Response(null, { status: 204 });
    }
    assert.ok(["/master/jobs/one", "/master/jobs/one/results"].includes(new URL(url).pathname));
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
