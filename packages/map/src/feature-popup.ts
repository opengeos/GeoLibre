import {
  stringifyPopupValue,
  isInlineImageValue,
  isSafePopupUrl,
  resolvePopupTitle,
  resolvePopupBody,
  resolvePopupRows,
  resolvePopupImageHeight,
  resolvePopupMaxWidth,
  resolveConfiguredPopupTitle,
  type FieldVisibility,
  type LayerPopupConfig,
  type PopupRow,
  documentLocale,
} from "@geolibre/core";
import type { Feature } from "geojson";

/**
 * The author's popup design for a layer, plus what the renderer needs to apply
 * it. Every field is optional: the WMS, pixel and status popups pass none of
 * it and get exactly the rendering they always had.
 */
export interface IdentifyPopupOptions {
  popup?: LayerPopupConfig;
  fieldVisibility?: Record<string, FieldVisibility>;
  /** The real feature, when the caller has one — feeds geometry-aware expressions. */
  feature?: Feature | null;
  /** Map zoom for `["zoom"]` in the title/body expressions. */
  zoom?: number;
}

/**
 * Closes the lightbox that is currently open, if any. Held module-side so a
 * second image link tears the previous viewer down through the same path that
 * unregisters its key handler, rather than orphaning the listener by removing
 * only the DOM node.
 */
let closeActivePopupImageViewer: (() => void) | null = null;

/** Open a configured popup image in a lightbox over the map. */
function openPopupImageViewer(source: string, alt: string): void {
  closeActivePopupImageViewer?.();
  // Focus moves into the dialog and has to come back to whatever opened it,
  // which is the image link in the popup unless the popup itself has gone.
  const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const overlay = document.createElement("div");
  overlay.className = "geolibre-photo-fullscreen geolibre-popup-image-viewer";
  overlay.role = "dialog";
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-label", alt);

  const image = document.createElement("img");
  image.src = source;
  image.alt = alt;
  image.className = "geolibre-popup-image-viewer-img";
  // Pinned providers such as Caltrans serve small stills (320x260), and
  // stretching one to the viewport just magnifies the JPEG artifacts. Publish
  // the natural size so the stylesheet can stop enlarging past 2x.
  const capToNaturalSize = () => {
    if (!image.naturalWidth || !image.naturalHeight) return;
    overlay.style.setProperty("--geolibre-popup-image-max-w", `${image.naturalWidth * 2}px`);
    overlay.style.setProperty("--geolibre-popup-image-max-h", `${image.naturalHeight * 2}px`);
  };
  if (image.complete) capToNaturalSize();
  else image.addEventListener("load", capToNaturalSize, { once: true });

  const closeButton = document.createElement("button");
  closeButton.type = "button";
  closeButton.className = "geolibre-photo-fullscreen-close";
  closeButton.textContent = "×";
  closeButton.setAttribute("aria-label", "Close");

  const close = () => {
    document.removeEventListener("keydown", onKeyDown);
    if (closeActivePopupImageViewer === close) closeActivePopupImageViewer = null;
    overlay.remove();
    if (trigger?.isConnected) trigger.focus();
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      // The globe's own Escape handler listens on `window` and would clear the
      // Identify popup underneath, so closing the lightbox stops there.
      event.stopPropagation();
      close();
      return;
    }
    // An aria-modal dialog must hold focus. The close button is its only
    // control, so Tab in either direction stays on it instead of walking into
    // the page behind the backdrop.
    if (event.key === "Tab") {
      event.preventDefault();
      closeButton.focus();
    }
  };
  closeButton.addEventListener("click", close);
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) close();
  });
  document.addEventListener("keydown", onKeyDown);
  closeActivePopupImageViewer = close;
  overlay.append(image, closeButton);
  document.body.appendChild(overlay);
  closeButton.focus();
}

/**
 * Draw one resolved value into its cell. `"auto"` keeps the historical
 * behavior (sanitized KML description markup, inline base64 images as
 * thumbnails, everything else as text); the explicit kinds render what the
 * author asked for, and fall back to text when the value cannot support it
 * (a `link` whose value is not an http(s) URL, an `image` that is not one).
 */
