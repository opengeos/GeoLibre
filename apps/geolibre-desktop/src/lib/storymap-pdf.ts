/**
 * Build a multi-page PDF handout from selected story-map chapters (GH #830).
 *
 * Each chapter renders on its own page as: the document title (running header),
 * the chapter title, the captured map view (with the chapter's own photo beside
 * it when the chapter has one), the chapter description, and a running footer
 * with the user's footer text and a page number. The images are supplied by the
 * caller (the map via {@link ./print-layout-export.captureMapImage}, the photo
 * loaded from the chapter image URL) as canvases or data URLs, so this builder
 * stays free of MapLibre and the DOM and can be unit tested with data-URL
 * images.
 */
import jsPDF from "jspdf";
import {
  pageMm,
  resolvePageSize,
  type Orientation,
  type PaperSizeId,
} from "./print-layout";

/** An image to embed: a canvas (app) or a PNG/JPEG data URL (tests), plus its
 * natural pixel dimensions so the aspect ratio can be preserved. */
export interface HandoutImage {
  data: HTMLCanvasElement | string;
  width: number;
  height: number;
}

/** A single captured chapter to place on one handout page. */
export interface HandoutChapter {
  /** Chapter title, drawn above the images. */
  title: string;
  /** Optional chapter description; HTML is reduced to plain text. */
  description?: string;
  /** The captured map view for this chapter. */
  map: HandoutImage;
  /** The chapter's own photo, when it has one and it loaded successfully. */
  photo?: HandoutImage;
}

/** Page setup and running text for the handout. */
export interface HandoutOptions {
  paperSize: PaperSizeId;
  orientation: Orientation;
  /** Document title drawn at the top of every page (omitted when empty). */
  title: string;
  /** Footer text drawn at the bottom of every page (omitted when empty). */
  footer: string;
}

const MARGIN_MM = 12;
/** Width reserved at each edge for the right-aligned page number in the footer,
 * so the centered footer text never collides with it. */
const PAGE_NUM_SLOT_MM = 24;
/** Points to millimetres (1 pt = 1/72 in). */
const PT_TO_MM = 25.4 / 72;
/** Line spacing multiplier applied to a font's point size. */
const LINE_SPACING = 1.15;

