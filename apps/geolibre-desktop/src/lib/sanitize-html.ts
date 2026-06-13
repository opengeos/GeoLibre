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
 * `ALLOWED_TAGS`/`ALLOWED_ATTR` whitelist only the permitted prose elements and
 * attributes (replacing DOMPurify's defaults), and the module-level hook above
 * adds `rel="noopener noreferrer"` to any `target="_blank"` link so the opener
 * cannot be leaked. `<img>` is intentionally excluded so a shared project cannot
 * embed tracking pixels in a description; chapter images use the dedicated
 * `image` field instead.
 *
 * @param html Raw HTML string to clean.
 * @returns A sanitized HTML string safe for `dangerouslySetInnerHTML`.
 */
export function sanitizeStoryHtml(html: string): string {
  // Story text is prose with links and light formatting, so allow only that set
  // of tags rather than the full HTML profile. This excludes forms, tables,
  // media, and other structural elements by construction.
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS: [
      "a", "abbr", "b", "blockquote", "br", "code", "del", "em",
      "h1", "h2", "h3", "h4", "h5", "h6", "hr", "i", "ins", "kbd",
      "li", "mark", "ol", "p", "pre", "s", "small", "span", "strong",
      "sub", "sup", "u", "ul",
    ],
    ALLOWED_ATTR: ["href", "title", "target", "rel"],
  });
}