function renderPopupValue(cell: HTMLElement, row: PopupRow): void {
  if (row.kind === "image") {
    if (isSafePopupUrl(row.value, true)) {
      const source = row.value.trim();
      const isRemoteImage = /^https?:\/\//i.test(source);
      const trigger = isRemoteImage
        ? document.createElement("a")
        : document.createElement("button");
      if (trigger instanceof HTMLAnchorElement) {
        trigger.href = source;
        trigger.target = "_blank";
        trigger.rel = "noopener noreferrer";
      } else {
        trigger.type = "button";
      }
      trigger.className = "geolibre-popup-image-link";
      trigger.addEventListener("click", (event) => {
        const mouseEvent = event as MouseEvent;
        if (
          isRemoteImage &&
          (mouseEvent.button !== 0 ||
            mouseEvent.metaKey ||
            mouseEvent.ctrlKey ||
            mouseEvent.shiftKey ||
            mouseEvent.altKey)
        ) {
          return;
        }
        event.preventDefault();
        openPopupImageViewer(source, row.label);
      });
      const image = document.createElement("img");
      // Trimmed, because that is the copy isSafePopupUrl actually validated —
      // as in the link branch below.
      image.src = source;
      image.alt = row.label;
      image.loading = "lazy";
      image.className = "geolibre-popup-image rounded";
      trigger.appendChild(image);
      cell.appendChild(trigger);
      return;
    }
    cell.textContent = row.text;
    return;
  }

  if (row.kind === "link") {
    if (isSafePopupUrl(row.value)) {
      const link = document.createElement("a");
      link.href = row.value.trim();
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.className = "break-all underline";
      link.textContent = row.linkLabel ?? row.text;
      cell.appendChild(link);
      return;
    }
    cell.textContent = row.text;
    return;
  }

  if (row.kind === "auto") {
    // Render known KML description structures as sanitized markup. Requiring a
    // supported tag keeps ordinary text such as "Elevation <500m>" intact.
    if (
      row.field === "description" &&
      typeof row.value === "string" &&
      /<(?:a|b|br|div|em|i|p|span|strong|table|tbody|td|th|thead|tr)\b/i.test(row.value)
    ) {
      appendSanitizedKmlDescription(cell, row.value);
      return;
    }
    // Render inline image data URLs (e.g. a geotagged-photo or field-collection
    // thumbnail) as an actual thumbnail rather than a multi-kilobyte string.
    // Match base64 raster images only, excluding SVG (which can carry scripts)
    // so an untrusted GeoJSON value can't smuggle one in.
    if (isInlineImageValue(row.value)) {
      const image = document.createElement("img");
      image.src = row.value;
      image.alt = row.field;
      image.loading = "lazy";
      image.className = "geolibre-popup-inline-image rounded";
      cell.appendChild(image);
      return;
    }
  }

  cell.textContent = row.text;
}

/**
 * MapLibre's own `maxWidth` for an Identify popup, which caps the shell the
 * root element sits in. It has to clear the author's width or the shell would
 * clip what the root was just told it may use; the 40px is the popup content's
 * padding plus its border, the same slack the 560px default leaves over the
 * root's 520px cap.
 */
export const IDENTIFY_POPUP_SHELL_PADDING = 40;

/** The `maxWidth` option for a MapLibre Identify popup showing this config. */
export function identifyPopupShellMaxWidth(popup: LayerPopupConfig | undefined): string {
  const maxWidth = resolvePopupMaxWidth(popup);
  return maxWidth === undefined ? "560px" : `${maxWidth + IDENTIFY_POPUP_SHELL_PADDING}px`;
}

/**
 * Apply an author's {@link LayerPopupConfig.maxWidth} to a *filled* popup root.
 *
 * Written as an inline style so it beats both the Tailwind cap on the element
 * and the wider `:has(.geolibre-popup-image)` rule in the app stylesheet, and
 * kept inside `min()` with the viewport so an oversized setting still leaves
 * the map visible on a phone.
 *
 * `width` is set only for a popup that carries a picture, which is why this
 * runs after the content is in place. There the `:has(.geolibre-popup-image)`
 * rule already pins a fixed `width: min(420px, …)` that has to be overridden
 * or the new cap could never be reached, and the image is `width: 100%` of its
 * cell, so a shrink-to-fit popup would draw a thumbnail as narrow as the text
 * beside it. A text-only popup keeps shrinking to its content the way it
 * always has, with the author's value as its ceiling rather than its size.
 */
