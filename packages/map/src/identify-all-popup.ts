import { resolveConfiguredPopupTitle, type GeoLibreLayer } from "@geolibre/core";
import type { Feature } from "geojson";
import { applyPopupWidth, createIdentifyPopupRows } from "./feature-popup";

// The grouped, all-layer Identify popup. Engine-neutral DOM, shared by the
// MapLibre and Mapbox canvases so both show the same chooser.

/** Text formatters used by the grouped, all-layer Identify popup. */
export interface MapCanvasIdentifyAllLabels {
  title: (count: number) => string;
  resultCount: (count: number) => string;
  featureFallback: (index: number) => string;
  pixel: string;
  expandAll: string;
  collapseAll: string;
  loadingTitle: string;
  loading: string;
  errorLabel: string;
  error: string;
}

/** English fallbacks; the app passes translated labels. */
export const DEFAULT_IDENTIFY_ALL_LABELS: MapCanvasIdentifyAllLabels = {
  title: (count) => `Identified results (${count})`,
  resultCount: (count) => `${count} ${count === 1 ? "result" : "results"}`,
  featureFallback: (index) => `Feature ${index}`,
  pixel: "Pixel",
  expandAll: "Expand all",
  collapseAll: "Collapse all",
  loadingTitle: "Identify visible layers",
  loading: "Loading...",
  errorLabel: "Error",
  error: "Could not identify this layer.",
};

/** One entry in the grouped, all-layer Identify popup. */
export interface GlobalIdentifyHit {
  layer: GeoLibreLayer;
  properties: Record<string, unknown>;
  /** The rendered feature, when the hit came from a style layer. */
  feature?: Feature;
  featureId: string | null;
  title?: string;
}

/**
 * Build the all-layer Identify result, grouped by owning GeoLibre layer.
 *
 * @param hits Rendered feature hits in topmost-first map order.
 * @param zoom Current map zoom for expression-backed popup formatting.
 * @param onActivate Selects the owning layer and feature in the application.
 * @param labels Translated headings and counters for the grouped result.
 * @param maxWidth Widest width any hit layer's popup config asked for, in CSS
 *   pixels, or `undefined` to keep the default cap.
 * @returns Popup DOM containing every grouped hit and its visible attributes.
 */
export function createGlobalIdentifyPopupElement(
  hits: GlobalIdentifyHit[],
  zoom: number,
  onActivate: (hit: GlobalIdentifyHit) => void,
  labels: MapCanvasIdentifyAllLabels,
  maxWidth?: number,
): HTMLElement {
  const root = document.createElement("div");
  root.className =
    "geolibre-identify-popup-root flex min-w-[min(18rem,calc(100vw-48px))] max-w-[min(520px,calc(100vw-48px))] flex-col text-xs";

  const title = document.createElement("div");
  title.className = "font-semibold text-foreground";
  title.textContent = labels.title(hits.length);
  const header = document.createElement("div");
  header.className = "mb-2 flex shrink-0 items-center justify-between gap-3 pe-10";
  const actions = document.createElement("div");
  actions.className = "flex shrink-0 items-center gap-1";
  const detailsElements: HTMLDetailsElement[] = [];
  const createToggleAllButton = (text: string, open: boolean) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className =
      "rounded border px-1.5 py-0.5 font-normal text-muted-foreground hover:bg-muted hover:text-foreground";
    button.textContent = text;
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      for (const details of detailsElements) details.open = open;
    });
    return button;
  };
  actions.append(
    createToggleAllButton(labels.expandAll, true),
    createToggleAllButton(labels.collapseAll, false),
  );
  header.append(title, actions);
  root.appendChild(header);

  // Only the results scroll. Scrolling `root` instead would run the scrollbar
  // up the full popup height, and a sticky header painted over MapLibre's own
  // close button — which lives outside this element and takes no stacking
  // order from it.
  const body = document.createElement("div");
  body.className = "geolibre-identify-popup-groups";
  root.appendChild(body);

  const groups = new Map<string, GlobalIdentifyHit[]>();
  for (const hit of hits) {
    const group = groups.get(hit.layer.id);
    if (group) group.push(hit);
    else groups.set(hit.layer.id, [hit]);
  }

  for (const groupHits of groups.values()) {
    const { layer } = groupHits[0];
    const section = document.createElement("details");
    section.className = "group border-t py-2 first:border-t-0 first:pt-0";
    section.open = true;
    detailsElements.push(section);

    const layerButton = document.createElement("summary");
    layerButton.className =
      "mb-1 flex w-full cursor-pointer list-none items-center justify-between gap-3 rounded px-1 py-1 text-start font-semibold text-foreground hover:bg-muted [&::-webkit-details-marker]:hidden";
    const layerName = document.createElement("span");
    layerName.className = "min-w-0 break-words";
    layerName.textContent = layer.name;
    const count = document.createElement("span");
    count.className = "shrink-0 font-normal text-muted-foreground";
    count.textContent = labels.resultCount(groupHits.length);
    layerButton.append(layerName, count);
    layerButton.addEventListener("click", (event) => {
      event.stopPropagation();
      onActivate(groupHits[0]);
    });
    section.appendChild(layerButton);

    for (const [index, hit] of groupHits.entries()) {
      const featureContainer = document.createElement("div");
      featureContainer.className = "mb-2 rounded border bg-background/60 p-2 last:mb-0";
      const configuredTitle = hit.feature
        ? resolveConfiguredPopupTitle(hit.properties, layer.popup, {
            feature: hit.feature,
            zoom,
            fieldVisibility: layer.fieldVisibility,
          })
        : null;
      const featureButton = document.createElement("button");
      featureButton.type = "button";
      featureButton.className =
        "mb-1 w-full break-words text-start font-medium text-foreground hover:underline";
      featureButton.textContent = configuredTitle ?? hit.title ?? labels.featureFallback(index + 1);
      featureButton.addEventListener("click", (event) => {
        event.stopPropagation();
        onActivate(hit);
      });
      featureContainer.appendChild(featureButton);
      featureContainer.appendChild(
        createIdentifyPopupRows(
          hit.properties,
          hit.featureId ?? undefined,
          {
            popup: layer.popup,
            fieldVisibility: layer.fieldVisibility,
            feature: hit.feature,
            zoom,
          },
          false,
        ),
      );
      section.appendChild(featureContainer);
    }
    body.appendChild(section);
  }

  // Last, so applyPopupWidth can see whether any group drew a picture.
  applyPopupWidth(root, maxWidth === undefined ? undefined : { maxWidth });

  return root;
}
