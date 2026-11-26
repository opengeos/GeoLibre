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
import { ogcProcessMonitorLinks } from "../apps/geolibre-desktop/src/lib/ogc-process-link-header";
import { monitorOgcProcessJob } from "../apps/geolibre-desktop/src/lib/ogc-process-job";
import { validOgcProcessGeoJson } from "../apps/geolibre-desktop/src/lib/ogc-process-geometry";
import {
  canImportOgcProcessOutput,
  ogcProcessOutputPreview,
} from "../apps/geolibre-desktop/src/lib/ogc-process-results";
import { fromArrayBuffer } from "geotiff";
import {
  ogcProcessInputDefaults,
  parseOgcProcessInputs,
  serializeOgcProcessLayerInput,
} from "../apps/geolibre-desktop/src/lib/ogc-process-inputs";
import { MAX_PROCESS_INPUT_BYTES } from "../apps/geolibre-desktop/src/lib/ogc-process-limits";
import i18next from "i18next";
import {
  OgcProcessError,
  ogcProcessErrorText,
} from "../apps/geolibre-desktop/src/lib/ogc-process-errors";

test("client errors follow the active language and retain original service details", async () => {
  const previous = i18next.language;
  const error = new OgcProcessError("inputObject");
  i18next.addResourceBundle(
    "fr",
    "translation",
    {
      processing: {
        ogcProcesses: {
          errors: {
            inputObject: "Les paramètres doivent être un objet JSON.",
            http: "Erreur distante {{status}}{{detail}}",
          },
        },
      },
    },
    true,
    true,
  );
  try {
    await i18next.changeLanguage("fr");
    assert.equal(ogcProcessErrorText(error), "Les paramètres doivent être un objet JSON.");
    assert.equal(
      new OgcProcessError("http", { status: 400, detail: ": Original service detail" }).message,
      "Erreur distante 400: Original service detail",
    );
  } finally {
    await i18next.changeLanguage(previous);
  }
});

test("binary output previews use the active language", async () => {
  const previous = i18next.language;
  await i18next.changeLanguage("en");
  assert.equal(ogcProcessOutputPreview({ id: "bytes", bytes: new Uint8Array(1) }), "1 byte");
  assert.equal(ogcProcessOutputPreview({ id: "bytes", bytes: new Uint8Array(2) }), "2 bytes");
  i18next.addResourceBundle(
    "fr",
    "translation",
    {
      processing: {
        ogcProcesses: {
          outputBytes_one: "{{count}} octet",
          outputBytes_other: "{{count}} octets",
        },
      },
    },
    true,
    true,
  );
  try {
    await i18next.changeLanguage("fr");
    assert.equal(ogcProcessOutputPreview({ id: "bytes", bytes: new Uint8Array(3) }), "3 octets");
  } finally {
    await i18next.changeLanguage(previous);
  }
});

test("unusable output links preserve other completed outputs and remain downloadable as metadata", async () => {
  const process = await processDescription();
  for (const href of [
    "mailto:operator@example.org",
    "http://[",
    "https://user:secret@example.org/data",
  ]) {
    const raw = { href, type: "image/tiff" };
    const calls = serve(() => ({ bad: raw, echo: "Completed" }));
    const signal = new AbortController().signal;
    const result = await executeOgcProcess(process, {}, signal);
    assert.equal(result.kind, "results");
    if (result.kind !== "results") throw Error("Expected completed results");
    assert.equal(result.outputs[1].value, "Completed");
    assert.equal(result.outputs[0].warning, "invalidReference");
    assert.equal(canImportOgcProcessOutput(result.outputs[0]), false);
    assert.deepEqual(
      JSON.parse(await (await downloadOgcProcessOutput(result.outputs[0], signal)).text()),
      raw,
    );
    assert.equal(calls.filter((call) => call.init?.method === "POST").length, 1);
  }
});

test("a malformed completed result without job routing retains its original downloadable bytes", async () => {
  const process = await processDescription();
  const calls = serve(
    () => new Response("{broken", { headers: { "Content-Type": "application/json" } }),
  );
  const signal = new AbortController().signal;
  const result = await executeOgcProcess(process, {}, signal);
  assert.equal(result.kind, "results");
  if (result.kind !== "results") throw Error("Expected completed results");
  assert.equal(result.outputs[0].warning, "invalidDocument");
  assert.equal(canImportOgcProcessOutput(result.outputs[0]), false);
  assert.equal(await (await downloadOgcProcessOutput(result.outputs[0], signal)).text(), "{broken");
  assert.equal(calls.filter((call) => call.init?.method === "POST").length, 1);
});

test("polling keeps an advertised results route unless a later status explicitly replaces it", async () => {
  for (const replace of [false, true]) {
    let reads = 0;
    const calls = serve((url) => {
      if (new URL(url).pathname.startsWith("/artifacts/")) return { echo: 5 };
      const first = reads++ === 0;
      return new Response(
        JSON.stringify({
          jobID: "one",
          status: first ? "running" : "successful",
          ...(first || replace
            ? {
                links: [{ rel: "results", href: first ? "/artifacts/first" : "/artifacts/second" }],
              }
            : {}),
        }),
        { headers: { "Content-Type": "application/json", "Retry-After": "0" } },
      );
    });
    assert.deepEqual(
      await monitorOgcProcessJob("https://example.org/jobs/one", new AbortController().signal),
      [{ id: "echo", value: 5 }],
    );
    assert.equal(
      new URL(calls.at(-1)!.url).pathname,
      replace ? "/artifacts/second" : "/artifacts/first",
    );
    assert.equal(calls.length, 3);
  }
});

