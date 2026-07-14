import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { classifyFetchFailure } from "../apps/geolibre-desktop/src/lib/fetch-error";

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
    // The browser hint keeps the CORS / "try the desktop app" advice.
    assert.ok(result.hint?.includes("CORS"));
    assert.ok(result.hint?.includes("desktop app"));
  });

  it("classifies the WebKit 'Load failed' TypeError as network", () => {
    assert.equal(classifyFetchFailure(new TypeError("Load failed")).kind, "network");
  });

  it("classifies a native reqwest TLS certificate error string as network without the CORS advice", () => {
    const result = classifyFetchFailure(
      "Request failed: error sending request: invalid peer certificate",
    );
    assert.equal(result.kind, "network");
    assert.equal(result.label, "network");
    // The native path already runs in the desktop app, so its hint drops the
    // CORS / "try the desktop app" sentence.
    assert.ok(result.hint);
    assert.ok(!result.hint?.includes("CORS"));
    assert.ok(!result.hint?.includes("desktop app"));
  });

  it("classifies native DNS/connection error strings as network", () => {
    assert.equal(
      classifyFetchFailure("Request failed: dns error: failed to lookup host")
        .kind,
      "network",
    );
    assert.equal(
      classifyFetchFailure("Request failed: connection refused (os error 111)")
        .kind,
      "network",
    );
  });

  it("does not misclassify a network failure whose URL has a 'timeout' query param", () => {
    // The real cause is a refused connection; `timeout=30` is only a URL param,
    // so stripping the embedded URL must keep this classified as network.
    const result = classifyFetchFailure(
      "error sending request for url (https://host/wfs?timeout=30): connection refused",
    );
    assert.equal(result.kind, "network");
  });

  it("still classifies a genuine native timeout message", () => {
    assert.equal(
      classifyFetchFailure("error sending request: operation timed out").kind,
      "timeout",
    );
  });

  it("does not misclassify a non-network error whose URL contains a network word", () => {
    // "connect" appears only as a URL path substring, not as a real error cause,
    // so the tightened phrase matching must leave it unclassified.
    const result = classifyFetchFailure(
      "error decoding response body for url (https://host/api/connect): invalid json",
    );
    assert.equal(result.kind, "unknown");
    assert.equal(result.hint, null);
  });

  it("leaves an unrecognized error as unknown with no hint", () => {
    const result = classifyFetchFailure(
      new Error("Request failed with status 500"),
    );
    assert.equal(result.kind, "unknown");
    assert.equal(result.hint, null);
  });

  it("reads the message from a non-Error, non-DOMException value safely", () => {
    assert.equal(classifyFetchFailure({}).kind, "unknown");
    assert.equal(classifyFetchFailure(undefined).kind, "unknown");
  });
});
