/**
 * Print layout composer rendering.
 *
 * Pure, framework-free drawing helpers that compose a captured map image with
 * cartographic furniture (title, legend, scale bar, north arrow, footer) onto a
 * 2D canvas at a paper page size. The same {@link drawLayout} function backs
 * both the on-screen preview (small canvas) and the high-resolution export
 * (PNG / PDF), so the preview is faithful to the output.
 */

import { formatRoundNum, getRoundNum, scaleDenomination, type MapScaleUnit } from "@geolibre/core";

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
  {
    id: "letter",
    label: "Letter (8.5 × 11 in)",
    width: 215.9,
    height: 279.4,
    unit: "mm",
    group: "paper",
  },
  {
    id: "legal",
    label: "Legal (8.5 × 14 in)",
    width: 215.9,
    height: 355.6,
    unit: "mm",
    group: "paper",
  },
  {
    id: "tabloid",
    label: "Tabloid (11 × 17 in)",
    width: 279.4,
    height: 431.8,
    unit: "mm",
    group: "paper",
  },
  {
    id: "fullhd",
    label: "Full HD (1920 × 1080 px)",
    width: 1080,
    height: 1920,
    unit: "px",
    group: "screen",
  },
  { id: "hd", label: "HD (1280 × 720 px)", width: 720, height: 1280, unit: "px", group: "screen" },
  {
    id: "uhd4k",
    label: "4K UHD (3840 × 2160 px)",
    width: 2160,
    height: 3840,
    unit: "px",
    group: "screen",
  },
  {
    id: "square",
    label: "Square (1080 × 1080 px)",
    width: 1080,
    height: 1080,
    unit: "px",
    group: "screen",
  },
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
export function pagePx(size: ResolvedPageSize, dpi: number): { width: number; height: number } {
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

/** Corner of the map body a composed panel is anchored to. */
export type BodyCorner = "top-left" | "top-right" | "bottom-left" | "bottom-right";

/**
 * Resolved, drawable data for the chart block (GH #1324). Like the colorbar's
 * `colors`, everything here is already computed by the dialog (aggregation,
 * top-N capping, colors) so this drawing code stays data-only.
 */
export type DataChartData =
  | {
      kind: "bar";
      bars: { label: string; value: number; color: string }[];
      /** Largest bar value (>= 0), for scaling. */
      maxValue: number;
      /** Smallest bar value; negative when sum/mean produce negatives. */
      minValue: number;
      /**
       * Categories dropped past the top-N cap, drawn as a "+N more" note so
       * the chart is never silently incomplete (the pie folds its remainder
       * into an "(other)" slice instead).
       */
      truncated?: number;
    }
  | {
      kind: "pie";
      slices: { label: string; value: number; color: string }[];
      /** Sum of every slice value (> 0). */
      total: number;
    }
  | {
      kind: "line";
      /** Finite values plotted against original row order (gaps skipped). */
      points: { index: number; value: number }[];
      min: number;
      max: number;
      /** Total row count, so x spans the full feature order. */
      length: number;
      color: string;
    };

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
  /**
   * Unit system the scale bar labels distances in: `"metric"` (km/m/cm),
   * `"imperial"` (mi/ft), or `"nautical"` (nmi). Follows the project's map
   * preference so the printed bar matches the on-screen bar. Defaults to
   * `"metric"` when omitted.
   */
  scaleUnit?: MapScaleUnit;
  showNorthArrow: boolean;
  /**
   * Group the north arrow directly above the scale bar in the lower-right
   * corner (the cartographic "navigation duo"). When false they fall back to
   * isolated anchors: north arrow top-right, scale bar bottom-right.
   */
  navigationGrouped?: boolean;
  /**
   * Cartographic "title block" (stempel) drawn as a bordered panel in the
   * bottom-right corner. When present, the scale bar + north arrow relocate to
   * the bottom-left so they never sit under the block. GH #522.
   */
  showInfoBlock?: boolean;
  /** Map author or organization line of the info block. */
  author?: string;
  /** Project / reference number line of the info block. */
  projectNumber?: string;
  /** Coordinate reference system line of the info block (e.g. "EPSG:4326"). */
  crs?: string;
  /** Revision / version status line of the info block (e.g. "Rev 01"). */
  revision?: string;
  /**
   * Row labels for the info block. Supplied (translated) by the dialog; English
   * fallbacks are used when omitted so the framework-free drawing code stays
   * i18n-agnostic, like the legend title and north "N".
   */
  infoLabels?: {
    author?: string;
    project?: string;
    crs?: string;
    scale?: string;
    revision?: string;
  };
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
  /**
   * Colour of the map frame (the border drawn around the map body). Defaults to
   * a neutral grey when omitted. GH #749.
   */
  mapBorderColor?: string;
  /**
   * Map frame thickness on a 0–10 scale (relative to page size); 0 hides the
   * frame. Defaults to 1 (the original hairline). GH #749.
   */
  mapBorderWidth?: number;
  /**
   * Fill colour drawn behind the map image. Shows through wherever the capture
   * is transparent (most visibly the area around the sphere in globe
   * projection). Defaults to a light grey.
   */
  mapBackground?: string;
  /**
   * An optional colorbar composed in the Print Layout (independent of any on-map
   * colorbar control), drawn crisply at export resolution at the chosen corner.
   * `colors` are the gradient stops (low value first), resolved from a named
   * ramp by the dialog so this drawing code stays data-only.
   */
  colorbar?: {
    colors: readonly string[];
    min: number;
    max: number;
    label?: string;
    orientation: "horizontal" | "vertical";
    position: "top-left" | "top-right" | "bottom-left" | "bottom-right";
    /** Bar length as a percentage of the body's width (horizontal) or height
     * (vertical). Defaults to 34. */
    lengthPct?: number;
  } | null;
  /**
   * A user-defined legend composed in the Print Layout (independent of the
   * layer-derived {@link legend}), drawn as a bordered panel at the chosen
   * corner -- the equivalent of a Controls -> Legend control, but native to the
   * layout so it stays crisp.
   */
  customLegend?: {
    title?: string;
    entries: { label: string; color: string }[];
    position: "top-left" | "top-right" | "bottom-left" | "bottom-right";
  } | null;
  /**
   * An attribute-table block composed in the Print Layout (GH #1324): rows of a
   * vector layer's attributes drawn as a bordered panel at the chosen corner.
   * Cell text is already resolved to display strings (and, for an atlas page,
   * already filtered to the page extent) by the dialog, so this drawing code
   * stays data-only.
   */
  dataTable?: {
    title?: string;
    /** Column headers, in display order. */
    columns: string[];
    /** Row cells as display strings, aligned with {@link columns}. */
    rows: string[][];
    /**
     * How many source rows the dialog's row limit already dropped. Rows the
     * renderer additionally hides to fit the body height are added to this
     * count in a "+N more" note under the table.
     */
    truncated?: number;
    /**
     * Translated formatter for the note (e.g. `(n) => t("moreRows", {count:
     * n})`). A function rather than preformatted text because the final count
     * depends on the canvas geometry; falls back to English "+N more" when
     * omitted, like the drawing code's other i18n fallbacks.
     */
    formatNote?: (count: number) => string;
    position: BodyCorner;
  } | null;
  /**
   * A chart block composed in the Print Layout (GH #1324): a bar, pie, or line
   * chart of a vector layer's attributes, drawn crisply at export resolution
   * at the chosen corner.
   */
  dataChart?: {
    title?: string;
    position: BodyCorner;
    data: DataChartData;
    /**
     * Translated formatter for the bar chart's "+N more" truncation note;
     * falls back to English when omitted (like the table's formatter).
     */
    formatNote?: (count: number) => string;
  } | null;
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
  /**
   * How the captured map fills the body. "cover" (default) scales to fill and
   * crops the overflow; "contain" fits the whole image inside the body without
   * cropping, leaving {@link mapBackground} margins on the shorter axis. Used so
   * an active graticule's edge labels are not trimmed by the cover crop.
   */
  mapFit?: "cover" | "contain";
}