test("layer input serialization stops early and preserves JSON and UTF-8 semantics", () => {
  const limit = MAX_PROCESS_INPUT_BYTES;
  assert.equal(serializeOgcProcessLayerInput("x".repeat(limit - 2))?.length, limit);
  assert.equal(serializeOgcProcessLayerInput("x".repeat(limit - 1)), null);
  assert.equal(serializeOgcProcessLayerInput("é".repeat(limit / 2)), null);
  assert.equal(serializeOgcProcessLayerInput("\u0000".repeat(Math.ceil(limit / 6))), null);
  assert.equal(
    serializeOgcProcessLayerInput({
      oversized: "x".repeat(limit),
      get later() {
        throw new Error("Serialization should already have stopped");
      },
    }),
    null,
  );
  let calls = 0;
  const value = {
    text: 'é😀\ud800\u0000"\\',
    omitted: undefined,
    array: [undefined, NaN],
    custom: {
      toJSON() {
        calls++;
        return "small";
      },
    },
    skipped: {
      toJSON() {
        return undefined;
      },
    },
  };
  const actual = serializeOgcProcessLayerInput(value);
  assert.equal(calls, 1);
  assert.equal(actual, JSON.stringify(value));
  assert.equal(serializeOgcProcessLayerInput({ ["x".repeat(limit)]: undefined }), "{}");
});

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

test("invalid URLs and an empty accepted response without routing use catalog errors", async () => {
  const process = await processDescription();
  const calls = serve(() => new Response(null, { status: 202 }));
  await assert.rejects(
    discoverOgcProcesses("example.org/processes", new AbortController().signal),
    { code: "invalidUrl" },
  );
  assert.equal(calls.length, 0);
  await assert.rejects(executeOgcProcess(process, {}, new AbortController().signal), {
    code: "noStatusUrl",
  });
  serve(() => ({ status: "successful" }));
  const current = await readOgcProcessJob(
    "https://example.org/jobs/bad%ZZ",
    new AbortController().signal,
  );
  assert.equal(current.id, "bad%ZZ");
});

test("malformed accepted bodies without routing report the localized missing-status error", async () => {
  const process = await processDescription();
  for (const status of [201, 202]) {
    for (const body of ["<html>accepted</html>", "[]", '"accepted"']) {
      const calls = serve(
        () => new Response(body, { status, headers: { "Content-Type": "application/json" } }),
      );
      await assert.rejects(executeOgcProcess(process, {}, new AbortController().signal), {
        code: "noStatusUrl",
      });
      assert.equal(calls.length, 1);
    }
  }
});

test("hosted transport can recover body routing when non-exposed response headers are unavailable", async () => {
  const process = await processDescription();
  const calls = serve(
    () =>
      new Response(
        JSON.stringify({
          status: "accepted",
          links: [{ rel: "self", href: "/api/jobs/from-body" }],
        }),
        {
          status: 201,
          headers: { "Content-Type": "application/json" },
        },
      ),
  );
  const result = await executeOgcProcess(process, {}, new AbortController().signal);
  assert.equal(result.kind, "job");
  assert.equal(new URL(result.job!.url).pathname, "/api/jobs/from-body");
  assert.equal(
    calls[0].url.startsWith("https://example.org/"),
    true,
    "direct non-Tauri request without the development proxy",
  );
});

test("GeoJSON validation covers nested geometry types and rejects non-finite positions", () => {
  const ring = [
    [0, 0],
    [2, 0],
    [2, 2],
    [0, 0],
  ];
  const geometries = [
    { type: "Point", coordinates: [1, 2, 3] },
    { type: "MultiPoint", coordinates: [[1, 2]] },
    {
      type: "LineString",
      coordinates: [
        [0, 0],
        [1, 1],
      ],
    },
    {
      type: "MultiLineString",
      coordinates: [
        [
          [0, 0],
          [1, 1],
        ],
      ],
    },
    { type: "Polygon", coordinates: [ring] },
    { type: "MultiPolygon", coordinates: [[ring]] },
    { type: "GeometryCollection", geometries: [{ type: "Point", coordinates: [1, 2] }] },
  ];
  const collection = (geometry: unknown) => ({
    type: "FeatureCollection",
    features: [{ type: "Feature", properties: {}, geometry }],
  });
  for (const geometry of geometries)
    assert.equal(validOgcProcessGeoJson(collection(geometry)), true);
  for (const geometry of [
    { type: "Point", coordinates: ["bad", 0] },
    { type: "Point", coordinates: [NaN, 0] },
    { type: "MultiPoint", coordinates: [[1, Infinity]] },
    { type: "LineString", coordinates: [[1, 2]] },
    {
      type: "MultiLineString",
      coordinates: [
        [
          [0, 0],
          ["bad", 1],
        ],
      ],
    },
    {
      type: "Polygon",
      coordinates: [
        [
          [0, 0],
          [2, 0],
          [2, 2],
          [1, 1],
        ],
      ],
    },
    {
      type: "MultiPolygon",
      coordinates: [
        [
          [
            [0, 0],
            [2, 0],
            [2, "bad"],
            [0, 0],
          ],
        ],
      ],
    },
    { type: "GeometryCollection", geometries: [{ type: "Point", coordinates: [1, "bad"] }] },
  ])
    assert.equal(validOgcProcessGeoJson(collection(geometry)), false);
  assert.equal(validOgcProcessGeoJson(collection(null)), true);
});

test("acknowledged or already-absent dismissals complete despite unreadable response bodies", async () => {
  for (const status of [200, 404, 410]) {
    const calls = serve(
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new Error("interrupted body"));
            },
          }),
          { status },
        ),
    );
    await dismissOgcProcessJob("https://example.org/jobs/one", new AbortController().signal);
    assert.equal(calls.length, 1);
  }
});

