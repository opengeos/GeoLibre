import { IS_MAS_BUILD } from "../build-flags";
import { isTauri } from "../is-tauri";
import type { DiscoveredModel } from "./model-discovery";

/**
 * Sign in with ChatGPT for the AI Assistant: the user's ChatGPT plan pays for
 * the assistant instead of an API key, through OpenAI's Sign in with ChatGPT
 * for open-source apps (https://developers.openai.com/siwc/token-sharing-open-source).
 *
 * Desktop only. The sign-in, the tokens and every request live in the Tauri
 * backend (`src-tauri/src/chatgpt_auth.rs`); no token ever reaches the webview,
 * where external plugins run. {@link chatGptFetch} hands each request to the
 * backend, which authorizes it and streams the reply back.
 */

/** The Responses API the plan's sign-in is for. */
export const CHATGPT_API_BASE = "https://api.openai.com/v1";

/** Where the user sees and limits the plan's usage, or disconnects GeoLibre. */
export const CHATGPT_USAGE_URL = "https://chatgpt.com/settings/usage?tab=overview";

/**
 * The OpenAI SDK requires an API key; the backend replaces the Authorization
 * header with the signed-in account's access token, so this is only a marker.
 */
export const CHATGPT_KEY_PLACEHOLDER = "chatgpt-sign-in";

/** The window event other parts of the app already refresh their provider state on. */
const RUNTIME_ENV_EVENT = "geolibre:runtime-env-change";

/** Who is signed in, as the backend reports it. */
export interface ChatGptStatus {
  signedIn: boolean;
  email: string;
  /** The grant lets GeoLibre use the plan (`chatgpt.tokens.use.direct`). */
  planAllowed: boolean;
  /** A registration is saved, so the next sign-in reuses its issued client id. */
  registered: boolean;
  /** The sign-in is kept in the OS keychain (false: for this session only). */
  remembered: boolean;
  signingIn: boolean;
}

const SIGNED_OUT: ChatGptStatus = {
  signedIn: false,
  email: "",
  planAllowed: false,
  registered: false,
  remembered: false,
  signingIn: false,
};

let status: ChatGptStatus = SIGNED_OUT;
let loaded = false;
const listeners = new Set<() => void>();

/**
 * Whether this build can sign in with ChatGPT: the desktop app, outside the
 * Mac App Store (whose sandbox build may not open a loopback listener).
 *
 * @returns True in a desktop build with the sign-in compiled in.
 */
export function isChatGptSignInAvailable(): boolean {
  return isTauri() && !IS_MAS_BUILD;
}

/** The last known status (signed out until {@link refreshChatGptStatus} runs). */
export function getChatGptStatus(): ChatGptStatus {
  return status;
}

/**
 * Whether the assistant can send requests with the signed-in plan right now.
 *
 * @returns True when signed in and the plan's use was allowed.
 */
export function isChatGptReady(): boolean {
  return status.signedIn && status.planAllowed;
}

/**
 * Subscribe to status changes (for `useSyncExternalStore`).
 *
 * @param listener Called after every change.
 * @returns A function that unsubscribes.
 */
export function subscribeChatGptStatus(listener: () => void): () => void {
  listeners.add(listener);
  if (!loaded && isChatGptSignInAvailable()) void refreshChatGptStatus();
  return () => listeners.delete(listener);
}

/**
 * Replace the known status and notify subscribers. When readiness changes the
 * app-wide runtime-env event fires too, so the assistant re-checks which
 * providers are configured and rebuilds its agent.
 *
 * @param next The new status.
 */
export function applyChatGptStatus(next: ChatGptStatus): void {
  const wasReady = isChatGptReady();
  status = { ...SIGNED_OUT, ...next };
  loaded = true;
  for (const listener of listeners) listener();
  if (wasReady !== isChatGptReady() && typeof window !== "undefined") {
    window.dispatchEvent(new Event(RUNTIME_ENV_EVENT));
  }
}

async function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke: tauriInvoke } = await import("@tauri-apps/api/core");
  return tauriInvoke<T>(command, args);
}

/**
 * Read the sign-in status from the backend.
 *
 * @returns The current status (signed out where the sign-in is unavailable).
 */
