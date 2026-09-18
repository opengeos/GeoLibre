import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CLERK_PUBLISHABLE_KEY_ENV,
  CLERK_WAITLIST_ENV,
  resolveClerkPublishableKey,
  resolveClerkWaitlistEnabled,
} from "../apps/geolibre-desktop/src/lib/clerk-auth";

describe("optional Clerk authentication", () => {
  it("stays disabled when no publishable key is configured", () => {
    assert.equal(resolveClerkPublishableKey(true, {}, {}), undefined);
  });

  it("prefers the Docker runtime key over the build-time key", () => {
    assert.equal(
      resolveClerkPublishableKey(
        true,
        { [CLERK_PUBLISHABLE_KEY_ENV]: " pk_live_runtime " },
        { [CLERK_PUBLISHABLE_KEY_ENV]: "pk_test_build" },
      ),
      "pk_live_runtime",
    );
  });

  it("falls back to the build-time key", () => {
    assert.equal(
      resolveClerkPublishableKey(true, {}, { [CLERK_PUBLISHABLE_KEY_ENV]: "pk_test_build" }),
      "pk_test_build",
    );
  });

  it("never gates native or embedded applications", () => {
    assert.equal(
      resolveClerkPublishableKey(
        false,
        { [CLERK_PUBLISHABLE_KEY_ENV]: "pk_live_runtime" },
        { [CLERK_PUBLISHABLE_KEY_ENV]: "pk_test_build" },
      ),
      undefined,
    );
  });
});

describe("optional Clerk waitlist", () => {
  it("stays off unless the deployment opts in", () => {
    assert.equal(resolveClerkWaitlistEnabled(true, {}, {}), false);
  });

  it("accepts the documented truthy spellings, case-insensitively", () => {
    for (const value of ["1", "true", "TRUE", " True "]) {
      assert.equal(resolveClerkWaitlistEnabled(true, { [CLERK_WAITLIST_ENV]: value }, {}), true);
    }
  });

  it("treats any other value as off", () => {
    for (const value of ["0", "false", "off", "no", "yes", "waitlist"]) {
      assert.equal(resolveClerkWaitlistEnabled(true, { [CLERK_WAITLIST_ENV]: value }, {}), false);
    }
  });

  it("prefers the Docker runtime flag over the build-time flag", () => {
    assert.equal(
      resolveClerkWaitlistEnabled(
        true,
        { [CLERK_WAITLIST_ENV]: "0" },
        { [CLERK_WAITLIST_ENV]: "1" },
      ),
      false,
    );
    assert.equal(
      resolveClerkWaitlistEnabled(
        true,
        { [CLERK_WAITLIST_ENV]: "1" },
        { [CLERK_WAITLIST_ENV]: "0" },
      ),
      true,
    );
  });

  it("falls back to the build-time flag", () => {
    assert.equal(resolveClerkWaitlistEnabled(true, {}, { [CLERK_WAITLIST_ENV]: "1" }), true);
  });

  it("never applies to native or embedded applications", () => {
    assert.equal(resolveClerkWaitlistEnabled(false, { [CLERK_WAITLIST_ENV]: "1" }, {}), false);
  });
});