test("a failed accepted body read preserves the job status and URL", async () => {
  const process = await processDescription();
  const calls = serve(
    () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new Error("interrupted body"));
          },
        }),
        {
          status: 202,
          headers: { Location: "/api/jobs/accepted", "Content-Type": "application/json" },
        },
      ),
  );
  const result = await executeOgcProcess(process, {}, new AbortController().signal);
  assert.equal(result.kind, "job");
  if (result.kind === "job") assert.equal(new URL(result.job.url).pathname, "/api/jobs/accepted");
  assert.equal(calls.length, 1);
  serve(
    () =>
      new Response("{invalid-json", {
        status: 201,
        headers: { Location: "/api/jobs/accepted", "Content-Type": "application/json" },
      }),
  );
  assert.equal((await executeOgcProcess(process, {}, new AbortController().signal)).kind, "job");
});

test("successful synchronous writes recover monitor routing after body failures without resubmission", async () => {
  const process = await processDescription();
  for (const failure of ["stream", "malformed JSON"] as const) {
    const calls = serve((url, init) => {
      if (init?.method === "POST")
        return new Response(
          failure === "stream"
            ? new ReadableStream({
                start(controller) {
                  controller.error(new Error("interrupted"));
                },
              })
            : "{broken",
          {
            status: 200,
            headers: {
              "Content-Type": "application/json",
              Link: '</api/jobs/sync>; rel="monitor"',
              "Retry-After": "0",
            },
          },
        );
      if (url.includes("/results")) return { echo: "Recovered" };
      return { status: "successful", jobID: "sync" };
    });
    const signal = new AbortController().signal;
    const result = await executeOgcProcess(process, {}, signal);
    assert.equal(result.kind, "job");
    if (result.kind !== "job") throw new Error("Expected recoverable job");
    assert.equal(new URL(result.job.url).pathname, "/api/jobs/sync");
    assert.deepEqual(await monitorOgcProcessJob(result.job, signal), [
      { id: "echo", value: "Recovered", mediaType: "application/json" },
    ]);
    assert.equal(calls.filter((call) => call.init?.method === "POST").length, 1);
  }
});

test("an unreadable successful execution without routing remains uncertain rather than empty success", async () => {
  const process = await processDescription();
  const calls = serve(
    () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new Error("interrupted"));
          },
        }),
        { status: 200 },
      ),
  );
  await assert.rejects(executeOgcProcess(process, {}, new AbortController().signal), {
    code: "executionUncertain",
  });
  assert.equal(calls.length, 1);
  serve(
    () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new Error("interrupted GET"));
          },
        }),
        { status: 200, headers: { Link: '</api/jobs/sync>; rel="monitor"' } },
      ),
  );
  await assert.rejects(processHttp("https://example.org/results", new AbortController().signal));
});

test("monitoring and request deadlines use localized errors and preserve caller cancellation", async (t) => {
  const original = AbortSignal.timeout;
  const observation = new AbortController();
  t.mock.method(AbortSignal, "timeout", (ms: number) =>
    ms === 30 * 60_000 ? observation.signal : original(ms),
  );
  serve(() => ({ jobID: "one", status: "running" }));
  await assert.rejects(
    monitorOgcProcessJob("https://example.org/jobs/one", new AbortController().signal, () =>
      observation.abort(new DOMException("deadline", "TimeoutError")),
    ),
    { code: "monitoringTimeout" },
  );
  const caller = new AbortController();
  caller.abort();
  await assert.rejects(monitorOgcProcessJob("https://example.org/jobs/one", caller.signal), {
    name: "AbortError",
  });
  globalThis.fetch = async () => {
    throw new DOMException("deadline", "TimeoutError");
  };
  await assert.rejects(processHttp("https://example.org/processes", new AbortController().signal), {
    code: "requestTimeout",
  });
});

test("an error-body deadline preserves received HTTP rejection while caller cancellation stays distinct", async (t) => {
  let deadline = new AbortController();
  t.mock.method(AbortSignal, "timeout", () => deadline.signal);
  for (const status of [401, 503]) {
    deadline = new AbortController();
    serve(
      () =>
        new Response(
          new ReadableStream(
            {
              pull(controller) {
                deadline.abort(new DOMException("deadline", "TimeoutError"));
                controller.error(deadline.signal.reason);
              },
            },
            { highWaterMark: 0 },
          ),
          { status },
        ),
    );
    const response = await processHttp(
      "https://example.org/jobs/one",
      new AbortController().signal,
    );
    assert.equal(response.status, status);
    assert.equal(response.bodyReadFailed, true);
  }
  deadline = new AbortController();
  const caller = new AbortController();
  serve(
    () =>
      new Response(
        new ReadableStream(
          {
            pull(controller) {
              caller.abort(new DOMException("cancelled", "AbortError"));
              controller.error(caller.signal.reason);
            },
          },
          { highWaterMark: 0 },
        ),
        { status: 401 },
      ),
  );
  await assert.rejects(processHttp("https://example.org/jobs/one", caller.signal), {
    name: "AbortError",
  });
});

