import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AUTH0_CLIENT_ID_ENV, AUTH0_DOMAIN_ENV } from "../apps/geolibre-desktop/src/lib/auth0-auth";
import { resolveAuthGate } from "../apps/geolibre-desktop/src/lib/auth-gate";
import {
  CLERK_PUBLISHABLE_KEY_ENV,
  CLERK_WAITLIST_ENV,
} from "../apps/geolibre-desktop/src/lib/clerk-auth";

type Env = Record<string, string | undefined>;

const CLERK_KEY = "pk_live_Y2xlcmsuZXhhbXBsZS5jb20k";
const AUTH0 = { domain: "tenant.us.auth0.com", clientId: "aBcD1234efGh5678" };

/** An env record naming Clerk. */
function clerkEnv(waitlist?: string): Env {
  return { [CLERK_PUBLISHABLE_KEY_ENV]: CLERK_KEY, [CLERK_WAITLIST_ENV]: waitlist };
}

/** An env record naming Auth0. */
function auth0Env(): Env {
  return { [AUTH0_DOMAIN_ENV]: AUTH0.domain, [AUTH0_CLIENT_ID_ENV]: AUTH0.clientId };
}

describe("sign-in gate selection", () => {
  it("stays off when neither provider is configured", () => {
    assert.equal(resolveAuthGate(true, {}, {}), undefined);
  });

  it("selects Clerk when only Clerk is configured", () => {
    assert.deepEqual(resolveAuthGate(true, clerkEnv(), {}), {
      provider: "clerk",
      publishableKey: CLERK_KEY,
      waitlist: false,
    });
  });

  it("selects Auth0 when only Auth0 is configured", () => {
    assert.deepEqual(resolveAuthGate(true, auth0Env(), {}), { provider: "auth0", ...AUTH0 });
  });

  it("turns a build-time Clerk key's waitlist on from the deployment env", () => {
    const gate = resolveAuthGate(true, { [CLERK_WAITLIST_ENV]: "1" }, clerkEnv());
    assert.deepEqual(gate, { provider: "clerk", publishableKey: CLERK_KEY, waitlist: true });
  });

  it("keeps Clerk when both are named at the same level", () => {
    // Both in the deployment env...
    assert.equal(
      resolveAuthGate(true, { ...clerkEnv(), ...auth0Env() }, {})?.provider,
      "clerk",
      "deployment env",
    );
    // ...and both baked into the build.
    assert.equal(
      resolveAuthGate(true, {}, { ...clerkEnv(), ...auth0Env() })?.provider,
      "clerk",
      "build env",
    );
  });

  it("lets a deployment-configured provider override a build-configured one", () => {
    assert.deepEqual(resolveAuthGate(true, auth0Env(), clerkEnv()), {
      provider: "auth0",
      ...AUTH0,
    });
    assert.deepEqual(resolveAuthGate(true, clerkEnv(), auth0Env()), {
      provider: "clerk",
      publishableKey: CLERK_KEY,
      waitlist: false,
    });
  });

  it("counts either half of a split Auth0 pair as naming Auth0 at runtime", () => {
    // Only the client ID is set at runtime; the domain and a Clerk key come
    // from the build. Auth0 is still the provider the deployment asked for.
    const gate = resolveAuthGate(
      true,
      { [AUTH0_CLIENT_ID_ENV]: AUTH0.clientId },
      { ...clerkEnv(), [AUTH0_DOMAIN_ENV]: AUTH0.domain },
    );
    assert.deepEqual(gate, { provider: "auth0", ...AUTH0 });
  });

  it("completes a split Auth0 configuration across both levels", () => {
    const gate = resolveAuthGate(
      true,
      { [AUTH0_DOMAIN_ENV]: AUTH0.domain },
      { [AUTH0_CLIENT_ID_ENV]: AUTH0.clientId },
    );
    assert.deepEqual(gate, { provider: "auth0", ...AUTH0 });
  });

  it("never gates native or embedded applications", () => {
    assert.equal(resolveAuthGate(false, { ...clerkEnv(), ...auth0Env() }, {}), undefined);
  });
});
