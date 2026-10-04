import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createEmptyProject, serializeProject, type LayerStyle } from "@geolibre/core";
import {
  DEFAULT_PROJECT_TITLE,
  DEFAULT_SHARE_BASE_URL,
  fetchProjectShares,
  fetchSharedProjectVersions,
  isShareableTitle,
  MAX_PROJECT_TITLE_LENGTH,
  normalizeShareRole,
  resolveShareBaseUrl,
  resolveShareHost,
  revokeShare,
  SHARE_URL_ENV,
  sharedProjectContentMatches,
  shareHostLabel,
  ShareUploadError,
  updateSharedProjectContent,
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
const BASE = "https://share.geolibre.app";

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
  content: serializeProject(createEmptyProject("My Map")),
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

  // A rejected value must NOT resolve to the public host: a self-hosted
  // deployment with a bad share URL would otherwise upload its users' projects
  // to share.geolibre.app. See GeoLibre#1684.
  it("refuses plaintext HTTP to non-loopback hosts instead of falling back", () => {
    assert.equal(resolveShareBaseUrl("http://internal.corp"), null);
  });

  it("refuses loopback-lookalike hosts that a prefix check would allow", () => {
    assert.equal(resolveShareBaseUrl("http://localhost.evil.com"), null);
    assert.equal(resolveShareBaseUrl("http://127.0.0.1.evil.com"), null);
  });

  it("refuses an unparseable override instead of falling back", () => {
    assert.equal(resolveShareBaseUrl("not a url"), null);
  });

  // Mirrors service_url() in docker/entrypoint.sh: a credentialed base would send
  // Basic Auth alongside the Bearer token and leak into logs and error messages.
  it("refuses credentials embedded in the URL, on any scheme", () => {
    assert.equal(resolveShareBaseUrl("https://user:pass@maps.example.org"), null);
    assert.equal(resolveShareBaseUrl("https://user@maps.example.org"), null);
    assert.equal(resolveShareBaseUrl("http://user:pass@localhost:8000"), null);
  });

  it("refuses query strings and fragments in share base URLs", () => {
    assert.equal(resolveShareBaseUrl("https://maps.example.org/?tenant=private"), null);
    assert.equal(resolveShareBaseUrl("https://maps.example.org/#section"), null);
    assert.equal(resolveShareBaseUrl("https://maps.example.org?"), null);
    assert.equal(resolveShareBaseUrl("https://maps.example.org#"), null);
  });

  it('treats "off" as sharing disabled', () => {
    assert.equal(resolveShareBaseUrl("off"), null);
    assert.equal(resolveShareBaseUrl("OFF"), null);
  });
});

describe("resolveShareHost", () => {
  it("reports why the host is what it is", () => {
    assert.deepEqual(resolveShareHost(undefined), {
      status: "default",
      baseUrl: DEFAULT_SHARE_BASE_URL,
      configured: null,
    });
    assert.deepEqual(resolveShareHost("https://maps.example.org"), {
      status: "configured",
      baseUrl: "https://maps.example.org",
      configured: "https://maps.example.org",
    });
    assert.deepEqual(resolveShareHost("off"), {
      status: "disabled",
      baseUrl: null,
      configured: "off",
    });
    assert.deepEqual(resolveShareHost("http://internal.corp"), {
      status: "invalid",
      baseUrl: null,
      configured: "http://internal.corp",
    });
  });

  it("keeps the rejected value so the UI can name it", () => {
    assert.equal(resolveShareHost("not a url").configured, "not a url");
  });

  // The Docker entrypoint writes the deployment env at container startup, so a
  // prebuilt image can be repointed without a rebuild.
  it("prefers the deployment env over the build-time default", () => {
    const resolved = resolveShareHost(undefined, {
      [SHARE_URL_ENV]: "https://maps.example.org",
    });
    assert.equal(resolved.status, "configured");
    assert.equal(resolved.baseUrl, "https://maps.example.org");
  });

  it("ignores a blank deployment value", () => {
    const resolved = resolveShareHost(undefined, { [SHARE_URL_ENV]: "  " });
    assert.equal(resolved.status, "default");
    assert.equal(resolved.baseUrl, DEFAULT_SHARE_BASE_URL);
  });
});

describe("shareHostLabel", () => {
  function withShareUrl<T>(value: string, run: () => T): T {
    (globalThis as { window?: unknown }).window = {
      __GEOLIBRE_DEPLOYMENT_ENV__: { [SHARE_URL_ENV]: value },
    };
    try {
      return run();
    } finally {
      delete (globalThis as { window?: unknown }).window;
    }
  }

  it("names the host of the configured server", () => {
    // Nothing configured resolves to the hosted default.
    assert.equal(shareHostLabel(), new URL(DEFAULT_SHARE_BASE_URL).host);
    assert.equal(
      withShareUrl("https://maps.example.org", () => shareHostLabel()),
      "maps.example.org",
    );
  });

  // A server under a subpath must be named the way links built from the same base
  // resolve, so the copy and the account-settings link agree.
  it("keeps a subpath so the label matches the links built from the base", () => {
    assert.equal(
      withShareUrl("https://example.test/geolibre", () => shareHostLabel()),
      "example.test/geolibre",
    );
    assert.equal(
      withShareUrl("https://example.test/geolibre/", () => shareHostLabel()),
      "example.test/geolibre",
    );
  });

  it("names an unusable host as the hosted default rather than an empty string", () => {
    assert.equal(
      withShareUrl("off", () => shareHostLabel()),
      new URL(DEFAULT_SHARE_BASE_URL).host,
    );
  });
});

