/**
 * Print layout composer rendering.
 *
 * Pure, framework-free drawing helpers that compose a captured map image with
 * cartographic furniture (title, legend, scale bar, north arrow, footer) onto a
 * 2D canvas at a paper page size. The same {@link drawLayout} function backs
 * both the on-screen preview (small canvas) and the high-resolution export
 * (PNG / PDF), so the preview is faithful to the output.
 */

export type PaperSizeId =
  | "a4"
  | "a3"
  | "letter"
  | "legal"
  | "tabloid"
  | "fullhd"
  | "hd"
  | "uhd4k"
  | "square"
  | "custom";
export type Orientation = "portrait" | "landscape";
/** How a size's width/height are expressed: physical millimetres or screen pixels. */
export type SizeUnit = "mm" | "px";

export interface PaperSize {
  id: PaperSizeId;
  label: string;
  /** Width in {@link unit}, in portrait orientation (width ≤ height). */
  width: number;
  /** Height in {@link unit}, in portrait orientation. */
  height: number;
  unit: SizeUnit;
  /** Grouping used by the size dropdown: physical paper vs digital screen. */
  group: "paper" | "screen";
}

/**
 * Selectable output sizes. Physical paper formats are expressed in their
 * portrait millimetre dimensions; digital/screen presets are expressed in
 * pixels, also stored portrait-first so the shared orientation swap applies.
 * The "Custom…" entry is a placeholder whose real dimensions come from
 * {@link LayoutOptions.customSize}.
 */
export const PAPER_SIZES: PaperSize[] = [
  { id: "a4", label: "A4 (210 × 297 mm)", width: 210, height: 297, unit: "mm", group: "paper" },
  { id: "a3", label: "A3 (297 × 420 mm)", width: 297, height: 420, unit: "mm", group: "paper" },
  { id: "letter", label: "Letter (8.5 × 11 in)", width: 215.9, height: 279.4, unit: "mm", group: "paper" },
  { id: "legal", label: "Legal (8.5 × 14 in)", width: 215.9, height: 355.6, unit: "mm", group: "paper" },
  { id: "tabloid", label: "Tabloid (11 × 17 in)", width: 279.4, height: 431.8, unit: "mm", group: "paper" },
  { id: "fullhd", label: "Full HD (1920 × 1080 px)", width: 1080, height: 1920, unit: "px", group: "screen" },
  { id: "hd", label: "HD (1280 × 720 px)", width: 720, height: 1280, unit: "px", group: "screen" },
  { id: "uhd4k", label: "4K UHD (3840 × 2160 px)", width: 2160, height: 3840, unit: "px", group: "screen" },
  { id: "square", label: "Square (1080 × 1080 px)", width: 1080, height: 1080, unit: "px", group: "screen" },
  { id: "custom", label: "Custom…", width: 1280, height: 720, unit: "px", group: "screen" },
];

export function getPaperSize(id: PaperSizeId): PaperSize {
  return PAPER_SIZES.find((p) => p.id === id) ?? PAPER_SIZES[0];
}

/** A page size already resolved for a specific orientation. */
export interface ResolvedPageSize {
  width: number;
  height: number;
  unit: SizeUnit;
}

/** Custom user-defined dimensions, used when {@link LayoutOptions.paperSize} is "custom". */
export interface CustomSize {
  width: number;
  height: number;
  unit: SizeUnit;
}

/** CSS reference pixels per millimetre (96 dpi), used to bridge px ↔ mm sizes. */
const PX_PER_MM_96 = 96 / 25.4;

/**
 * Resolve the effective page dimensions for a layout, applying the orientation
 * swap to preset sizes. Custom sizes are taken verbatim (the dialog disables the
 * orientation control for them) so the numbers the user typed are honoured.
 */
export function resolvePageSize(opts: {
  paperSize: PaperSizeId;
  orientation: Orientation;
  customSize?: CustomSize | null;
}): ResolvedPageSize {
  if (opts.paperSize === "custom") {
    const c = opts.customSize;
    if (c && c.width > 0 && c.height > 0) {
      return { width: c.width, height: c.height, unit: c.unit };
    }
    return { width: 1280, height: 720, unit: "px" };
  }
  const paper = getPaperSize(opts.paperSize);
  return opts.orientation === "landscape"
    ? { width: paper.height, height: paper.width, unit: paper.unit }
    : { width: paper.width, height: paper.height, unit: paper.unit };
}

