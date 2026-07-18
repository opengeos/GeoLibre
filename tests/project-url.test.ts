import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fetchProjectFromUrl } from "../apps/geolibre-desktop/src/lib/project-url";

const PROJECT_URL = "https://example.com/Test.geolibre.json";

// A serialized project carrying exactly the fields `parseProject` requires
// (version, name, mapView). Kept as a string so the fixture stays decoupled
// from the full `GeoLibreProject` shape.
const VALID_PROJECT_JSON = JSON.stringify({
  version: "1.0",
  name: "Test",
  mapView: { center: [0, 0], zoom: 2, bearing: 0, pitch: 0 },
});

/** A `fetchImpl` that returns the given body with a 200 OK response. */
function okFetch(body: string): typeof fetch {
  return (async () => new Response(body, { status: 200 })) as unknown as typeof fetch;
}

describe("fetchProjectFromUrl", () => {
  it("returns the parsed project on a successful fetch", async () => {
    const project = await fetchProjectFromUrl(PROJECT_URL, {
      fetchImpl: okFetch(VALID_PROJECT_JSON),
    });
    assert.equal(project.name, "Test");
  });

  it("turns a rejected fetch (network/CORS) into a message naming the URL and CORS", async () => {
    // Mimic the bare TypeError a browser throws on a network or CORS failure
    // ("Failed to fetch" / "Load failed") rather than leaking it verbatim.
    const original = new TypeError("Load failed");
    const fetchImpl = (async () => {
      throw original;
    }) as unknown as typeof fetch;

    await assert.rejects(
      () => fetchProjectFromUrl(PROJECT_URL, { fetchImpl }),
      (error: Error) => {
        assert.match(error.message, /Could not fetch the project from/);
        assert.ok(error.message.includes(PROJECT_URL));
        assert.match(error.message, /CORS/);
        // The opaque browser string must not be what the user sees.
        assert.notEqual(error.message, "Load failed");
        // The original error is preserved as `cause` for diagnostics.
        assert.equal(error.cause, original);
        return true;
      },
    );
  });

  it("wraps a network failure even when no signal is provided", async () => {
    // Exercises the `options = {}` default branch, where `signal` is undefined:
    // a non-abort rejection is still wrapped rather than rethrown.
    const fetchImpl = (async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;

    await assert.rejects(
      () => fetchProjectFromUrl(PROJECT_URL, { fetchImpl }),
      (error: Error) => {
        assert.match(error.message, /Could not fetch the project from/);
        assert.notEqual(error.message, "Failed to fetch");
        return true;
      },
    );
  });

  it("wraps a body-streaming failure after a 200 response", async () => {
    // The connection drops mid-stream: text() rejects with the same opaque
    // TypeError, which must get the same network treatment as a failed request.
    const fetchImpl = (async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () => {
        throw new TypeError("Load failed");
      },
    })) as unknown as typeof fetch;

    await assert.rejects(
      () => fetchProjectFromUrl(PROJECT_URL, { fetchImpl }),
      (error: Error) => {
        assert.match(error.message, /Could not fetch the project from/);
        assert.notEqual(error.message, "Load failed");
        return true;
      },
    );
  });

  it("propagates an abort that happens during body streaming", async () => {
    // The signal fires between the 200 response and the finished body read:
    // text() rejects with AbortError, which must propagate untouched.
    const fetchImpl = (async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () => {
        throw new DOMException("Aborted", "AbortError");
      },
    })) as unknown as typeof fetch;

    await assert.rejects(
      () => fetchProjectFromUrl(PROJECT_URL, { fetchImpl }),
      (error: Error) => {
        assert.equal(error.name, "AbortError");
        return true;
      },
    );
  });

  it("omits an empty statusText (HTTP/2) to avoid a dangling period", async () => {
    const fetchImpl = (async () =>
      new Response("Not found", {
        status: 404,
        statusText: "",
      })) as unknown as typeof fetch;

    await assert.rejects(
      () => fetchProjectFromUrl(PROJECT_URL, { fetchImpl }),
      (error: Error) => {
        assert.match(error.message, /with HTTP 404\./);
        assert.doesNotMatch(error.message, /HTTP 404 \./);
        return true;
      },
    );
  });

  it("propagates a caller-initiated abort untouched", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchImpl = (async () => {
      throw new DOMException("Aborted", "AbortError");
    }) as unknown as typeof fetch;

    await assert.rejects(
      () =>
        fetchProjectFromUrl(PROJECT_URL, {
          fetchImpl,
          signal: controller.signal,
        }),
      (error: Error) => {
        assert.equal(error.name, "AbortError");
        return true;
      },
    );
  });

  it("reports a non-2xx response with its status", async () => {
    const fetchImpl = (async () =>
      new Response("Not found", {
        status: 404,
        statusText: "Not Found",
      })) as unknown as typeof fetch;

    await assert.rejects(
      () => fetchProjectFromUrl(PROJECT_URL, { fetchImpl }),
      (error: Error) => {
        assert.match(error.message, /HTTP 404 Not Found/);
        assert.ok(error.message.includes(PROJECT_URL));
        return true;
      },
    );
  });

  it("reports a malformed body as an invalid project rather than a raw SyntaxError", async () => {
    await assert.rejects(
      () =>
        fetchProjectFromUrl(PROJECT_URL, {
          fetchImpl: okFetch("{ this is not json"),
        }),
      (error: Error) => {
        assert.match(error.message, /is not a valid GeoLibre project/);
        assert.ok(error.message.includes(PROJECT_URL));
        return true;
      },
    );
  });

  it("reports a valid-JSON file that is missing required fields", async () => {
    await assert.rejects(
      () =>
        fetchProjectFromUrl(PROJECT_URL, {
          fetchImpl: okFetch(JSON.stringify({ not: "a project" })),
        }),
      (error: Error) => {
        assert.match(error.message, /is not a valid GeoLibre project/);
        // Loosely assert the underlying reason carries through, without
        // hard-coding parseProject's exact wording.
        assert.match(error.message, /missing.*fields/i);
        // parseProject's own "Invalid GeoLibre project:" prefix is stripped so
        // the wrapper does not repeat the noun.
        assert.doesNotMatch(error.message, /\): Invalid GeoLibre project:/);
        return true;
      },
    );
  });
});