test("JSON GeoJSON and GeometryCollection results stay whole without reserving output IDs", async () => {
  const process = await processDescription();
  for (const mediaType of ["application/json", "application/geo+json"]) {
    for (const document of [
      { type: "FeatureCollection", features: [] },
      { type: "GeometryCollection", geometries: [] },
    ]) {
      serve(
        () => new Response(JSON.stringify(document), { headers: { "Content-Type": mediaType } }),
      );
      const result = await executeOgcProcess(process, {}, new AbortController().signal);
      if (result.kind !== "results") throw Error("Expected results");
      assert.equal(result.outputs.length, 1);
      assert.deepEqual(
        JSON.parse(
          await (
            await downloadOgcProcessOutput(result.outputs[0], new AbortController().signal)
          ).text(),
        ),
        document,
      );
    }
  }
  process.outputs = {
    type: { schema: { type: "string" } },
    features: { schema: { type: "array" } },
  };
  serve(() => ({ type: "FeatureCollection", features: [] }));
  const literal = await executeOgcProcess(process, {}, new AbortController().signal);
  if (literal.kind !== "results") throw Error("Expected results");
  assert.deepEqual(
    literal.outputs.map((value) => value.id),
    ["type", "features"],
  );
});

test("binary output schemas survive synchronous execution and asynchronous polling", async () => {
  const process = await processDescription();
  process.outputs = {
    binary: {
      schema: {
        type: "string",
        contentEncoding: "binary",
        contentMediaType: "application/octet-stream",
      },
    },
    literal: { schema: { type: "string" } },
    formatted: { schema: { type: "string", format: "byte" } },
  };
  const signal = new AbortController().signal;
  for (const asynchronous of [false, true]) {
    serve((url, init) => {
      if (init?.method === "POST" && asynchronous)
        return new Response(null, {
          status: 202,
          headers: { Location: "/api/jobs/one", "Retry-After": "0" },
        });
      if (new URL(url).pathname === "/api/jobs/one") return { jobID: "one", status: "successful" };
      return { binary: "AAEC/w==", literal: "AAEC/w==", formatted: "AAEC/w==" };
    });
    const execution = await executeOgcProcess(process, {}, signal, asynchronous);
    const result =
      execution.kind === "job"
        ? await monitorOgcProcessJob(execution.job, signal)
        : execution.outputs;
    assert.deepEqual(
      new Uint8Array(await (await downloadOgcProcessOutput(result[0], signal)).arrayBuffer()),
      new Uint8Array([0, 1, 2, 255]),
    );
    assert.equal(await (await downloadOgcProcessOutput(result[1], signal)).text(), "AAEC/w==");
    assert.deepEqual(
      new Uint8Array(await (await downloadOgcProcessOutput(result[2], signal)).arrayBuffer()),
      new Uint8Array([0, 1, 2, 255]),
    );
  }
});

test("oneOf output defaults retain their media type and explicit result formats override it", async () => {
  const process = await processDescription();
  process.outputs = {
    image: {
      schema: {
        oneOf: [
          { type: "string", contentEncoding: "binary", contentMediaType: "image/tiff" },
          { type: "string", contentEncoding: "binary", contentMediaType: "image/jp2" },
        ],
      },
    },
  };
  const signal = new AbortController().signal;
  for (const explicit of [false, true]) {
    serve(() => ({ image: explicit ? { value: "AAEC/w==", mediaType: "image/jp2" } : "AAEC/w==" }));
    const result = await executeOgcProcess(process, {}, signal);
    if (result.kind !== "results") throw new Error("Expected synchronous result");
    const downloaded = await downloadOgcProcessOutput(result.outputs[0], signal);
    assert.equal(downloaded.type, explicit ? "image/jp2" : "image/tiff");
    assert.deepEqual(
      new Uint8Array(await downloaded.arrayBuffer()),
      new Uint8Array([0, 1, 2, 255]),
    );
  }
  process.outputs.image.schema = {
    oneOf: [
      { type: "string", contentMediaType: "text/plain" },
      { type: "string", contentEncoding: "binary", contentMediaType: "image/tiff" },
    ],
  };
  serve(() => ({ image: "AAEC/w==" }));
  const text = await executeOgcProcess(process, {}, signal);
  if (text.kind !== "results") throw new Error("Expected synchronous result");
  assert.equal(await (await downloadOgcProcessOutput(text.outputs[0], signal)).text(), "AAEC/w==");
  assert.equal(text.outputs[0].encoding, undefined);
  process.outputs.image.schema = {
    oneOf: [
      { type: "string", contentEncoding: "binary", contentMediaType: "image/tiff" },
      { type: "string", contentMediaType: "text/plain" },
    ],
  };
  serve(() => ({ image: { value: "A literal message", mediaType: "text/plain" } }));
  const overridden = await executeOgcProcess(process, {}, signal);
  if (overridden.kind !== "results") throw new Error("Expected synchronous result");
  assert.equal(overridden.outputs[0].encoding, undefined);
  assert.equal(
    await (await downloadOgcProcessOutput(overridden.outputs[0], signal)).text(),
    "A literal message",
  );
});

test("repeated defaults produce occurrence arrays while single defaults retain their values", async () => {
  const process = await processDescription();
  const collection = { type: "FeatureCollection", features: [] };
  process.inputs = {
    number: { schema: { type: "integer", default: 5 }, maxOccurs: 2 },
    object: { schema: { type: "object", default: collection }, maxOccurs: "unbounded" },
    array: { schema: { type: "array", default: [1, 2] }, maxOccurs: 2 },
    single: { schema: { type: "integer", default: 5 } },
  };
  assert.deepEqual(parseOgcProcessInputs(process, ogcProcessInputDefaults(process)), {
    number: [5],
    object: [{ value: collection }],
    array: [[1, 2]],
    single: 5,
  });
});

