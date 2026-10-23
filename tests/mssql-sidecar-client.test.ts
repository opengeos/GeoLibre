import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  MssqlSessionExpiredError,
  MssqlWriteRejectedError,
  readMssqlTable,
  setSidecarFetch,
  writeMssqlTable,
} from "../packages/processing/src";

afterEach(() => {
  setSidecarFetch(null);
});

describe("MSSQL sidecar client errors", () => {
  it("classifies an expired session response", async () => {
    let requestedUrl = "";
    let requestedHeaders: Headers | undefined;
    setSidecarFetch((async (input: RequestInfo | URL, init?: RequestInit) => {
      requestedUrl = String(input);
      requestedHeaders = new Headers(init?.headers);
      return new Response(
        JSON.stringify({ detail: "Unknown or expired SQL Server session; reconnect." }),
        { status: 410 },
      );
    }) as typeof fetch);

    await assert.rejects(
      readMssqlTable({ session_id: "expired", table: "parcels" }),
      (error: unknown) => {
        assert.ok(error instanceof MssqlSessionExpiredError);
        assert.equal(error.message, "Unknown or expired SQL Server session; reconnect.");
        return true;
      },
    );
    assert.match(requestedUrl, /\/mssql\/read$/);
    assert.equal(requestedHeaders?.get("x-geolibre-expected-status"), "410");
  });

  it("keeps other write errors as ordinary errors", async () => {
    setSidecarFetch(
      (async () =>
        new Response(JSON.stringify({ detail: "boom" }), { status: 400 })) as typeof fetch,
    );

    await assert.rejects(
      writeMssqlTable({
        session_id: "live",
        table: "parcels",
        geojson: { type: "FeatureCollection", features: [] },
      }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.ok(!(error instanceof MssqlSessionExpiredError));
        assert.ok(!(error instanceof MssqlWriteRejectedError));
        return true;
      },
    );
  });
  it("classifies an explicit rollback response as a definite write rejection", async () => {
    setSidecarFetch(
      (async () =>
        new Response(JSON.stringify({ detail: "constraint violation", rolled_back: true }), {
          status: 400,
        })) as typeof fetch,
    );

    await assert.rejects(
      writeMssqlTable({
        session_id: "live",
        table: "parcels",
        geojson: { type: "FeatureCollection", features: [] },
      }),
      (error: unknown) => {
        assert.ok(error instanceof MssqlWriteRejectedError);
        assert.equal(error.message, "constraint violation");
        return true;
      },
    );
  });
});
