import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createRemoteDownload,
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
