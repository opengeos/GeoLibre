import {
  compareFeatureProperties,
  documentLocale,
  resolveConfiguredPopupTitle,
  resolvePopupMaxWidth,
  type ComparePin,
  type FieldVisibility,
  type LayerPopupConfig,
} from "@geolibre/core";
import type { Feature } from "geojson";

// The hover tooltip of a layer with a pinned feature: how the hovered feature
// differs from the pinned one. Engine-neutral DOM, built by every 2D engine's
// hover handler through `createHoverTooltipElement`.

/** Text of the compare tooltip; the app passes translated labels. */
export interface CompareTooltipLabels {
  /** The line under the heading; `title` is the pinned feature's popup title, if it has one. */
  comparedWith: (title: string | null) => string;
  /** The pinned feature's value of a text field, beside the hovered one's. */
  pinnedValue: (value: string) => string;
  /** A field one of the two features has no value for. */
  noValue: string;
  /** The hovered feature matches the pinned one in every field. */
  identical: string;
  /** Differing fields beyond the ones listed. */
  moreDifferences: (count: number) => string;
  /** Fields both features share the same value in. */
  sameFields: (count: number) => string;
}

/** English fallbacks; the app passes translated labels. */
export const DEFAULT_COMPARE_TOOLTIP_LABELS: CompareTooltipLabels = {
  comparedWith: (title) =>
    title ? `Compared with ${title}` : "Compared with the pinned feature",
  pinnedValue: (value) => `pinned: ${value}`,
  noValue: "(none)",
  identical: "Same as the pinned feature in every field",
  moreDifferences: (count) => `${count} more ${count === 1 ? "difference" : "differences"}`,
  sameFields: (count) => `${count} ${count === 1 ? "field" : "fields"} the same`,
};

/** What a hover tooltip needs to compare against the pinned feature. */
export interface HoverCompareOptions {
  pin: ComparePin;
  labels: CompareTooltipLabels;
}

/**
 * The compare tooltip: the hovered feature's title, what it is compared
 * with, then each differing field as label, hovered value, and either the
 * signed difference (numbers) or the pinned value (anything else).
 */
export function createCompareTooltipElement(
  title: string,
  properties: Record<string, unknown>,
  compare: HoverCompareOptions,
  options: {
    popup?: LayerPopupConfig;
    fieldVisibility?: Record<string, FieldVisibility>;
    feature?: Feature | null;
    zoom?: number;
  } = {},
): HTMLElement {
  const { popup, fieldVisibility, zoom } = options;
  const { pin, labels } = compare;
  const comparison = compareFeatureProperties(properties, pin.properties, {
    popup,
    fieldVisibility,
    locale: documentLocale(),
  });

  const root = document.createElement("div");
  root.className = "geolibre-hover-tooltip-root geolibre-compare-tooltip flex flex-col gap-0.5 text-xs";
  const width = Math.max(resolvePopupMaxWidth(popup) ?? 256, 256);
  root.style.width = `min(${width}px, calc(100vw - 48px))`;
  root.style.maxWidth = "100%";

  const heading = document.createElement("div");
  heading.className = "font-semibold text-foreground";
  heading.textContent = title;
  const subheading = document.createElement("div");
  subheading.className = "mb-0.5 text-muted-foreground";
  subheading.textContent = labels.comparedWith(
    resolveConfiguredPopupTitle(pin.properties, popup, { zoom, fieldVisibility }),
  );
  root.append(heading, subheading);

  const muted = (text: string) => {
    const line = document.createElement("div");
    line.className = "text-muted-foreground";
    line.textContent = text;
    return line;
  };

  if (comparison.rows.length === 0) {
    root.appendChild(muted(labels.identical));
    return root;
  }

  for (const row of comparison.rows) {
    const line = document.createElement("div");
    line.className = "grid gap-1.5 border-t pt-0.5 text-foreground";
    line.style.gridTemplateColumns = "minmax(0, 1fr) minmax(0, 1.2fr) minmax(0, 1fr)";
    const label = document.createElement("span");
    label.className = "min-w-0 text-muted-foreground";
    label.style.overflowWrap = "anywhere";
    label.textContent = row.label;
    const value = document.createElement("span");
    value.className = "min-w-0";
    value.style.overflowWrap = "anywhere";
    value.textContent = row.text || labels.noValue;
    const difference = document.createElement("span");
    difference.className = "min-w-0 text-end text-muted-foreground";
    difference.style.overflowWrap = "anywhere";
    if (row.delta !== undefined) {
      // Numbers line up when their digits share a width.
      difference.classList.add("font-medium", "tabular-nums", "text-foreground");
      difference.textContent = row.delta;
    } else {
      difference.textContent = labels.pinnedValue(row.pinnedText || labels.noValue);
    }
    line.append(label, value, difference);
    root.appendChild(line);
  }

  const footer = [
    comparison.moreCount > 0 ? labels.moreDifferences(comparison.moreCount) : null,
    comparison.sameCount > 0 ? labels.sameFields(comparison.sameCount) : null,
  ].filter((part): part is string => part !== null);
  if (footer.length > 0) {
    const line = muted(footer.join(" · "));
    line.classList.add("mt-0.5");
    root.appendChild(line);
  }
  return root;
}