const PAGE_BACKGROUND = "#ffffff";
const INK = "#111827";
const MUTED = "#6b7280";
const BORDER = "#9ca3af";

/** Resolved presence of the optional title/footer content, shared by the body
 * geometry computation and the drawing pass so they never disagree. */
interface ContentFlags {
  showSubtitle: boolean;
  hasTitleText: boolean;
  hasSubtitleText: boolean;
  hasTitleBlock: boolean;
  titleInside: boolean;
  attributionText: string | false;
  footerText: string | false;
  dateText: string | false;
  hasFooterRow: boolean;
}

function resolveContentFlags(opts: LayoutOptions): ContentFlags {
  const titleInside = opts.titlePlacement === "inside";
  const showSubtitle = opts.showSubtitle ?? true;
  const hasTitleText = opts.showTitle && opts.title.trim().length > 0;
  const hasSubtitleText = showSubtitle && opts.subtitle.trim().length > 0;
  // Attribution is opt-out (on unless explicitly disabled), deliberately unlike
  // the other new booleans: GH #526 wants a pre-checked "Created with GeoLibre"
  // credit so it survives a user replacing the footer text.
  const attributionText =
    opts.showAttribution !== false && (opts.attributionText ?? "Created with GeoLibre").trim();
  const footerText = opts.showFooter && opts.footerText.trim();
  const dateText = (opts.showDate && (opts.dateText ?? "").trim()) || false;
  return {
    showSubtitle,
    hasTitleText,
    hasSubtitleText,
    hasTitleBlock: hasTitleText || hasSubtitleText,
    titleInside,
    attributionText,
    footerText,
    dateText,
    hasFooterRow: Boolean(attributionText || footerText || dateText),
  };
}

/** Geometry of the map body and the furniture scale unit for a given page. */
interface BodyRect {
  unit: number;
  margin: number;
  bodyX: number;
  bodyY: number;
  bodyW: number;
  bodyH: number;
}

/**
 * Compute the map body rectangle for a page of {@link W}×{@link H} pixels,
 * reserving room for an outside title block (top) and the footer row (bottom).
 * Shared by {@link drawLayout} and {@link computeScaleRatio} so the preview, the
 * export, and the reported 1:N scale are all derived from the same geometry.
 */
function computeBodyRect(opts: LayoutOptions, W: number, H: number): BodyRect {
  const unit = Math.min(W, H) / 100;
  const marginScale = opts.pageMargin === "none" ? 0 : opts.pageMargin === "narrow" ? 0.5 : 1;
  const margin = unit * 5 * marginScale;
  const f = resolveContentFlags(opts);

  let bodyTop = margin;
  if (f.hasTitleBlock && !f.titleInside) {
    const titleSize = unit * 4.5;
    const subtitleSize = unit * 2.4;
    let y = margin + titleSize;
    if (f.hasSubtitleText) y += subtitleSize * 1.4;
    bodyTop = y + unit * 3;
  }

  let bodyBottom = H - margin;
  if (f.hasFooterRow) {
    const footSize = unit * 2.2;
    bodyBottom = H - margin - footSize * 1.8;
  }

  bodyTop = Math.min(bodyTop, bodyBottom - unit * 10);
  return {
    unit,
    margin,
    bodyX: margin,
    bodyY: bodyTop,
    bodyW: W - margin * 2,
    bodyH: Math.max(unit * 10, bodyBottom - bodyTop),
  };
}

/**
 * Cover-scale of a captured map image into the body rectangle: the factor that
 * fills the body (cropping overflow), matching the draw in {@link drawLayout}.
 */
function coverScaleFor(
  bodyW: number,
  bodyH: number,
  imgW: number,
  imgH: number,
  fit: "cover" | "contain" = "cover",
): number {
  if (imgW <= 0 || imgH <= 0) return 1;
  // "cover" scales to the larger ratio (fills, crops overflow); "contain" scales
  // to the smaller ratio (fits entirely, no crop).
  return fit === "contain"
    ? Math.min(bodyW / imgW, bodyH / imgH)
    : Math.max(bodyW / imgW, bodyH / imgH);
}

/**
 * The representative fraction (the N in "1:N") the layout currently renders at:
 * how many ground millimetres each paper millimetre spans. Returns 0 when the
 * scale is not meaningful (a pixel/screen size, or no captured map), so callers
 * can hide the scale control.
 *
 * The value is independent of the resolution the page is rasterized at (the
 * body and cover scale grow together with the canvas), so a nominal reference
 * canvas is used here.
 */
export function computeScaleRatio(opts: LayoutOptions): number {
  const page = resolvePageSize(opts);
  if (page.unit !== "mm") return 0;
  if (
    !opts.mapImage ||
    opts.mapImageWidth <= 0 ||
    opts.mapImageHeight <= 0 ||
    !(opts.metersPerPixel > 0) ||
    !Number.isFinite(opts.metersPerPixel)
  ) {
    return 0;
  }
  const aspect = page.width / page.height;
  const refLong = 1000;
  const W = aspect >= 1 ? refLong : refLong * aspect;
  const H = aspect >= 1 ? refLong / aspect : refLong;
  const rect = computeBodyRect(opts, W, H);
  const coverScale = coverScaleFor(
    rect.bodyW,
    rect.bodyH,
    opts.mapImageWidth,
    opts.mapImageHeight,
    opts.mapFit ?? "cover",
  );
  const outputMpp = opts.metersPerPixel / (coverScale || 1);
  const mmPerPx = pageMm(page).widthMm / W;
  if (!(mmPerPx > 0)) return 0;
  const ratio = (outputMpp * 1000) / mmPerPx;
  return Number.isFinite(ratio) && ratio > 0 ? ratio : 0;
}

/**
 * Draw the full page layout onto a canvas. The canvas pixel dimensions define
 * the render resolution; all furniture is scaled relative to the page so the
 * preview and the export look identical.
 *
 * @param canvas - Destination canvas; its width/height are taken as the page
 *   size in pixels.
 * @param opts - Layout content and options.
 */