test("declared size rejection cancels the unread body while preserving accepted routing", async () => {
  const process = await processDescription();
  let cancelled = 0;
  const oversized = (status: number) =>
    new Response(
      new ReadableStream(
        {
          cancel() {
            cancelled++;
          },
        },
        { highWaterMark: 0 },
      ),
      {
        status,
        headers: { "Content-Length": "999999999", Location: "/api/jobs/retained" },
      },
    );
  serve(() => oversized(202));
  const accepted = await executeOgcProcess(process, {}, new AbortController().signal);
  assert.equal(accepted.kind, "job");
  assert.equal(new URL(accepted.job!.url).pathname, "/api/jobs/retained");
  assert.equal(cancelled, 1);
  serve(() => oversized(200));
  await assert.rejects(
    processHttp("https://example.org/result", new AbortController().signal),
    /download limit/,
  );
  assert.equal(cancelled, 2);
});

test("generic binary TIFF outputs remain eligible for validated import", async () => {
  const bytes = new Uint8Array(
    readFileSync(new URL("./fixtures/ogc-processes/gdps-striped-float64.tif", import.meta.url)),
  );
  const output = { id: "raster", bytes, mediaType: "application/octet-stream" };
  assert.equal(canImportOgcProcessOutput(output), true);
  assert.equal(
    canImportOgcProcessOutput({
      id: "raster",
      href: "https://example.org/result",
      mediaType: "application/octet-stream",
    }),
    true,
  );
  assert.equal(
    canImportOgcProcessOutput({
      id: "raster",
      encoding: "base64",
      value: "AA==",
      mediaType: "application/octet-stream",
    }),
    true,
  );
  assert.equal(
    canImportOgcProcessOutput({ id: "text", value: "A message", mediaType: "text/plain" }),
    false,
  );
  const blob = await downloadOgcProcessOutput(output, new AbortController().signal);
  const image = await (await fromArrayBuffer(await blob.arrayBuffer())).getImage();
  assert.ok(image.getWidth() > 0 && image.getHeight() > 0);
});

test("unencoded string outputs keep their schema media type and original text", async () => {
  const process = await processDescription();
  process.outputs = {
    map: { schema: { type: "string", contentMediaType: "application/geo+json" } },
  };
  const text = JSON.stringify({ type: "FeatureCollection", features: [] });
  serve(() => ({ map: text }));
  const signal = new AbortController().signal;
  const execution = await executeOgcProcess(process, {}, signal);
  assert.equal(execution.kind, "results");
  if (execution.kind !== "results") throw new Error("Expected synchronous outputs");
  assert.equal(execution.outputs[0].encoding, undefined);
  const blob = await downloadOgcProcessOutput(execution.outputs[0], signal);
  assert.equal(blob.type, "application/geo+json");
  assert.equal(await blob.text(), text);
});

test("job status rejects non-string values rather than polling indefinitely", async () => {
  for (const status of [["successful"], null, {}, 1, true]) {
    serve(() => ({ status }));
    await assert.rejects(
      readOgcProcessJob("https://example.org/jobs/one", new AbortController().signal),
      { code: "unknownJobStatus" },
    );
  }
});

test("monitor links with a different anchor context are ignored", () => {
  assert.deepEqual(
    ogcProcessMonitorLinks(
      '</jobs/other>; rel=monitor; anchor="/other/execution", </jobs/current>; rel="monitor"',
    ),
    ["/jobs/current"],
  );
  assert.deepEqual(ogcProcessMonitorLinks('</jobs/other>; ANCHOR=""; rel=monitor'), []);
});

test("an untracked job resolves advertised process outputs before parsing legacy results", async () => {
  const descriptionValue = description();
  const calls = serve((url) => {
    const path = new URL(url).pathname;
    if (path === "/api/jobs/external")
      return { jobID: "external", processID: "hello-world", status: "successful" };
    if (path.endsWith("/results"))
      return {
        outputs: [
          {
            id: "echo",
            value: { type: "FeatureCollection", features: [] },
            mediaType: "application/geo+json",
          },
        ],
      };
    assert.equal(path, "/api/processes/hello-world");
    return descriptionValue;
  });
  const result = await monitorOgcProcessJob(
    "https://example.org/api/jobs/external?token=secret",
    new AbortController().signal,
  );
  assert.equal(result[0].id, "echo");
  assert.equal(result[0].mediaType, "application/geo+json");
  assert.equal(calls.length, 3);
  assert.ok(calls.every((call) => call.init?.method === "GET"));
  descriptionValue.outputs = { outputs: { schema: { type: "array" } } };
  const core = await monitorOgcProcessJob(
    "https://example.org/api/jobs/external?token=secret",
    new AbortController().signal,
  );
  assert.equal(core[0].id, "outputs");
  assert.ok(Array.isArray(core[0].value));
});

test("monitoring resolves context when processID first appears in a later status", async () => {
  for (const coreOutput of [false, true]) {
    let reads = 0;
    let descriptions = 0;
    const document = description();
    if (coreOutput) document.outputs = { outputs: { schema: { type: "array" } } };
    serve((url) => {
      const path = new URL(url).pathname;
      if (path.endsWith("/results")) return { outputs: [{ id: "echo", value: 5 }] };
      if (path.includes("/processes/")) {
        descriptions++;
        return document;
      }
      return reads++ ? { status: "successful", processID: "hello-world" } : { status: "running" };
    });
    const result = await monitorOgcProcessJob(
      "https://example.org/api/jobs/late",
      new AbortController().signal,
    );
    assert.equal(descriptions, 1);
    assert.equal(result[0].id, coreOutput ? "outputs" : "echo");
    assert.deepEqual(result[0].value, coreOutput ? [{ id: "echo", value: 5 }] : 5);
  }
});

