import assert from "node:assert/strict";
import test from "node:test";
import {
  asFetchError,
  fetchNativeWithWebviewFallback,
} from "../apps/geolibre-desktop/src/lib/native-fetch-fallback";

/** The signal the webview retry was handed, for a given native failure. */
async function retrySignalFor(nativeError: string): Promise<AbortSignal | undefined> {
  let received: AbortSignal | undefined;
  await fetchNativeWithWebviewFallback(
    async () => {
      throw nativeError;
    },
    async (signal) => {
      received = signal;
      return "webview";
    },
  );
  return received;
}

// `invoke` rejects with the Rust command's string, as these do.
const NATIVE_404 = "Request failed with status 404 Not Found";
const NATIVE_TIMEOUT =
  "Request failed: error sending request for url (https://sdi.example.it/wms): operation timed out";
const NATIVE_SSRF = "Requests to private or loopback addresses are blocked";
const WEBVIEW_NETWORK = new TypeError("Failed to fetch");

function counted<T>(outcome: () => Promise<T>) {
  let calls = 0;
  return {
    run: () => {
      calls += 1;
      return outcome();
    },
    calls: () => calls,
  };
}

test("returns the native bytes without touching the webview", async () => {
  const webview = counted(async () => "webview");
  assert.equal(await fetchNativeWithWebviewFallback(async () => "native", webview.run), "native");
  assert.equal(webview.calls(), 0);
});

test("a native HTTP error status is thrown as is, with no webview retry", async () => {
  // The reported case: the server answered 404, and the webview's CORS-blind
  // second attempt turned it into "Failed to fetch" with a second
  // Diagnostics entry.
  const webview = counted(async () => {
    throw WEBVIEW_NETWORK;
  });
  await assert.rejects(
    fetchNativeWithWebviewFallback(async () => {
      throw NATIVE_404;
    }, webview.run),
    (error: unknown) => error instanceof Error && error.message === NATIVE_404,
  );
  assert.equal(webview.calls(), 0);
});

test("a 5xx is the server's answer too, so it is not asked again", async () => {
  const webview = counted(async () => "webview");
  await assert.rejects(
    fetchNativeWithWebviewFallback(async () => {
      throw "Request failed with status 503 Service Unavailable";
    }, webview.run),
    /status 503/,
  );
  assert.equal(webview.calls(), 0);
});

test("a 403 may be the native user agent being refused, so the webview tries", async () => {
  const native403 = "Request failed with status 403 Forbidden";
  assert.equal(
    await fetchNativeWithWebviewFallback(
      async () => {
        throw native403;
      },
      async () => "webview",
    ),
    "webview",
  );
  // And when the webview cannot do better, the 403 is what the caller sees.
  await assert.rejects(
    fetchNativeWithWebviewFallback(
      async () => {
        throw native403;
      },
      async () => {
        throw WEBVIEW_NETWORK;
      },
    ),
    (error: unknown) => error instanceof Error && error.message === native403,
  );
});

test("a native failure without a status still falls back, and success wins", async () => {
  // A loopback host the SSRF guard refuses is one the webview may reach.
  const result = await fetchNativeWithWebviewFallback(
    async () => {
      throw NATIVE_SSRF;
    },
    async () => "webview",
  );
  assert.equal(result, "webview");
});

test("when both fail, the native reason is thrown instead of the webview's", async () => {
  await assert.rejects(
    fetchNativeWithWebviewFallback(
      async () => {
        throw NATIVE_TIMEOUT;
      },
      async () => {
        throw WEBVIEW_NETWORK;
      },
    ),
    (error: unknown) => error instanceof Error && error.message === NATIVE_TIMEOUT,
  );
});

test("a webview HTTP status beats a native failure that never reached the server", async () => {
  const webview404 = new Error("HTTP 404 Not Found");
  await assert.rejects(
    fetchNativeWithWebviewFallback(
      async () => {
        throw NATIVE_SSRF;
      },
      async () => {
        throw webview404;
      },
    ),
    (error: unknown) => error === webview404,
  );
});

test("asFetchError keeps Errors and wraps the strings invoke rejects with", () => {
  const original = new Error("boom");
  assert.equal(asFetchError(original), original);
  const wrapped = asFetchError(NATIVE_404);
  assert.ok(wrapped instanceof Error);
  assert.equal(wrapped.message, NATIVE_404);
  assert.equal(wrapped.cause, NATIVE_404);
});

test("the webview retry is time-boxed only when the native client never reached the host", async () => {
  // An unreachable host cost 25 s on Windows and over two minutes on
  // WebKitGTK while the webview waited out its own connect timeout.
  for (const unreachable of [
    NATIVE_TIMEOUT,
    "Request failed: error sending request for url (https://sdi.example.it/)",
    "Could not resolve host sdi.example.it: failed to lookup address information",
  ]) {
    const signal = await retrySignalFor(unreachable);
    assert.ok(signal instanceof AbortSignal, unreachable);
  }
  // A loopback host the SSRF guard refused was never attempted natively, so
  // the webview gets its full time.
  assert.equal(await retrySignalFor(NATIVE_SSRF), undefined);
});