export async function refreshChatGptStatus(): Promise<ChatGptStatus> {
  if (!isChatGptSignInAvailable()) return status;
  try {
    applyChatGptStatus(await invoke<ChatGptStatus>("chatgpt_status"));
  } catch (cause) {
    console.error("[GeoLibre] Could not read the ChatGPT sign-in", cause);
    applyChatGptStatus(SIGNED_OUT);
  }
  return status;
}

/** Options for {@link signInWithChatGpt}. */
export interface ChatGptSignInOptions {
  /** Forget the saved registration and register for whichever account signs in. */
  anotherAccount?: boolean;
  /** Called with the authorization page once the listener is ready. */
  onUrl?: (url: string) => void;
  /** Stops waiting (and cancels the sign-in in the backend). */
  signal?: AbortSignal;
}

const POLL_MS = 1000;

/**
 * Open OpenAI's sign-in page in the system browser and wait until the browser
 * comes back to GeoLibre's loopback listener (or the attempt fails).
 *
 * @param options Account choice, URL callback and cancellation.
 * @returns The status after the sign-in.
 * @throws When the sign-in fails, times out or is cancelled.
 */
export async function signInWithChatGpt(
  options: ChatGptSignInOptions = {},
): Promise<ChatGptStatus> {
  const { url } = await invoke<{ url: string }>("chatgpt_sign_in_start", {
    anotherAccount: Boolean(options.anotherAccount),
  });
  applyChatGptStatus({
    ...status,
    signingIn: true,
    registered: !options.anotherAccount && status.registered,
  });
  options.onUrl?.(url);
  await openChatGptPage(url);
  try {
    for (;;) {
      if (options.signal?.aborted) {
        await invoke("chatgpt_sign_in_cancel");
        throw new DOMException("The sign-in was cancelled.", "AbortError");
      }
      const poll = await invoke<{ state: string; error?: string | null }>("chatgpt_sign_in_poll");
      if (poll.state === "done") break;
      if (poll.state === "failed") throw new Error(poll.error || "The sign-in failed.");
      if (poll.state === "idle") throw new DOMException("The sign-in was cancelled.", "AbortError");
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
  } finally {
    await refreshChatGptStatus();
  }
  return status;
}

/**
 * Open a page in the system browser.
 *
 * @param url The page to open.
 */
export async function openChatGptPage(url: string): Promise<void> {
  const { openUrl } = await import("@tauri-apps/plugin-opener");
  await openUrl(url);
}

/** Stop a sign-in under way. */
export async function cancelChatGptSignIn(): Promise<void> {
  await invoke("chatgpt_sign_in_cancel");
  await refreshChatGptStatus();
}

/**
 * Sign out: the tokens are forgotten here and revoked at OpenAI.
 *
 * @param forget Also forget the registration, so the next sign-in can be another account.
 * @returns Whether OpenAI confirmed the revocation.
 */
export async function signOutOfChatGpt(forget = false): Promise<{ revoked: boolean }> {
  try {
    return await invoke<{ revoked: boolean }>("chatgpt_sign_out", { forget });
  } finally {
    await refreshChatGptStatus();
  }
}

/**
 * The backend route a request URL maps to: only the Responses API and the
 * model list are reachable with the plan's sign-in.
 *
 * @param url The URL the OpenAI SDK asked for.
 * @returns `responses`, `models`, or null for anything else.
 */
export function chatGptRoute(url: string): "responses" | "models" | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.origin !== new URL(CHATGPT_API_BASE).origin) return null;
  if (parsed.pathname === "/v1/responses") return "responses";
  if (parsed.pathname === "/v1/models") return "models";
  return null;
}

