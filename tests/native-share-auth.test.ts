import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  DESKTOP_SHARE_CALLBACK,
  NativeShareAuthReceiver,
  NativeShareCallbackError,
  parseNativeShareCallback,
} from "../apps/geolibre-desktop/src/lib/native-share-auth";

const issuer = "https://share.geolibre.app";
const state = "opaque-random-state";
const callback = `${DESKTOP_SHARE_CALLBACK}?code=one-time-code&state=${state}&iss=${encodeURIComponent(issuer)}`;

describe("desktop OAuth callback", () => {
  it("accepts the registered hostless URI and consumes state exactly once", async () => {
    let cold = 0;
    const receiver = new NativeShareAuthReceiver(() => {
      cold += 1;
    });
    const pending = receiver.waitForCode(state, issuer, 300_000);
    assert.equal(receiver.accept("geo:12,34"), false);
    assert.equal(receiver.accept(callback), true);
    assert.equal(await pending.code, "one-time-code");
    assert.equal(receiver.accept(callback), true);
    assert.equal(cold, 0);
    assert.deepEqual(parseNativeShareCallback(callback), { code: "one-time-code", state, issuer });
  });

  it("ignores an abandoned callback during the next sign-in", async () => {
    let cold = 0;
    const receiver = new NativeShareAuthReceiver(() => {
      cold += 1;
    });
    const abandoned = receiver.waitForCode(state, issuer, 300_000);
    abandoned.cancel();
    await assert.rejects(abandoned.code, NativeShareCallbackError);
    assert.equal(receiver.accept(callback), true);
    assert.equal(cold, 0);

    const nextState = "next-random-state";
    const retry = receiver.waitForCode(nextState, issuer, 300_000);
    assert.equal(receiver.accept(callback), true);
    assert.equal(receiver.accept(callback.replace(`state=${state}`, `state=${nextState}`)), true);
    assert.equal(await retry.code, "one-time-code");
  });

  it("ignores late callbacks after a timed-out sign-in, even during a retry", async () => {
    let cold = 0;
    const receiver = new NativeShareAuthReceiver(() => {
      cold += 1;
    });
    const expired = receiver.waitForCode(state, issuer, 0);
    await assert.rejects(
      expired.code,
      (error: unknown) => error instanceof NativeShareCallbackError && error.code === "timeout",
    );
    assert.equal(receiver.accept(callback), true);
    assert.equal(cold, 0);

    const nextState = "next-random-state";
    const retry = receiver.waitForCode(nextState, issuer, 300_000);
    assert.equal(receiver.accept(callback), true);
    assert.equal(receiver.accept(callback.replace(`state=${state}`, `state=${nextState}`)), true);
    assert.equal(await retry.code, "one-time-code");
  });

  it("ignores a late callback for an older abandoned attempt during a newer one", async () => {
    let cold = 0;
    const receiver = new NativeShareAuthReceiver(() => {
      cold += 1;
    });
    for (const abandonedState of ["state-a", "state-b"]) {
      const abandoned = receiver.waitForCode(abandonedState, issuer, 300_000);
      abandoned.code.catch(() => {});
      abandoned.cancel();
    }
    const retryState = "state-c";
    const retry = receiver.waitForCode(retryState, issuer, 300_000);
    // The stale callback for state A must be recognized without consuming the
    // pending state-C transaction.
    assert.equal(receiver.accept(callback.replace(state, "state-a")), true);
    assert.equal(cold, 0);
    assert.equal(receiver.accept(callback.replace(state, retryState)), true);
    assert.equal(await retry.code, "one-time-code");
  });

  it("rejects ambiguous, authority-bearing, unknown, or fragment-bearing callbacks", () => {
    const invalid = [
      callback.replace(":/oauth/", "://host/oauth/"),
      callback.replace(":/oauth/", "://user@host/oauth/"),
      callback.replace("/oauth/callback", "/oauth/other"),
      `${callback}&state=duplicate`,
      `${callback}&iss=${encodeURIComponent(issuer)}`,
      `${callback}&code=another`,
      `${callback}&unknown=value`,
      `${callback}&error=access_denied`,
      `${callback}&error_description=ignored`,
      `${callback}#fragment`,
      callback.replace("state=opaque-random-state", "state="),
      callback.replace("&iss=", "&other="),
    ];
    for (const uri of invalid) assert.equal(parseNativeShareCallback(uri), null);
  });

  it("requires the exact state and issuer and never accepts a replay", async () => {
    for (const [uri, code] of [
      [callback.replace(state, "attacker-state"), "state-mismatch"],
      [
        callback.replace(encodeURIComponent(issuer), encodeURIComponent("https://other.example")),
        "issuer-mismatch",
      ],
      [
        callback.replace("code=one-time-code", "error=access_denied&error_description=secret"),
        "access-denied",
      ],
    ] as const) {
      const receiver = new NativeShareAuthReceiver(() => {});
      const pending = receiver.waitForCode(state, issuer, 300_000);
      assert.equal(receiver.accept(uri), true);
      await assert.rejects(
        pending.code,
        (error: unknown) => error instanceof NativeShareCallbackError && error.code === code,
      );
    }
  });

  it("reports a cold-start callback without ever exchanging its code", () => {
    let cold = 0;
    const receiver = new NativeShareAuthReceiver(() => {
      cold += 1;
    });
    assert.equal(receiver.accept(callback), true);
    assert.equal(cold, 1);
    assert.equal(receiver.accept("geo:1,2"), false);
    assert.equal(receiver.accept("org.geolibre.desktop:/oauth/callback"), true);
    assert.equal(cold, 1);
  });

  it("rejects expired transactions even with the correct callback", async () => {
    const receiver = new NativeShareAuthReceiver(() => {});
    const pending = receiver.waitForCode(state, issuer, 300_000);
    const originalNow = Date.now;
    Date.now = () => originalNow() + 301_000;
    try {
      receiver.accept(callback);
      await assert.rejects(
        pending.code,
        (error: unknown) => error instanceof NativeShareCallbackError && error.code === "timeout",
      );
    } finally {
      Date.now = originalNow;
    }
  });
});

describe("desktop callback scheme registration", () => {
  // The Rust setup hook hands `register_all()` whatever schemes this config
  // lists, and that is what claims the callback URI on Linux. If the two drift,
  // the OS keeps launching the app with an empty argv and sign-in hangs on a
  // code that never arrives (#2667), with nothing failing at build time.
  it("registers the scheme the callback URI actually uses", () => {
    const config = JSON.parse(
      readFileSync("apps/geolibre-desktop/src-tauri/tauri.conf.json", "utf8"),
    ) as { plugins?: { "deep-link"?: { desktop?: { schemes?: string[] } } } };
    const schemes = config.plugins?.["deep-link"]?.desktop?.schemes ?? [];
    const scheme = DESKTOP_SHARE_CALLBACK.slice(0, DESKTOP_SHARE_CALLBACK.indexOf(":"));
    assert.ok(scheme.length > 0, "callback URI carries no scheme");
    assert.ok(
      schemes.includes(scheme),
      `tauri.conf.json does not register "${scheme}" (registers ${JSON.stringify(schemes)})`,
    );
  });
});