test("a replacement advertised process description recovers after the first reference fails", async () => {
  let reads = 0;
  const descriptions: string[] = [];
  serve((url) => {
    const path = new URL(url).pathname;
    if (path.endsWith("/results")) return { echo: { value: btoa("decoded") } };
    if (path.includes("/processes/")) {
      descriptions.push(path);
      if (path.endsWith("/missing")) return new Response(null, { status: 404 });
      const doc = description();
      doc.outputs = {
        echo: {
          schema: {
            type: "string",
            contentEncoding: "base64",
            contentMediaType: "application/octet-stream",
          },
        },
      };
      return doc;
    }
    const first = reads++ === 0;
    return {
      status: first ? "running" : "successful",
      links: [
        { rel: "process", href: first ? "/api/processes/missing" : "/api/processes/replacement" },
      ],
    };
  });
  const signal = new AbortController().signal;
  const result = await monitorOgcProcessJob("https://example.org/api/jobs/replacement", signal);
  assert.deepEqual(descriptions, ["/api/processes/missing", "/api/processes/replacement"]);
  assert.equal(result[0].encoding, "base64");
  assert.equal(await (await downloadOgcProcessOutput(result[0], signal)).text(), "decoded");
});

test("header-only raw result references remain downloadable without selecting navigation links", async () => {
  serve((url) => {
    if (url.includes("/results"))
      return new Response(null, {
        status: 204,
        headers: {
          Link: '<https://files.example/a,b.tif>; rel="output"; type="image/tiff"; title="DEM", </api/map.geojson>; type="application/geo+json"; title="Map", </api/jobs/one>; rel="monitor", </api/jobs/one/results>; rel="self", <mailto:bad@example.org>; rel="output"; title="Bad"',
        },
      });
    if (url.includes(".tif") || url.includes(".geojson")) return new Response("downloaded");
    return { jobID: "one", status: "successful" };
  });
  const signal = new AbortController().signal;
  const job = await readOgcProcessJob("https://example.org/api/jobs/one", signal);
  const result = await readOgcProcessResults(job, signal);
  assert.deepEqual(
    result.map((output) => output.id),
    ["DEM", "Map", "Bad"],
  );
  assert.equal(result[0].mediaType, "image/tiff");
  assert.equal(result[1].mediaType, "application/geo+json");
  assert.equal(await (await downloadOgcProcessOutput(result[0], signal)).text(), "downloaded");
  assert.equal(result[2].warning, "invalidReference");
  serve(() => new Response(null, { status: 204 }));
  assert.deepEqual(await readOgcProcessResults(job, signal), []);
});

test("duplicate rel parameters cannot redirect monitoring away from the first relation", () => {
  assert.deepEqual(
    ogcProcessMonitorLinks(
      '</jobs/other>; rel=alternate; rel=monitor, </jobs/current>; rel="alternate monitor"',
    ),
    ["/jobs/current"],
  );
});

test("execution input nesting matches the native parser limit before any dispatch", async () => {
  const process = await processDescription();
  let value: unknown = 0;
  for (let i = 0; i < 125; i++) value = [value];
  const signal = new AbortController().signal;
  let calls = serve(() => ({ echo: "ok" }));
  assert.equal((await executeOgcProcess(process, { payload: value }, signal)).kind, "results");
  assert.equal(calls.length, 1);
  calls = serve(() => ({ echo: "must not dispatch" }));
  await assert.rejects(executeOgcProcess(process, { payload: [value] }, signal), {
    code: "inputDepth",
  });
  await assert.rejects(
    processHttp("https://example.org/execution", signal, {
      method: "POST",
      body: JSON.stringify({ inputs: { payload: [value] } }),
    }),
    { code: "inputDepth" },
  );
  assert.equal(calls.length, 0);
});

test("a received response with an interrupted body does not report a CORS failure", async () => {
  serve(
    () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new TypeError("terminated"));
          },
        }),
      ),
  );
  await assert.rejects(processHttp("https://example.org/result", new AbortController().signal), {
    code: "responseInterrupted",
  });
});

test("resumed process descriptions must match an explicitly reported process ID", async () => {
  for (const matches of [false, true]) {
    serve((url) => {
      if (url.includes("/results")) return { echo: { value: "dGV4dA==" } };
      if (url.includes("/processes/")) {
        const doc = description();
        doc.id = matches ? "A" : "B";
        doc.outputs.echo.schema = {
          type: "string",
          contentEncoding: "base64",
          contentMediaType: "application/octet-stream",
        };
        return doc;
      }
      return {
        jobID: "one",
        status: "successful",
        processID: "A",
        links: [{ rel: "process", href: "/api/processes/A" }],
      };
    });
    const signal = new AbortController().signal;
    const outputs = await monitorOgcProcessJob("https://example.org/api/jobs/one", signal);
    assert.equal(outputs[0].encoding, matches ? "base64" : undefined);
    assert.equal(
      await (await downloadOgcProcessOutput(outputs[0], signal)).text(),
      matches ? "text" : "dGV4dA==",
    );
  }
});

test("raw JSON scalars retain their original download bytes without changing document strings", async () => {
  const process = await processDescription();
  for (const text of [' "hello"\n', "9007199254740993", "-0", "null", "[1, 2]"]) {
    serve(() => new Response(text, { headers: { "Content-Type": "application/json" } }));
    const signal = new AbortController().signal;
    const result = await executeOgcProcess(process, {}, signal);
    assert.equal(result.kind, "results");
    if (result.kind !== "results") throw Error("Expected results");
    assert.deepEqual(result.outputs[0].value, JSON.parse(text));
    assert.equal(await (await downloadOgcProcessOutput(result.outputs[0], signal)).text(), text);
  }
  serve(() => ({ echo: "plain document string" }));
  const signal = new AbortController().signal;
  const result = await executeOgcProcess(process, {}, signal);
  if (result.kind !== "results") throw Error("Expected results");
  assert.equal(
    await (await downloadOgcProcessOutput(result.outputs[0], signal)).text(),
    "plain document string",
  );
});

