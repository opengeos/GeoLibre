import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { uploadProjectToShare } from "../apps/geolibre-desktop/src/lib/share-geolibre";

const PROJECT_DTO = {
  username: "giswqs",
  slug: "my-map",
  projectUrl: "https://share.geolibre.app/giswqs/my-map",
  viewerUrl: "https://viewer.geolibre.app/?url=https://share.geolibre.app/giswqs/my-map.geolibre.json",
  rawJsonUrl: "https://share.geolibre.app/giswqs/my-map.geolibre.json",
};

function fakeFetch(
  status: number,
  body: unknown,
): { fn: typeof fetch; calls: { url: string; init: RequestInit }[] } {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = (async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    } as Response;
  }) as unknown as typeof fetch;
  return { fn, calls };
}

const baseArgs = {
  token: "glb_secrettoken",
  filename: "my-map.geolibre.json",
  content: '{"version":"1.0.0"}',
  visibility: "unlisted" as const,
  baseUrl: "https://share.geolibre.app",
};

describe("uploadProjectToShare", () => {
  it("rejects when no token is provided", async () => {
    await assert.rejects(
      () => uploadProjectToShare({ ...baseArgs, token: "  " }),
      /token/i,
    );
  });

  it("POSTs the project with a bearer token and returns the URLs", async () => {
    const { fn, calls } = fakeFetch(201, { project: PROJECT_DTO });
    const result = await uploadProjectToShare({ ...baseArgs, fetchImpl: fn });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://share.geolibre.app/api/projects");
    assert.equal(calls[0].init.method, "POST");
    const headers = calls[0].init.headers as Record<string, string>;
    assert.equal(headers.Authorization, "Bearer glb_secrettoken");
    assert.equal(headers["Content-Type"], "application/json");
    assert.deepEqual(JSON.parse(calls[0].init.body as string), {
      filename: "my-map.geolibre.json",
      content: '{"version":"1.0.0"}',
      visibility: "unlisted",
    });
    assert.equal(result.projectUrl, PROJECT_DTO.projectUrl);
    assert.equal(result.viewerUrl, PROJECT_DTO.viewerUrl);
    assert.equal(result.rawJsonUrl, PROJECT_DTO.rawJsonUrl);
  });

  it("maps 401 to an invalid-token message", async () => {
    const { fn } = fakeFetch(401, { error: "Unauthorized" });
    await assert.rejects(
      () => uploadProjectToShare({ ...baseArgs, fetchImpl: fn }),
      /invalid or expired/i,
    );
  });

  it("maps 429 to a rate-limit message", async () => {
    const { fn } = fakeFetch(429, { error: "Rate limit exceeded" });
    await assert.rejects(
      () => uploadProjectToShare({ ...baseArgs, fetchImpl: fn }),
      /too many uploads/i,
    );
  });

  it("surfaces the server error message for other failures", async () => {
    const { fn } = fakeFetch(400, { error: "Project schema is invalid." });
    await assert.rejects(
      () => uploadProjectToShare({ ...baseArgs, fetchImpl: fn }),
      /Project schema is invalid\./,
    );
  });

  it("wraps a network failure in a friendly message", async () => {
    const fn = (async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    await assert.rejects(
      () => uploadProjectToShare({ ...baseArgs, fetchImpl: fn }),
      /could not reach/i,
    );
  });
});
