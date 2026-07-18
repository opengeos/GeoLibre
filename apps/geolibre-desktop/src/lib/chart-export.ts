/**
 * Export an inline chart `<svg>` as a downloadable SVG or PNG file. The charts
 * paint with theme CSS variables (e.g. `hsl(var(--primary))`) which do not
 * resolve outside the app, so the variables are substituted with their computed
 * values before serializing. Kept DOM-only and framework-free.
 */

// The theme CSS variables the chart SVG references, resolved at export time.
const CHART_COLOR_VARS = ["--border", "--muted-foreground", "--primary"] as const;

/** Read a CSS custom property off the document root as an `hsl(...)` string. */
function resolvedHsl(name: string): string | null {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value ? `hsl(${value})` : null;
}

/**
 * Serialize a chart SVG into a standalone document string: clone it, set
 * explicit pixel dimensions, declare the SVG namespace, and replace each
 * `hsl(var(--x))` reference with the current theme's resolved color.
 */
export function serializeChartSvg(svg: SVGSVGElement, width: number, height: number): string {
  const clone = svg.cloneNode(true) as SVGSVGElement;
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  clone.setAttribute("width", String(width));
  clone.setAttribute("height", String(height));

  let source = new XMLSerializer().serializeToString(clone);
  for (const name of CHART_COLOR_VARS) {
    const resolved = resolvedHsl(name);
    if (resolved) source = source.split(`hsl(var(${name}))`).join(resolved);
  }
  return source;
}

function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

/** Download the chart as a standalone `.svg` file. */
export function downloadChartSvg(
  svg: SVGSVGElement,
  width: number,
  height: number,
  filename: string,
): void {
  const source = serializeChartSvg(svg, width, height);
  triggerDownload(new Blob([source], { type: "image/svg+xml;charset=utf-8" }), filename);
}

/**
 * Rasterize the chart to a `.png` at `scale`× resolution. Paints an opaque
 * background first (defaults to the theme `--background`) so the export isn't
 * transparent. Resolves once the file has been handed to the browser.
 */
export async function downloadChartPng(
  svg: SVGSVGElement,
  width: number,
  height: number,
  filename: string,
  scale = 2,
): Promise<void> {
  const source = serializeChartSvg(svg, width, height);
  const svgUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(source)}`;

  const image = new Image();
  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new Error("Could not render chart image."));
    image.src = svgUrl;
  });

  const canvas = document.createElement("canvas");
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D context unavailable.");

  ctx.fillStyle = resolvedHsl("--background") ?? "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.scale(scale, scale);
  ctx.drawImage(image, 0, 0, width, height);

  await new Promise<void>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error("Could not encode the chart image."));
        return;
      }
      triggerDownload(blob, filename);
      resolve();
    }, "image/png");
  });
}
