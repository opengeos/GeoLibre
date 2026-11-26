import "./helpers/dom";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  describeOgcProcess,
  discoverOgcProcesses,
  dismissOgcProcessJob,
  downloadOgcProcessOutput,
  executeOgcProcess,
  ogcProcessLink,
  ogcProcessRetryDelay,
  readOgcProcessJob,
  readOgcProcessResults,
} from "../apps/geolibre-desktop/src/lib/ogc-api-processes";
import { processHttp } from "../apps/geolibre-desktop/src/lib/ogc-process-http";
import { monitorOgcProcessJob } from "../apps/geolibre-desktop/src/lib/ogc-process-job";

function description() {
  return JSON.parse(
    readFileSync(
      new URL("./fixtures/ogc-processes/hello-world.json", import.meta.url),
      "utf8",
    ).replaceAll("https://demo.pygeoapi.io/master", "https://example.org/api"),
  );
}
function serve(answer: (url: string, init?: RequestInit) => unknown) {
  const calls: { url: string; init?: RequestInit }[] = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, init });
    const result = answer(url, init);
    return result instanceof Response
      ? result
      : new Response(JSON.stringify(result), {
          headers: { "Content-Type": "application/json" },
        });
  };
  return calls;
}
async function processDescription() {
  serve(() => description());
  return (
    await discoverOgcProcesses(
      "https://example.org/api/processes/hello-world?token=secret",
      new AbortController().signal,
    )
  )[0];
}

test("discovers advertised process catalogs and describes real pygeoapi input schemas", async () => {
  const calls = serve((url) => {
    if (new URL(url).pathname === "/api/")
      return {
        id: "a-service-not-a-process",
        links: [
          {
            rel: "http://www.opengis.net/def/rel/ogc/1.0/processes",
            href: "./catalog",
            type: "application/json",
          },
        ],
      };
    if (new URL(url).pathname === "/api/catalog") return { processes: [description()] };
    return description();
  });
  const signal = new AbortController().signal;
  const [summary] = await discoverOgcProcesses("https://example.org/api/?token=secret", signal);
  assert.equal(summary.id, "hello-world");
  const full = await describeOgcProcess(summary, signal);
  assert.deepEqual(full.inputs.name.schema, { type: "string" });
  assert.ok(full.jobControlOptions.includes("async-execute"));
  assert.equal(calls.length, 3);
  assert.ok(calls.every(({ url }) => new URL(url).searchParams.get("token") === "secret"));
});

test("preserves real pygeometa GeoJSON outputs without a value wrapper", async () => {
  const process = await processDescription();
  const record = JSON.parse(
    readFileSync(new URL("./fixtures/ogc-processes/metadata-record.json", import.meta.url), "utf8"),
  );
  serve(() => ({ outputs: [record] }));
  const result = await executeOgcProcess(process, {}, new AbortController().signal);
  assert.equal(result.kind, "results");
  if (result.kind !== "results") throw new Error("Expected synchronous results");
  assert.equal(result.outputs[0].id, record.id);
  assert.deepEqual(result.outputs[0].value, record);
  const downloaded = await downloadOgcProcessOutput(
    result.outputs[0],
    new AbortController().signal,
  );
  assert.deepEqual(JSON.parse(await downloaded.text()), record);
});

test("does not copy credentials across origins and refuses non-HTTP or user-info links", () => {
  assert.equal(
    ogcProcessLink("https://other.example/result", "https://example.org/api?token=secret"),
    "https://other.example/result",
  );
  assert.equal(
    new URL(ogcProcessLink("/jobs/one", "https://example.org/api?token=secret")).searchParams.get(
      "token",
    ),
    "secret",
  );
  for (const link of [
    "file:///tmp/data",
    "data:application/json,{}",
    "https://user:password@example.org/jobs",
  ])
    assert.throws(() => ogcProcessLink(link, "https://example.org/api"));
  const job = new URL(
    ogcProcessLink(
      "/jobs/one",
      "https://example.org/processes?token=secret&page=2&startindex=5&limit=10&offset=5",
    ),
  );
  assert.equal(job.search, "?token=secret");
});

