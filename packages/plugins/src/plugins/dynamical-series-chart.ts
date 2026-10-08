/**
 * The line chart the Dynamical panel draws a point's time series in: plain SVG, sized to its
 * container, in the app's theme tokens so dark mode follows the theme.
 *
 * A deterministic series is one 2px line (no legend: the heading names it). An ensemble is its
 * mean as the line over a wash of the member range, with a legend. A crosshair snaps to the
 * nearest step and a tooltip lists the values there; the arrow keys move it when the chart has
 * focus, and Enter or a click picks the step.
 */

import { niceTicks, timeTicks, type SeriesStep } from "./dynamical-api";

const SVG_NS = "http://www.w3.org/2000/svg";
const HEIGHT = 190;
const MARGIN = { top: 10, right: 12, bottom: 24, left: 44 };

/** The labels the chart shows, translated by the caller. */
export interface SeriesChartLabels {
  /** What a value is in, e.g. its unit, after the number in the tooltip. */
  value: string;
  mean: string;
  range: string;
  /** Marks the step the map shows. */
  shown: string;
  /** The chart's accessible description. */
  description: string;
}

/** What the chart draws. */
export interface SeriesChartOptions {
  steps: readonly SeriesStep[];
  /** The step the map shows, highlighted; -1 for none. */
  currentIndex: number;
  labels: SeriesChartLabels;
  /** Called with a step index when the reader picks one. */
  onPick?: (index: number) => void;
}

function svg<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attributes: Record<string, string | number> = {},
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, String(value));
  return node;
}

const numberFormat = new Intl.NumberFormat(undefined, { maximumSignificantDigits: 4 });
const tickNumberFormat = new Intl.NumberFormat(undefined, { maximumFractionDigits: 6 });

function formatTime(ms: number, withTime: boolean): string {
  return new Intl.DateTimeFormat(undefined, {
    timeZone: "UTC",
    month: "short",
    day: "numeric",
    ...(withTime ? { hour: "2-digit", minute: "2-digit", hourCycle: "h23" } : {}),
  }).format(ms);
}

/** A path through the finite points, broken where a value is missing. */
function linePath(points: Array<[number, number] | null>): string {
  let path = "";
  let drawing = false;
  for (const point of points) {
    if (!point) {
      drawing = false;
      continue;
    }
    path += `${drawing ? "L" : "M"}${point[0].toFixed(1)},${point[1].toFixed(1)}`;
    drawing = true;
  }
  return path;
}

/**
 * Draw a series chart into `container`, redrawing as it resizes.
 *
 * Args:
 *   container: The element to draw into; its children are replaced.
 *   options: The series and labels.
 *
 * Returns:
 *   A function that stops the resize tracking.
 */
