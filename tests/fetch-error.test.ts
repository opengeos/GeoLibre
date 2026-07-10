import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  classifyFetchFailure,
  fetchFailureMessage,
} from "../apps/geolibre-desktop/src/lib/fetch-error";

describe("classifyFetchFailure", () => {
  it("classifies an AbortError as an abort with no hint", () => {
    const error = new DOMException("aborted", "AbortError");
    const result = classifyFetchFailure(error);
    assert.equal(result.kind, "abort");
    assert.equal(result.hint, null);
  });

  it("classifies a TimeoutError DOMException as a timeout with a hint", () => {
    const error = new DOMException("timed out", "TimeoutError");
    const result = classifyFetchFailure(error);
    assert.equal(result.kind, "timeout");
    assert.ok(result.hint && result.hint.length > 0);
  });

  it("classifies a wrapped 'timed out' message as a timeout", () => {
    const result = classifyFetchFailure(new Error("The request timed out."));
    assert.equal(result.kind, "timeout");
  });

  it("classifies the browser 'Failed to fetch' TypeError as network/TLS/CORS", () => {
    const result = classifyFetchFailure(new TypeError("Failed to fetch"));
    assert.equal(result.kind, "network");
    assert.equal(result.label, "network/TLS/CORS");
    assert.ok(result.hint?.includes("CORS"));
  });

  it("classifies the WebKit 'Load failed' TypeError as network", () => {
    assert.equal(classifyFetchFailure(new TypeError("Load failed")).kind, "network");
  });

  it("classifies a native reqwest TLS certificate error string as network", () => {
    const result = classifyFetchFailure(
      "Request failed: error sending request: invalid peer certificate",
    );
    assert.equal(result.kind, "network");
    assert.ok(result.hint);
  });

  it("classifies a native DNS/connection error string as network", () => {
    assert.equal(
      classifyFetchFailure("Request failed: dns error: failed to lookup host")
        .kind,
      "network",
    );
    assert.equal(
      classifyFetchFailure("Request failed: connection refused").kind,
      "network",
    );
  });

  it("leaves an unrecognized error as unknown with no hint", () => {
    const result = classifyFetchFailure(
      new Error("Request failed with status 500"),
    );
    assert.equal(result.kind, "unknown");
    assert.equal(result.hint, null);
  });
});

describe("fetchFailureMessage", () => {
  it("returns the classified hint for a network failure", () => {
    const message = fetchFailureMessage(
      new TypeError("Failed to fetch"),
      "fallback",
    );
    assert.ok(message.includes("CORS"));
  });

  it("returns the error's own message when it is not a recognized failure", () => {
    const message = fetchFailureMessage(
      new Error("The WFS service returned an error."),
      "fallback",
    );
    assert.equal(message, "The WFS service returned an error.");
  });

  it("falls back when the error carries no message", () => {
    assert.equal(fetchFailureMessage({}, "fallback"), "fallback");
  });
});