test("bounded pagination deduplicates processes and skips unusable next links", async () => {
  const calls = serve((url) => ({
    processes: [description()],
    links: [
      {
        rel: "next",
        href: new URL(url).searchParams.has("page") ? "mailto:invalid@example.org" : "?page=2",
      },
    ],
  }));
  const items = await discoverOgcProcesses(
    "https://example.org/api/processes",
    new AbortController().signal,
  );
  assert.equal(items.length, 1);
  assert.equal(calls.length, 2);
  serve(() => ({ processes: [], links: [{ rel: "next", href: "?f=json" }] }));
  await assert.rejects(
    discoverOgcProcesses("https://example.org/api/processes", new AbortController().signal),
    /cycle/,
  );
});

test("synchronous execution submits once and preserves pygeoapi document outputs", async () => {
  const process = await processDescription();
  const calls = serve((_url, init) => {
    assert.equal(init?.method, "POST");
    assert.deepEqual(JSON.parse(String(init.body)), {
      inputs: { name: "GeoLibre" },
      response: "document",
    });
    return {
      outputs: [
        { id: "echo", value: "Hello GeoLibre!" },
        { id: "zero", value: 0 },
      ],
    };
  });
  const result = await executeOgcProcess(
    process,
    { name: "GeoLibre" },
    new AbortController().signal,
  );
  assert.equal(result.kind, "results");
  if (result.kind !== "results") throw Error("Expected results");
  assert.deepEqual(result.outputs, [
    { id: "echo", value: "Hello GeoLibre!" },
    { id: "zero", value: 0 },
  ]);
  assert.equal(calls.length, 1);
  assert.equal(new URL(calls[0].url).pathname, "/api/processes/hello-world/execution");
});

for (const status of [201, 202]) {
  test(`HTTP ${status} execution follows job routing through completion, results and dismissal`, async () => {
    const process = await processDescription();
    const calls = serve((url, init) => {
      const path = new URL(url).pathname;
      if (init?.method === "POST") {
        assert.equal(new Headers(init.headers).get("Prefer"), "respond-async");
        return new Response(JSON.stringify({ jobID: "one", status: "accepted" }), {
          status,
          headers: {
            "Content-Type": "application/json",
            Location: "/api/jobs/one",
            "Retry-After": "2",
          },
        });
      }
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      if (path.endsWith("/results"))
        return {
          result: {
            value: { type: "FeatureCollection", features: [] },
            mediaType: "application/geo+json",
          },
        };
      return {
        jobID: "one",
        status: "successful",
        progress: 100,
        links: [
          {
            rel: "http://www.opengis.net/def/rel/ogc/1.0/results",
            href: "./one/results",
            type: "application/json",
          },
        ],
      };
    });
    const signal = new AbortController().signal;
    const submitted = await executeOgcProcess(process, { name: "GeoLibre" }, signal, true);
    if (submitted.kind !== "job") throw Error("Expected asynchronous job");
    assert.equal(submitted.job.status, "accepted");
    assert.equal(submitted.job.retryAfterMs, 2000);
    assert.equal(new URL(submitted.job.url).searchParams.get("token"), "secret");
    const complete = await readOgcProcessJob(submitted.job.url, signal);
    assert.equal(complete.status, "successful");
    const outputs = await readOgcProcessResults(complete, signal);
    assert.equal(outputs[0].mediaType, "application/geo+json");
    await dismissOgcProcessJob(complete.url, signal);
    assert.deepEqual(
      calls.map((call) => call.init?.method),
      ["POST", "GET", "GET", "DELETE"],
    );
  });
}

test("supports normative reference outputs, base64 values and binary raw results", async () => {
  const process = await processDescription();
  serve(() => ({
    bytes: { value: "AQID", encoding: "base64", mediaType: "application/octet-stream" },
    raster: { href: "https://other.example/output.tif", type: "image/tiff" },
  }));
  const result = await executeOgcProcess(process, {}, new AbortController().signal);
  if (result.kind !== "results") throw Error("Expected results");
  assert.deepEqual(
    new Uint8Array(
      await (
        await downloadOgcProcessOutput(result.outputs[0], new AbortController().signal)
      ).arrayBuffer(),
    ),
    new Uint8Array([1, 2, 3]),
  );
  assert.equal(result.outputs[1].href, "https://other.example/output.tif");
  serve(
    () =>
      new Response(new Uint8Array([73, 73, 42, 0]), { headers: { "Content-Type": "image/tiff" } }),
  );
  const binary = await executeOgcProcess(process, {}, new AbortController().signal);
  if (binary.kind !== "results") throw Error("Expected results");
  assert.deepEqual(binary.outputs[0].bytes, new Uint8Array([73, 73, 42, 0]));
});

