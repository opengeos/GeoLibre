/**
 * Print layout composer rendering.
 *
 * Pure, framework-free drawing helpers that compose a captured map image with
 * cartographic furniture (title, legend, scale bar, north arrow, footer) onto a
 * 2D canvas at a paper page size. The same {@link drawLayout} function backs
 * both the on-screen preview (small canvas) and the high-resolution export
 * (PNG / PDF), so the preview is faithful to the output.
 */

export type PaperSizeId = "a4" | "a3" | "letter" | "legal" | "tabloid";
export type Orientation = "portrait" | "landscape";

export interface PaperSize {
  id: PaperSizeId;
  label: string;
  /** Width in millimetres in portrait orientation. */
  widthMm: number;
  /** Height in millimetres in portrait orientation. */
  heightMm: number;
}

/** Standard paper sizes, expressed in their portrait dimensions. */
export const PAPER_SIZES: PaperSize[] = [
  { id: "a4", label: "A4 (210 × 297 mm)", widthMm: 210, heightMm: 297 },
  { id: "a3", label: "A3 (297 × 420 mm)", widthMm: 297, heightMm: 420 },
  { id: "letter", label: "Letter (8.5 × 11 in)", widthMm: 215.9, heightMm: 279.4 },
  { id: "legal", label: "Legal (8.5 × 14 in)", widthMm: 215.9, heightMm: 355.6 },
  { id: "tabloid", label: "Tabloid (11 × 17 in)", widthMm: 279.4, heightMm: 431.8 },
];

export function getPaperSize(id: PaperSizeId): PaperSize {
  return PAPER_SIZES.find((p) => p.id === id) ?? PAPER_SIZES[0];
}

/**
 * Page dimensions in millimetres for a paper size and orientation, with the
 * width/height swapped for landscape.
 */
export function pageDimensionsMm(
  id: PaperSizeId,
  orientation: Orientation,
): { widthMm: number; heightMm: number } {
  const paper = getPaperSize(id);
  return orientation === "landscape"
    ? { widthMm: paper.heightMm, heightMm: paper.widthMm }
    : { widthMm: paper.widthMm, heightMm: paper.heightMm };
}

/** A single swatch in a legend entry (one color, with an optional label). */
export interface LegendSwatch {
  color: string;
  label?: string;
}

export interface LegendEntry {
  name: string;
  swatches: LegendSwatch[];
}

export interface LayoutOptions {
  title: string;
  subtitle: string;
  paperSize: PaperSizeId;
  orientation: Orientation;
  showTitle: boolean;
  showLegend: boolean;
  showScaleBar: boolean;
  showNorthArrow: boolean;
  showFooter: boolean;
  footerText: string;
  legend: LegendEntry[];
  /** Ground metres per source-image pixel at the map centre. */
  metersPerPixel: number;
  /** Map bearing in degrees clockwise from north. */
  bearingDeg: number;
  /** The captured map image (already composited). */
  mapImage: CanvasImageSource | null;
  /** Intrinsic width of {@link mapImage} in pixels. */
  mapImageWidth: number;
  /** Intrinsic height of {@link mapImage} in pixels. */
  mapImageHeight: number;
}

const PAGE_BACKGROUND = "#ffffff";
const INK = "#111827";
const MUTED = "#6b7280";
const BORDER = "#9ca3af";

/**
 * Draw the full page layout onto a canvas. The canvas pixel dimensions define
 * the render resolution; all furniture is scaled relative to the page so the
 * preview and the export look identical.
 *
 * @param canvas - Destination canvas; its width/height are taken as the page
 *   size in pixels.
 * @param opts - Layout content and options.
 */