/** Convert a resolved page size to millimetres (screen px treated as 96 dpi). */
export function pageMm(size: ResolvedPageSize): {
  widthMm: number;
  heightMm: number;
} {
  if (size.unit === "mm") return { widthMm: size.width, heightMm: size.height };
  return { widthMm: size.width / PX_PER_MM_96, heightMm: size.height / PX_PER_MM_96 };
}

/**
 * Convert a resolved page size to output pixels at the given dpi. Pixel-unit
 * sizes are exact (dpi is ignored); millimetre sizes scale by dpi/25.4.
 */
export function pagePx(
  size: ResolvedPageSize,
  dpi: number,
): { width: number; height: number } {
  if (size.unit === "px") {
    return { width: Math.round(size.width), height: Math.round(size.height) };
  }
  const pxPerMm = dpi / 25.4;
  return {
    width: Math.round(size.width * pxPerMm),
    height: Math.round(size.height * pxPerMm),
  };
}

/** A single swatch in a legend entry (one color, with an optional label). */
export interface LegendSwatch {
  color: string;
  label?: string;
}

export interface LegendEntry {
  /** Stable identifier of the source layer (used to key user customizations). */
  id: string;
  name: string;
  swatches: LegendSwatch[];
}

export interface LayoutOptions {
  title: string;
  subtitle: string;
  paperSize: PaperSizeId;
  orientation: Orientation;
  /** Explicit dimensions used when {@link paperSize} is "custom". */
  customSize?: CustomSize | null;
  showTitle: boolean;
  /** Whether the subtitle line is drawn (independent of {@link showTitle}). */
  showSubtitle?: boolean;
  /** Where the title/subtitle render: above the map (default) or overlaid inside it. */
  titlePlacement?: "outside" | "inside";
  /** Horizontal alignment of the title/subtitle text. */
  titleAlign?: "left" | "center" | "right";
  showLegend: boolean;
  showScaleBar: boolean;
  showNorthArrow: boolean;
  /**
   * Group the north arrow directly above the scale bar in the lower-right
   * corner (the cartographic "navigation duo"). When false they fall back to
   * isolated anchors: north arrow top-right, scale bar bottom-right.
   */
  navigationGrouped?: boolean;
  showFooter: boolean;
  footerText: string;
  /** Draw the production date (right side of the footer row). */
  showDate?: boolean;
  /** The formatted date string drawn when {@link showDate} is true. */
  dateText?: string;
  /** Draw the "Created with GeoLibre" attribution (left side of the footer row). */
  showAttribution?: boolean;
  /** Attribution text; defaults to "Created with GeoLibre" when omitted. */
  attributionText?: string;
  /** Outer page padding preset: full margins, narrow, or borderless. */
  pageMargin?: "normal" | "narrow" | "none";
  /** Draw a customizable border around the whole page (useful for PNG export). */
  showPageBorder?: boolean;
  pageBorderColor?: string;
  /** Page border thickness on a 1–10 scale (relative to page size). */
  pageBorderWidth?: number;
  legend: LegendEntry[];
  /** Heading drawn above the legend entries. */
  legendTitle: string;
  /**
   * When true, multi-class entries show a per-layer heading above their
   * classes; when false, classes are listed flat without the layer heading.
   */
  legendGroupByLayer: boolean;
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
  const marginScale =
    opts.pageMargin === "none" ? 0 : opts.pageMargin === "narrow" ? 0.5 : 1;
  const margin = unit * 5 * marginScale;

  const titleAlign = opts.titleAlign ?? "center";
  const titleInside = opts.titlePlacement === "inside";
  const showSubtitle = opts.showSubtitle ?? true;
  const hasTitleText = opts.showTitle && opts.title.trim().length > 0;
  const hasSubtitleText = showSubtitle && opts.subtitle.trim().length > 0;
  const hasTitleBlock = hasTitleText || hasSubtitleText;

  // Footer row slots: attribution (left), footer text (centre), date (right).
  const attributionText =
    opts.showAttribution !== false && (opts.attributionText ?? "Created with GeoLibre").trim();
  const footerText = opts.showFooter && opts.footerText.trim();
  const dateText = opts.showDate && (opts.dateText ?? "").trim();
  const hasFooterRow = Boolean(attributionText || footerText || dateText);

  ctx.save();
  ctx.fillStyle = PAGE_BACKGROUND;
  ctx.fillRect(0, 0, W, H);