test("oversized error bodies preserve HTTP status and execution failures never retry", async () => {
  const process = await processDescription();
  const calls = serve(
    () => new Response("error", { status: 503, headers: { "Content-Length": "9999999" } }),
  );
  await assert.rejects(executeOgcProcess(process, {}, new AbortController().signal), /HTTP 503/);
  assert.equal(calls.length, 1);
  serve(
    () =>
      new Response(
        JSON.stringify({ code: "InvalidParameterValue", description: "Name required" }),
        {
          status: 400,
          headers: { "Content-Type": "application/json" },
        },
      ),
  );
  await assert.rejects(
    executeOgcProcess(process, {}, new AbortController().signal),
    /HTTP 400: Name required/,
  );
});

test("cancelled and oversized submissions never reach the network", async () => {
  const process = await processDescription();
  const calls = serve(() => {
    throw Error("Must not send a request");
  });
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(executeOgcProcess(process, {}, abort.signal), { name: "AbortError" });
  await assert.rejects(
    executeOgcProcess(process, { data: "x".repeat(1024 * 1024) }, new AbortController().signal),
    /1 MiB/,
  );
  await assert.rejects(
    processHttp("https://example.org", new AbortController().signal, {
      method: "DELETE",
      body: "{}",
    }),
    /Only/,
  );
  assert.equal(calls.length, 0);
});

test("unknown job states fail explicitly and Retry-After remains bounded", async () => {
  serve(() => ({ jobID: "one", status: "unknown" }));
  await assert.rejects(
    readOgcProcessJob("https://example.org/jobs/one", new AbortController().signal),
    /unknown/,
  );
  assert.equal(ogcProcessRetryDelay("2"), 2000);
  assert.equal(ogcProcessRetryDelay("9999"), 30000);
  assert.equal(ogcProcessRetryDelay("-1"), 500);
  assert.equal(ogcProcessRetryDelay(null), 1000);
  assert.equal(ogcProcessRetryDelay("Thu, 01 Jan 1970 00:00:05 GMT", 1000), 4000);
});

test("monitoring advances job status and reads results without resubmitting execution", async () => {
  let reads = 0;
  const calls = serve((url, init) => {
    assert.equal(init?.method, "GET");
    if (new URL(url).pathname.endsWith("/results")) return { echo: "complete" };
    return new Response(
      JSON.stringify({
        jobID: "one",
        status: reads++ ? "successful" : "running",
        progress: reads * 50,
      }),
      { headers: { "Content-Type": "application/json", "Retry-After": "0" } },
    );
  });
  const statuses: string[] = [];
  const result = await monitorOgcProcessJob(
    "https://example.org/jobs/one",
    new AbortController().signal,
    (job) => statuses.push(job.status),
  );
  assert.deepEqual(statuses, ["running", "successful"]);
  assert.deepEqual(result, [{ id: "echo", value: "complete" }]);
  assert.equal(calls.length, 3);
});

test("cancelling monitoring stops reads without deleting the remote job", async () => {
  const calls = serve(() => ({ jobID: "one", status: "running" }));
  const abort = new AbortController();
  await assert.rejects(
    monitorOgcProcessJob("https://example.org/jobs/one", abort.signal, () => abort.abort()),
    { name: "AbortError" },
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init?.method, "GET");
});

test("failed jobs surface their service message without trying to read results", async () => {
  const calls = serve(() => ({ jobID: "one", status: "failed", message: "Input has no geometry" }));
  await assert.rejects(
    monitorOgcProcessJob("https://example.org/jobs/one", new AbortController().signal),
    /Input has no geometry/,
  );
  assert.equal(calls.length, 1);
});
