import { AUTH0_CLIENT_ID_ENV, AUTH0_DOMAIN_ENV, resolveAuth0Config } from "./auth0-auth";
import {
  CLERK_PUBLISHABLE_KEY_ENV,
  resolveClerkPublishableKey,
  resolveClerkWaitlistEnabled,
} from "./clerk-auth";
import { readDeploymentEnv, readDeploymentEnvValue, type EnvRecord } from "./deployment-env";

/** Which optional sign-in gate a hosted deployment has configured, if any. */
export type AuthGateConfig =
  | { provider: "clerk"; publishableKey: string; waitlist: boolean }
  | { provider: "auth0"; domain: string; clientId: string };

/**
 * Pick the sign-in gate for a web deployment.
 *
 * Clerk and Auth0 are configured independently and only one is ever loaded, so
 * a deployment that names both needs a rule. It is the same rule the individual
 * settings already follow (see deployment-env.ts): the deployment env is the
 * more specific statement, so a provider named there wins over one baked into
 * the build. Naming both at the same level keeps Clerk, which shipped first —
 * an image built with a Clerk key must not switch providers on its own. The
 * Docker entrypoint refuses to boot when both are passed at runtime, so that
 * tie only arises from build-time environment variables.
 *
 * @param webApp - Whether this is the hosted web build. Must be derived from
 *   the build target alone: a runtime signal the visitor controls (`?embed=1`)
 *   would let anyone switch a configured gate off.
 * @param deploymentEnv - Runtime env; defaults to the value on `window`.
 * @param buildEnv - Build-time env; defaults to `import.meta.env`.
 * @returns The provider and its settings, or undefined when no gate is configured.
 */
export function resolveAuthGate(
  webApp: boolean,
  deploymentEnv?: EnvRecord,
  buildEnv?: EnvRecord,
): AuthGateConfig | undefined {
  if (!webApp) return undefined;
  const deployment = deploymentEnv ?? readDeploymentEnv();
  const build = buildEnv ?? (import.meta.env as EnvRecord);

  const clerkKey = resolveClerkPublishableKey(true, deployment, build);
  const auth0 = resolveAuth0Config(true, deployment, build);

  const clerk = (): AuthGateConfig => ({
    provider: "clerk",
    publishableKey: clerkKey!,
    // Resolved across both tiers rather than the winning one, so a build-time
    // key can still have its waitlist screen turned on at runtime.
    waitlist: resolveClerkWaitlistEnabled(true, deployment, build),
  });

  if (clerkKey && auth0) {
    // Raw presence, not a full resolve: this only asks which tier *named* the
    // provider. Re-resolving would re-report a partial Auth0 configuration that
    // the merged read above already completed from the build env.
    const clerkNamedAtRuntime = Boolean(
      readDeploymentEnvValue(CLERK_PUBLISHABLE_KEY_ENV, deployment, {}),
    );
    // Either half counts: the pair can be split across the two tiers, so a
    // deployment that supplies only the client ID at runtime has still named
    // Auth0 there, and checking the domain alone would hand it back to Clerk.
    const auth0NamedAtRuntime =
      Boolean(readDeploymentEnvValue(AUTH0_DOMAIN_ENV, deployment, {})) ||
      Boolean(readDeploymentEnvValue(AUTH0_CLIENT_ID_ENV, deployment, {}));
    if (auth0NamedAtRuntime && !clerkNamedAtRuntime) return { provider: "auth0", ...auth0 };
    return clerk();
  }
  if (clerkKey) return clerk();
  if (auth0) return { provider: "auth0", ...auth0 };
  return undefined;
}
