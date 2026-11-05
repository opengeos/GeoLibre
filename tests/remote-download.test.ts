import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createRemoteDownload,
  createWriteFileToFolder,
  MAX_WRITE_FILE_BYTES,
  normalizeBinaryData,
  type RemoteDownloadProgress,
} from "../apps/geolibre-desktop/src/lib/remote-download";

type Invoke = Parameters<typeof createRemoteDownload>[0];

interface FakeChannel {
  onmessage: (message: RemoteDownloadProgress) => void;
}

/** A fake Tauri host: records invokes and lets the test drive the download. */
function fakeHost() {
  const calls: { cmd: string; args: Record<string, unknown> }[] = [];
  let channel: FakeChannel | null = null;
  let finish: (value: unknown) => void = () => undefined;
  const invoke = (async (cmd: string, args?: Record<string, unknown>) => {
    calls.push({ cmd, args: args ?? {} });
    if (cmd === "download_remote_file") {
      return new Promise<unknown>((resolve) => {
        finish = resolve;
      });
    }
    if (cmd === "take_cached_download") return new Uint8Array([1, 2, 3]).buffer;
    return undefined;
  }) as Invoke;
  const download = createRemoteDownload(invoke, () => {
    channel = { onmessage: () => undefined };
    return channel;
  });
  return {
    calls,
    download,
    progress: (message: RemoteDownloadProgress) => channel?.onmessage(message),
    finish: (value: unknown) => finish(value),
  };
}

describe("native remote download glue", () => {
  it("sends headers to the command and reads a memory download back once", async () => {
    const host = fakeHost();
    const seen: [number, number | null][] = [];
    const pending = host.download("https://example.com/a.h5", {
      fileName: "a.h5",
      target: "memory",
      headers: { Authorization: "Bearer t" },
      onProgress: (received, total) => seen.push([received, total]),
    });
    await Promise.resolve();
    const request = host.calls[0].args.request as Record<string, unknown>;
    assert.deepEqual(request.headers, [["Authorization", "Bearer t"]]);
    assert.equal(request.save, false);
    host.progress({ received: 0, total: 3 });
    host.progress({ received: 3, total: 3 });
    host.finish({ path: null, size: 3 });
    const result = await pending;
    assert.equal(result?.data?.byteLength, 3);
    assert.deepEqual(seen, [
      [0, 3],
      [3, 3],
    ]);
    assert.equal(host.calls[1].cmd, "take_cached_download");
    assert.equal(host.calls[1].args.requestId, host.calls[0].args.requestId);
  });

  it("passes a picked folder's id and returns the saved path", async () => {
    const host = fakeHost();
    const pending = host.download("https://example.com/B04.tif", {
      fileName: "B04.tif",
      target: "folder",
      folderId: "folder-1",
    });
    await Promise.resolve();
    const request = host.calls[0].args.request as Record<string, unknown>;
    assert.equal(request.folderId, "folder-1");
    assert.equal(request.save, false);
    host.finish({ path: "/data/hls/B04.tif", size: 9 });
    assert.deepEqual(await pending, { path: "/data/hls/B04.tif", size: 9, data: null });
    assert.equal(host.calls.length, 1);
  });

  it("rejects a folder download without a folder id", async () => {
    const host = fakeHost();
    await assert.rejects(
      host.download("https://example.com/a.tif", {
        fileName: "a.tif",
        target: "folder",
      } as unknown as Parameters<typeof host.download>[1]),
      /folderId/,
    );
    assert.equal(host.calls.length, 0);
  });

  it("resolves null when the save dialog is cancelled", async () => {
    const host = fakeHost();
    const pending = host.download("https://example.com/a.h5", { fileName: "a.h5", target: "save" });
    await Promise.resolve();
    host.finish(null);
    assert.equal(await pending, null);
    assert.equal(host.calls.length, 1);
  });

  it("rejects at once on abort and cancels natively once Rust registers", async () => {
    const host = fakeHost();
    const controller = new AbortController();
    const pending = host.download("https://example.com/a.h5", {
      fileName: "a.h5",
      target: "save",
      signal: controller.signal,
    });
    await Promise.resolve();
    // Still in the save dialog: nothing to cancel natively yet.
    controller.abort(new Error("stop"));
    await assert.rejects(pending, /stop/);
    assert.equal(host.calls.filter((c) => c.cmd === "cancel_remote_download").length, 0);
    // The user then picks a path; the first progress message registers the download.
    host.progress({ received: 0, total: null });
    assert.equal(host.calls.filter((c) => c.cmd === "cancel_remote_download").length, 1);
  });
});

