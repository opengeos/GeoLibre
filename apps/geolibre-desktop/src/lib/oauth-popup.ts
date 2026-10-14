/**
 * Waiting for an OAuth authorization-code popup to come back through
 * `oauth-callback.html`, shared by the sign-ins that open a popup on the web
 * (ArcGIS, and plugins through the app API).
 */

import { NO_ISSUER } from "./native-share-auth";
import { validateCallbackPayload } from "./share-oauth";

const POPUP_POLL_MS = 500;

/** Why a popup sign-in ended without a code. */
export type OAuthPopupFailure = "access-denied" | "invalid-callback" | "cancelled" | "timeout";

export class OAuthPopupError extends Error {
  constructor(readonly reason: OAuthPopupFailure) {
    super(`OAuth popup sign-in failed: ${reason}`);
    this.name = "OAuthPopupError";
  }
}

/**
 * Resolve with the authorization code the popup's callback page relays.
 * Only a message from this popup, at the app's origin, carrying this flow's
 * `state` is accepted. Rejects with an {@link OAuthPopupError} when the
 * provider denies access, the callback doesn't match, the user closes the
 * popup, or `timeoutMs` passes.
 *
 * @param popup - The popup window the flow navigated to the provider.
 * @param state - The `state` sent in the authorization request.
 * @param timeoutMs - How long to wait for the user to finish.
 * @returns The authorization code.
 */
export function waitForPopupCode(popup: Window, state: string, timeoutMs: number): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let settled = false;
    const finish = (run: () => void) => {
      if (settled) return;
      settled = true;
      window.removeEventListener("message", onMessage);
      window.clearInterval(poll);
      window.clearTimeout(timer);
      run();
    };
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin || event.source !== popup) return;
      // Providers that send no `iss` bind the callback to the flow by state alone.
      const verdict = validateCallbackPayload(event.data, { state, issuer: NO_ISSUER });
      if (!verdict.ok) {
        finish(() =>
          reject(
            new OAuthPopupError(
              verdict.code === "access-denied" ? "access-denied" : "invalid-callback",
            ),
          ),
        );
        return;
      }
      finish(() => resolve(verdict.code));
    };
    const poll = window.setInterval(() => {
      if (popup.closed) finish(() => reject(new OAuthPopupError("cancelled")));
    }, POPUP_POLL_MS);
    const timer = window.setTimeout(
      () => finish(() => reject(new OAuthPopupError("timeout"))),
      timeoutMs,
    );
    window.addEventListener("message", onMessage);
  });
}
