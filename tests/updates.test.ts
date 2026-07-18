import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  compareVersions,
  fetchLatestRelease,
  formatVersion,
  meetsNotificationLevel,
  parseVersion,
  releaseSeverity,
  UPDATE_URL,
  UpdateCheckError,
} from "../apps/geolibre-desktop/src/lib/updates";

describe("update version helpers", () => {
  it("parses semantic versions with and without a v prefix", () => {
    assert.deepEqual(parseVersion("1.5.0"), [1, 5, 0]);
    assert.deepEqual(parseVersion("v2.0.3"), [2, 0, 3]);
    assert.equal(parseVersion("1.5"), null);
    assert.equal(parseVersion("not-a-version"), null);
  });

  it("compares versions numerically, not lexically", () => {
    assert.ok(compareVersions("1.5.0", "1.10.0") < 0);
    assert.ok(compareVersions("1.5.0", "1.5.0") === 0);
    assert.ok(compareVersions("2.0.0", "1.9.9") > 0);
  });

  it("treats unparseable versions as equal so it never falsely reports an update", () => {
    assert.equal(compareVersions("1.5.0", "garbage"), 0);
  });

  it("normalizes a version to a leading v", () => {
    assert.equal(formatVersion("1.5.0"), "v1.5.0");
    assert.equal(formatVersion("v1.5.0"), "v1.5.0");
    assert.equal(formatVersion("  1.5.0 "), "v1.5.0");
  });
});

describe("releaseSeverity", () => {
  it("classifies the kind of newer release", () => {
    assert.equal(releaseSeverity("1.5.0", "2.0.0"), "major");
    assert.equal(releaseSeverity("1.5.0", "1.6.0"), "minor");
    assert.equal(releaseSeverity("1.5.0", "1.5.1"), "patch");
  });

  it("returns null when the candidate is not newer or is unparseable", () => {
    assert.equal(releaseSeverity("1.5.0", "1.5.0"), null);
    assert.equal(releaseSeverity("1.5.0", "1.4.9"), null);
    assert.equal(releaseSeverity("1.5.0", "v1.x"), null);
  });
});

describe("meetsNotificationLevel", () => {
  it("notifies for everything at the 'all' level", () => {
    assert.equal(meetsNotificationLevel("patch", "all"), true);
    assert.equal(meetsNotificationLevel("minor", "all"), true);
    assert.equal(meetsNotificationLevel("major", "all"), true);
  });

  it("suppresses patches at the 'minor' level", () => {
    assert.equal(meetsNotificationLevel("patch", "minor"), false);
    assert.equal(meetsNotificationLevel("minor", "minor"), true);
    assert.equal(meetsNotificationLevel("major", "minor"), true);
  });

  it("notifies only for major releases at the 'major' level", () => {
    assert.equal(meetsNotificationLevel("patch", "major"), false);
    assert.equal(meetsNotificationLevel("minor", "major"), false);
    assert.equal(meetsNotificationLevel("major", "major"), true);
  });
});

describe("fetchLatestRelease", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const stubFetch = (response: Response) => {
    globalThis.fetch = (async () => response) as typeof fetch;
  };

  it("normalizes a valid release and keeps a GitHub html_url", async () => {
    stubFetch(
      new Response(
        JSON.stringify({
          tag_name: "1.6.0",
          body: "  notes  ",
          html_url: "https://github.com/opengeos/GeoLibre/releases/tag/v1.6.0",
        }),
        { status: 200 },
      ),
    );
    const release = await fetchLatestRelease();
    assert.equal(release.version, "v1.6.0");
    assert.equal(release.notes, "notes");
    assert.equal(release.url, "https://github.com/opengeos/GeoLibre/releases/tag/v1.6.0");
  });

  it("falls back to the downloads page for a non-GitHub html_url", async () => {
    stubFetch(
      new Response(JSON.stringify({ tag_name: "v1.6.0", html_url: "http://evil.example" }), {
        status: 200,
      }),
    );
    const release = await fetchLatestRelease();
    assert.equal(release.url, UPDATE_URL);
  });

  it("falls back to the downloads page when html_url is absent", async () => {
    stubFetch(new Response(JSON.stringify({ tag_name: "v1.6.0" }), { status: 200 }));
    const release = await fetchLatestRelease();
    assert.equal(release.url, UPDATE_URL);
    assert.equal(release.notes, "");
  });

  it("wraps a malformed 200 body as a network error", async () => {
    stubFetch(new Response("{ not json", { status: 200 }));
    await assert.rejects(fetchLatestRelease(), (error: unknown) => {
      assert.ok(error instanceof UpdateCheckError);
      assert.equal(error.code, "network");
      return true;
    });
  });

  it("reports an exhausted rate limit", async () => {
    stubFetch(
      new Response("", {
        status: 403,
        headers: { "X-RateLimit-Remaining": "0" },
      }),
    );
    await assert.rejects(fetchLatestRelease(), (error: unknown) => {
      assert.ok(error instanceof UpdateCheckError);
      assert.equal(error.code, "rateLimit");
      return true;
    });
  });

  it("treats a 429 secondary rate limit as a rate limit error", async () => {
    stubFetch(new Response("", { status: 429 }));
    await assert.rejects(fetchLatestRelease(), (error: unknown) => {
      assert.ok(error instanceof UpdateCheckError);
      assert.equal(error.code, "rateLimit");
      return true;
    });
  });

  it("flags a missing version tag", async () => {
    stubFetch(new Response(JSON.stringify({ body: "no tag" }), { status: 200 }));
    await assert.rejects(fetchLatestRelease(), (error: unknown) => {
      assert.ok(error instanceof UpdateCheckError);
      assert.equal(error.code, "noTag");
      return true;
    });
  });
});
