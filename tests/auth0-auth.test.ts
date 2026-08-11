import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AUTH0_CLIENT_ID_ENV,
  AUTH0_DOMAIN_ENV,
  resolveAuth0Config,
} from "../apps/geolibre-desktop/src/lib/auth0-auth";

const CLIENT_ID = "aBcD1234efGh5678ijKl9012mnOp3456";

/** Build an env record for the two Auth0 variables. */
function env(domain?: string, clientId?: string): Record<string, string | undefined> {
  return { [AUTH0_DOMAIN_ENV]: domain, [AUTH0_CLIENT_ID_ENV]: clientId };
}

/**
 * Run `body` with console.error silenced.
 *
 * The resolver logs when it rejects a half or malformed configuration, which is
 * the point — but it would otherwise print on every negative assertion here.
 */
function quietly<T>(body: () => T): T {
  const original = console.error;
  console.error = () => {};
  try {
    return body();
  } finally {
    console.error = original;
  }
}

describe("optional Auth0 authentication", () => {
  it("stays disabled when nothing is configured", () => {
    assert.equal(resolveAuth0Config(true, {}, {}), undefined);
  });

  it("resolves a complete configuration", () => {
    assert.deepEqual(resolveAuth0Config(true, env("tenant.us.auth0.com", CLIENT_ID), {}), {
      domain: "tenant.us.auth0.com",
      clientId: CLIENT_ID,
    });
  });

  it("normalizes a domain pasted as a URL", () => {
    for (const domain of [
      "https://tenant.us.auth0.com",
      "https://tenant.us.auth0.com/",
      "http://tenant.us.auth0.com",
      " Tenant.US.auth0.com ",
    ]) {
      assert.deepEqual(
        resolveAuth0Config(true, env(domain, CLIENT_ID), {})?.domain,
        "tenant.us.auth0.com",
        domain,
      );
    }
  });

  it("rejects a domain that is not a bare hostname", () => {
    for (const domain of ["localhost", "tenant.us.auth0.com:8443", "user@tenant.us.auth0.com"]) {
      assert.equal(
        quietly(() => resolveAuth0Config(true, env(domain, CLIENT_ID), {})),
        undefined,
      );
    }
  });

  it("rejects a client ID outside Auth0's charset", () => {
    for (const clientId of ["not a client id", '"quoted"', "https://example.com"]) {
      assert.equal(
        quietly(() => resolveAuth0Config(true, env("tenant.us.auth0.com", clientId), {})),
        undefined,
      );
    }
  });

  it("stays disabled — loudly — on a half or malformed configuration", () => {
    const records = [
      env("tenant.us.auth0.com", undefined),
      env(undefined, CLIENT_ID),
      // One malformed value alongside a good one...
      env("localhost", CLIENT_ID),
      env("tenant.us.auth0.com", "not a client id"),
      // ...and both malformed, which normalizes to the same shape as "unset"
      // and so is the case most at risk of failing silently.
      env("localhost", "not a client id"),
    ];
    for (const record of records) {
      const messages: unknown[] = [];
      const original = console.error;
      console.error = (message: unknown) => messages.push(message);
      try {
        assert.equal(resolveAuth0Config(true, record, {}), undefined);
      } finally {
        console.error = original;
      }
      assert.equal(messages.length, 1, JSON.stringify(record));
    }
  });

  it("says nothing when the gate is simply unconfigured", () => {
    const messages: unknown[] = [];
    const original = console.error;
    console.error = (message: unknown) => messages.push(message);
    try {
      assert.equal(resolveAuth0Config(true, {}, {}), undefined);
    } finally {
      console.error = original;
    }
    assert.deepEqual(messages, []);
  });

  it("prefers the Docker runtime values over the build-time values", () => {
    assert.deepEqual(
      resolveAuth0Config(
        true,
        env(" runtime.us.auth0.com ", "runtimeClientId"),
        env("build.us.auth0.com", "buildClientId"),
      ),
      { domain: "runtime.us.auth0.com", clientId: "runtimeClientId" },
    );
  });

  it("falls back to the build-time values", () => {
    assert.deepEqual(resolveAuth0Config(true, {}, env("build.us.auth0.com", "buildClientId")), {
      domain: "build.us.auth0.com",
      clientId: "buildClientId",
    });
  });

  it("never gates native or embedded applications", () => {
    assert.equal(
      resolveAuth0Config(
        false,
        env("tenant.us.auth0.com", CLIENT_ID),
        env("build.us.auth0.com", "buildClientId"),
      ),
      undefined,
    );
  });
});