  let bodyTop = margin;
  let bodyBottom = H - margin;

  // X anchor + canvas textAlign for the chosen title alignment.
  const titleX =
    titleAlign === "left" ? margin : titleAlign === "right" ? W - margin : W / 2;

  // --- Title block (outside the map) -------------------------------------
  if (hasTitleBlock && !titleInside) {
    const titleSize = unit * 4.5;
    const subtitleSize = unit * 2.4;
    let y = margin + titleSize;
    if (hasTitleText) {
      ctx.fillStyle = INK;
      ctx.font = `600 ${titleSize}px system-ui, -apple-system, sans-serif`;
      ctx.textAlign = titleAlign;
      ctx.textBaseline = "alphabetic";
      ctx.fillText(opts.title.trim(), titleX, y, W - margin * 2);
    }
    if (hasSubtitleText) {
      y += subtitleSize * 1.4;
      ctx.fillStyle = MUTED;
      ctx.font = `400 ${subtitleSize}px system-ui, -apple-system, sans-serif`;
      ctx.textAlign = titleAlign;
      ctx.fillText(opts.subtitle.trim(), titleX, y, W - margin * 2);
    }
    bodyTop = y + unit * 3;
  }

  // --- Footer row --------------------------------------------------------
  if (hasFooterRow) {
    const footSize = unit * 2.2;
    bodyBottom = H - margin - footSize * 1.8;
    const baselineY = H - margin - footSize * 0.6;
    ctx.fillStyle = MUTED;
    ctx.font = `400 ${footSize}px system-ui, -apple-system, sans-serif`;
    ctx.textBaseline = "middle";
    const slotMax = W - margin * 2;
    if (attributionText) {
      ctx.textAlign = "left";
      ctx.fillText(attributionText, margin, baselineY, slotMax);
    }
    if (footerText) {
      ctx.textAlign = "center";
      ctx.fillText(footerText, W / 2, baselineY, slotMax);
    }
    if (dateText) {
      ctx.textAlign = "right";
      ctx.fillText(dateText, W - margin, baselineY, slotMax);
    }
  }