export function drawLayout(
  canvas: HTMLCanvasElement,
  opts: LayoutOptions,
): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  const W = canvas.width;
  const H = canvas.height;
  // Scale furniture relative to the page's shorter side so output looks the
  // same at any resolution / paper size.
  const unit = Math.min(W, H) / 100;
  const margin = unit * 5;

  ctx.save();
  ctx.fillStyle = PAGE_BACKGROUND;
  ctx.fillRect(0, 0, W, H);

  let bodyTop = margin;
  let bodyBottom = H - margin;

  // --- Title block -------------------------------------------------------
  if (opts.showTitle && (opts.title.trim() || opts.subtitle.trim())) {
    const titleSize = unit * 4.5;
    const subtitleSize = unit * 2.4;
    let y = margin + titleSize;
    if (opts.title.trim()) {
      ctx.fillStyle = INK;
      ctx.font = `600 ${titleSize}px system-ui, -apple-system, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "alphabetic";
      ctx.fillText(opts.title.trim(), W / 2, y, W - margin * 2);
    }
    if (opts.subtitle.trim()) {
      y += subtitleSize * 1.4;
      ctx.fillStyle = MUTED;
      ctx.font = `400 ${subtitleSize}px system-ui, -apple-system, sans-serif`;
      ctx.textAlign = "center";
      ctx.fillText(opts.subtitle.trim(), W / 2, y, W - margin * 2);
    }
    bodyTop = y + unit * 3;
  }

  // --- Footer ------------------------------------------------------------
  if (opts.showFooter && opts.footerText.trim()) {
    const footSize = unit * 2.2;
    bodyBottom = H - margin - footSize * 1.8;
    ctx.fillStyle = MUTED;
    ctx.font = `400 ${footSize}px system-ui, -apple-system, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(
      opts.footerText.trim(),
      W / 2,
      H - margin - footSize * 0.6,
      W - margin * 2,
    );
  }

  // --- Map body ----------------------------------------------------------
  const bodyX = margin;
  const bodyY = bodyTop;
  const bodyW = W - margin * 2;
  const bodyH = Math.max(unit * 10, bodyBottom - bodyTop);

  ctx.save();
  ctx.beginPath();
  ctx.rect(bodyX, bodyY, bodyW, bodyH);
  ctx.clip();
  ctx.fillStyle = "#e5e7eb";
  ctx.fillRect(bodyX, bodyY, bodyW, bodyH);

  // Draw the map image with "cover" scaling (fill the body, crop overflow).
  let coverScale = 1;
  if (opts.mapImage && opts.mapImageWidth > 0 && opts.mapImageHeight > 0) {
    coverScale = Math.max(
      bodyW / opts.mapImageWidth,
      bodyH / opts.mapImageHeight,
    );
    const drawW = opts.mapImageWidth * coverScale;
    const drawH = opts.mapImageHeight * coverScale;
    const dx = bodyX + (bodyW - drawW) / 2;
    const dy = bodyY + (bodyH - drawH) / 2;
    ctx.drawImage(opts.mapImage, dx, dy, drawW, drawH);
  }
  ctx.restore();

  // Body border.
  ctx.strokeStyle = BORDER;
  ctx.lineWidth = Math.max(1, unit * 0.2);
  ctx.strokeRect(bodyX, bodyY, bodyW, bodyH);

  const inset = unit * 2;
  // Metres per pixel in the *output* image after cover scaling.
  const outputMpp = opts.metersPerPixel / (coverScale || 1);

  // --- North arrow (top-right inside the map) ---------------------------
  if (opts.showNorthArrow) {
    const arrowRadius = unit * 2.6;
    const discRadius = arrowRadius * 1.5;
    // The "N" label extends above the arrow tip, so the disc is not the top
    // extent; account for both so nothing is clipped by the map edge.
    const topExtent = arrowRadius + unit * 2.4;
    const arrowMargin = unit * 3;
    drawNorthArrow(
      ctx,
      bodyX + bodyW - arrowMargin - discRadius,
      bodyY + arrowMargin + topExtent,
      arrowRadius,
      opts.bearingDeg,
      unit,
    );
  }

  // --- Scale bar (bottom-right inside the map) --------------------------
  if (opts.showScaleBar && outputMpp > 0 && Number.isFinite(outputMpp)) {
    drawScaleBar(
      ctx,
      bodyX + bodyW - inset,
      bodyY + bodyH - inset,
      bodyW * 0.28,
      outputMpp,
      unit,
    );
  }

  // --- Legend (bottom-left inside the map) ------------------------------
  if (opts.showLegend && opts.legend.length > 0) {
    drawLegend(ctx, bodyX + inset, bodyY + inset, opts.legend, unit);
  }

  ctx.restore();
}

