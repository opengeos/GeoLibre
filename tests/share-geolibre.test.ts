import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_PROJECT_TITLE,
  DEFAULT_SHARE_BASE_URL,
  fetchProjectShares,
  isShareableTitle,
  MAX_PROJECT_TITLE_LENGTH,
  normalizeShareRole,
  resolveShareBaseUrl,
  revokeShare,
  ShareUploadError,
  uploadProjectToShare,
  verifySharePassword,
} from "../apps/geolibre-desktop/src/lib/share-geolibre";

const PROJECT_DTO = {
  username: "giswqs",
  slug: "my-map",
  projectUrl: "https://share.geolibre.app/giswqs/my-map",
  viewerUrl: "https://web.geolibre.app/?url=https://share.geolibre.app/giswqs/my-map.geolibre.json",
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

describe("isShareableTitle", () => {
  it("rejects empty, whitespace, and the default project title", () => {
    assert.equal(isShareableTitle(""), false);
    assert.equal(isShareableTitle("   "), false);
    assert.equal(isShareableTitle(DEFAULT_PROJECT_TITLE), false);
    assert.equal(isShareableTitle(`  ${DEFAULT_PROJECT_TITLE}  `), false);
  });

  it("accepts a real, non-default title", () => {
    assert.equal(isShareableTitle("My Flood Map"), true);
    assert.equal(isShareableTitle("  Trimmed Title  "), true);
  });

  it("rejects a title longer than the max length", () => {
    assert.equal(isShareableTitle("a".repeat(MAX_PROJECT_TITLE_LENGTH)), true);
    assert.equal(isShareableTitle("a".repeat(MAX_PROJECT_TITLE_LENGTH + 1)), false);
  });
});

describe("resolveShareBaseUrl", () => {
  it("falls back to production when no override is configured", () => {
    assert.equal(resolveShareBaseUrl(undefined), DEFAULT_SHARE_BASE_URL);
    assert.equal(resolveShareBaseUrl("   "), DEFAULT_SHARE_BASE_URL);
  });

  it("accepts an HTTPS override and trims trailing slashes", () => {
    assert.equal(
      resolveShareBaseUrl("https://staging.geolibre.app/"),
      "https://staging.geolibre.app",
    );
  });

  it("accepts HTTP only on loopback hosts", () => {
    assert.equal(resolveShareBaseUrl("http://localhost:8787"), "http://localhost:8787");
    assert.equal(resolveShareBaseUrl("http://127.0.0.1:8787"), "http://127.0.0.1:8787");
  });

  it("rejects plaintext HTTP to non-loopback hosts", () => {
    assert.equal(resolveShareBaseUrl("http://internal.corp"), DEFAULT_SHARE_BASE_URL);
  });

  it("rejects loopback-lookalike hosts that a prefix check would allow", () => {
    assert.equal(resolveShareBaseUrl("http://localhost.evil.com"), DEFAULT_SHARE_BASE_URL);
    assert.equal(resolveShareBaseUrl("http://127.0.0.1.evil.com"), DEFAULT_SHARE_BASE_URL);
  });

  it("falls back to production for an unparseable override", () => {
    assert.equal(resolveShareBaseUrl("not a url"), DEFAULT_SHARE_BASE_URL);
  });
});

describe("uploadProjectToShare", () => {
  it("rejects when no token is provided", async () => {
    await assert.rejects(() => uploadProjectToShare({ ...baseArgs, token: "  " }), /token/i);
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
      (err: ShareUploadError) =>
        err instanceof ShareUploadError &&
        err.code === undefined &&
        /Project schema is invalid\./.test(err.message),
    );
  });

  it("flags the missing-username 400 with a username-required code", async () => {
    const { fn } = fakeFetch(400, {
      error: "Username required before uploading projects",
    });
    await assert.rejects(
      () => uploadProjectToShare({ ...baseArgs, fetchImpl: fn }),
      (err: ShareUploadError) =>
        err instanceof ShareUploadError &&
        err.code === "username-required" &&
        /username required/i.test(err.message),
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

  it("maps 403 to a forbidden message", async () => {
    const { fn } = fakeFetch(403, { error: "Forbidden" });
    await assert.rejects(
      () => uploadProjectToShare({ ...baseArgs, fetchImpl: fn }),
      /not allowed to upload/i,
    );
  });

  it("rejects when the response is missing required fields", async () => {
    const { fn } = fakeFetch(201, { project: { username: "test" } });
    await assert.rejects(
      () => uploadProjectToShare({ ...baseArgs, fetchImpl: fn }),
      /unexpected response/i,
    );
  });

  it("maps a TimeoutError to a timeout message", async () => {
    const fn = (async () => {
      throw new DOMException("The operation timed out.", "TimeoutError");
    }) as unknown as typeof fetch;
    await assert.rejects(() => uploadProjectToShare({ ...baseArgs, fetchImpl: fn }), /timed out/i);
  });

  it("re-throws AbortError without wrapping it", async () => {
    const fn = (async () => {
      throw new DOMException("The operation was aborted.", "AbortError");
    }) as unknown as typeof fetch;
    await assert.rejects(
      () => uploadProjectToShare({ ...baseArgs, fetchImpl: fn }),
      (err: Error) => err.name === "AbortError",
    );
  });

  it("defaults optional fields to empty strings", async () => {
    const { fn } = fakeFetch(201, {
      project: {
        projectUrl: "https://share.geolibre.app/user/project",
        rawJsonUrl: "https://share.geolibre.app/user/project.geolibre.json",
      },
    });
    const result = await uploadProjectToShare({ ...baseArgs, fetchImpl: fn });
    assert.equal(result.username, "");
    assert.equal(result.slug, "");
    assert.equal(result.viewerUrl, "");
  });

  it("sends role, expiresIn, and password when provided", async () => {
    const { fn, calls } = fakeFetch(201, {
      project: {
        ...PROJECT_DTO,
        role: "view",
        expiresAt: "2026-07-30T12:00:00Z",
        hasPassword: true,
      },
    });
    const result = await uploadProjectToShare({
      ...baseArgs,
      role: "view",
      expiresIn: "24h",
      password: "secretpassword",
      fetchImpl: fn,
    });

    assert.equal(calls.length, 1);
    const body = JSON.parse(calls[0].init.body as string);
    assert.equal(body.role, "view");
    assert.equal(body.expiresIn, "24h");
    assert.equal(body.password, "secretpassword");
    assert.equal(result.role, "view");
    assert.equal(result.hasPassword, true);
  });
});

describe("fetchProjectShares", () => {
  it("fetches active shares for authenticated user", async () => {
    const { fn, calls } = fakeFetch(200, {
      shares: [
        {
          id: "s1",
          slug: "my-map",
          title: "My Map",
          visibility: "unlisted",
          role: "view",
          expiresAt: null,
          hasPassword: false,
          createdAt: "2026-07-29T12:00:00Z",
          projectUrl: "https://share.geolibre.app/u/my-map",
          viewerUrl: "https://share.geolibre.app/viewer?url=https://share.geolibre.app/u/my-map",
        },
      ],
    });

    const shares = await fetchProjectShares({
      token: "glb_secrettoken",
      baseUrl: "https://share.geolibre.app",
      fetchImpl: fn,
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://share.geolibre.app/api/shares");
    assert.equal(shares.length, 1);
    assert.equal(shares[0].id, "s1");
    assert.equal(shares[0].role, "view");
    assert.equal(shares[0].visibility, "unlisted");
  });

  it("rejects when no token is provided", async () => {
    await assert.rejects(() => fetchProjectShares({ token: "   " }), /token/i);
  });

  it("fails closed to the view role when the server sends an unknown one", async () => {
    const { fn } = fakeFetch(200, {
      shares: [
        { id: "s1", slug: "my-map" },
        { id: "s2", slug: "other-map", role: "owner" },
      ],
    });

    const shares = await fetchProjectShares({
      token: "glb_secrettoken",
      baseUrl: "https://share.geolibre.app",
      fetchImpl: fn,
    });

    assert.equal(shares.length, 2);
    // A missing or unrecognized role must never be displayed as full edit access.
    assert.equal(shares[0].role, "view");
    assert.equal(shares[1].role, "view");
  });

  it("percent-encodes the project URL in the fallback viewer link", async () => {
    const { fn } = fakeFetch(200, {
      shares: [{ id: "s1", projectUrl: "https://example.com/p?a=1&b=2#frag" }],
    });

    const shares = await fetchProjectShares({
      token: "glb_secrettoken",
      baseUrl: "https://share.geolibre.app",
      fetchImpl: fn,
    });

    // Without encoding, the raw `&` and `#` would truncate the viewer link.
    assert.equal(
      shares[0].viewerUrl,
      "https://share.geolibre.app/viewer?url=https%3A%2F%2Fexample.com%2Fp%3Fa%3D1%26b%3D2%23frag",
    );
  });
});

describe("normalizeShareRole", () => {
  it("passes through valid share roles", () => {
    assert.equal(normalizeShareRole("view"), "view");
    assert.equal(normalizeShareRole("comment"), "comment");
    assert.equal(normalizeShareRole("edit"), "edit");
  });

  it("fails closed to view for unknown or missing values", () => {
    assert.equal(normalizeShareRole("owner"), "view");
    assert.equal(normalizeShareRole(null), "view");
    assert.equal(normalizeShareRole(undefined), "view");
  });
});

describe("revokeShare", () => {
  it("deletes the specified share", async () => {
    const { fn, calls } = fakeFetch(200, { ok: true });
    await revokeShare({
      token: "glb_secrettoken",
      shareId: "s1",
      baseUrl: "https://share.geolibre.app",
      fetchImpl: fn,
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://share.geolibre.app/api/shares/s1");
    assert.equal(calls[0].init.method, "DELETE");
  });

  it("rejects when no token is provided", async () => {
    await assert.rejects(() => revokeShare({ token: "", shareId: "s1" }), /token/i);
  });

  it("rejects when revocation returns 404", async () => {
    const { fn } = fakeFetch(404, { error: "Not found" });
    await assert.rejects(
      () =>
        revokeShare({
          token: "glb_secrettoken",
          shareId: "s1",
          baseUrl: "https://share.geolibre.app",
          fetchImpl: fn,
        }),
      /Failed to revoke share \(HTTP 404\)/i,
    );
  });
});

describe("verifySharePassword", () => {
  it("POSTs password and returns project content on success", async () => {
    const { fn, calls } = fakeFetch(200, { content: '{"version":"1.0.0"}', role: "view" });
    const result = await verifySharePassword({
      shareUrl: "https://share.geolibre.app/u/protected-share",
      password: "secretpassword",
      fetchImpl: fn,
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://share.geolibre.app/u/protected-share/access");
    assert.equal(calls[0].init.method, "POST");
    assert.equal(result.projectContent, '{"version":"1.0.0"}');
    assert.equal(result.role, "view");
  });

  it("rejects with incorrect password on 401/403", async () => {
    const { fn } = fakeFetch(401, { error: "Incorrect password" });
    await assert.rejects(
      () =>
        verifySharePassword({
          shareUrl: "https://share.geolibre.app/u/protected-share",
          password: "wrongpassword",
          fetchImpl: fn,
        }),
      /incorrect password/i,
    );
  });
});