test("same-origin links inherit repeated query values while respecting original overrides", () => {
  const base = "https://example.org/api/processes/one?scope=read&scope=jobs&token=a&token=b&f=json";
  const inherited = new URL(ogcProcessLink("/api/jobs/one", base));
  assert.deepEqual(inherited.searchParams.getAll("scope"), ["read", "jobs"]);
  assert.deepEqual(inherited.searchParams.getAll("token"), ["a", "b"]);
  const overridden = new URL(ogcProcessLink("/api/jobs/one?scope=explicit", base));
  assert.deepEqual(overridden.searchParams.getAll("scope"), ["explicit"]);
  assert.equal(new URL(ogcProcessLink("https://other.example/jobs/one", base)).search, "");
});

test("Unicode values and property names are validated before any execution dispatch", async () => {
  const process = await processDescription();
  const calls = serve(() => ({ echo: "ok" }));
  const signal = new AbortController().signal;
  for (const inputs of [{ name: "\ud800" }, { name: "\udfff" }, { "\ud800": "value" }]) {
    await assert.rejects(executeOgcProcess(process, inputs, signal), { code: "inputUnicode" });
    await assert.rejects(
      processHttp("https://example.org/execution", signal, {
        method: "POST",
        body: JSON.stringify({ inputs }),
      }),
      { code: "inputUnicode" },
    );
  }
  await assert.rejects(
    processHttp("https://example.org/execution", signal, { method: "POST", body: "{broken" }),
    { code: "inputsJsonSyntax" },
  );
  assert.equal(calls.length, 0);
  assert.equal(
    (await executeOgcProcess(process, { name: "\ud83d\ude00" }, signal)).kind,
    "results",
  );
  assert.equal(calls.length, 1);
});

test("equivalent parameterized media types retain the selected encoding and parameter case", async () => {
  const process = await processDescription();
  for (const uniqueBase of [false, true]) {
    process.outputs.echo.schema = {
      oneOf: [
        {
          type: "string",
          contentMediaType: `${uniqueBase ? "application/json" : "text/plain"}; charset=utf-8; profile=CaseA`,
        },
        {
          type: "string",
          contentEncoding: "base64",
          contentMediaType: 'text/plain; charset=iso-8859-1; profile="CaseB"',
        },
      ],
    };
    const signal = new AbortController().signal;
    for (const profile of ["CaseB", "caseb"]) {
      serve(() => ({
        echo: {
          value: "dGV4dA==",
          mediaType: `TEXT/PLAIN; PROFILE="${profile}"; CHARSET="ISO-8859-1"`,
        },
      }));
      const result = await executeOgcProcess(process, {}, signal);
      if (result.kind !== "results") throw Error("Expected results");
      assert.equal(result.outputs[0].encoding, profile === "CaseB" ? "base64" : undefined);
      assert.equal(
        await (await downloadOgcProcessOutput(result.outputs[0], signal)).text(),
        profile === "CaseB" ? "text" : "dGV4dA==",
      );
    }
  }
});

test("invalid base64 errors are localized and valid padded or whitespace encodings download", async () => {
  const signal = new AbortController().signal;
  await assert.rejects(
    downloadOgcProcessOutput({ id: "bad", value: "!bad!", encoding: "base64" }, signal),
    { code: "invalidBase64" },
  );
  for (const value of ["dGV4dA==", " dG\nV4dA==\t", "dGV4dA"]) {
    assert.equal(
      await (
        await downloadOgcProcessOutput({ id: "ok", value, encoding: "base64" }, signal)
      ).text(),
      "text",
    );
  }
});

test("nonnullable JSON null defaults are omitted while explicit nullable defaults survive", async () => {
  const process = await processDescription();
  process.inputs = {
    object: { schema: { type: "object", default: null }, minOccurs: 0 },
    array: { schema: { type: "array", default: null }, minOccurs: 0 },
    nullable: { schema: { type: ["object", "null"], default: null }, minOccurs: 0 },
  };
  const defaults = ogcProcessInputDefaults(process);
  assert.deepEqual(defaults, { nullable: "null" });
  assert.deepEqual(parseOgcProcessInputs(process, defaults), { nullable: null });
});

test("an unavailable process description is not repeatedly fetched while monitoring", async () => {
  let reads = 0;
  let descriptions = 0;
  serve((url) => {
    if (url.includes("/results")) return { echo: 1 };
    if (url.includes("/processes/")) {
      descriptions++;
      return new Response(null, { status: 404 });
    }
    return { status: reads++ < 2 ? "running" : "successful", processID: "hello-world" };
  });
  assert.deepEqual(
    await monitorOgcProcessJob("https://example.org/api/jobs/late", new AbortController().signal),
    [{ id: "echo", value: 1 }],
  );
  assert.equal(descriptions, 1);
});

test("incompatible primitive null defaults are omitted while nullable JSON defaults survive", async () => {
  const process = await processDescription();
  process.inputs.name.schema = { type: "string", default: null };
  process.inputs.nullable = { schema: { type: ["string", "null"], default: null }, minOccurs: 0 };
  const defaults = ogcProcessInputDefaults(process);
  assert.equal(Object.hasOwn(defaults, "name"), false);
  assert.equal(defaults.nullable, "null");
  assert.equal(parseOgcProcessInputs(process, defaults, false).nullable, null);
});