/** Draw a north-pointing arrow rotated to account for map bearing. */
function drawNorthArrow(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  radius: number,
  bearingDeg: number,
  unit: number,
): void {
  ctx.save();
  // Translucent backing disc for legibility over imagery.
  ctx.fillStyle = "rgba(255,255,255,0.78)";
  ctx.beginPath();
  ctx.arc(cx, cy, radius * 1.5, 0, Math.PI * 2);
  ctx.fill();

  ctx.translate(cx, cy);
  // North points to -bearing (map rotates clockwise by bearing).
  ctx.rotate((-bearingDeg * Math.PI) / 180);

  ctx.fillStyle = INK;
  ctx.beginPath();
  ctx.moveTo(0, -radius);
  ctx.lineTo(radius * 0.55, radius * 0.7);
  ctx.lineTo(0, radius * 0.35);
  ctx.lineTo(-radius * 0.55, radius * 0.7);
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = INK;
  ctx.font = `700 ${unit * 1.8}px system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("N", 0, -radius - unit * 1.4);
  ctx.restore();
}

/** Round a distance down to a "nice" 1/2/5 × 10ⁿ value. */
function niceDistance(meters: number): number {
  const pow = Math.pow(10, Math.floor(Math.log10(meters)));
  const frac = meters / pow;
  let nice: number;
  if (frac >= 5) nice = 5;
  else if (frac >= 2) nice = 2;
  else nice = 1;
  return nice * pow;
}

function formatDistance(meters: number): string {
  if (meters >= 1000) {
    const km = meters / 1000;
    return `${km % 1 === 0 ? km : km.toFixed(1)} km`;
  }
  return `${meters % 1 === 0 ? meters : meters.toFixed(1)} m`;
}

/** Draw a scale bar anchored at its bottom-right corner. */
function drawScaleBar(
  ctx: CanvasRenderingContext2D,
  rightX: number,
  bottomY: number,
  maxWidthPx: number,
  metersPerPixel: number,
  unit: number,
): void {
  const maxMeters = maxWidthPx * metersPerPixel;
  const distance = niceDistance(maxMeters);
  const barWidth = distance / metersPerPixel;
  const barHeight = unit * 1.1;
  const x0 = rightX - barWidth;
  const y0 = bottomY - barHeight;

  ctx.save();
  // Backing for legibility.
  ctx.fillStyle = "rgba(255,255,255,0.78)";
  ctx.fillRect(
    x0 - unit * 0.8,
    y0 - unit * 2.4,
    barWidth + unit * 1.6,
    barHeight + unit * 3.2,
  );

  // Two-tone bar.
  const half = barWidth / 2;
  ctx.fillStyle = INK;
  ctx.fillRect(x0, y0, half, barHeight);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(x0 + half, y0, half, barHeight);
  ctx.strokeStyle = INK;
  ctx.lineWidth = Math.max(1, unit * 0.15);
  ctx.strokeRect(x0, y0, barWidth, barHeight);

  ctx.fillStyle = INK;
  ctx.font = `500 ${unit * 1.7}px system-ui, sans-serif`;
  ctx.textAlign = "right";
  ctx.textBaseline = "bottom";
  ctx.fillText(formatDistance(distance), rightX, y0 - unit * 0.5);
  ctx.restore();
}

/** Draw a legend box anchored at its top-left corner. */
function drawLegend(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  entries: LegendEntry[],
  unit: number,
): void {
  const pad = unit * 1.4;
  const rowH = unit * 2.6;
  const swatch = unit * 2;
  const titleSize = unit * 2;
  const labelSize = unit * 1.7;

  // Measure required width.
  ctx.save();
  ctx.font = `600 ${titleSize}px system-ui, sans-serif`;
  let maxText = ctx.measureText("Legend").width;
  ctx.font = `400 ${labelSize}px system-ui, sans-serif`;
  const rows: { color: string; text: string }[] = [];
  for (const entry of entries) {
    if (entry.swatches.length <= 1) {
      rows.push({
        color: entry.swatches[0]?.color ?? "#999999",
        text: entry.name,
      });
    } else {
      rows.push({ color: "", text: entry.name });
      for (const sw of entry.swatches) {
        rows.push({ color: sw.color, text: sw.label ?? "" });
      }
    }
  }
  for (const r of rows) {
    const w = ctx.measureText(r.text).width + (r.color ? swatch + unit : 0);
    if (w > maxText) maxText = w;
  }

  const boxW = maxText + pad * 2;
  const boxH = pad * 2 + titleSize + unit + rows.length * rowH;

  ctx.fillStyle = "rgba(255,255,255,0.85)";
  ctx.strokeStyle = BORDER;
  ctx.lineWidth = Math.max(1, unit * 0.15);
  roundRect(ctx, x, y, boxW, boxH, unit);
  ctx.fill();
  ctx.stroke();

  let cy = y + pad + titleSize;
  ctx.fillStyle = INK;
  ctx.font = `600 ${titleSize}px system-ui, sans-serif`;
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  ctx.fillText("Legend", x + pad, cy);
  cy += unit;

  for (const r of rows) {
    cy += rowH;
    const textX = r.color ? x + pad + swatch + unit : x + pad;
    if (r.color) {
      ctx.fillStyle = r.color;
      ctx.fillRect(x + pad, cy - swatch * 0.85, swatch, swatch);
      ctx.strokeStyle = BORDER;
      ctx.strokeRect(x + pad, cy - swatch * 0.85, swatch, swatch);
    }
    ctx.fillStyle = r.color ? INK : MUTED;
    ctx.font = `${r.color ? 400 : 600} ${labelSize}px system-ui, sans-serif`;
    ctx.fillText(r.text, textX, cy);
  }
  ctx.restore();
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}