  // --- Map body ----------------------------------------------------------
  // Clamp the top so a tall title block plus footer on a very small page can
  // never push the map area below the footer (which would overflow the page).
  bodyTop = Math.min(bodyTop, bodyBottom - unit * 10);
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
  // Guard the draw: a tainted/broken capture must not abort the whole layout,
  // otherwise a single bad basemap (e.g. cross-origin OpenTopo tiles) would wipe
  // out every cartographic element too, not just the map image.
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
    try {
      ctx.drawImage(opts.mapImage, dx, dy, drawW, drawH);
    } catch {
      // Leave the grey placeholder; the rest of the layout still renders.
    }
  }
  ctx.restore();

  // Body border.
  ctx.strokeStyle = BORDER;
  ctx.lineWidth = Math.max(1, unit * 0.2);
  ctx.strokeRect(bodyX, bodyY, bodyW, bodyH);

  // --- Title block (inside the map) --------------------------------------
  // Overlaid at the top of the map body with a translucent backing for legibility.
  if (hasTitleBlock && titleInside) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(bodyX, bodyY, bodyW, bodyH);
    ctx.clip();
    const titleSize = unit * 4;
    const subtitleSize = unit * 2.2;
    const padY = unit * 2;
    let y = bodyY + padY + titleSize;
    const insetX = unit * 2;
    const tx =
      titleAlign === "left"
        ? bodyX + insetX
        : titleAlign === "right"
          ? bodyX + bodyW - insetX
          : bodyX + bodyW / 2;
    const blockH =
      padY * 2 + (hasTitleText ? titleSize : 0) + (hasSubtitleText ? subtitleSize * 1.6 : 0);
    ctx.fillStyle = "rgba(255,255,255,0.7)";
    ctx.fillRect(bodyX, bodyY, bodyW, blockH);
    if (hasTitleText) {
      ctx.fillStyle = INK;
      ctx.font = `600 ${titleSize}px system-ui, -apple-system, sans-serif`;
      ctx.textAlign = titleAlign;
      ctx.textBaseline = "alphabetic";
      ctx.fillText(opts.title.trim(), tx, y, bodyW - insetX * 2);
    }
    if (hasSubtitleText) {
      y += subtitleSize * 1.4;
      ctx.fillStyle = MUTED;
      ctx.font = `400 ${subtitleSize}px system-ui, -apple-system, sans-serif`;
      ctx.textAlign = titleAlign;
      ctx.fillText(opts.subtitle.trim(), tx, y, bodyW - insetX * 2);
    }
    ctx.restore();
  }

  const inset = unit * 2;
  // Metres per pixel in the *output* image after cover scaling.
  const outputMpp = opts.metersPerPixel / (coverScale || 1);
  const hasScale =
    opts.showScaleBar && outputMpp > 0 && Number.isFinite(outputMpp);
  // Representative fraction (1:N), only meaningful for physical paper sizes.
  const page = resolvePageSize(opts);
  let scaleRatio = 0;
  if (hasScale && page.unit === "mm" && W > 0) {
    const mmPerPx = pageMm(page).widthMm / W;
    if (mmPerPx > 0) scaleRatio = (outputMpp * 1000) / mmPerPx;
  }
  const navGrouped = opts.navigationGrouped ?? true;
  const groupNav = navGrouped && opts.showNorthArrow && hasScale;

  // --- Scale bar + north arrow ------------------------------------------
  let scaleTopY = bodyY + bodyH - inset;
  if (hasScale) {
    scaleTopY = drawScaleBar(
      ctx,
      bodyX + bodyW - inset,
      bodyY + bodyH - inset,
      bodyW * 0.28,
      outputMpp,
      unit,
      scaleRatio,
    );
  }
  if (opts.showNorthArrow) {
    const arrowRadius = unit * 2.6;
    const discRadius = arrowRadius * 1.5;
    if (groupNav) {
      // Stack the north arrow directly above the scale bar (the "navigation duo").
      drawNorthArrow(
        ctx,
        bodyX + bodyW - inset - discRadius,
        scaleTopY - unit * 1.4 - discRadius,
        arrowRadius,
        opts.bearingDeg,
        unit,
      );
    } else {
      // Isolated fallback: top-right corner inside the map.
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
  }

  // --- Legend (bottom-left inside the map) ------------------------------
  // Clip to the map body so a legend with many layers cannot overflow onto the
  // footer or off the page.
  if (opts.showLegend && opts.legend.length > 0) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(bodyX, bodyY, bodyW, bodyH);
    ctx.clip();
    drawLegend(ctx, bodyX + inset, bodyY + inset, opts.legend, unit, {
      title: opts.legendTitle,
      groupByLayer: opts.legendGroupByLayer,
    });
    ctx.restore();
  }

  // --- Page border -------------------------------------------------------
  if (opts.showPageBorder) {
    const widthScale = Math.max(1, Math.min(10, opts.pageBorderWidth ?? 2));
    const lw = Math.max(1, unit * 0.2 * widthScale);
    ctx.strokeStyle = opts.pageBorderColor ?? INK;
    ctx.lineWidth = lw;
    ctx.strokeRect(lw / 2, lw / 2, W - lw, H - lw);
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
  // Keep the label upright (only the arrow rotates with bearing): move to the
  // tip in the rotated frame, then undo the rotation before drawing the glyph.
  ctx.save();
  ctx.translate(0, -radius - unit * 1.4);
  ctx.rotate((bearingDeg * Math.PI) / 180);
  ctx.fillText("N", 0, 0);
  ctx.restore();
  ctx.restore();
}

/** Round a distance down to a "nice" 1/2/5 × 10ⁿ value. */
function niceDistance(meters: number): number {
  // Guard against a zero/negative body width: Math.log10(0) is -Infinity, which
  // would propagate as NaN through the scale-bar geometry.
  if (meters <= 0) return 1;
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
  // Below a metre (street/parcel zoom) label in centimetres instead of showing
  // a useless "0.0 m".
  if (meters >= 1) return `${Math.round(meters)} m`;
  return `${Math.round(meters * 100)} cm`;
}

/**
 * Draw a scale bar anchored at its bottom-right corner. When `scaleRatio` is a
 * positive value, a representative-fraction label (e.g. "1:25,000") is drawn
 * above the distance label.
 *
 * @returns The top Y of the scale bar's backing box, so a caller can stack the
 *   north arrow directly above it without overlapping.
 */
