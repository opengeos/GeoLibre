/**
 * The assistant's shared TypeSafe System One transport.
 *
 * Two features ask Jev typed questions rather than asking an LLM to generate
 * text: {@link ../fast-path} routes a simple map command straight to a tool,
 * and {@link ../catalog-select} picks Whitebox tools out of a 775-entry
 * catalog. They ask very different questions but need exactly the same
 * plumbing — where to send them, how to authenticate, what a failure means —
 * so it lives here once.
 *
 * The one rule both features inherit: **a System One request can only make an
 * assistant turn better, never fail one.** Every error mode — no credential, a
 * refused origin, a timeout, malformed JSON — resolves to null, and the caller
 * falls back to whatever it would have done without this module.
 */

/** The TypeSafe endpoint. Overridable for tests and self-hosted proxies. */
export const TYPESAFE_ENDPOINT = "https://api.typesafe.ai/v1/systemone";

/**
 * Hard cap on options in one Choice question, enforced by the TypeSafe API
 * (`Too many choices. Must have at most 255 choices.`).
 *
 * Both callers build questions whose option count scales with data they do not
 * control — the user's layer list, the catalog's largest category — so both
 * have to measure against this rather than assume they fit.
 */
export const SYSTEM_ONE_MAX_CHOICES = 255;

/** One typed answer, as a System One response carries it. */
export interface SystemOneAnswer {
  choice?: string;
  noul?: number;
  score?: number;
  confidence?: number;
  /**
   * The full distribution over a Choice question's options.
   *
   * `choice` is only its argmax. Reading the distribution is what lets
   * `catalog-select` carry several candidate categories forward instead of
   * betting the whole lookup on one pick.
   */
  probabilities?: Record<string, number>;
}

/** The answers map from a System One response. */
export type SystemOneAnswers = Record<string, SystemOneAnswer | undefined>;

/** The transport used to reach TypeSafe, injectable for tests. */
export type SystemOneFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

/** Where questions are sent, and how they authenticate. */
export interface SystemOneEndpoint {
  url: string;
  /**
   * Bearer credential, or null when the endpoint supplies its own.
   *
   * The managed proxy holds the TypeSafe key server-side — nginx injects the
   * instance token and the Worker attaches the credential — so the browser
   * sends no `Authorization` at all, exactly as it does for managed chat.
   */
  apiKey: string | null;
}

/**
 * Resolve a same-origin `/path` against the page origin.
 *
 * A reverse proxy in front of the app is configured as a path, and browser
 * `fetch` resolves that itself — but Tauri's native HTTP client, which is the
 * only transport that can reach TypeSafe on the desktop, requires an absolute
 * URL. Doing it here rather than at config time covers every route into this
 * function, including the runtime env map that is rebuilt without an origin.
 */
function absoluteUrl(url: string): string {
  if (!url.startsWith("/")) return url;
  const origin = globalThis.location?.origin;
  return origin && origin !== "null" ? new URL(url, origin).toString().replace(/\/+$/, "") : url;
}

/**
 * Whether an endpoint may be used, given the scheme it was configured with.
 *
 * What travels to System One is the user's prompt, their layer names and their
 * catalog searches, and what comes back decides which tool the assistant runs
 * — including, on the fast path, `remove_layer`. Over cleartext an on-path
 * observer reads the first and rewrites the second, so plain HTTP is refused.
 *
 * Two carve-outs, both cases where HTTPS would add nothing:
 *
 * - **Loopback.** `http://127.0.0.1:5173/systemone` is the dev server's own
 *   proxy route. There is no network hop to observe.
 * - **Same origin as the page.** A self-hosted deployment served over plain
 *   HTTP on an internal network resolves `/systemone` against its own origin.
 *   Refusing that would disable the feature for them while protecting nothing:
 *   an attacker positioned to read this request is already reading the app
 *   itself, the prompt as it was typed, and the project as it loads.
 *
 * A malformed URL is refused rather than passed to `fetch` to fail later.
 */
function isAllowedEndpointUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol === "https:") return true;
  if (parsed.protocol !== "http:") return false;

  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host === "::1" || /^127\./.test(host)) return true;
  return parsed.origin === globalThis.location?.origin;
}

/**
 * Decide where to send questions, or null when System One is not configured.
 *
 * A managed proxy wins over a personal credential: where an operator has
 * configured one, it is the only route that works in a browser at all, since
 * `api.typesafe.ai` refuses the app's origin outright.
 *
 * The env names still say `FAST_PATH` because they are deployment
 * configuration that predates the catalog lookup, and renaming them would
 * silently disable the feature on every deployment that already sets them.
 * They select the System One endpoint as a whole, not one feature.
 */
export function resolveSystemOneEndpoint(env: Record<string, string>): SystemOneEndpoint | null {
  // An explicit routing endpoint wins over everything. It is what a dev server
  // or a self-hosted deployment points at its own token-injecting proxy, and it
  // is deliberately separate from the chat proxy: the two can live in different
  // places, and a deployment may want routing without changing where chat goes.
  // The endpoint supplies its own credential, so no Authorization is sent.
  const explicit = env.GEOLIBRE_FAST_PATH_URL?.trim().replace(/\/+$/, "");
  if (explicit) return allowed({ url: absoluteUrl(explicit), apiKey: null });

  const proxy = env.GEOLIBRE_AI_PROXY_BASE_URL?.trim().replace(/\/+$/, "");
  if (proxy) {
    // The proxy base is normalized to end in `/v1` because it doubles as an
    // OpenAI-compatible chat base URL (`managedProxyBaseUrl`). On the Worker,
    // `/systemone` is a root-level route — a sibling of `/v1/chat/completions`,
    // alongside `/search` and `/tavily` — so that suffix has to come off first.
    const root = proxy.replace(/\/v1$/, "");
    return allowed({ url: absoluteUrl(`${root}/systemone`), apiKey: null });
  }

  const key = env.JEV_API_KEY?.trim();
  return key ? { url: TYPESAFE_ENDPOINT, apiKey: key } : null;
}