describe("uploadProjectToShare", () => {
  it("redacts credentials before the share request leaves the app", async () => {
    const { fn, calls } = fakeFetch(201, { project: PROJECT_DTO });
    const project = createEmptyProject("Secret map");
    project.preferences.geocoding.apiKeys.mapbox = "share-egress-secret";
    project.layers.push({
      id: "auth",
      name: "Authenticated tiles",
      type: "3d-tiles",
      source: {
        url: "https://example.com/tileset.json?token=share-egress-secret",
        requestHeaders: { Authorization: "Bearer share-egress-secret" },
      },
      visible: true,
      opacity: 1,
      style: {} as LayerStyle,
      metadata: {},
    });

    await uploadProjectToShare({
      ...baseArgs,
      content: serializeProject(project),
      fetchImpl: fn,
    });

    const body = String(calls[0].init.body);
    assert.ok(!body.includes("share-egress-secret"));
    const envelope = JSON.parse(body) as { content: string };
    const shared = JSON.parse(envelope.content) as typeof project;
    assert.deepEqual(shared.preferences.geocoding.apiKeys, {});
    assert.ok(!("requestHeaders" in shared.layers[0].source));
  });

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
    const body = JSON.parse(calls[0].init.body as string) as {
      filename: string;
      content: string;
      visibility: string;
    };
    assert.equal(body.filename, "my-map.geolibre.json");
    assert.equal(body.visibility, "unlisted");
    assert.equal((JSON.parse(body.content) as { name: string }).name, "My Map");
    assert.equal(result.projectUrl, PROJECT_DTO.projectUrl);
    assert.equal(result.viewerUrl, PROJECT_DTO.viewerUrl);
    assert.equal(result.rawJsonUrl, PROJECT_DTO.rawJsonUrl);
  });

  it("sends organization ownership and additive group shares", async () => {
    const { fn, calls } = fakeFetch(201, { project: PROJECT_DTO });
    await uploadProjectToShare({
      ...baseArgs,
      visibility: "organization",
      organizationId: "org-1",
      groupIds: ["group-1", "group-2"],
      fetchImpl: fn,
    });
    const body = JSON.parse(String(calls[0].init.body)) as {
      organizationId: string;
      groupIds: string[];
    };
    assert.equal(body.organizationId, "org-1");
    assert.deepEqual(body.groupIds, ["group-1", "group-2"]);
  });

  it("flags 401 with an unauthorized code so the UI prompts re-auth", async () => {
    const { fn } = fakeFetch(401, { error: "Unauthorized" });
    await assert.rejects(
      () => uploadProjectToShare({ ...baseArgs, fetchImpl: fn }),
      (err: ShareUploadError) =>
        err instanceof ShareUploadError &&
        err.code === "unauthorized" &&
        err.message === "unauthorized",
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
    assert.deepEqual(result.unconfirmedSettings, []);
  });

  it("flags requested settings a URL-only response did not confirm", async () => {
    // A server that predates link settings ignores the fields and answers with
    // the plain v1 response, so none of them may be reported as applied.
    const { fn } = fakeFetch(201, { project: PROJECT_DTO });
    const result = await uploadProjectToShare({
      ...baseArgs,
      role: "view",
      expiresIn: "24h",
      password: "secretpassword",
      fetchImpl: fn,
    });
    assert.deepEqual(result.unconfirmedSettings, ["role", "expiry", "password"]);
  });

  it("does not flag the default edit role on a URL-only response", async () => {
    const { fn } = fakeFetch(201, { project: PROJECT_DTO });
    const result = await uploadProjectToShare({ ...baseArgs, role: "edit", fetchImpl: fn });
    assert.deepEqual(result.unconfirmedSettings, []);
  });

  it("fails closed to the view role when the upload response sends an unknown one", async () => {
    const { fn } = fakeFetch(201, { project: { ...PROJECT_DTO, role: "owner" } });
    const result = await uploadProjectToShare({ ...baseArgs, role: "comment", fetchImpl: fn });
    assert.equal(result.role, "view");
    assert.deepEqual(result.unconfirmedSettings, ["role"]);
  });

  it("does not treat an unknown role as confirming a requested view role", async () => {
    const { fn } = fakeFetch(201, { project: { ...PROJECT_DTO, role: "owner" } });
    const result = await uploadProjectToShare({ ...baseArgs, role: "view", fetchImpl: fn });
    assert.equal(result.role, "view");
    assert.deepEqual(result.unconfirmedSettings, ["role"]);
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

describe("updateSharedProjectContent", () => {
  it("PUTs content with expectedVersion and returns a stale-version warning", async () => {
    const { fn, calls } = fakeFetch(201, {
      project: { versionCount: 4 },
      version: 4,
      warning: "version conflict",
    });
    const result = await updateSharedProjectContent({
      token: "glb_secrettoken",
      projectId: "project/id",
      content: baseArgs.content,
      expectedVersion: 2,
      baseUrl: baseArgs.baseUrl,
      fetchImpl: fn,
    });
    assert.equal(calls[0].url, "https://share.geolibre.app/api/projects/project%2Fid/content");
    assert.equal(calls[0].init.method, "PUT");
    assert.equal(
      (calls[0].init.headers as Record<string, string>).Authorization,
      "Bearer glb_secrettoken",
    );
    const body = JSON.parse(String(calls[0].init.body)) as {
      content: string;
      expectedVersion: number;
    };
    assert.equal(body.expectedVersion, 2);
    assert.equal(result.versionCount, 4);
    assert.equal(result.warning, "version conflict");
    assert.equal(result.savedContent, body.content);
  });

  it("returns no warning after an ordinary update", async () => {
    const { fn } = fakeFetch(201, { project: { versionCount: 3 }, version: 3 });
    const result = await updateSharedProjectContent({
      token: "glb_secrettoken",
      projectId: "project-1",
      content: baseArgs.content,
      expectedVersion: 2,
      baseUrl: baseArgs.baseUrl,
      fetchImpl: fn,
    });
    assert.equal(result.warning, null);
  });

  it("rejects with ShareUploadError when the server returns a non-ok status", async () => {
    const { fn } = fakeFetch(400, { error: "Version conflict detected" });
    await assert.rejects(
      () =>
        updateSharedProjectContent({
          token: "glb_secrettoken",
          projectId: "project-1",
          content: baseArgs.content,
          expectedVersion: 2,
          baseUrl: baseArgs.baseUrl,
          fetchImpl: fn,
        }),
      (err: unknown) =>
        err instanceof ShareUploadError && /Version conflict detected/.test(err.message),
    );
  });
});

describe("sharedProjectContentMatches", () => {
  it("matches canonical sanitized content but detects edits made during a save", () => {
    const sent = createEmptyProject("Remote map");
    sent.preferences.geocoding.apiKeys.mapbox = "secret-a";
    const same = structuredClone(sent);
    same.preferences.geocoding.apiKeys.mapbox = "secret-b";
    assert.equal(sharedProjectContentMatches(serializeProject(sent), serializeProject(same)), true);

    same.name = "Edited while saving";
    assert.equal(
      sharedProjectContentMatches(serializeProject(sent), serializeProject(same)),
      false,
    );
  });

  it("fails safely for invalid live content", () => {
    assert.equal(sharedProjectContentMatches(baseArgs.content, "not json"), false);
  });
});

describe("fetchSharedProjectVersions", () => {
  it("fetches, normalizes, and sorts authoritative server versions", async () => {
    const { fn, calls } = fakeFetch(200, {
      versions: [
        { number: 1, createdAt: "2026-01-01T00:00:00Z" },
        { version: 3, createdAt: "2026-01-03T00:00:00Z" },
      ],
    });
    const versions = await fetchSharedProjectVersions({
      token: "glb_secrettoken",
      projectId: "project/id",
      baseUrl: BASE,
      fetchImpl: fn,
    });
    assert.equal(calls[0].url, `${BASE}/api/projects/project%2Fid/versions`);
    assert.equal(
      (calls[0].init.headers as Record<string, string>).Authorization,
      "Bearer glb_secrettoken",
    );
    assert.deepEqual(
      versions.map((version) => [version.number, version.rawUrl]),
      [
        [3, `${BASE}/api/projects/project%2Fid/versions/3`],
        [1, `${BASE}/api/projects/project%2Fid/versions/1`],
      ],
    );
  });

  it("rejects when the versions payload is not an array", async () => {
    const { fn } = fakeFetch(200, { versions: "invalid" });
    await assert.rejects(
      () =>
        fetchSharedProjectVersions({
          token: "glb_secrettoken",
          projectId: "project/id",
          baseUrl: BASE,
          fetchImpl: fn,
        }),
      /unexpected response/i,
    );
  });

  it("surfaces the server error message for non-ok responses", async () => {
    const { fn } = fakeFetch(404, { error: "Project history not found" });
    await assert.rejects(
      () =>
        fetchSharedProjectVersions({
          token: "glb_secrettoken",
          projectId: "project/id",
          baseUrl: BASE,
          fetchImpl: fn,
        }),
      /Project history not found/,
    );
  });
});