export function renderSeriesChart(container: HTMLElement, options: SeriesChartOptions): () => void {
  const { steps, labels } = options;
  const ensemble = steps.some((step) => step.min !== undefined);
  let active = options.currentIndex >= 0 ? options.currentIndex : steps.length - 1;

  const frame = document.createElement("div");
  frame.style.cssText = "position:relative;width:100%;";
  const tooltip = document.createElement("div");
  tooltip.style.cssText =
    "position:absolute;top:0;pointer-events:none;display:none;padding:6px 8px;border-radius:6px;" +
    "border:1px solid hsl(var(--border));background:hsl(var(--popover));color:hsl(var(--popover-foreground));" +
    "font-size:11px;line-height:1.4;white-space:nowrap;box-shadow:0 2px 8px rgb(0 0 0 / 0.12);z-index:1;";
  const legend = document.createElement("div");
  legend.style.cssText =
    "display:flex;gap:12px;flex-wrap:wrap;font-size:11px;color:hsl(var(--muted-foreground));margin-top:4px;";

  const draw = (width: number): void => {
    const plotWidth = Math.max(40, width - MARGIN.left - MARGIN.right);
    const plotHeight = HEIGHT - MARGIN.top - MARGIN.bottom;
    let low = Number.POSITIVE_INFINITY;
    let high = Number.NEGATIVE_INFINITY;
    for (const step of steps) {
      for (const value of [step.value, step.min, step.max]) {
        if (value !== undefined && Number.isFinite(value)) {
          low = Math.min(low, value);
          high = Math.max(high, value);
        }
      }
    }
    if (!Number.isFinite(low)) {
      low = 0;
      high = 1;
    }
    // Round the domain out to whole tick steps, so the extremes sit on labelled ticks.
    const inner = niceTicks(low, high, 4);
    const tickStep = inner.length > 1 ? inner[1] - inner[0] : 0;
    const yMin = tickStep ? Math.floor(low / tickStep) * tickStep : low;
    const yMax = tickStep ? Math.ceil(high / tickStep) * tickStep : high;
    const yTicks = tickStep ? niceTicks(yMin, yMax, Math.round((yMax - yMin) / tickStep)) : inner;
    const span = yMax - yMin || 1;
    const start = steps[0]?.time ?? 0;
    const end = steps[steps.length - 1]?.time ?? start;
    const x = (time: number) =>
      MARGIN.left + (end > start ? ((time - start) / (end - start)) * plotWidth : plotWidth / 2);
    const y = (value: number) => MARGIN.top + (1 - (value - yMin) / span) * plotHeight;

    const chart = svg("svg", {
      width,
      height: HEIGHT,
      viewBox: `0 0 ${width} ${HEIGHT}`,
      role: "img",
      tabindex: 0,
      "aria-label": labels.description,
    });
    chart.style.cssText = "display:block;overflow:visible;outline-offset:2px;cursor:crosshair;";

    // Recessive hairline grid and axis text in text tokens.
    for (const tick of yTicks) {
      const ty = y(tick);
      chart.append(
        svg("line", {
          x1: MARGIN.left,
          x2: MARGIN.left + plotWidth,
          y1: ty,
          y2: ty,
          // A faint ink rather than --border, which nearly matches the muted card behind it.
          stroke: "hsl(var(--muted-foreground))",
          "stroke-opacity": 0.2,
          "stroke-width": 1,
        }),
      );
      const label = svg("text", {
        x: MARGIN.left - 6,
        y: ty,
        "text-anchor": "end",
        "dominant-baseline": "middle",
        "font-size": 10,
        fill: "hsl(var(--muted-foreground))",
      });
      label.style.fontVariantNumeric = "tabular-nums";
      label.textContent = tickNumberFormat.format(tick);
      chart.append(label);
    }
    const ticks = timeTicks(start, end, Math.max(3, Math.floor(plotWidth / 64)));
    const withTime = ticks.length > 1 && ticks[1] - ticks[0] < 24 * 3_600_000;
    for (const tick of ticks) {
      const label = svg("text", {
        x: x(tick),
        y: HEIGHT - 6,
        "text-anchor": "middle",
        "font-size": 10,
        fill: "hsl(var(--muted-foreground))",
      });
      label.textContent = formatTime(tick, withTime);
      chart.append(label);
    }

    if (ensemble) {
      // The member range as a ~10% wash of the series hue, broken where a step has no members.
      let upper: Array<[number, number]> = [];
      let lower: Array<[number, number]> = [];
      const flush = () => {
        if (upper.length > 1) {
          const outline = [...upper, ...lower.reverse()];
          chart.append(
            svg("path", {
              d: `${linePath(outline)}Z`,
              fill: "hsl(var(--primary))",
              "fill-opacity": 0.12,
              stroke: "none",
            }),
          );
        }
        upper = [];
        lower = [];
      };
      for (const step of steps) {
        if (Number.isFinite(step.min) && Number.isFinite(step.max)) {
          upper.push([x(step.time), y(step.max as number)]);
          lower.push([x(step.time), y(step.min as number)]);
        } else {
          flush();
        }
      }
      flush();
    }

    chart.append(
      svg("path", {
        d: linePath(
          steps.map((step) => (Number.isFinite(step.value) ? [x(step.time), y(step.value)] : null)),
        ),
        fill: "none",
        stroke: "hsl(var(--primary))",
        "stroke-width": 2,
        "stroke-linejoin": "round",
        "stroke-linecap": "round",
      }),
    );

    // The step the map shows: a hairline and a ringed dot.
    const shown = steps[options.currentIndex];
    if (shown) {
      chart.append(
        svg("line", {
          x1: x(shown.time),
          x2: x(shown.time),
          y1: MARGIN.top,
          y2: MARGIN.top + plotHeight,
          stroke: "hsl(var(--muted-foreground))",
          "stroke-width": 1,
          "stroke-opacity": 0.6,
        }),
      );
      if (Number.isFinite(shown.value)) {
        const dot = svg("circle", {
          cx: x(shown.time),
          cy: y(shown.value),
          r: 4,
          fill: "hsl(var(--primary))",
          stroke: "hsl(var(--background))",
          "stroke-width": 2,
        });
        const title = svg("title");
        title.textContent = labels.shown;
        dot.append(title);
        chart.append(dot);
      }
    }

    // Crosshair: snaps to the step nearest the pointer.
    const crosshair = svg("line", {
      y1: MARGIN.top,
      y2: MARGIN.top + plotHeight,
      stroke: "hsl(var(--foreground))",
      "stroke-width": 1,
      "stroke-opacity": 0.5,
      visibility: "hidden",
    });
    const marker = svg("circle", {
      r: 4,
      fill: "hsl(var(--primary))",
      stroke: "hsl(var(--background))",
      "stroke-width": 2,
      visibility: "hidden",
    });
    chart.append(crosshair, marker);

    const nearest = (px: number): number => {
      let best = 0;
      let distance = Number.POSITIVE_INFINITY;
      steps.forEach((step, index) => {
        const d = Math.abs(x(step.time) - px);
        if (d < distance) {
          distance = d;
          best = index;
        }
      });
      return best;
    };

    const show = (index: number): void => {
      const step = steps[index];
      if (!step) return;
      active = index;
      const cx = x(step.time);
      crosshair.setAttribute("x1", String(cx));
      crosshair.setAttribute("x2", String(cx));
      crosshair.setAttribute("visibility", "visible");
      if (Number.isFinite(step.value)) {
        marker.setAttribute("cx", String(cx));
        marker.setAttribute("cy", String(y(step.value)));
        marker.setAttribute("visibility", "visible");
      } else {
        marker.setAttribute("visibility", "hidden");
      }
      // Values lead, labels follow; every value through textContent.
      tooltip.replaceChildren();
      const time = document.createElement("div");
      time.style.color = "hsl(var(--muted-foreground))";
      time.textContent = `${formatTime(step.time, true)} UTC`;
      tooltip.append(time);
      const row = (value: number | undefined, label: string) => {
        const line = document.createElement("div");
        const strong = document.createElement("strong");
        strong.textContent =
          value !== undefined && Number.isFinite(value) ? numberFormat.format(value) : "—";
        line.append(strong, document.createTextNode(` ${label}`));
        tooltip.append(line);
      };
      if (ensemble) {
        row(step.value, labels.mean);
        const range = document.createElement("div");
        range.style.color = "hsl(var(--muted-foreground))";
        range.textContent = `${labels.range}: ${
          Number.isFinite(step.min) ? numberFormat.format(step.min as number) : "—"
        } – ${Number.isFinite(step.max) ? numberFormat.format(step.max as number) : "—"}`;
        tooltip.append(range);
      } else {
        row(step.value, labels.value);
      }
      tooltip.style.display = "block";
      // Keep the tooltip inside the chart: flip to the crosshair's left past the middle, then
      // clamp, since a long label can be wider than either side.
      const left = cx > width / 2 ? cx - tooltip.offsetWidth - 10 : cx + 10;
      tooltip.style.left = `${Math.max(0, Math.min(left, width - tooltip.offsetWidth))}px`;
    };
    const hide = (): void => {
      crosshair.setAttribute("visibility", "hidden");
      marker.setAttribute("visibility", "hidden");
      tooltip.style.display = "none";
    };

    const pointerIndex = (event: PointerEvent | MouseEvent): number => {
      const box = chart.getBoundingClientRect();
      return nearest(((event.clientX - box.left) / box.width) * width);
    };
    chart.addEventListener("pointermove", (event) => show(pointerIndex(event)));
    chart.addEventListener("pointerleave", () => {
      if (document.activeElement !== chart) hide();
    });
    chart.addEventListener("click", (event) => options.onPick?.(pointerIndex(event)));
    chart.addEventListener("focus", () => show(active));
    chart.addEventListener("blur", hide);
    chart.addEventListener("keydown", (event) => {
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        event.preventDefault();
        show(
          Math.min(steps.length - 1, Math.max(0, active + (event.key === "ArrowLeft" ? -1 : 1))),
        );
      } else if (event.key === "Home" || event.key === "End") {
        event.preventDefault();
        show(event.key === "Home" ? 0 : steps.length - 1);
      } else if (event.key === "Enter") {
        options.onPick?.(active);
      }
    });

    frame.replaceChildren(chart, tooltip);
  };

  // The legend, for an ensemble only: a line key for the mean and a swatch for the range.
  if (ensemble) {
    const item = (key: HTMLElement, text: string) => {
      const entry = document.createElement("span");
      entry.style.cssText = "display:inline-flex;align-items:center;gap:6px;";
      const label = document.createElement("span");
      label.textContent = text;
      entry.append(key, label);
      legend.append(entry);
    };
    const line = document.createElement("span");
    line.style.cssText =
      "display:inline-block;width:14px;height:2px;border-radius:1px;background:hsl(var(--primary));";
    const swatch = document.createElement("span");
    swatch.style.cssText =
      "display:inline-block;width:12px;height:10px;border-radius:2px;background:hsl(var(--primary) / 0.12);";
    item(line, labels.mean);
    item(swatch, labels.range);
  }

  container.replaceChildren(frame, ...(ensemble ? [legend] : []));
  let lastWidth = 0;
  const redraw = () => {
    const width = Math.round(frame.clientWidth || container.clientWidth || 320);
    if (width === lastWidth) return;
    lastWidth = width;
    draw(width);
  };
  redraw();
  if (typeof ResizeObserver === "undefined") return () => undefined;
  const observer = new ResizeObserver(redraw);
  observer.observe(frame);
  return () => observer.disconnect();
}
