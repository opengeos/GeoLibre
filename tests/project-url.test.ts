import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  fetchProjectFromUrl,
} from "../apps/geolibre-desktop/src/lib/project-url";
import { serializeProject, type GeoLibreProject } from "@geolibre/core";

const PROJECT_URL = "https://example.com/Test.geolibre.json";

function validProject(): GeoLibreProject {
  return {
    version: "1.0",
    name: "Test",
    mapView: { center: [0, 0], zoom: 2, bearing: 0, pitch: 0 },
    basemapStyleUrl: "https://example.com/style.json",
    basemapVisible: true,
    basemapOpacity: 1,
    layers: [],
    styles: {},
  } as unknown as GeoLibreProject;
}

/** A `fetchImpl` that returns the given body with a 200 OK response. */
function okFetch(body: string): typeof fetch {
  return (async () =>
    new Response(body, { status: 200 })) as unknown as typeof fetch;
}

describe("fetchProjectFromUrl", () => {
  it("returns the parsed project on a successful fetch", async () => {
    const project = await fetchProjectFromUrl(PROJECT_URL, {
      fetchImpl: okFetch(serializeProject(validProject())),
    });
    assert.equal(project.name, "Test");
  });

  it("turns a rejected fetch (network/CORS) into a message naming the URL and CORS", async () => {
    // Mimic the bare TypeError a browser throws on a network or CORS failure
    // ("Failed to fetch" / "Load failed") rather than leaking it verbatim.
    const fetchImpl = (async () => {
      throw new TypeError("Load failed");
    }) as unknown as typeof fetch;

    await assert.rejects(
      () => fetchProjectFromUrl(PROJECT_URL, { fetchImpl }),
      (error: Error) => {
        assert.match(error.message, /Could not fetch the project from/);
        assert.ok(error.message.includes(PROJECT_URL));
        assert.match(error.message, /CORS/);
        // The opaque browser string must not be what the user sees.
        assert.notEqual(error.message, "Load failed");
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
        assert.match(error.message, /missing required fields/);
        return true;
      },
    );
  });
});
