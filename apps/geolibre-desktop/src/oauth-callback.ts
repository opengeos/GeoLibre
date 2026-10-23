// Script for oauth-callback.html, the OAuth authorization-code redirect target.
//
// One job: read the redirect's query parameters, strip them from the address
// bar (they are single-use and must not survive a reload, a copy, or the
// browser history), relay them to the opener window at the app's own origin,
// and close. The opener validates state/iss before exchanging the code — this
// page does no validation of its own beyond relaying.

const params = new URLSearchParams(window.location.search);
const payload = {
  type: "geolibre-share-oauth",
  code: params.get("code") ?? undefined,
  state: params.get("state") ?? undefined,
  iss: params.get("iss") ?? undefined,
  error: params.get("error") ?? undefined,
};

// Scrub the query first so the code leaves the address bar before anything
// else happens; the payload above already captured the values.
history.replaceState(null, "", window.location.pathname);

const status = document.getElementById("status");
const opener = window.opener as Window | null;
if (opener && !opener.closed) {
  opener.postMessage(payload, window.location.origin);
  if (status) {
    status.textContent = payload.error
      ? "Sign-in failed. You can close this window."
      : "Signed in. You can close this window.";
  }
  // Let the message flush before closing; a closed popup can drop an
  // in-flight postMessage in some engines.
  window.setTimeout(() => window.close(), 400);
} else if (status) {
  // Opened directly (no opener, e.g. the user pasted the URL): say what
  // happened instead of a blank page. There is nothing to hand a code to.
  status.textContent = payload.error
    ? "Sign-in failed. Return to GeoLibre and try again."
    : "Signed in. Return to the GeoLibre tab.";
}

// Module scope: keeps `status`/`opener` from colliding with the DOM globals
// TypeScript declares for classic (non-module) scripts.
export {};