test("empty accepted responses preserve the job before any status request", async () => {
  const process = await processDescription();
  const calls = serve(
    () =>
      new Response(null, {
        status: 202,
        headers: { Location: "/api/jobs/accepted", "Retry-After": "3" },
      }),
  );
  const result = await executeOgcProcess(
    process,
    { name: "GeoLibre" },
    new AbortController().signal,
    true,
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init?.method, "POST");
  assert.equal(calls[0].init?.redirect, "error");
  assert.equal(result.kind, "job");
  if (result.kind !== "job") return;
  assert.equal(new URL(result.job.url).pathname, "/api/jobs/accepted");
  assert.equal(result.job.status, "accepted");
  assert.equal(result.job.retryAfterMs, 3000);
  assert.deepEqual(result.job.outputIds, Object.keys(process.outputs));
});

test("invalid optional Location headers preserve outputs and usable monitor or body links", async () => {
  const process = await processDescription();
  const signal = new AbortController().signal;
  serve(
    () =>
      new Response(JSON.stringify({ echo: "Done" }), {
        headers: {
          "Content-Type": "application/json",
          Location: "http://[",
          Link: "</api/jobs/retained>; rel=monitor",
        },
      }),
  );
  const sync = await executeOgcProcess(process, { name: "GeoLibre" }, signal);
  assert.equal(sync.kind, "results");
  if (sync.kind !== "results") return;
  assert.equal(sync.outputs[0].value, "Done");
  assert.equal(new URL(sync.job!.url).pathname, "/api/jobs/retained");
  serve(
    () =>
      new Response(
        JSON.stringify({
          jobID: "one",
          status: "accepted",
          links: [{ rel: "status", href: "/api/jobs/one" }],
        }),
        {
          status: 202,
          headers: {
            "Content-Type": "application/json",
            Location: "http://[",
          },
        },
      ),
  );
  const asyncJob = await executeOgcProcess(process, { name: "GeoLibre" }, signal);
  assert.equal(asyncJob.kind, "job");
  if (asyncJob.kind === "job") assert.equal(new URL(asyncJob.job.url).pathname, "/api/jobs/one");
});

test("synchronous monitor links retain job routing without changing successful outputs", async () => {
  const process = await processDescription();
  const signal = new AbortController().signal;
  for (const location of [undefined, "/api/jobs/location"]) {
    serve(
      () =>
        new Response(JSON.stringify({ echo: "Done" }), {
          headers: {
            "Content-Type": "application/json",
            Link: '<https://other.example/a,b>; title="a,b; rel=monitor"; rel="other", <ftp://invalid/job>; rel=monitor, <../jobs/retained>; title="a,b; rel=other"; rel="alternate monitor"',
            ...(location ? { Location: location } : {}),
          },
        }),
    );
    const result = await executeOgcProcess(process, { name: "GeoLibre" }, signal);
    assert.equal(result.kind, "results");
    if (result.kind !== "results") return;
    assert.equal(new URL(result.job!.url).pathname, location ?? "/api/processes/jobs/retained");
    assert.equal(new URL(result.job!.url).searchParams.get("token"), "secret");
    assert.equal(result.outputs[0].value, "Done");
  }
});

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

test("Core output identifiers are not reserved by legacy result envelopes", async () => {
  const process = await processDescription();
  process.outputs = { outputs: {}, stats: {}, type: {} };
  for (const value of [{ type: "FeatureCollection", features: [] }, [{ id: "nested", value: 5 }]]) {
    serve(() => ({ outputs: { value, mediaType: "application/json" }, stats: 3, type: "Feature" }));
    const result = await executeOgcProcess(process, {}, new AbortController().signal);
    assert.equal(result.kind, "results");
    if (result.kind !== "results") throw Error("Expected results");
    assert.deepEqual(result.outputs, [
      { id: "outputs", value, mediaType: "application/json" },
      { id: "stats", value: 3 },
      { id: "type", value: "Feature" },
    ]);
  }
  serve(() => ({ outputs: [{ id: "nested", value: 5 }] }));
  const result = await executeOgcProcess(process, {}, new AbortController().signal);
  if (result.kind !== "results") throw Error("Expected results");
  assert.deepEqual(result.outputs, [{ id: "outputs", value: [{ id: "nested", value: 5 }] }]);
});

test("catalog and completed execution links use the document retrieval context", async () => {
  serve((url, init) => {
    const path = new URL(url).pathname;
    if (init?.method === "POST")
      return new Response(
        JSON.stringify({
          jobID: "j1",
          status: "successful",
          links: [{ rel: "results", href: "../../jobs/j1/results" }],
        }),
        { status: 201, headers: { "Content-Type": "application/json", Location: "/api/jobs/j1" } },
      );
    if (path.endsWith("/results")) return { result: 7 };
    const value = {
      ...description(),
      id: "p",
      links: [
        { rel: "self", href: "./processes/p" },
        { rel: "http://www.opengis.net/def/rel/ogc/1.0/execute", href: "./processes/p/execution" },
      ],
    };
    return { processes: [value] };
  });
  const signal = new AbortController().signal;
  const [process] = await discoverOgcProcesses(
    "https://example.org/api/processes?token=secret&page=2",
    signal,
  );
  assert.equal(new URL(process.url).pathname, "/api/processes/p");
  const result = await executeOgcProcess(process, {}, signal);
  assert.equal(result.kind, "job");
  if (result.kind !== "job") throw Error("Expected job");
  assert.equal(new URL(result.job.resultsUrl).pathname, "/api/jobs/j1/results");
  assert.deepEqual(await monitorOgcProcessJob(result.job, signal), [{ id: "result", value: 7 }]);
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
  assert.ok(calls.every(({ url }) => new URL(url).searchParams.get("f") === "json"));
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
    { id: "echo", value: "Hello GeoLibre!", mediaType: "application/json" },
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
