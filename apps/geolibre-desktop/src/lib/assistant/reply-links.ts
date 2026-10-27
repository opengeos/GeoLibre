/** The part of a click event the transcript's link handler reads. */
export interface ReplyLinkClick {
  target: EventTarget | null;
  preventDefault(): void;
}

/**
 * Open a link clicked in an assistant reply outside the app. Left alone, the
 * click navigates GeoLibre's own webview: on the desktop the page replaces the
 * app with no way back, on the web the tab leaves GeoLibre.
 *
 * Every link click is cancelled, but only an absolute http(s) `href` is handed
 * to `open`: an in-page `#fragment` would replace the URL fragment that carries
 * an inline project (and `link.href` would resolve it to GeoLibre's own URL),
 * and other schemes have nowhere safe to go.
 *
 * @param event The click on the transcript.
 * @param open Opens a URL outside the app, e.g. `openExternalLink`.
 * @returns Whether the click was on a link.
 */
export function openReplyLink(event: ReplyLinkClick, open: (url: string) => void): boolean {
  const target = event.target as { closest?: (selector: string) => Element | null } | null;
  const link = target?.closest?.("a[href]");
  if (!link) return false;
  event.preventDefault();
  const href = link.getAttribute("href") ?? "";
  if (/^https?:\/\//i.test(href)) open(href);
  return true;
}