export function applyPopupWidth(root: HTMLElement, popup: LayerPopupConfig | undefined): void {
  const maxWidth = resolvePopupMaxWidth(popup);
  if (maxWidth === undefined) return;
  const cap = `min(${maxWidth}px, calc(100vw - 48px))`;
  root.style.maxWidth = cap;
  if (root.querySelector(".geolibre-popup-image")) root.style.width = cap;
}

/**
 * Publish an author's {@link LayerPopupConfig.imageHeight} to the stylesheet.
 *
 * The cap belongs to `.geolibre-popup-image`, which the rows element does not
 * own, so this sets the custom property the rule reads rather than styling the
 * images directly — the fullscreen-image popup variant can then still drop the
 * cap entirely, as it always has.
 */
export function applyPopupImageHeight(
  rows: HTMLElement,
  popup: LayerPopupConfig | undefined,
): void {
  const height = resolvePopupImageHeight(popup);
  if (height === undefined) return;
  rows.style.setProperty("--geolibre-popup-image-height", `${height}px`);
}

export function createIdentifyPopupElement(
  layerName: string,
  properties: Record<string, unknown>,
  featureId?: string | number,
  options: IdentifyPopupOptions = {},
): HTMLElement {
  const { popup, fieldVisibility, feature, zoom } = options;

  const root = document.createElement("div");
  root.className =
    "geolibre-identify-popup-root flex min-w-[min(18rem,calc(100vw-48px))] max-w-[min(520px,calc(100vw-48px))] flex-col text-xs";

  const title = document.createElement("div");
  // Leave room for MapLibre's close button, which sits in the same corner the
  // heading would otherwise run into.
  title.className = "mb-2 pe-6 font-semibold text-foreground";
  title.textContent = resolvePopupTitle(layerName, properties, popup, {
    feature,
    zoom,
    fieldVisibility,
  });
  root.appendChild(title);

  root.appendChild(createIdentifyPopupRows(properties, featureId, options));

  // Last, because applyPopupWidth reads the finished content to decide whether
  // the popup needs a fixed width or may keep shrinking to fit.
  applyPopupWidth(root, popup);

  return root;
}

/** Build the attribute rows shared by per-layer and all-layer Identify popups. */
export function createIdentifyPopupRows(
  properties: Record<string, unknown>,
  featureId?: string | number,
  options: IdentifyPopupOptions = {},
  scrollable = true,
): HTMLElement {
  const { popup, fieldVisibility, feature, zoom } = options;
  const locale = documentLocale();

  const rows = document.createElement("div");
  rows.className = scrollable ? "geolibre-identify-popup-rows pe-2" : "pe-2";
  applyPopupImageHeight(rows, popup);

  // An author-supplied body expression replaces the whole body outright — the
  // field table AND the synthetic id row. The point of it is a sentence
  // instead of rows, and a raw feature id dangling under that sentence would
  // undo it. The designer disables the "Show the feature id row" checkbox
  // while a body expression is set, so the UI does not offer a control that
  // cannot take effect.
  const body = resolvePopupBody(properties, popup, { feature, zoom, fieldVisibility });
  if (body !== null) {
    const paragraph = document.createElement("div");
    paragraph.className = "whitespace-pre-wrap break-words text-foreground";
    paragraph.textContent = body;
    rows.appendChild(paragraph);
    return rows;
  }

  const appendRow = (row: PopupRow) => {
    const rowElement = document.createElement("div");
    rowElement.className = "grid grid-cols-[minmax(5rem,0.45fr)_1fr] gap-2 border-t py-1";
    if (row.kind === "image") rowElement.classList.add("geolibre-identify-popup-image-row");

    const keyCell = document.createElement("div");
    keyCell.className = "break-words font-medium text-muted-foreground";
    keyCell.textContent = row.label;

    const valueCell = document.createElement("div");
    valueCell.className = "break-words text-foreground";
    if (row.kind === "image") valueCell.classList.add("geolibre-popup-image-cell");
    renderPopupValue(valueCell, row);

    rowElement.append(keyCell, valueCell);
    rows.appendChild(rowElement);
  };

  const showFeatureId = featureId != null && popup?.showFeatureId !== false;
  if (showFeatureId) {
    appendRow({
      field: "id",
      label: "id",
      value: featureId,
      text: stringifyPopupValue(featureId),
      kind: "auto",
    });
  }

  // resolvePopupRows drops GeoLibre's internal columns and the heavy
  // full-resolution photo twin, and applies the author's field list, order,
  // labels and formatting. Its result is empty for a feature with nothing to
  // show, which is what the "No attributes" state reports.
  const resolved = resolvePopupRows(properties, {
    popup,
    fieldVisibility,
    locale,
  });
  if (resolved.length === 0 && !showFeatureId) {
    const empty = document.createElement("div");
    empty.className = "text-muted-foreground";
    empty.textContent = "No attributes";
    rows.appendChild(empty);
  } else {
    for (const row of resolved) appendRow(row);
  }

  return rows;
}