export function drawLayout(canvas: HTMLCanvasElement, opts: LayoutOptions): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  const W = canvas.width;
  const H = canvas.height;
  // Scale furniture relative to the page's shorter side so output looks the
  // same at any resolution / paper size. The body rectangle and unit come from
  // the shared geometry helper so the on-screen scale matches the export.
  const { unit, margin, bodyX, bodyY, bodyW, bodyH } = computeBodyRect(opts, W, H);
  const {
    hasTitleText,
    hasSubtitleText,
    hasTitleBlock,
    titleInside,
    attributionText,
    footerText,
    dateText,
    hasFooterRow,
  } = resolveContentFlags(opts);

  const titleAlign = opts.titleAlign ?? "center";

  ctx.save();
  ctx.fillStyle = PAGE_BACKGROUND;
  ctx.fillRect(0, 0, W, H);

  // X anchor + canvas textAlign for the chosen title alignment.
  const titleX = titleAlign === "left" ? margin : titleAlign === "right" ? W - margin : W / 2;

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
  }

  // --- Footer row --------------------------------------------------------
  if (hasFooterRow) {
    const footSize = unit * 2.2;
    const baselineY = H - margin - footSize * 0.6;
    ctx.fillStyle = MUTED;
    ctx.font = `400 ${footSize}px system-ui, -apple-system, sans-serif`;
    ctx.textBaseline = "middle";
    // Give each of the three slots a third of the printable width so a long
    // left attribution cannot visually bleed into the centred footer text.
    const slotMax = (W - margin * 2) / 3;
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
  // The body rectangle is computed by computeBodyRect (which already clamps the
  // top so a tall title block plus footer on a very small page can never push
  // the map area below the footer).
  ctx.save();
  ctx.beginPath();
  ctx.rect(bodyX, bodyY, bodyW, bodyH);
  ctx.clip();
  ctx.fillStyle = opts.mapBackground ?? "#e5e7eb";
  ctx.fillRect(bodyX, bodyY, bodyW, bodyH);

  // Draw the map image. "cover" (default) fills the body and crops the overflow;
  // "contain" fits the whole image without cropping (used for a graticule so its
  // edge labels are not trimmed), leaving background margins on the shorter axis.
  // Guard the draw: a tainted/broken capture must not abort the whole layout,
  // otherwise a single bad basemap (e.g. cross-origin OpenTopo tiles) would wipe
  // out every cartographic element too, not just the map image.
  let coverScale = 1;
  if (opts.mapImage && opts.mapImageWidth > 0 && opts.mapImageHeight > 0) {
    coverScale = coverScaleFor(
      bodyW,
      bodyH,
      opts.mapImageWidth,
      opts.mapImageHeight,
      opts.mapFit ?? "cover",
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

  // Body border (the map frame). Colour and thickness are user-customizable; a
  // thickness of 0 hides the frame entirely (GH #749). The thickness is a 0–10
  // scale relative to the page so it reads the same at any export resolution.
  const mapBorderScale = Math.max(0, Math.min(10, opts.mapBorderWidth ?? 1));
  const mapBorderWidth = mapBorderScale > 0 ? Math.max(1, unit * 0.2 * mapBorderScale) : 0;
  if (mapBorderWidth > 0) {
    ctx.strokeStyle = opts.mapBorderColor ?? BORDER;
    ctx.lineWidth = mapBorderWidth;
    ctx.strokeRect(bodyX, bodyY, bodyW, bodyH);
  }

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
    // Seed the baseline at the first line that is actually drawn: when the title
    // is hidden, the subtitle takes the top slot rather than being pushed a full
    // title-height down (which dropped it below the backing rect). GH #526.
    let y = bodyY + padY + (hasTitleText ? titleSize : subtitleSize);
    const insetX = unit * 2;
    const tx =
      titleAlign === "left"
        ? bodyX + insetX
        : titleAlign === "right"
          ? bodyX + bodyW - insetX
          : bodyX + bodyW / 2;
    const blockH =
      padY * 2 +
      (hasTitleText ? titleSize : 0) +
      (hasSubtitleText ? (hasTitleText ? subtitleSize * 1.6 : subtitleSize * 1.2) : 0);
    // Keep the translucent backing clear of the map frame so it does not wash
    // out the dark border line at the top/left/right edges (GH #748). strokeRect
    // centres the stroke on the body edge, so only its inner half (lineWidth/2)
    // intrudes into the body; inset the fill by exactly that so it starts at the
    // frame's inner edge with no gap and no overlap.
    const frameInset = mapBorderWidth / 2;
    ctx.fillStyle = "rgba(255,255,255,0.7)";
    ctx.fillRect(
      bodyX + frameInset,
      bodyY + frameInset,
      bodyW - frameInset * 2,
      // Top shifted down by frameInset; shrink the height to keep the bottom
      // edge at bodyY + blockH (which sits inside the body, off any frame line).
      blockH - frameInset,
    );
    if (hasTitleText) {
      ctx.fillStyle = INK;
      ctx.font = `600 ${titleSize}px system-ui, -apple-system, sans-serif`;
      ctx.textAlign = titleAlign;
      ctx.textBaseline = "alphabetic";
      ctx.fillText(opts.title.trim(), tx, y, bodyW - insetX * 2);
    }
    if (hasSubtitleText) {
      // Only advance past the title line when one was drawn.
      if (hasTitleText) y += subtitleSize * 1.4;
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
  const hasScale = opts.showScaleBar && outputMpp > 0 && Number.isFinite(outputMpp);
  // Representative fraction (1:N) from the shared, resolution-independent helper
  // so the scale bar, the info block, and the dialog's scale input all agree.
  // It is only non-zero for physical paper sizes with a captured map.
  const scaleRatio = computeScaleRatio(opts);

  // --- Info block (cartographic title block / "stempel", bottom-right) ----
  // Rendered only when the toggle is on AND there is at least one row to show
  // (a metadata field or an available scale). With the toggle on but every
  // field empty and no scale (e.g. a screen-size page), nothing is drawn rather
  // than an empty box; the dialog still shows the input fields to fill in.
  const infoLines = buildInfoLines(opts, scaleRatio);
  const hasInfoBlock = (opts.showInfoBlock ?? false) && infoLines.length > 0;
  if (hasInfoBlock) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(bodyX, bodyY, bodyW, bodyH);
    ctx.clip();
    drawInfoBlock(ctx, bodyX + bodyW - inset, bodyY + bodyH - inset, infoLines, unit);
    ctx.restore();
  }

  const navGrouped = opts.navigationGrouped ?? true;
  const groupNav = navGrouped && opts.showNorthArrow && hasScale;
  // When the info block occupies the bottom-right corner, move the scale bar +
  // north arrow to the bottom-left so they never sit under the block.
  const navOnLeft = hasInfoBlock;
  const navAnchorX = navOnLeft ? bodyX + inset + bodyW * 0.28 : bodyX + bodyW - inset;

  // --- Scale bar + north arrow ------------------------------------------
  let scaleTopY = bodyY + bodyH - inset;
  if (hasScale) {
    scaleTopY = drawScaleBar(
      ctx,
      navAnchorX,
      bodyY + bodyH - inset,
      bodyW * 0.28,
      outputMpp,
      unit,
      scaleRatio,
      opts.scaleUnit ?? "metric",
    );
  }
  if (opts.showNorthArrow) {
    const arrowRadius = unit * 2.6;
    const discRadius = arrowRadius * 1.5;
    if (groupNav) {
      // Stack the north arrow directly above the scale bar (the "navigation duo").
      drawNorthArrow(
        ctx,
        navAnchorX - discRadius,
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

  // --- Legend (top-left inside the map) ---------------------------------
  // Clip to the map body so a legend with many layers cannot overflow onto the
  // footer or off the page.
  let legendHeight = 0;
  if (opts.showLegend && opts.legend.length > 0) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(bodyX, bodyY, bodyW, bodyH);
    ctx.clip();
    legendHeight = drawLegend(ctx, bodyX + inset, bodyY + inset, opts.legend, unit, {
      title: opts.legendTitle,
      groupByLayer: opts.legendGroupByLayer,
    });
    ctx.restore();
  }

  // --- Corner panels (colorbar, custom legend, table, chart) ------------
  // Panels sharing a corner stack toward the body centre instead of drawing
  // on top of each other (e.g. colorbar + chart, both defaulting top-right).
  // The ledger tracks the vertical space already claimed per corner; the info
  // block still owns the bottom-right, so panels aimed there relocate to the
  // top-right first (the original colorbar rule, GH #522).
  const stackGap = unit * 1.2;
  const cornerUsed: Record<BodyCorner, number> = {
    // The layer-derived legend always occupies the top-left corner when shown;
    // seed the ledger so a panel aimed there stacks below it.
    "top-left": legendHeight > 0 ? legendHeight + stackGap : 0,
    "top-right": 0,
    "bottom-left": 0,
    "bottom-right": 0,
  };
  const resolveCorner = (position: BodyCorner): BodyCorner =>
    hasInfoBlock && position === "bottom-right" ? "top-right" : position;
  const drawCornerPanel = (
    position: BodyCorner,
    draw: (corner: BodyCorner, stackOffset: number) => number,
  ) => {
    const corner = resolveCorner(position);
    ctx.save();
    ctx.beginPath();
    ctx.rect(bodyX, bodyY, bodyW, bodyH);
    ctx.clip();
    const height = draw(corner, cornerUsed[corner]);
    ctx.restore();
    cornerUsed[corner] += height + stackGap;
  };

  if (opts.colorbar && opts.colorbar.colors.length >= 2) {
    const colorbar = opts.colorbar;
    drawCornerPanel(colorbar.position, (corner, stackOffset) =>
      drawColorbar(
        ctx,
        { ...colorbar, position: corner },
        bodyX,
        bodyY,
        bodyW,
        bodyH,
        unit,
        stackOffset,
      ),
    );
  }

  if (opts.customLegend && opts.customLegend.entries.length > 0) {
    const customLegend = opts.customLegend;
    drawCornerPanel(customLegend.position, (corner, stackOffset) =>
      drawCustomLegend(
        ctx,
        { ...customLegend, position: corner },
        bodyX,
        bodyY,
        bodyW,
        bodyH,
        unit,
        stackOffset,
      ),
    );
  }

  if (opts.dataTable && opts.dataTable.columns.length > 0 && opts.dataTable.rows.length > 0) {
    const table = opts.dataTable;
    drawCornerPanel(table.position, (corner, stackOffset) =>
      drawDataTable(
        ctx,
        { ...table, position: corner },
        bodyX,
        bodyY,
        bodyW,
        bodyH,
        unit,
        stackOffset,
      ),
    );
  }

  if (opts.dataChart) {
    const chart = opts.dataChart;
    drawCornerPanel(chart.position, (corner, stackOffset) =>
      drawDataChart(
        ctx,
        { ...chart, position: corner },
        bodyX,
        bodyY,
        bodyW,
        bodyH,
        unit,
        stackOffset,
      ),
    );
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

/**
 * Round a positive span with the shared cartographic rounder ({@link
 * getRoundNum} — the same one the on-screen `PlanetaryScaleControl` uses), so
 * the printed bar snaps a given ground span to the same value the map does.
 * Falls back to 1 for a non-positive span (a zero/negative body width) so the
 * bar geometry never turns into NaN — `getRoundNum` returns 0 there.
 */
function niceSpan(span: number): number {
  return span > 0 ? getRoundNum(span) : 1;
}

/**
 * The denomination the print bar rounds and labels distances with. Delegates to
 * the shared {@link scaleDenomination} (km/m, mi/ft, nmi) and adds one
 * print-only refinement: a metric sub-metre span (street/parcel zoom) labels in
 * centimetres rather than showing a useless "0.x m". Returns the size in metres
 * of one unit of that denomination so the caller can round in unit space and
 * convert the result back to metres (and thus pixels).
 */
function printScaleDenomination(
  maxMeters: number,
  unit: MapScaleUnit,
): { metersPerUnit: number; label: string } {
  if (unit === "metric" && maxMeters > 0 && maxMeters < 1) {
    return { metersPerUnit: 0.01, label: "cm" };
  }
  return scaleDenomination(maxMeters, unit);
}

/** Format a rounded span in its denomination, trimming trailing-zero noise. */
function formatSpanLabel(span: number, label: string): string {
  return `${formatRoundNum(span)} ${label}`;
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
  scaleUnit: MapScaleUnit = "metric",
): number {
  const maxMeters = maxWidthPx * metersPerPixel;
  // Round to a nice number in the target unit (feet, miles, km, ...) so the bar
  // lands on a readable value in that system, then convert back to metres for
  // the pixel width.
  const { metersPerUnit, label } = printScaleDenomination(maxMeters, scaleUnit);
  const rounded = niceSpan(maxMeters / metersPerUnit);
  const distance = rounded * metersPerUnit;
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
  ctx.fillText(formatSpanLabel(rounded, label), rightX, y0 - unit * 0.5);
  ctx.restore();
  return backingTop;
}

/** Format a representative fraction as "1:N" with thousands separators. */
function formatScaleRatio(ratio: number): string {
  const rounded = Math.round(ratio);
  // No explicit locale tag: a 1:N scale prints on the exported artefact, so it
  // should follow the host environment's thousands separator (e.g. dots/spaces
  // for de/fr) rather than being pinned to US commas.
  return `1:${rounded.toLocaleString()}`;
}

/** One "Label: value" row of the cartographic info block. */
interface InfoLine {
  label: string;
  value: string;
}

/**
 * Build the rows of the info block (title block / "stempel") from the layout
 * options, in conventional top-to-bottom order: project reference, author,
 * CRS, scale, then revision. Empty fields are skipped, and the scale row is
 * auto-populated from {@link scaleRatio} when a physical scale is available.
 */
function buildInfoLines(opts: LayoutOptions, scaleRatio: number): InfoLine[] {
  const labels = opts.infoLabels ?? {};
  const lines: InfoLine[] = [];
  const push = (label: string | undefined, fallback: string, value?: string) => {
    const v = (value ?? "").trim();
    if (v) lines.push({ label: label ?? fallback, value: v });
  };
  // Row order follows the cartographic title-block convention (reference number
  // first as the primary identifier), which intentionally differs from the
  // dialog form's field order; keep it stable rather than matching the form.
  push(labels.project, "Project", opts.projectNumber);
  push(labels.author, "Author", opts.author);
  push(labels.crs, "CRS", opts.crs);
  if (scaleRatio > 0 && Number.isFinite(scaleRatio)) {
    lines.push({
      label: labels.scale ?? "Scale",
      value: formatScaleRatio(scaleRatio),
    });
  }
  push(labels.revision, "Revision", opts.revision);
  return lines;
}

/**
 * Draw the info block as a bordered panel anchored at its bottom-right corner,
 * with one "Label: value" row per entry. Mirrors {@link drawLegend}'s boxed
 * style so the two panels read as a set.
 *
 * @returns The top Y of the drawn box.
 */
function drawInfoBlock(
  ctx: CanvasRenderingContext2D,
  rightX: number,
  bottomY: number,
  lines: InfoLine[],
  unit: number,
): number {
  const pad = unit * 1.4;
  const rowH = unit * 2.4;
  const labelSize = unit * 1.7;
  const gap = unit * 1.2;

  ctx.save();
  ctx.font = `600 ${labelSize}px system-ui, sans-serif`;
  let labelW = 0;
  for (const l of lines) labelW = Math.max(labelW, ctx.measureText(l.label).width);
  ctx.font = `400 ${labelSize}px system-ui, sans-serif`;
  let valueW = 0;
  for (const l of lines) valueW = Math.max(valueW, ctx.measureText(l.value).width);

  const boxW = pad * 2 + labelW + gap + valueW;
  const boxH = pad * 2 + lines.length * rowH;
  const x = rightX - boxW;
  const y = bottomY - boxH;

  ctx.fillStyle = "rgba(255,255,255,0.85)";
  ctx.strokeStyle = BORDER;
  ctx.lineWidth = Math.max(1, unit * 0.15);
  roundRect(ctx, x, y, boxW, boxH, unit);
  ctx.fill();
  ctx.stroke();

  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  let cy = y + pad;
  for (const l of lines) {
    cy += rowH;
    ctx.fillStyle = MUTED;
    ctx.font = `600 ${labelSize}px system-ui, sans-serif`;
    // Cap each cell to its measured column width so a measureText rounding
    // error can never push a glyph past the box border.
    ctx.fillText(l.label, x + pad, cy, labelW);
    ctx.fillStyle = INK;
    ctx.font = `400 ${labelSize}px system-ui, sans-serif`;
    ctx.fillText(l.value, x + pad + labelW + gap, cy, valueW);
  }
  ctx.restore();
  return y;
}

/**
 * Format a colorbar tick value compactly (exponential for extremes). `decimals`
 * is derived from the tick step so a small range (e.g. 0..0.01) does not collapse
 * to repeated labels; trailing zeros are trimmed.
 */
function formatColorbarTick(value: number, decimals = 2): string {
  if (!Number.isFinite(value)) return String(value);
  const abs = Math.abs(value);
  if (abs !== 0 && (abs >= 100000 || abs < 0.001)) return value.toExponential(1);
  const fixed = value.toFixed(Math.max(0, Math.min(8, decimals)));
  return fixed.includes(".") ? fixed.replace(/\.?0+$/, "") : fixed;
}

type ColorbarSpec = NonNullable<LayoutOptions["colorbar"]>;

/**
 * Draw a colorbar (gradient ramp + value ticks + optional label) as a bordered
 * panel anchored at one of the four body corners. Rendered with the canvas at
 * full output resolution, so it stays crisp in the export (unlike a rasterized
 * on-map control).
 *
 * @returns The drawn panel's height, so a later panel sharing the corner can
 *   stack below/above it instead of overlapping.
 */
function drawColorbar(
  ctx: CanvasRenderingContext2D,
  cb: ColorbarSpec,
  bodyX: number,
  bodyY: number,
  bodyW: number,
  bodyH: number,
  unit: number,
  stackOffset = 0,
): number {
  const vertical = cb.orientation === "vertical";
  const pad = unit * 1.4;
  const barThick = unit * 2.2;
  // Clamp the requested length to a sane band so the bar can't vanish or run off
  // the body, then take that fraction of the relevant body dimension.
  const lengthFrac = Math.max(5, Math.min(95, cb.lengthPct ?? 34)) / 100;
  const barLen = (vertical ? bodyH : bodyW) * lengthFrac;
  const labelSize = unit * 1.7;
  const titleSize = unit * 1.9;
  const tickGap = unit * 0.7;
  const tickLen = unit * 0.7;
  const inset = unit * 2; // matches the info block/legend corner inset
  const lineW = Math.max(1, unit * 0.12);
  const titleGap = unit * 0.8;
  const title = (cb.label ?? "").trim();
  const hasTitle = title.length > 0;

  const span = cb.max - cb.min;
  // A zero (or non-finite) range would render five identical tick labels; show
  // a single centred label instead.
  const TICKS = span > 0 ? 5 : 1;
  const step = TICKS > 1 ? span / (TICKS - 1) : 0;
  // Enough decimals to keep adjacent ticks distinct for small ranges (at least
  // 2, as before, for normal ranges).
  const decimals =
    step > 0 && step < 1 ? Math.max(2, Math.min(8, Math.ceil(-Math.log10(step)) + 1)) : 2;
  const ticks = Array.from({ length: TICKS }, (_, i) => {
    const t = TICKS === 1 ? 0.5 : i / (TICKS - 1);
    return { t, text: formatColorbarTick(cb.min + span * t, decimals) };
  });

  ctx.save();
  ctx.font = `400 ${labelSize}px system-ui, sans-serif`;
  let maxLabelW = 0;
  for (const tk of ticks) {
    maxLabelW = Math.max(maxLabelW, ctx.measureText(tk.text).width);
  }
  ctx.font = `600 ${titleSize}px system-ui, sans-serif`;
  const titleW = hasTitle ? ctx.measureText(title).width : 0;
  // Space reserved for the label: a horizontal line above the bar, or a rotated
  // line beside it (vertical orientation).
  const titleStrip = hasTitle ? titleSize + titleGap : 0;

  // Panel size. Vertical bars reserve half a label above/below so the end ticks
  // (drawn middle-baseline) never clip the panel.
  let panelW: number;
  let panelH: number;
  if (vertical) {
    panelW = pad * 2 + titleStrip + barThick + tickLen + tickGap + maxLabelW;
    panelH = pad * 2 + barLen + labelSize;
  } else {
    panelW = pad * 2 + Math.max(barLen, titleW);
    panelH = pad * 2 + titleStrip + barThick + tickLen + tickGap + labelSize;
  }

  const { x: px, y: py } = panelOrigin(
    cb.position,
    bodyX,
    bodyY,
    bodyW,
    bodyH,
    inset,
    panelW,
    panelH,
    stackOffset,
  );

  ctx.fillStyle = "rgba(255,255,255,0.85)";
  ctx.strokeStyle = BORDER;
  ctx.lineWidth = Math.max(1, unit * 0.15);
  roundRect(ctx, px, py, panelW, panelH, unit);
  ctx.fill();
  ctx.stroke();

  const addStops = (grad: CanvasGradient) => {
    const n = cb.colors.length - 1;
    cb.colors.forEach((c, i) => grad.addColorStop(n > 0 ? i / n : 0, c));
  };

  if (vertical) {
    const barX = px + pad + titleStrip;
    const barY = py + pad + labelSize / 2;
    // Label: rotated to read bottom-to-top, centred along the bar, in the strip
    // to the left of it.
    if (hasTitle) {
      ctx.save();
      ctx.translate(px + pad + titleSize / 2, barY + barLen / 2);
      ctx.rotate(-Math.PI / 2);
      ctx.fillStyle = INK;
      ctx.font = `600 ${titleSize}px system-ui, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(title, 0, 0, barLen);
      ctx.restore();
    }
    // Bar (bottom = min, top = max).
    const grad = ctx.createLinearGradient(0, barY + barLen, 0, barY);
    addStops(grad);
    ctx.fillStyle = grad;
    ctx.fillRect(barX, barY, barThick, barLen);
    ctx.strokeStyle = INK;
    ctx.lineWidth = lineW;
    ctx.strokeRect(barX, barY, barThick, barLen);
    ctx.font = `400 ${labelSize}px system-ui, sans-serif`;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    for (const tk of ticks) {
      const ty = barY + barLen - tk.t * barLen;
      ctx.strokeStyle = INK;
      ctx.beginPath();
      ctx.moveTo(barX + barThick, ty);
      ctx.lineTo(barX + barThick + tickLen, ty);
      ctx.stroke();
      ctx.fillStyle = INK;
      ctx.fillText(tk.text, barX + barThick + tickLen + tickGap, ty);
    }
  } else {
    const centerX = px + panelW / 2;
    let cursorY = py + pad;
    // Label: horizontal, centred above the bar.
    if (hasTitle) {
      ctx.fillStyle = INK;
      ctx.font = `600 ${titleSize}px system-ui, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      ctx.fillText(title, centerX, cursorY, panelW - pad * 2);
      cursorY += titleStrip;
    }
    const barX = centerX - barLen / 2;
    const barY = cursorY;
    // Left = min, right = max.
    const grad = ctx.createLinearGradient(barX, 0, barX + barLen, 0);
    addStops(grad);
    ctx.fillStyle = grad;
    ctx.fillRect(barX, barY, barLen, barThick);
    ctx.strokeStyle = INK;
    ctx.lineWidth = lineW;
    ctx.strokeRect(barX, barY, barLen, barThick);
    ctx.font = `400 ${labelSize}px system-ui, sans-serif`;
    ctx.textBaseline = "top";
    for (const tk of ticks) {
      const tx = barX + tk.t * barLen;
      ctx.strokeStyle = INK;
      ctx.beginPath();
      ctx.moveTo(tx, barY + barThick);
      ctx.lineTo(tx, barY + barThick + tickLen);
      ctx.stroke();
      // Keep the end labels inside the panel.
      ctx.textAlign = tk.t === 0 ? "left" : tk.t === 1 ? "right" : "center";
      ctx.fillStyle = INK;
      ctx.fillText(tk.text, tx, barY + barThick + tickLen + tickGap);
    }
  }
  ctx.restore();
  return panelH;
}

type CustomLegendSpec = NonNullable<LayoutOptions["customLegend"]>;

/**
 * Draw a user-defined legend (title + colour/label rows) as a bordered panel
 * anchored at one of the four body corners. Crisp at export resolution, the
 * native equivalent of a Controls -> Legend control.
 *
 * @returns The drawn panel's height, for corner stacking.
 */
function drawCustomLegend(
  ctx: CanvasRenderingContext2D,
  cl: CustomLegendSpec,
  bodyX: number,
  bodyY: number,
  bodyW: number,
  bodyH: number,
  unit: number,
  stackOffset = 0,
): number {
  const pad = unit * 1.4;
  const rowH = unit * 2.6;
  const swatch = unit * 2;
  const gap = unit;
  const titleSize = unit * 2;
  const labelSize = unit * 1.7;
  const inset = unit * 2; // matches the info block/legend corner inset
  const title = (cl.title ?? "").trim();
  const hasTitle = title.length > 0;

  ctx.save();
  ctx.font = `600 ${titleSize}px system-ui, sans-serif`;
  let maxText = hasTitle ? ctx.measureText(title).width : 0;
  ctx.font = `400 ${labelSize}px system-ui, sans-serif`;
  for (const e of cl.entries) {
    const w = swatch + gap + ctx.measureText(e.label).width;
    if (w > maxText) maxText = w;
  }

  const titleBlock = hasTitle ? titleSize + unit : 0;
  const boxW = pad * 2 + maxText;
  const boxH = pad * 2 + titleBlock + cl.entries.length * rowH;
  const { x, y } = panelOrigin(
    cl.position,
    bodyX,
    bodyY,
    bodyW,
    bodyH,
    inset,
    boxW,
    boxH,
    stackOffset,
  );

  ctx.fillStyle = "rgba(255,255,255,0.85)";
  ctx.strokeStyle = BORDER;
  ctx.lineWidth = Math.max(1, unit * 0.15);
  roundRect(ctx, x, y, boxW, boxH, unit);
  ctx.fill();
  ctx.stroke();

  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  let cy = y + pad;
  if (hasTitle) {
    cy += titleSize;
    ctx.fillStyle = INK;
    ctx.font = `600 ${titleSize}px system-ui, sans-serif`;
    ctx.fillText(title, x + pad, cy, boxW - pad * 2);
    cy += unit;
  }
  ctx.font = `400 ${labelSize}px system-ui, sans-serif`;
  for (const e of cl.entries) {
    cy += rowH;
    ctx.fillStyle = e.color;
    ctx.fillRect(x + pad, cy - swatch * 0.85, swatch, swatch);
    ctx.strokeStyle = BORDER;
    ctx.lineWidth = Math.max(1, unit * 0.15);
    ctx.strokeRect(x + pad, cy - swatch * 0.85, swatch, swatch);
    ctx.fillStyle = INK;
    ctx.fillText(e.label, x + pad + swatch + gap, cy, boxW - pad * 2 - swatch - gap);
  }
  ctx.restore();
  return boxH;
}

/**
 * Top-left origin of a panel of `boxW`×`boxH` anchored at a body corner.
 * `stackOffset` shifts the panel toward the body centre (down from a top
 * corner, up from a bottom one) past panels already drawn in that corner, so
 * two panels sharing a corner stack instead of overlapping.
 */
function panelOrigin(
  position: BodyCorner,
  bodyX: number,
  bodyY: number,
  bodyW: number,
  bodyH: number,
  inset: number,
  boxW: number,
  boxH: number,
  stackOffset = 0,
): { x: number; y: number } {
  return {
    x: position.endsWith("left") ? bodyX + inset : bodyX + bodyW - inset - boxW,
    y: position.startsWith("top")
      ? bodyY + inset + stackOffset
      : bodyY + bodyH - inset - boxH - stackOffset,
  };
}

/**
 * Truncate text to fit `maxWidth` with a trailing ellipsis, using the context's
 * current font. Returns the text unchanged when it already fits.
 */
function truncateToWidth(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let lo = 0;
  let hi = text.length;
  // Largest prefix whose "prefix…" still fits (binary search on length).
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (ctx.measureText(`${text.slice(0, mid)}…`).width <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  return `${text.slice(0, lo)}…`;
}

type DataTableSpec = NonNullable<LayoutOptions["dataTable"]>;

/**
 * Draw the attribute-table block as a bordered panel anchored at one of the
 * four body corners: an optional title, a bold header row over a hairline, one
 * row per feature, and an optional "+N more" note. Column widths come from the
 * widest cell, capped per column and scaled down together when the full table
 * would overrun the body width. GH #1324.
 *
 * @returns The drawn panel's height, for corner stacking.
 */
function drawDataTable(
  ctx: CanvasRenderingContext2D,
  table: DataTableSpec,
  bodyX: number,
  bodyY: number,
  bodyW: number,
  bodyH: number,
  unit: number,
  stackOffset = 0,
): number {
  const pad = unit * 1.4;
  const rowH = unit * 2.4;
  const labelSize = unit * 1.7;
  const titleSize = unit * 2;
  const colGap = unit * 1.6;
  const maxColW = unit * 26;
  const inset = unit * 2; // matches the info block/legend corner inset
  const title = (table.title ?? "").trim();
  const hasTitle = title.length > 0;
  const titleBlockH = hasTitle ? titleSize + unit : 0;

  // Fit the rows to the body height remaining below/above the stack offset:
  // a 50-row table on a small page would otherwise clip its title or note
  // away silently. The note row is part of the same budget, so a table whose
  // rows exactly fill the space still has room for a dialog-truncation note.
  const budget = bodyH - inset * 2 - stackOffset - (pad * 2 + titleBlockH + rowH);
  let rows = table.rows;
  let hidden = table.truncated ?? 0;
  if (rows.length * rowH + (hidden > 0 ? rowH : 0) > budget) {
    // Reserve one row of the budget for the note the truncation produces.
    // When even a single row cannot fit (several panels already stacked in
    // this corner on a small page), degrade to header + note only rather
    // than forcing a row that would overlap the neighbouring panel.
    const fitRows = Math.max(0, Math.floor((budget - rowH) / rowH));
    if (fitRows < rows.length) {
      hidden += rows.length - fitRows;
      rows = rows.slice(0, fitRows);
    }
  }
  const note = hidden > 0 ? (table.formatNote?.(hidden) ?? `+${hidden} more`) : "";
  const hasNote = note.length > 0;

  ctx.save();
  // Measure each column: the widest of its header (bold) and cells (regular),
  // capped so one long text field cannot swallow the page.
  const colW = table.columns.map((header, i) => {
    ctx.font = `600 ${labelSize}px system-ui, sans-serif`;
    let w = ctx.measureText(header).width;
    ctx.font = `400 ${labelSize}px system-ui, sans-serif`;
    for (const row of rows) {
      w = Math.max(w, ctx.measureText(row[i] ?? "").width);
    }
    return Math.min(w, maxColW);
  });
  let contentW = colW.reduce((sum, w) => sum + w, 0) + colGap * (table.columns.length - 1);
  // Shrink every column proportionally if the table would overrun the body;
  // cell text is ellipsis-truncated to its final column width below.
  const availW = bodyW - inset * 2 - pad * 2;
  if (contentW > availW && contentW > 0) {
    const scale = availW / contentW;
    for (let i = 0; i < colW.length; i++) colW[i] *= scale;
    contentW = availW;
  }
  ctx.font = `600 ${titleSize}px system-ui, sans-serif`;
  const titleW = hasTitle ? ctx.measureText(title).width : 0;

  const boxW = pad * 2 + Math.max(contentW, Math.min(titleW, availW));
  const boxH = pad * 2 + titleBlockH + (1 + rows.length) * rowH + (hasNote ? rowH : 0);
  const { x, y } = panelOrigin(
    table.position,
    bodyX,
    bodyY,
    bodyW,
    bodyH,
    inset,
    boxW,
    boxH,
    stackOffset,
  );

  ctx.fillStyle = "rgba(255,255,255,0.85)";
  ctx.strokeStyle = BORDER;
  ctx.lineWidth = Math.max(1, unit * 0.15);
  roundRect(ctx, x, y, boxW, boxH, unit);
  ctx.fill();
  ctx.stroke();

  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  let cy = y + pad;
  if (hasTitle) {
    cy += titleSize;
    ctx.fillStyle = INK;
    ctx.font = `600 ${titleSize}px system-ui, sans-serif`;
    ctx.fillText(truncateToWidth(ctx, title, boxW - pad * 2), x + pad, cy);
    cy += unit;
  }

  // Header row, with a hairline separating it from the data rows.
  cy += rowH;
  ctx.fillStyle = INK;
  ctx.font = `600 ${labelSize}px system-ui, sans-serif`;
  let cx = x + pad;
  table.columns.forEach((header, i) => {
    ctx.fillText(truncateToWidth(ctx, header, colW[i]), cx, cy);
    cx += colW[i] + colGap;
  });
  ctx.strokeStyle = BORDER;
  ctx.lineWidth = Math.max(1, unit * 0.12);
  ctx.beginPath();
  ctx.moveTo(x + pad, cy + unit * 0.7);
  ctx.lineTo(x + boxW - pad, cy + unit * 0.7);
  ctx.stroke();

  ctx.fillStyle = INK;
  ctx.font = `400 ${labelSize}px system-ui, sans-serif`;
  for (const row of rows) {
    cy += rowH;
    cx = x + pad;
    table.columns.forEach((_, i) => {
      ctx.fillText(truncateToWidth(ctx, row[i] ?? "", colW[i]), cx, cy);
      cx += colW[i] + colGap;
    });
  }

  if (hasNote) {
    cy += rowH;
    ctx.fillStyle = MUTED;
    ctx.fillText(truncateToWidth(ctx, note, boxW - pad * 2), x + pad, cy);
  }
  ctx.restore();
  return boxH;
}

type DataChartSpec = NonNullable<LayoutOptions["dataChart"]>;

/**
 * Draw the chart block as a bordered panel anchored at one of the four body
 * corners. Bars render horizontally (label, bar, value per row — long category
 * names stay readable), the pie renders as a disc with a swatch legend, and the
 * line renders as a framed sparkline with min/max labels. GH #1324.
 *
 * @returns The drawn panel's height, for corner stacking.
 */
function drawDataChart(
  ctx: CanvasRenderingContext2D,
  chart: DataChartSpec,
  bodyX: number,
  bodyY: number,
  bodyW: number,
  bodyH: number,
  unit: number,
  stackOffset = 0,
): number {
  const pad = unit * 1.4;
  const rowH = unit * 2.4;
  const labelSize = unit * 1.7;
  const titleSize = unit * 2;
  const gap = unit;
  const inset = unit * 2; // matches the info block/legend corner inset
  const title = (chart.title ?? "").trim();
  const hasTitle = title.length > 0;
  const titleBlock = hasTitle ? titleSize + unit : 0;
  const data = chart.data;

  ctx.save();
  ctx.font = `400 ${labelSize}px system-ui, sans-serif`;

  // Content size + a deferred content draw at (cx0, cy0), so panel sizing and
  // anchoring are computed once for all three chart kinds.
  let contentW = 0;
  let contentH = 0;
  let drawContent: (cx0: number, cy0: number) => void = () => {};

  if (data.kind === "bar") {
    const labelCap = unit * 18;
    const barAreaW = unit * 20;
    // Categories the top-N cap dropped are surfaced as a note row, so the
    // chart is never silently incomplete.
    const barNote =
      (data.truncated ?? 0) > 0
        ? (chart.formatNote?.(data.truncated ?? 0) ?? `+${data.truncated} more`)
        : "";
    let labelW = 0;
    let valueW = 0;
    for (const bar of data.bars) {
      labelW = Math.max(labelW, Math.min(ctx.measureText(bar.label).width, labelCap));
      valueW = Math.max(valueW, ctx.measureText(formatColorbarTick(bar.value)).width);
    }
    contentW = labelW + gap + barAreaW + gap + valueW;
    contentH = (data.bars.length + (barNote ? 1 : 0)) * rowH;
    drawContent = (cx0, cy0) => {
      // Scale across the full value range so negative sums/means keep a truthful
      // zero baseline (bars extend left of it).
      const lo = Math.min(0, data.minValue);
      const hi = Math.max(0, data.maxValue);
      const span = hi - lo || 1;
      const zeroX = cx0 + labelW + gap + ((0 - lo) / span) * barAreaW;
      let cy = cy0;
      for (const bar of data.bars) {
        cy += rowH;
        ctx.fillStyle = INK;
        ctx.textAlign = "left";
        ctx.fillText(truncateToWidth(ctx, bar.label, labelCap), cx0, cy);
        const barW = (Math.abs(bar.value) / span) * barAreaW;
        const barX = bar.value < 0 ? zeroX - barW : zeroX;
        ctx.fillStyle = bar.color;
        ctx.fillRect(barX, cy - labelSize * 0.85, barW, labelSize);
        ctx.fillStyle = INK;
        ctx.fillText(formatColorbarTick(bar.value), cx0 + labelW + gap + barAreaW + gap, cy);
      }
      if (barNote) {
        cy += rowH;
        ctx.fillStyle = MUTED;
        ctx.textAlign = "left";
        ctx.fillText(truncateToWidth(ctx, barNote, contentW), cx0, cy);
      }
    };
  } else if (data.kind === "pie") {
    const diameter = unit * 14;
    const swatch = unit * 2;
    let legendW = 0;
    for (const slice of data.slices) {
      const pct = Math.round((slice.value / data.total) * 100);
      legendW = Math.max(
        legendW,
        swatch + gap + Math.min(ctx.measureText(`${slice.label} (${pct}%)`).width, unit * 22),
      );
    }
    contentW = diameter + gap * 2 + legendW;
    contentH = Math.max(diameter, data.slices.length * rowH);
    drawContent = (cx0, cy0) => {
      const cx = cx0 + diameter / 2;
      const cyMid = cy0 + contentH / 2;
      const r = diameter / 2;
      let angle = -Math.PI / 2;
      for (const slice of data.slices) {
        const sweep = (slice.value / data.total) * Math.PI * 2;
        ctx.fillStyle = slice.color;
        ctx.beginPath();
        ctx.moveTo(cx, cyMid);
        ctx.arc(cx, cyMid, r, angle, angle + sweep);
        ctx.closePath();
        ctx.fill();
        angle += sweep;
      }
      ctx.strokeStyle = BORDER;
      ctx.lineWidth = Math.max(1, unit * 0.12);
      ctx.beginPath();
      ctx.arc(cx, cyMid, r, 0, Math.PI * 2);
      ctx.stroke();
      // Swatch legend, vertically centred beside the disc.
      let cy = cy0 + (contentH - data.slices.length * rowH) / 2;
      ctx.textAlign = "left";
      for (const slice of data.slices) {
        cy += rowH;
        ctx.fillStyle = slice.color;
        ctx.fillRect(cx0 + diameter + gap * 2, cy - swatch * 0.85, swatch, swatch);
        ctx.strokeStyle = BORDER;
        ctx.strokeRect(cx0 + diameter + gap * 2, cy - swatch * 0.85, swatch, swatch);
        const pct = Math.round((slice.value / data.total) * 100);
        ctx.fillStyle = INK;
        ctx.fillText(
          truncateToWidth(ctx, `${slice.label} (${pct}%)`, unit * 22),
          cx0 + diameter + gap * 2 + swatch + gap,
          cy,
        );
      }
    };
  } else {
    const plotW = unit * 24;
    const plotH = unit * 12;
    const maxLabel = formatColorbarTick(data.max);
    const minLabel = formatColorbarTick(data.min);
    const axisW = Math.max(ctx.measureText(maxLabel).width, ctx.measureText(minLabel).width);
    contentW = axisW + gap + plotW;
    contentH = plotH;
    drawContent = (cx0, cy0) => {
      const plotX = cx0 + axisW + gap;
      ctx.strokeStyle = BORDER;
      ctx.lineWidth = Math.max(1, unit * 0.12);
      ctx.strokeRect(plotX, cy0, plotW, plotH);
      ctx.fillStyle = MUTED;
      ctx.textAlign = "right";
      ctx.textBaseline = "top";
      ctx.fillText(maxLabel, plotX - gap * 0.6, cy0);
      ctx.textBaseline = "bottom";
      ctx.fillText(minLabel, plotX - gap * 0.6, cy0 + plotH);
      ctx.textBaseline = "alphabetic";
      const spanY = data.max - data.min || 1;
      const spanX = Math.max(1, data.length - 1);
      const px = (index: number) => plotX + (index / spanX) * plotW;
      const py = (value: number) => cy0 + plotH - ((value - data.min) / spanY) * plotH;
      ctx.strokeStyle = data.color;
      ctx.lineWidth = Math.max(1, unit * 0.25);
      if (data.points.length === 1) {
        // A single sample has no path to stroke; mark it with a dot instead.
        ctx.fillStyle = data.color;
        ctx.beginPath();
        ctx.arc(px(data.points[0].index), py(data.points[0].value), unit * 0.5, 0, Math.PI * 2);
        ctx.fill();
      } else if (data.points.length > 1) {
        ctx.beginPath();
        data.points.forEach((p, i) => {
          if (i === 0) ctx.moveTo(px(p.index), py(p.value));
          else ctx.lineTo(px(p.index), py(p.value));
        });
        ctx.stroke();
      }
    };
  }

  ctx.font = `600 ${titleSize}px system-ui, sans-serif`;
  const titleW = hasTitle ? ctx.measureText(title).width : 0;
  const boxW = pad * 2 + Math.max(contentW, Math.min(titleW, unit * 40));
  const boxH = pad * 2 + titleBlock + contentH;
  const { x, y } = panelOrigin(
    chart.position,
    bodyX,
    bodyY,
    bodyW,
    bodyH,
    inset,
    boxW,
    boxH,
    stackOffset,
  );

  ctx.fillStyle = "rgba(255,255,255,0.85)";
  ctx.strokeStyle = BORDER;
  ctx.lineWidth = Math.max(1, unit * 0.15);
  roundRect(ctx, x, y, boxW, boxH, unit);
  ctx.fill();
  ctx.stroke();

  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  let topY = y + pad;
  if (hasTitle) {
    ctx.fillStyle = INK;
    ctx.font = `600 ${titleSize}px system-ui, sans-serif`;
    ctx.fillText(truncateToWidth(ctx, title, boxW - pad * 2), x + pad, topY + titleSize);
    topY += titleBlock;
  }
  ctx.font = `400 ${labelSize}px system-ui, sans-serif`;
  drawContent(x + pad, topY);
  ctx.restore();
  return boxH;
}

/**
 * Draw a legend box anchored at its top-left corner.
 *
 * @returns The drawn box's height, so corner panels can stack below it.
 */
function drawLegend(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  entries: LegendEntry[],
  unit: number,
  opts: { title: string; groupByLayer: boolean },
): number {
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
  return boxH;
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