/**
 * Pass an endpoint through, or refuse it for its scheme.
 *
 * Refusing is loud, unlike every other stand-down in this module: a deployment
 * that configured an endpoint and silently never uses it has no way to find out
 * why, and the reason here is a fixable misconfiguration rather than a service
 * being unavailable.
 */
function allowed(endpoint: SystemOneEndpoint): SystemOneEndpoint | null {
  if (isAllowedEndpointUrl(endpoint.url)) return endpoint;
  console.warn(
    `[GeoLibre] Ignoring the System One endpoint ${endpoint.url}: it is plain HTTP on another` +
      " origin, which would expose prompts and let a response be rewritten. Use HTTPS.",
  );
  return null;
}

/**
 * Statuses that mean "this endpoint will never serve System One".
 *
 * 503 is what the proxy returns when the operator never set a TypeSafe
 * credential; 404 is an older proxy with no `/systemone` route at all. Neither
 * changes while the app is running.
 */
const UNAVAILABLE_STATUSES = new Set([404, 503]);

/**
 * Endpoints that answered "not configured", so later requests skip them.
 *
 * `GEOLIBRE_AI_PROXY_BASE_URL` is set on *every* managed deployment, whether or
 * not its operator enabled System One, and the fast path runs on every prompt.
 * So without this, a deployment that never opted in would pay a round trip —
 * and a rate-limit token — per message, forever. One wasted request per session
 * is the right price for discovering that; one per message is not.
 *
 * Shared across features on purpose: an endpoint that has no credential has
 * none for the catalog lookup either, so whichever feature discovers it first
 * spares the other the same wasted round trip.
 *
 * Deliberately narrow: only the statuses above disable an endpoint. A timeout,
 * a network blip or a 500 leaves it enabled, because those do recover.
 */
const unavailableEndpoints = new Set<string>();

/** Whether this endpoint has already reported itself unconfigured. */
export function isSystemOneUnavailable(endpoint: SystemOneEndpoint): boolean {
  return unavailableEndpoints.has(endpoint.url);
}

/** Forget which endpoints reported themselves unconfigured. Exported for tests. */
export function resetSystemOneAvailability(): void {
  unavailableEndpoints.clear();
}

/** Longest name interpolated into a question's criteria. */
const MAX_CRITERION_NAME_LENGTH = 80;

/**
 * Flatten a name for safe use inside a question.
 *
 * Names reach the criteria from places the user does not necessarily control —
 * a shared `.geolibre.json`, a remote service's layer list, a catalog snapshot
 * — and they are interpolated into the text the classifier reads. Collapsing
 * newlines and control characters and capping the length keeps a name from
 * being shaped into instructions that argue for a different option.
 *
 * This bounds the surface rather than closing it. The real guarantee is that
 * both callers only ever act on an id that was already in the data they built
 * the question from, so the worst a crafted name can do is argue for another
 * of the user's own options.
 */
export function flattenCriterionName(name: string, maxLength = MAX_CRITERION_NAME_LENGTH): string {
  const flattened = name
    .replace(/[\p{C}\p{Zl}\p{Zp}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return flattened.length > maxLength ? `${flattened.slice(0, maxLength)}…` : flattened;
}

/** One System One request. */
export interface SystemOneRequest {
  endpoint: SystemOneEndpoint;
  fetchImpl: SystemOneFetch;
  /** The `state` the questions are asked against. */
  state: unknown;
  /** The `questions` map, keyed by ids the caller reads back. */
  questions: Record<string, unknown>;
  /** Abort budget for this request. */
  timeoutMs: number;
  /** Cancels the request when the surrounding run is cancelled. */
  signal?: AbortSignal;
}

/**
 * Ask one request's worth of questions, returning the answers or null.
 *
 * @returns The `answers` map, or null for any reason at all — an unconfigured
 *   endpoint, a cancelled run, a timeout, a transport error, a malformed body.
 *   Callers are expected to treat all of those identically.
 */
export async function postSystemOne(request: SystemOneRequest): Promise<SystemOneAnswers | null> {
  const { endpoint, fetchImpl, state, questions, timeoutMs, signal } = request;
  if (!endpoint?.url || isSystemOneUnavailable(endpoint)) return null;

  // An `abort` listener only catches an abort that has not happened yet. The
  // caller can already be cancelled by the time this runs — on desktop the
  // transport is resolved by dynamic import first, which is a real async gap to
  // press Stop in — and attaching a listener after the event has fired would
  // let the request go out anyway.
  if (signal?.aborted) return null;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort);

  try {
    const response = await fetchImpl(endpoint.url, {
      method: "POST",
      headers: {
        ...(endpoint.apiKey ? { Authorization: `Bearer ${endpoint.apiKey}` } : {}),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: "jev-latest", state, questions }),
      signal: controller.signal,
    });
    if (!response.ok) {
      if (UNAVAILABLE_STATUSES.has(response.status)) unavailableEndpoints.add(endpoint.url);
      return null;
    }
    const body = (await response.json()) as { answers?: SystemOneAnswers };
    return body?.answers ?? null;
  } catch {
    // Timed out, offline, origin refused, malformed JSON — all the same answer.
    return null;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
  }
}
