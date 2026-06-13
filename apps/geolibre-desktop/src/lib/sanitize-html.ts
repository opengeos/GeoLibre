import DOMPurify from "dompurify";

// Harden links that open in a new tab so the opened page cannot reach back
// through `window.opener`. DOMPurify passes `target`/`rel` through but does not
// add `rel`, so enforce it ourselves.
DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A" && node.getAttribute("target") === "_blank") {
    node.setAttribute("rel", "noopener noreferrer");
  }
});

/**
 * Sanitize a fragment of user-authored HTML for safe rendering.
 *
 * Story map titles, descriptions, and footers support inline formatting
 * (`<br>`, `<em>`, `<a>`, etc.) like the storytelling template, but a project
 * can be shared or loaded from a URL, so the markup is untrusted. DOMPurify
 * strips scripts and event-handler attributes while keeping formatting, and we
 * force external links to open in a new tab without leaking the opener.
 *
 * @param html Raw HTML string to clean.
 * @returns A sanitized HTML string safe for `dangerouslySetInnerHTML`.
 */
export function sanitizeStoryHtml(html: string): string {
  return DOMPurify.sanitize(html, {
    ADD_ATTR: ["target", "rel"],
    USE_PROFILES: { html: true },
  });
}