function drawScaleBar(
  ctx: CanvasRenderingContext2D,
  rightX: number,
  bottomY: number,
  maxWidthPx: number,
  metersPerPixel: number,
  unit: number,
  scaleRatio = 0,
): number {
  const maxMeters = maxWidthPx * metersPerPixel;
  const distance = niceDistance(maxMeters);
  const barWidth = distance / metersPerPixel;
  const barHeight = unit * 1.1;
  const x0 = rightX - barWidth;
  const y0 = bottomY - barHeight;

  const hasRatio = scaleRatio > 0 && Number.isFinite(scaleRatio);
  const ratioGap = hasRatio ? unit * 2.2 : 0;
  const backingTop = y0 - unit * 2.4 - ratioGap;

  ctx.save();
  // Backing for legibility.
  ctx.fillStyle = "rgba(255,255,255,0.78)";
  ctx.fillRect(
    x0 - unit * 0.8,
    backingTop,
    barWidth + unit * 1.6,
    bottomY - backingTop + unit * 0.8,
  );

  if (hasRatio) {
    ctx.fillStyle = INK;
    ctx.font = `600 ${unit * 1.7}px system-ui, sans-serif`;
    ctx.textAlign = "right";
    ctx.textBaseline = "bottom";
    ctx.fillText(formatScaleRatio(scaleRatio), rightX, y0 - unit * 2.4);
  }

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
  return backingTop;
}

/** Format a representative fraction as "1:N" with thousands separators. */
function formatScaleRatio(ratio: number): string {
  const rounded = Math.round(ratio);
  return `1:${rounded.toLocaleString("en-US")}`;
}

/** Draw a legend box anchored at its top-left corner. */
function drawLegend(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  entries: LegendEntry[],
  unit: number,
  opts: { title: string; groupByLayer: boolean },
): void {
  const pad = unit * 1.4;
  const rowH = unit * 2.6;
  const swatch = unit * 2;
  const titleSize = unit * 2;
  const labelSize = unit * 1.7;
  const title = opts.title.trim();
  const hasTitle = title.length > 0;

  // Flatten entries into drawable rows. Single-swatch entries render inline; a
  // multi-class entry renders a layer heading (when groupByLayer is on) above
  // its class swatches, or just the flat class swatches when it is off.
  const rows: { color: string; text: string }[] = [];
  for (const entry of entries) {
    if (entry.swatches.length <= 1) {
      // Prefer the swatch's own label so a multi-class entry collapsed to one
      // visible swatch (others hidden) keeps its class label (e.g. "High")
      // instead of falling back to the layer name. Genuine single-symbol
      // entries carry no swatch label, so they still show entry.name.
      const swatch = entry.swatches[0];
      rows.push({
        color: swatch?.color ?? "#999999",
        text: swatch?.label ?? entry.name,
      });
    } else {
      if (opts.groupByLayer) rows.push({ color: "", text: entry.name });
      for (const sw of entry.swatches) {
        rows.push({ color: sw.color, text: sw.label ?? "" });
      }
    }
  }

  // Measure required width.
  ctx.save();
  ctx.font = `600 ${titleSize}px system-ui, sans-serif`;
  let maxText = hasTitle ? ctx.measureText(title).width : 0;
  ctx.font = `400 ${labelSize}px system-ui, sans-serif`;
  for (const r of rows) {
    const w = ctx.measureText(r.text).width + (r.color ? swatch + unit : 0);
    if (w > maxText) maxText = w;
  }

  const boxW = maxText + pad * 2;
  const titleBlock = hasTitle ? titleSize + unit : 0;
  const boxH = pad * 2 + titleBlock + rows.length * rowH;

  ctx.fillStyle = "rgba(255,255,255,0.85)";
  ctx.strokeStyle = BORDER;
  ctx.lineWidth = Math.max(1, unit * 0.15);
  roundRect(ctx, x, y, boxW, boxH, unit);
  ctx.fill();
  ctx.stroke();

  // Rows advance by rowH before each draw, so seed cy at the top padding; with a
  // title, draw it first and leave a gap before the first row. Set the text
  // alignment unconditionally: drawLayout leaves textAlign/textBaseline at
  // center/middle from the title/footer blocks, so an empty legend title must
  // still reset them or the row labels render mis-anchored.
  let cy = y + pad;
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  if (hasTitle) {
    cy += titleSize;
    ctx.fillStyle = INK;
    ctx.font = `600 ${titleSize}px system-ui, sans-serif`;
    ctx.fillText(title, x + pad, cy);
    cy += unit;
  }

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
