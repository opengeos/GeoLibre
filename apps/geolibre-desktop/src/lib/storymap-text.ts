/**
 * Plain-text helpers for story-map text (GH #830).
 *
 * Kept apart from `storymap-pdf.ts` so the handout dialog can use them without
 * importing jsPDF, which then loads only when a handout is exported.
 */

/**
 * Named HTML entities a WYSIWYG story editor commonly emits, mapped to their
 * characters. Numeric entities (`&#160;`, `&#xA0;`) are handled separately.
 * Runs in Node for tests too, so this cannot rely on the DOM to decode.
 */
const HTML_ENTITIES: Record<string, string> = {
  nbsp: " ",
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  mdash: "—",
  ndash: "–",
  hellip: "…",
  ldquo: "“",
  rdquo: "”",
  lsquo: "‘",
  rsquo: "’",
  laquo: "«",
  raquo: "»",
  copy: "©",
  reg: "®",
  trade: "™",
  deg: "°",
};

/** Decode the named and numeric HTML entities in a string to their characters. */
function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-f]+|[a-z][a-z0-9]*);/gi, (match, body) => {
    if (body[0] === "#") {
      const code =
        body[1] === "x" || body[1] === "X"
          ? parseInt(body.slice(2), 16)
          : parseInt(body.slice(1), 10);
      // Guard the Unicode range: fromCodePoint throws (RangeError) above
      // 0x10FFFF (which would abort the export), and a code point of 0 would
      // insert a null byte that can corrupt the PDF text stream. Both are HTML
      // "parse errors", so leave the token as-is.
      return Number.isInteger(code) && code >= 1 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : match;
    }
    const named = HTML_ENTITIES[body.toLowerCase()];
    return named ?? match;
  });
}

/** Remove complete script/style blocks without retrying from every opening `<`. */
function stripRawTextBlocks(text: string): string {
  const lower = text.toLowerCase();
  const lastClose: Record<"script" | "style", number> = {
    script: lower.lastIndexOf("</script>"),
    style: lower.lastIndexOf("</style>"),
  };
  const output: string[] = [];
  let plainStart = 0;
  let searchFrom = 0;
  const hasTagName = (open: number, candidate: "script" | "style"): boolean => {
    if (!lower.startsWith(`<${candidate}`, open)) return false;
    const boundary = lower[open + candidate.length + 1];
    return boundary === ">" || boundary === "/" || /\s/.test(boundary ?? "");
  };

  for (;;) {
    const open = lower.indexOf("<", searchFrom);
    if (open === -1) break;
    const name = hasTagName(open, "script") ? "script" : hasTagName(open, "style") ? "style" : null;
    if (name === null || lastClose[name] <= open) {
      searchFrom = open + 1;
      continue;
    }

    const openEnd = lower.indexOf(">", open + name.length + 1);
    if (openEnd === -1) break;
    const closeToken = `</${name}>`;
    const close = lower.indexOf(closeToken, openEnd + 1);
    if (close === -1) {
      // The last closing token was swallowed by this malformed opening tag, so
      // no later block of the same type can be complete.
      lastClose[name] = -1;
      searchFrom = open + 1;
      continue;
    }

    output.push(text.slice(plainStart, open));
    plainStart = close + closeToken.length;
    searchFrom = plainStart;
  }

  output.push(text.slice(plainStart));
  return output.join("");
}

/**
 * Strip complete HTML-like tags in one pass while respecting quoted `>`.
 *
 * A regex that retries at every `<` becomes quadratic when no `>` follows.
 * When another unquoted `<` appears before a closing `>`, keep the malformed
 * prefix as text and treat the newer `<` as the start of a possible tag.
 * A raw `<` inside an attribute is likewise treated as malformed; valid HTML
 * escapes that character as `&lt;`, which is decoded after tags are stripped.
 */
function stripTags(text: string): string {
  const output: string[] = [];
  let plainStart = 0;
  let tagStart = -1;
  let quote: '"' | "'" | null = null;

  const closesBeforeNextTag = (start: number, delimiter: '"' | "'"): boolean => {
    for (let index = start; index < text.length; index += 1) {
      if (text[index] === delimiter) return true;
      if (text[index] === "<") return false;
    }
    return false;
  };

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (tagStart === -1) {
      if (character === "<") tagStart = index;
      continue;
    }

    if (quote !== null) {
      if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") {
      // Only enter quote mode when the delimiter closes before another tag can
      // begin. This lets malformed attribute quotes degrade locally instead of
      // consuming unrelated quoted text and well-formed tags later on.
      if (closesBeforeNextTag(index + 1, character)) quote = character;
    } else if (character === "<") {
      output.push(text.slice(plainStart, index));
      plainStart = index;
      tagStart = index;
    } else if (character === ">") {
      output.push(text.slice(plainStart, tagStart));
      plainStart = index + 1;
      tagStart = -1;
    }
  }

  output.push(text.slice(plainStart));
  return output.join("");
}

/**
 * Reduce an HTML (or plain) chapter description to single-spaced plain text.
 *
 * Block-level tags become line breaks, remaining tags are dropped, and named
 * and numeric HTML entities are decoded so the handout reads cleanly. This is
 * presentation-only (the text is drawn, never parsed as HTML), so a permissive
 * strip is sufficient.
 *
 * @param html The chapter description, possibly containing HTML.
 * @returns Plain text with normalized whitespace.
 */
export function htmlToPlainText(html: string): string {
  return decodeEntities(
    stripTags(
      stripRawTextBlocks(html)
        .replace(/<\s*br\s*(?:\/\s*)?>/gi, "\n")
        .replace(/<\/\s*(p|div|li|h[1-6]|tr)\s*>/gi, "\n"),
    ),
  )
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .trim();
}

/** Reduce HTML/multi-line text to a single line of plain text for headers. */
export function singleLine(value: string): string {
  return htmlToPlainText(value)
    .replace(/\s*\n\s*/g, " ")
    .trim();
}