function decodeBase64(data: string): Uint8Array {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

type ChatGptEvent =
  | { event: "head"; status: number; contentType: string }
  | { event: "chunk"; data: string }
  | { event: "end" };

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

async function requestBody(body: BodyInit | null | undefined): Promise<string | undefined> {
  if (body === null || body === undefined) return undefined;
  if (typeof body === "string") return body;
  return new Response(body).text();
}

/**
 * A `fetch` for the OpenAI SDK that sends the request through the signed-in
 * ChatGPT account. The backend puts on the access token (renewing it when it
 * expires) and streams the reply back over a Tauri channel, so streamed
 * Responses API replies arrive as they are generated. Any header the SDK set,
 * the placeholder Authorization included, stays behind.
 *
 * @param input The request URL (only the Responses API and model list).
 * @param init The method, body and abort signal.
 * @returns The reply, its body streaming.
 */
export async function chatGptFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const route = chatGptRoute(requestUrl(input));
  if (!route) throw new TypeError("This request can't use the ChatGPT sign-in.");
  const body = await requestBody(init?.body);
  const signal = init?.signal ?? undefined;
  if (signal?.aborted) throw new DOMException("The request was aborted.", "AbortError");
  const { invoke: tauriInvoke, Channel } = await import("@tauri-apps/api/core");
  const requestId =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

  return new Promise<Response>((resolve, reject) => {
    let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
    let settled = false;
    let finished = false;
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
      },
      cancel() {
        if (!finished) void tauriInvoke("chatgpt_request_cancel", { requestId });
      },
    });
    const fail = (error: unknown) => {
      if (finished) return;
      finished = true;
      if (!settled) {
        settled = true;
        reject(error);
      } else {
        try {
          controller?.error(error);
        } catch {
          // Already closed by the reader.
        }
      }
    };
    const onAbort = () => {
      void tauriInvoke("chatgpt_request_cancel", { requestId });
      fail(new DOMException("The request was aborted.", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    const channel = new Channel<ChatGptEvent>();
    channel.onmessage = (message) => {
      if (finished) return;
      if (message.event === "head") {
        settled = true;
        resolve(
          new Response(stream, {
            status: message.status,
            headers: message.contentType ? { "content-type": message.contentType } : {},
          }),
        );
      } else if (message.event === "chunk") {
        controller?.enqueue(decodeBase64(message.data));
      } else if (message.event === "end") {
        finished = true;
        signal?.removeEventListener("abort", onAbort);
        controller?.close();
      }
    };

    tauriInvoke("chatgpt_request", { requestId, path: route, body, events: channel }).then(
      () => {
        // The End event closes the body; nothing else to do.
      },
      (cause: unknown) => {
        signal?.removeEventListener("abort", onAbort);
        fail(new Error(typeof cause === "string" ? cause : String(cause)));
      },
    );
  });
}

/** An id with a control character could not be sent back and would garble the UI. */
function hasControlCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * The models a ChatGPT plan offers, in the catalog's order (the first is the
 * one to suggest). The plan's catalog lists models by `slug` with a
 * `visibility`; a plain OpenAI `data` list is read too.
 *
 * @param json The model list reply.
 * @returns The visible models.
 */
export function parseChatGptCatalog(json: unknown): DiscoveredModel[] {
  const root = (json ?? {}) as {
    models?: { slug?: unknown; visibility?: unknown; display_name?: unknown }[];
    data?: { id?: unknown }[];
  };
  const seen = new Set<string>();
  const models: DiscoveredModel[] = [];
  const add = (id: unknown, name: unknown) => {
    if (typeof id !== "string" || !id.trim() || hasControlCharacter(id) || seen.has(id)) return;
    seen.add(id);
    models.push({ id, name: typeof name === "string" && name.trim() ? name : id });
  };
  if (Array.isArray(root.models)) {
    for (const model of root.models) {
      if (model?.visibility !== undefined && model.visibility !== "list") continue;
      add(model?.slug, model?.display_name);
    }
  } else if (Array.isArray(root.data)) {
    for (const model of root.data) add(model?.id, model?.id);
  }
  return models.slice(0, 2000);
}

/**
 * Load the signed-in account's model catalog.
 *
 * @param signal Cancels the request.
 * @returns The plan's models, in catalog order.
 */
export async function discoverChatGptModels(signal?: AbortSignal): Promise<DiscoveredModel[]> {
  const response = await chatGptFetch(`${CHATGPT_API_BASE}/models`, { signal });
  const text = await response.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    // Reported below.
  }
  if (!response.ok) {
    const message =
      (json as { error?: { message?: string } } | null)?.error?.message ??
      `HTTP ${response.status}`;
    throw new Error(message);
  }
  return parseChatGptCatalog(json);
}

/** Reset the module state (tests only). */
export function resetChatGptStatusForTests(next: Partial<ChatGptStatus> = {}): void {
  status = { ...SIGNED_OUT, ...next };
  loaded = true;
}