describe("native write file to folder glue", () => {
  it("normalizes strings, Blobs, ArrayBuffers, and Uint8Arrays", async () => {
    const asList = async (data: Parameters<typeof normalizeBinaryData>[0]) =>
      Array.from(await normalizeBinaryData(data));
    assert.deepEqual(await asList("hello"), [104, 101, 108, 108, 111]);
    assert.deepEqual(await asList(new Uint8Array([1, 2, 3])), [1, 2, 3]);
    assert.deepEqual(await asList(new Uint8Array([4, 5, 6]).buffer), [4, 5, 6]);
    assert.deepEqual(await asList(new Blob(["world"])), [119, 111, 114, 108, 100]);
    // A view sends only its own bytes, and a later change to the caller's buffer is not sent.
    const whole = new Uint8Array([9, 8, 7, 6]);
    const pending = normalizeBinaryData(whole.subarray(1, 3));
    whole.fill(0);
    assert.deepEqual(Array.from(await pending), [8, 7]);
    await assert.rejects(
      normalizeBinaryData(123 as unknown as string),
      /Unsupported data type for writeFileToFolder/,
    );
  });

  it("rejects data exceeding MAX_WRITE_FILE_BYTES", async () => {
    const oversizedString = "a".repeat(MAX_WRITE_FILE_BYTES + 1);
    await assert.rejects(
      normalizeBinaryData(oversizedString),
      /writeFileToFolder data exceeds the 50 MiB limit/,
    );

    const fakeBlob = { size: MAX_WRITE_FILE_BYTES + 1 } as Blob;
    Object.setPrototypeOf(fakeBlob, Blob.prototype);
    await assert.rejects(
      normalizeBinaryData(fakeBlob),
      /writeFileToFolder data exceeds the 50 MiB limit/,
    );

    const fakeBuffer = new ArrayBuffer(MAX_WRITE_FILE_BYTES + 1);
    await assert.rejects(
      normalizeBinaryData(fakeBuffer),
      /writeFileToFolder data exceeds the 50 MiB limit/,
    );
  });

  it("sends the file as a raw body, with its folder and name as encoded headers", async () => {
    const calls: { cmd: string; args: unknown; headers?: Record<string, string> }[] = [];
    const invoke = (async (
      cmd: string,
      args?: unknown,
      options?: { headers?: Record<string, string> },
    ) => {
      calls.push({ cmd, args, headers: options?.headers });
      if (cmd === "write_file_to_folder") {
        return { path: "/picked/folder/test.geojson", size: 5 };
      }
      return undefined;
    }) as Invoke;

    const writer = createWriteFileToFolder(invoke);
    const result = await writer("folder-1", "test.geojson", "hello");

    assert.deepEqual(result, { path: "/picked/folder/test.geojson", size: 5 });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].cmd, "write_file_to_folder");
    assert.ok(calls[0].args instanceof Uint8Array, "the body is raw bytes, not a JSON list");
    assert.deepEqual(Array.from(calls[0].args), [104, 101, 108, 108, 111]);
    assert.deepEqual(calls[0].headers, {
      "x-folder-id": "folder-1",
      "x-file-name": "test.geojson",
    });

    await writer("folder-1", "春 map.geojson", "hello");
    assert.equal(calls[1].headers?.["x-file-name"], "%E6%98%A5%20map.geojson");
    assert.equal("x-subfolder" in (calls[1].headers ?? {}), false);

    await writer("folder-1", "test.geojson", "hello", { subfolder: "run 春" });
    assert.equal(calls[2].headers?.["x-subfolder"], "run%20%E6%98%A5");

    // Empty goes to the host to be refused, rather than quietly writing to the folder root.
    await writer("folder-1", "test.geojson", "hello", { subfolder: "" });
    assert.equal(calls[3].headers?.["x-subfolder"], "");
  });

  it("rejects when folderId or fileName is missing or invalid", async () => {
    const invoke = (async () => undefined) as Invoke;
    const writer = createWriteFileToFolder(invoke);

    await assert.rejects(
      writer("", "test.geojson", "data"),
      /writeFileToFolder requires a valid folderId/,
    );
    await assert.rejects(
      writer(null as unknown as string, "test.geojson", "data"),
      /writeFileToFolder requires a valid folderId/,
    );
    await assert.rejects(
      writer("folder-1", "", "data"),
      /writeFileToFolder requires a non-empty fileName/,
    );
    await assert.rejects(
      writer("folder-1", null as unknown as string, "data"),
      /writeFileToFolder requires a non-empty fileName/,
    );
  });
});
