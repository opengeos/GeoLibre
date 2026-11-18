/**
 * Text measurement and truncation for the chart SVGs. Kept free of React so it
 * can be unit-tested on its own; `chart-view` uses it to fit axis and category
 * labels into the space a chart actually has.
 */

/** Font size, in CSS pixels, of every chart tick and category label. */
export const CHART_LABEL_FONT_SIZE = 11;

/** Measures the rendered width of `text` in CSS pixels. */
export type TextMeasurer = (text: string) => number;

const ELLIPSIS = "…";

// Code points that render about one em wide: CJK ideographs, kana, Hangul and
// the fullwidth forms.
const WIDE = /[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿ꀀ-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]|[\u{20000}-\u{3FFFD}]/u;
// Marks that combine with the previous character take no width of their own.
const MARK = /\p{M}|[​-‏⁠]/u;
const NARROW = /[\s.,:;'|!ijlIft()[\]]/;
const BROAD = /[MWmw@%]/;

/**
 * Estimate the width of `text` set at `fontSize` px without a layout engine,
 * from per-character em widths of a typical UI sans-serif. Errs slightly wide
 * so a label truncated against it still fits when measured for real.
 *
 * @param text The text to measure.
 * @param fontSize Font size in CSS pixels.
 * @returns The approximate width in CSS pixels.
 */
export function approximateTextWidth(text: string, fontSize = CHART_LABEL_FONT_SIZE): number {
  let ems = 0;
  for (const char of text) {
    if (MARK.test(char)) continue;
    if (WIDE.test(char)) ems += 1;
    else if (NARROW.test(char)) ems += 0.3;
    else if (BROAD.test(char)) ems += 0.85;
    else if (char >= "A" && char <= "Z") ems += 0.66;
    else ems += 0.58;
  }
  return ems * fontSize;
}

let canvasContext: CanvasRenderingContext2D | null | undefined;

/**
 * Build a measurer for chart labels at `fontSize` px. Uses a canvas 2D
 * context's `measureText` with the document's own font when one is available,
 * and falls back to {@link approximateTextWidth} (tests, or a browser without
 * canvas text metrics).
 *
 * @param fontSize Font size in CSS pixels.
 * @returns A function returning the width of a string in CSS pixels.
 */
export function createTextMeasurer(fontSize = CHART_LABEL_FONT_SIZE): TextMeasurer {
  const fallback: TextMeasurer = (text) => approximateTextWidth(text, fontSize);
  if (typeof document === "undefined") return fallback;
  if (canvasContext === undefined) {
    try {
      canvasContext = document.createElement("canvas").getContext("2d");
    } catch {
      canvasContext = null;
    }
  }
  const ctx = canvasContext;
  if (!ctx || typeof ctx.measureText !== "function") return fallback;
  const family = document.body ? getComputedStyle(document.body).fontFamily : "";
  const font = `${fontSize}px ${family || "sans-serif"}`;
  const cache = new Map<string, number>();
  return (text) => {
    const cached = cache.get(text);
    if (cached !== undefined) return cached;
    ctx.font = font;
    const width = ctx.measureText(text).width;
    // A context that reports nothing (no font backend) is no better than none.
    const result = Number.isFinite(width) && (width > 0 || text === "") ? width : fallback(text);
    cache.set(text, result);
    return result;
  };
}

/** Split `text` into user-perceived characters so truncation never cuts a
 * surrogate pair, a combining sequence or an emoji in half. */
function graphemes(text: string): string[] {
  if (typeof Intl !== "undefined" && "Segmenter" in Intl) {
    const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
    return Array.from(segmenter.segment(text), (part) => part.segment);
  }
  return Array.from(text);
}

/** A label fitted to a width: the text to draw and whether it was shortened. */
export interface FittedLabel {
  text: string;
  truncated: boolean;
}

/**
 * Shorten `label` with a trailing ellipsis so it measures at most `maxWidth`.
 * Labels that already fit are returned unchanged. When not even one character
 * plus the ellipsis fits, the ellipsis alone is returned (still flagged as
 * truncated, so callers can attach the full label as a tooltip).
 *
 * @param label The full label.
 * @param maxWidth The available width in CSS pixels.
 * @param measure Measures a string's width; defaults to the 11px estimate.
 * @returns The text to draw and whether it was truncated.
 */
export function truncateToWidth(
  label: string,
  maxWidth: number,
  measure: TextMeasurer = approximateTextWidth,
): FittedLabel {
  if (measure(label) <= maxWidth) return { text: label, truncated: false };
  const parts = graphemes(label);
  // Binary search for the longest prefix that fits alongside the ellipsis.
  let low = 0;
  let high = parts.length - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (measure(`${parts.slice(0, mid).join("").trimEnd()}${ELLIPSIS}`) <= maxWidth) low = mid;
    else high = mid - 1;
  }
  return { text: `${parts.slice(0, low).join("").trimEnd()}${ELLIPSIS}`, truncated: true };
}