/**
 * The hover tooltip's content: the layer's popup title over the fields the
 * author flagged for hover. Kept deliberately small — this follows the pointer,
 * so it shows the one or two fields that name the feature, never the table.
 */
export function createHoverTooltipElement(
  layerName: string,
  properties: Record<string, unknown>,
  options: IdentifyPopupOptions = {},
): HTMLElement | null {
  const { popup, fieldVisibility, feature, zoom } = options;
  const rows = resolvePopupRows(properties, {
    popup,
    fieldVisibility,
    hover: true,
    locale: documentLocale(),
  });
  const configuredTitle = resolveConfiguredPopupTitle(properties, popup, {
    feature,
    zoom,
    fieldVisibility,
  });
  // Nothing to say: no flagged field, and no title the author configured, so
  // the tip would be a box repeating the layer name the user can already read
  // in the Layers panel. Keyed on whether a title was configured rather than on
  // whether it happens to equal the layer name — a feature legitimately called
  // the same thing as its layer still deserves its tooltip.
  if (rows.length === 0 && configuredTitle === null) return null;
  const title = configuredTitle ?? layerName;

  const root = document.createElement("div");
  root.className = "geolibre-hover-tooltip-root flex max-w-[16rem] flex-col gap-0.5 text-xs";

  const heading = document.createElement("div");
  heading.className = "font-semibold text-foreground";
  heading.textContent = title;
  root.appendChild(heading);

  for (const row of rows) {
    const line = document.createElement("div");
    line.className = "flex gap-1.5 text-foreground";
    const label = document.createElement("span");
    label.className = "shrink-0 text-muted-foreground";
    label.textContent = row.label;
    const value = document.createElement("span");
    value.className = "min-w-0 break-words";
    // A tooltip is a one-line read, so a link shows as its text rather than as
    // a clickable anchor — the tip has `pointer-events: none` and could not be
    // clicked anyway. Image rows never reach here: resolvePopupRows drops them
    // from the hover subset rather than printing a data URL.
    value.textContent = row.text;
    line.append(label, value);
    root.appendChild(line);
  }

  return root;
}

const KML_DESCRIPTION_TAGS = new Set([
  "a",
  "b",
  "br",
  "div",
  "em",
  "i",
  "p",
  "span",
  "strong",
  "table",
  "tbody",
  "td",
  "th",
  "thead",
  "tr",
]);

/** Render useful KML description markup while dropping scripts and attributes. */
function appendSanitizedKmlDescription(target: HTMLElement, html: string): void {
  const parsed = new DOMParser().parseFromString(html, "text/html");
  const copy = (node: Node, parent: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      parent.appendChild(document.createTextNode(node.textContent ?? ""));
      return;
    }
    if (!(node instanceof Element)) return;
    const tag = node.localName.toLowerCase();
    if (tag === "script" || tag === "style" || tag === "head" || tag === "meta") return;
    if (!KML_DESCRIPTION_TAGS.has(tag)) {
      for (const child of node.childNodes) copy(child, parent);
      return;
    }
    const element = document.createElement(tag);
    if (tag === "a") {
      const href = node.getAttribute("href")?.trim();
      if (href && /^(https?:|mailto:)/i.test(href)) {
        element.setAttribute("href", href);
        element.setAttribute("target", "_blank");
        element.setAttribute("rel", "noopener noreferrer");
      }
    }
    for (const child of node.childNodes) copy(child, element);
    parent.appendChild(element);
  };
  const content = document.createElement("div");
  content.className = "geolibre-kml-description";
  for (const child of parsed.body.childNodes) copy(child, content);
  target.appendChild(content);
}
