import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CLERK_PUBLISHABLE_KEY_ENV,
  resolveClerkPublishableKey,
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
