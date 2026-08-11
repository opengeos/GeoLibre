import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createEmptyProject, serializeProject } from "@geolibre/core";
import {
  DEFAULT_PROJECT_TITLE,
  DEFAULT_SHARE_BASE_URL,
  isShareableTitle,
  MAX_PROJECT_TITLE_LENGTH,
  resolveShareBaseUrl,
  resolveShareHost,
  SHARE_URL_ENV,
  shareHostLabel,
  ShareUploadError,
  uploadProjectToShare,
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
      style: {},
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
});
