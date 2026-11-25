import "./helpers/dom";
import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
const { inspectNativeMbtilesSource, extractNativeMbtilesPackage } =
  await import("../apps/geolibre-desktop/src/lib/native-mbtiles-extraction");

afterEach(() => {
  clearMocks();
  Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
});

it("cancels a preparation that resolves after its caller aborts, without starting SQLite", async () => {
  let prepared!: (value: string) => void;
  const pending = new Promise<string>((resolve) => {
    prepared = resolve;
  });
  const commands: string[] = [];
  mockIPC((command) => {
    commands.push(command);
    if (command === "prepare_native_offline_extraction") return pending;
    return undefined;
  });
  const controller = new AbortController();
  const operation = inspectNativeMbtilesSource("/data/source.mbtiles", controller.signal);
  controller.abort();
  prepared("extract-1");
  await assert.rejects(operation, { name: "AbortError" });
  assert.deepEqual(commands, [
    "prepare_native_offline_extraction",
    "cancel_native_offline_extraction",
  ]);
});

it("cancels running SQLite on abort and releases a failed inspection", async () => {
  const commands: string[] = [];
  let reject!: (error: Error) => void;
  let started!: () => void;
  const active = new Promise<void>((resolve) => {
    started = resolve;
  });
  const pending = new Promise<never>((_resolve, fail) => {
    reject = fail;
  });
  mockIPC((command) => {
    commands.push(command);
    if (command === "prepare_native_offline_extraction") return "extract-2";
    if (command === "inspect_native_mbtiles_source") {
      started();
      return pending;
    }
    return undefined;
  });
  const controller = new AbortController();
  const operation = inspectNativeMbtilesSource("/data/source.mbtiles", controller.signal);
  await active;
  controller.abort();
  reject(new Error("SQLite interrupted"));
  await assert.rejects(operation, { name: "AbortError" });
  assert.equal(
    commands.filter((command) => command === "cancel_native_offline_extraction").length,
    2,
  );
});

it("sends a path and bounded Unicode name without reading or transferring archive bytes", async () => {
  const calls: Array<{ command: string; args: unknown }> = [];
  const result = {
    package: { id: "pkg-1" },
    tileCount: 42,
    payloadBytes: 100,
    tileFormat: "png",
    sourceLayers: [],
  };
  mockIPC((command, args) => {
    calls.push({ command, args });
    if (command === "prepare_native_offline_extraction") return "extract-3";
    if (command === "extract_native_mbtiles_package") return result;
    return undefined;
  });
  const options = {
    bbox: [-123, 37, -122, 38] as [number, number, number, number],
    minZoom: 19,
    maxZoom: 19,
  };
  assert.deepEqual(
    await extractNativeMbtilesPackage(
      "/data/source.mbtiles",
      "🗺".repeat(300),
      options,
      null,
      new AbortController().signal,
    ),
    result,
  );
  assert.deepEqual(calls, [
    { command: "prepare_native_offline_extraction", args: {} },
    {
      command: "extract_native_mbtiles_package",
      args: {
        jobId: "extract-3",
        path: "/data/source.mbtiles",
        name: "🗺".repeat(128),
        options,
        flavor: null,
      },
    },
    { command: "cancel_native_offline_extraction", args: { jobId: "extract-3" } },
  ]);
});