/** Convert a font point size to its rendered line height in millimetres. */
function lineHeightMm(fontSizePt: number): number {
  return fontSizePt * PT_TO_MM * LINE_SPACING;
}

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
    html
      // Drop <script>/<style> blocks with their contents first; the generic tag
      // strip below only removes delimiters and would leave their text behind.
      .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, "")
      .replace(/<\s*br\s*\/?\s*>/gi, "\n")
      .replace(/<\/\s*(p|div|li|h[1-6]|tr)\s*>/gi, "\n")
      // Strip remaining tags, honouring quoted attribute values so a `>` inside
      // an attribute (e.g. title="a > b") doesn't end the match early and leak
      // the rest of the tag as text.
      .replace(/<[^>"']*(?:"[^"]*"[^>"']*|'[^']*'[^>"']*)*>/g, ""),
  )
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .trim();
}

/** Reduce HTML/multi-line text to a single line of plain text for headers. */
export function singleLine(value: string): string {
  return htmlToPlainText(value).replace(/\s*\n\s*/g, " ").trim();
}

/**
 * Append an ellipsis to a line, trimming trailing words until it (plus the
 * ellipsis) fits within `maxWidth`, so a truncated description ends in "…".
 */
function truncateWithEllipsis(
  pdf: jsPDF,
  line: string,
  maxWidth: number,
): string {
  const words = line.trimEnd().split(/\s+/);
  while (words.length > 0) {
    const candidate = words.join(" ") + "…";
    if (pdf.getTextWidth(candidate) <= maxWidth) return candidate;
    words.pop();
  }
  return "…";
}

/** Scale `(w, h)` to fit inside a `boxW x boxH` box, preserving aspect ratio. */
function fitInto(
  w: number,
  h: number,
  boxW: number,
  boxH: number,
): { width: number; height: number } {
  if (w <= 0 || h <= 0) return { width: boxW, height: boxH };
  const scale = Math.min(boxW / w, boxH / h);
  return { width: w * scale, height: h * scale };
}

/**
 * Pick the jsPDF image format for the data. Canvases encode as PNG; a data URL
 * keeps its real MIME type so a JPEG is not handed to the PNG parser (which
 * would corrupt it).
 */
function imageFormat(data: HandoutImage["data"]): "PNG" | "JPEG" {
  if (typeof data === "string" && /^data:image\/jpe?g[;,]/i.test(data)) {
    return "JPEG";
  }
  return "PNG";
}

/** Draw an image centered within a box at `(x, y)` of size `boxW x boxH`. */
function drawImageInBox(
  pdf: jsPDF,
  image: HandoutImage,
  x: number,
  y: number,
  boxW: number,
  boxH: number,
): void {
  const fit = fitInto(image.width, image.height, boxW, boxH);
  pdf.addImage(
    image.data,
    imageFormat(image.data),
    x + (boxW - fit.width) / 2,
    y + (boxH - fit.height) / 2,
    fit.width,
    fit.height,
    undefined,
    "FAST",
  );
}

/**
 * Render one chapter onto the current PDF page: document title, chapter title,
 * the map view (with the chapter photo beside it when present), the description,
 * and the running footer with a page number.
 */
function drawChapterPage(
  pdf: jsPDF,
  chapter: HandoutChapter,
  options: HandoutOptions,
  pageNumber: number,
  pageCount: number,
  widthMm: number,
  heightMm: number,
): void {
  const contentWidth = widthMm - MARGIN_MM * 2;
  const footerSize = 9;
  const footerY = heightMm - MARGIN_MM + lineHeightMm(footerSize);
  // The images must not overrun the footer band; reserve room for it plus a gap.
  const bottomLimit = heightMm - MARGIN_MM - lineHeightMm(footerSize) - 4;
  let y = MARGIN_MM;

  // The title and footer are running, single-line text; reduce any HTML the
  // story carried (e.g. the default footer's links) to plain text so the
  // handout shows readable labels instead of raw markup.
  const docTitle = singleLine(options.title);
  const footerText = singleLine(options.footer);

  if (docTitle) {
    const size = 10;
    pdf.setFont("helvetica", "normal");
    pdf.setFontSize(size);
    pdf.setTextColor(110, 110, 110);
    pdf.text(docTitle, widthMm / 2, y + lineHeightMm(size), {
      align: "center",
    });
    y += lineHeightMm(size) + 3;
  }

  if (chapter.title) {
    const size = 15;
    pdf.setFont("helvetica", "bold");
    pdf.setFontSize(size);
    pdf.setTextColor(20, 20, 20);
    const lines = pdf.splitTextToSize(chapter.title, contentWidth) as string[];
    for (const line of lines) {
      y += lineHeightMm(size);
      pdf.text(line, MARGIN_MM, y);
    }
    y += 3;
  }

  // Reserve a few lines of vertical space for the description so the image band
  // never crowds it off the page, then give the rest to the image(s). When a
  // long title has already consumed the page, the band can be non-positive;
  // skip the images entirely rather than drawing a fixed-height band over the
  // footer.
  const reservedForText = chapter.description ? 24 : 4;
  const imageBandHeight = bottomLimit - y - reservedForText;
  const gap = 5;
  if (imageBandHeight >= 20) {
    if (chapter.photo) {
      // Map on the left, the chapter photo on the right, each fit into its own
      // half-width column and vertically centered within the band.
      const colWidth = (contentWidth - gap) / 2;
      drawImageInBox(pdf, chapter.map, MARGIN_MM, y, colWidth, imageBandHeight);
      drawImageInBox(
        pdf,
        chapter.photo,
        MARGIN_MM + colWidth + gap,
        y,
        colWidth,
        imageBandHeight,
      );
    } else {
      // No photo: the map view spans the full content width.
      drawImageInBox(pdf, chapter.map, MARGIN_MM, y, contentWidth, imageBandHeight);
    }
    y += imageBandHeight + 5;
  }

  const description = chapter.description
    ? htmlToPlainText(chapter.description)
    : "";
  if (description) {
    const size = 10;
    pdf.setFont("helvetica", "normal");
    pdf.setFontSize(size);
    pdf.setTextColor(60, 60, 60);
    const lines = pdf.splitTextToSize(description, contentWidth) as string[];
    for (let i = 0; i < lines.length; i++) {
      // Stop before the footer band rather than letting long text overprint it.
      if (y + lineHeightMm(size) > bottomLimit) break;
      y += lineHeightMm(size);
      // Mark the cut with an ellipsis when text remains below this last line, so
      // a clipped description reads as truncated rather than as a clean ending.
      const isLastDrawable = y + lineHeightMm(size) > bottomLimit;
      const text =
        isLastDrawable && i < lines.length - 1
          ? truncateWithEllipsis(pdf, lines[i], contentWidth)
          : lines[i];
      pdf.text(text, MARGIN_MM, y);
    }
  }

  pdf.setFont("helvetica", "normal");
  pdf.setFontSize(footerSize);
  pdf.setTextColor(130, 130, 130);
  if (footerText) {
    // Keep the footer centered but bound its width symmetrically so it stays
    // clear of the right-aligned page number on both sides, even on wide pages
    // (e.g. Tabloid landscape). Only the first wrapped line is kept.
    const footerMaxWidth = Math.max(20, widthMm - 2 * (MARGIN_MM + PAGE_NUM_SLOT_MM));
    // splitTextToSize always returns at least one element for non-empty input,
    // and footerText is non-empty here, so `line` is always a string.
    const [line] = pdf.splitTextToSize(footerText, footerMaxWidth) as string[];
    pdf.text(line, widthMm / 2, footerY, { align: "center" });
  }
  pdf.text(`${pageNumber} / ${pageCount}`, widthMm - MARGIN_MM, footerY, {
    align: "right",
  });
}

/**
 * Build the handout PDF as raw bytes, one page per chapter.
 *
 * @param chapters Captured chapters, in the order they should appear.
 * @param options Paper size, orientation, and running title/footer text.
 * @returns The PDF document as a byte array, ready to save.
 * @throws If no chapters are provided.
 */
export function buildStoryMapHandoutPdf(
  chapters: HandoutChapter[],
  options: HandoutOptions,
): Uint8Array {
  if (chapters.length === 0) {
    throw new Error("Cannot build a handout with no chapters.");
  }
  const size = resolvePageSize({
    paperSize: options.paperSize,
    orientation: options.orientation,
  });
  const { widthMm, heightMm } = pageMm(size);
  // Keep jsPDF's page orientation consistent with the resolved dimensions;
  // pixel presets are stored portrait-first, so the format array is the truth.
  const orientation: Orientation =
    widthMm >= heightMm ? "landscape" : "portrait";
  const pdf = new jsPDF({
    orientation,
    unit: "mm",
    format: [widthMm, heightMm],
  });

  chapters.forEach((chapter, index) => {
    if (index > 0) pdf.addPage([widthMm, heightMm], orientation);
    drawChapterPage(
      pdf,
      chapter,
      options,
      index + 1,
      chapters.length,
      widthMm,
      heightMm,
    );
  });

  return new Uint8Array(pdf.output("arraybuffer"));
}
