import DOMPurify from "dompurify";

// Harden links that open in a new tab so the opened page cannot reach back
// through `window.opener`. DOMPurify passes `target`/`rel` through but does not
// add `rel`, so enforce it ourselves. The flag lives on the DOMPurify singleton
// so a re-evaluated module (HMR, dynamic import) cannot register it twice.
const purify = DOMPurify as typeof DOMPurify & { __glRelHook?: boolean };
if (!purify.__glRelHook) {
  purify.addHook("afterSanitizeAttributes", (node) => {
    if (node.tagName === "A" && node.getAttribute("target") === "_blank") {
      node.setAttribute("rel", "noopener noreferrer");
    }
  });
  purify.__glRelHook = true;
}

/**
 * Sanitize a fragment of user-authored HTML for safe rendering.
 *
 * Story map titles, descriptions, and footers support inline formatting
 * (`<br>`, `<em>`, `<a>`, etc.) like the storytelling template, but a project
 * can be shared or loaded from a URL, so the markup is untrusted. DOMPurify
 * strips scripts and event-handler attributes while keeping formatting;
 * `ADD_ATTR` keeps author-provided `target`/`rel`, and the module-level hook
 * above adds `rel="noopener noreferrer"` to any `target="_blank"` link so the
 * opener cannot be leaked.
 *
 * @param html Raw HTML string to clean.
 * @returns A sanitized HTML string safe for `dangerouslySetInnerHTML`.
 */
export function sanitizeStoryHtml(html: string): string {
  return DOMPurify.sanitize(html, {
    ADD_ATTR: ["target", "rel"],
    USE_PROFILES: { html: true },
    // Story text is prose/links/images; forms add no value and `target` on a
    // form is an exfiltration vector, so drop form controls entirely.
    FORBID_TAGS: ["form", "input", "button", "select", "option", "textarea"],
  });
}