it("filters progress by job and cancellation without misreporting an already committed package", async () => {
  const controller = new AbortController();
  let handler!: (event: {
    payload: { jobId: string; phase: "copying"; tileCount: number; payloadBytes: number };
  }) => void;
  const progress: number[] = [];
  const commands: string[] = [];
  const result = {
    package: { id: "pkg-committed" },
    tileCount: 42,
    payloadBytes: 100,
    tileFormat: "png",
    sourceLayers: [],
  };
  mockIPC((command) => {
    commands.push(command);
    if (command === "prepare_native_offline_extraction") return "extract-4";
    if (command === "plugin:event|listen") return 7;
    if (command === "extract_native_mbtiles_package") {
      handler({
        payload: { jobId: "other-job", phase: "copying", tileCount: 99, payloadBytes: 1 },
      });
      handler({ payload: { jobId: "extract-4", phase: "copying", tileCount: 1, payloadBytes: 1 } });
      controller.abort();
      handler({ payload: { jobId: "extract-4", phase: "copying", tileCount: 2, payloadBytes: 2 } });
      return result;
    }
    return undefined;
  });
  Reflect.set(
    Reflect.get(window, "__TAURI_INTERNALS__"),
    "transformCallback",
    (callback: typeof handler) => {
      handler = callback;
      return 1;
    },
  );
  Reflect.set(window, "__TAURI_EVENT_PLUGIN_INTERNALS__", { unregisterListener: () => {} });
  try {
    assert.deepEqual(
      await extractNativeMbtilesPackage(
        "/data/source.mbtiles",
        "Berkeley",
        { bbox: [-123, 37, -122, 38], minZoom: 19, maxZoom: 19 },
        null,
        controller.signal,
        (event) => progress.push(event.tileCount),
      ),
      result,
    );
    assert.deepEqual(progress, [1]);
    assert.ok(commands.includes("plugin:event|unlisten"));
  } finally {
    Reflect.deleteProperty(window, "__TAURI_EVENT_PLUGIN_INTERNALS__");
  }
});

it("does not reserve a job for an already-aborted signal without modern signal helpers", async () => {
  let called = false;
  mockIPC(() => {
    called = true;
  });
  const controller = new AbortController();
  Reflect.set(controller.signal, "throwIfAborted", undefined);
  Reflect.defineProperty(controller.signal, "reason", { value: undefined });
  controller.abort();
  await assert.rejects(inspectNativeMbtilesSource("/data/source.mbtiles", controller.signal), {
    name: "AbortError",
  });
  assert.equal(called, false);
});

it("normalizes control characters and supplies a nonblank name before native validation", async () => {
  const names: string[] = [];
  mockIPC((command, args) => {
    if (command === "prepare_native_offline_extraction") return "extract-name";
    if (command === "extract_native_mbtiles_package") names.push(Reflect.get(args ?? {}, "name"));
    return undefined;
  });
  for (const name of [" North\nCounty\u0085 ", "\u0000\n\t", "\n" + "🗺".repeat(129)])
    await extractNativeMbtilesPackage(
      "/data/source.mbtiles",
      name,
      { bbox: [-123, 37, -122, 38], minZoom: 19, maxZoom: 19 },
      null,
      new AbortController().signal,
    );
  assert.deepEqual(names, ["North County", "Offline MBTiles", "🗺".repeat(128)]);
});

it("observes rejected async listener cleanup without losing the committed result or cancellation", async (context) => {
  const commands: string[] = [];
  const failure = new Error("Unlisten IPC failed");
  const warnings = context.mock.method(console, "warn", () => {});
  const result = { package: { id: "pkg-committed" } };
  mockIPC((command) => {
    commands.push(command);
    if (command === "prepare_native_offline_extraction") return "extract-cleanup";
    if (command === "plugin:event|listen") return 8;
    if (command === "plugin:event|unlisten") return Promise.reject(failure);
    if (command === "extract_native_mbtiles_package") return result;
    return undefined;
  });
  Reflect.set(window, "__TAURI_EVENT_PLUGIN_INTERNALS__", { unregisterListener: () => {} });
  try {
    assert.deepEqual(
      await extractNativeMbtilesPackage(
        "/data/source.mbtiles",
        "Berkeley",
        { bbox: [-123, 37, -122, 38], minZoom: 19, maxZoom: 19 },
        null,
        new AbortController().signal,
        () => {},
      ),
      result,
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.ok(commands.includes("cancel_native_offline_extraction"));
    assert.equal(warnings.mock.calls.length, 1);
    assert.equal(warnings.mock.calls[0].arguments[1], failure);
  } finally {
    Reflect.deleteProperty(window, "__TAURI_EVENT_PLUGIN_INTERNALS__");
    warnings.mock.restore();
  }
});
