/**
 * Build a multi-page PDF handout from selected story-map chapters (GH #830).
 *
 * Each chapter renders on its own page as: the document title (running header),
 * the chapter title, a captured map image, the chapter description, and a
 * running footer with the user's footer text and a page number. The map images
 * are captured by the caller (see {@link ./print-layout-export.captureMapImage})
 * and handed in as canvases or data URLs so this builder stays free of MapLibre
 * and the DOM, and can be unit tested with plain data-URL images.
 */
import jsPDF from "jspdf";
import {
  pageMm,
  resolvePageSize,
  type Orientation,
  type PaperSizeId,
} from "./print-layout";

/** A single captured chapter to place on one handout page. */
export interface HandoutChapter {
  /** Chapter title, drawn above the map image. */
  title: string;
  /** Optional chapter description; HTML is reduced to plain text. */
  description?: string;
  /** Captured map image: a canvas (app) or a PNG/JPEG data URL (tests). */
  image: HTMLCanvasElement | string;
  /** Natural pixel width of the image, used to preserve the aspect ratio. */
  imageWidth: number;
  /** Natural pixel height of the image, used to preserve the aspect ratio. */
  imageHeight: number;
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
/** Points to millimetres (1 pt = 1/72 in). */
const PT_TO_MM = 25.4 / 72;
/** Line spacing multiplier applied to a font's point size. */
const LINE_SPACING = 1.15;

/** Convert a font point size to its rendered line height in millimetres. */
function lineHeightMm(fontSizePt: number): number {
  return fontSizePt * PT_TO_MM * LINE_SPACING;
}

/**
 * Reduce an HTML (or plain) chapter description to single-spaced plain text.
 *
 * Block-level tags become line breaks, remaining tags are dropped, and the few
 * named entities the story editor can emit are decoded so the handout reads
 * cleanly. This is presentation-only (the text is drawn, never parsed as HTML),
 * so a permissive strip is sufficient.
 *
 * @param html The chapter description, possibly containing HTML.
 * @returns Plain text with normalized whitespace.
 */
export function htmlToPlainText(html: string): string {
  return html
    .replace(/<\s*br\s*\/?\s*>/gi, "\n")
    .replace(/<\/\s*(p|div|li|h[1-6]|tr)\s*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .trim();
}

/** Reduce HTML/multi-line text to a single line of plain text for headers. */
function singleLine(value: string): string {
  return htmlToPlainText(value).replace(/\s*\n\s*/g, " ").trim();
}

/**
 * Render one chapter onto the current PDF page: document title, chapter title,
 * map image (fit to the content box while preserving aspect ratio), description,
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
  // The image must not overrun the footer band; reserve room for it plus a gap.
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

  // Fit the captured image into the content width, then clamp the height so the
  // description and footer still fit; a clamped height shrinks the width to keep
  // the aspect ratio, and the image is centered horizontally.
  const ratio =
    chapter.imageWidth > 0 && chapter.imageHeight > 0
      ? chapter.imageHeight / chapter.imageWidth
      : 0.75;
  let drawWidth = contentWidth;
  let drawHeight = drawWidth * ratio;
  const maxImageHeight = Math.max(20, bottomLimit - y - 20);
  if (drawHeight > maxImageHeight) {
    drawHeight = maxImageHeight;
    drawWidth = ratio > 0 ? drawHeight / ratio : contentWidth;
  }
  const imageX = MARGIN_MM + (contentWidth - drawWidth) / 2;
  pdf.addImage(
    chapter.image,
    "PNG",
    imageX,
    y,
    drawWidth,
    drawHeight,
    undefined,
    "FAST",
  );
  y += drawHeight + 5;

  const description = chapter.description
    ? htmlToPlainText(chapter.description)
    : "";
  if (description) {
    const size = 10;
    pdf.setFont("helvetica", "normal");
    pdf.setFontSize(size);
    pdf.setTextColor(60, 60, 60);
    const lines = pdf.splitTextToSize(description, contentWidth) as string[];
    for (const line of lines) {
      // Stop before the footer band rather than letting long text overprint it.
      if (y + lineHeightMm(size) > bottomLimit) break;
      y += lineHeightMm(size);
      pdf.text(line, MARGIN_MM, y);
    }
  }

  pdf.setFont("helvetica", "normal");
  pdf.setFontSize(footerSize);
  pdf.setTextColor(130, 130, 130);
  if (footerText) {
    // Clip an over-long footer to the content width so it never collides with
    // the right-aligned page number.
    const [line] = pdf.splitTextToSize(footerText, contentWidth - 30) as string[];
    pdf.text(line ?? footerText, widthMm / 2, footerY, { align: "center" });
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
