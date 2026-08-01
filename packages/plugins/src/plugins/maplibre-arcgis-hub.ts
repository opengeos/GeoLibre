import type { GeoLibreAppAPI, GeoLibrePlugin } from "../types";
import { addArcGISLayer } from "./arcgis-layer";
import {
  arcGisHubItemDataUrl,
  arcGisHubItemPageUrl,
  arcGisHubItemThumbnailUrl,
  fetchFeatureServiceGeoJson,
  itemBounds,
  searchArcGisHub,
  type ArcGisHubItem,
} from "./arcgis-hub-api";

export const ARCGIS_HUB_PLUGIN_ID = "maplibre-gl-arcgis-hub";
const PANEL_ID = ARCGIS_HUB_PLUGIN_ID;
const PAGE_SIZE = 20;

let appRef: GeoLibreAppAPI | null = null;
let unregisterPanel: (() => void) | null = null;
let disposePanel: (() => void) | null = null;

const styles = {
  panel:
    "display:flex;flex-direction:column;gap:8px;padding:8px;height:100%;box-sizing:border-box;" +
    "font-size:12px;color:hsl(var(--foreground));",
  row: "display:flex;gap:6px;",
  input:
    "min-width:0;flex:1;padding:6px 8px;border:1px solid hsl(var(--border));border-radius:6px;" +
    "background:hsl(var(--background));color:hsl(var(--foreground));",
  button:
    "padding:5px 9px;border:1px solid hsl(var(--border));border-radius:5px;cursor:pointer;" +
    "background:hsl(var(--background));color:hsl(var(--foreground));",
  primary:
    "padding:6px 10px;border:1px solid hsl(var(--primary));border-radius:6px;cursor:pointer;" +
    "background:hsl(var(--primary));color:hsl(var(--primary-foreground));",
  status: "font-size:11px;color:hsl(var(--muted-foreground));line-height:1.4;",
  results: "display:flex;flex-direction:column;gap:6px;overflow:auto;min-height:0;flex:1;",
  card:
    "display:flex;gap:8px;padding:8px;border:1px solid hsl(var(--border));" +
    "border-radius:6px;background:hsl(var(--muted));",
  thumbnail:
    "width:88px;height:66px;flex:0 0 88px;object-fit:cover;border-radius:4px;" +
    "background:hsl(var(--accent));cursor:zoom-in;",
  thumbnailPreview:
    "position:fixed;z-index:2147483000;max-width:360px;max-height:270px;object-fit:contain;" +
    "pointer-events:none;border:1px solid hsl(var(--border));border-radius:8px;" +
    "background:hsl(var(--background));box-shadow:0 12px 32px rgba(0,0,0,0.35);",
  cardBody: "display:flex;flex:1;min-width:0;flex-direction:column;gap:5px;",
  title: "font-weight:600;line-height:1.3;",
  meta: "font-size:10px;color:hsl(var(--muted-foreground));",
  actions: "display:flex;gap:4px;flex-wrap:wrap;",
} as const;

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  return node;
}

function safeFilename(title: string): string {
  const normalized = title
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-")
    .replace(/\s+/g, " ")
    .slice(0, 100);
  return normalized || "arcgis-hub-data";
}

function canVisualize(item: ArcGisHubItem): boolean {
  return item.type === "Feature Service" || item.type === "GeoJson";
}

async function visualize(item: ArcGisHubItem): Promise<void> {
  if (!appRef) return;
  if (item.type === "Feature Service" && item.url) {
    await addArcGISLayer(appRef, {
      layerType: "feature",
      sourceType: "portal-item",
      itemId: item.id,
      name: item.title,
    });
  } else if (item.type === "GeoJson") {
    const response = await fetch(arcGisHubItemDataUrl(item));
    if (!response.ok) throw new Error(`GeoJSON download failed with ${response.status}.`);
    const data = await response.json();
    if (data?.type !== "FeatureCollection") throw new Error("The item is not valid GeoJSON.");
    appRef.addGeoJsonLayer(item.title, data, arcGisHubItemDataUrl(item));
    const bounds = itemBounds(item);
    if (bounds) appRef.fitBounds?.(bounds);
  } else {
    throw new Error("This item cannot be visualized directly.");
  }
}

async function download(item: ArcGisHubItem): Promise<void> {
  if (!appRef) return;
  if (item.type === "Feature Service" && item.url) {
    const data = await fetchFeatureServiceGeoJson(item.url);
    appRef.exportTextFile?.(`${safeFilename(item.title)}.geojson`, JSON.stringify(data), {
      description: "GeoJSON",
      extensions: ["geojson", "json"],
      mimeType: "application/geo+json",
      promptName: true,
    });
    return;
  }
  appRef.openExternalUrl?.(arcGisHubItemDataUrl(item));
}

function buildPanel(container: HTMLElement): () => void {
  container.replaceChildren();
  const panel = element("div");
  panel.style.cssText = styles.panel;
  const hint = element(
    "div",
    "Search public datasets from ArcGIS Hub. Add supported layers to the map or download data.",
  );
  hint.style.cssText = styles.status;
  const form = element("form");
  form.style.cssText = styles.row;
  const input = element("input");
  input.type = "search";
  input.placeholder = "Search ArcGIS Hub datasets";
  input.ariaLabel = "Search ArcGIS Hub datasets";
  input.style.cssText = styles.input;
  const submit = element("button", "Search");
  submit.type = "submit";
  submit.style.cssText = styles.primary;
  form.append(input, submit);
  const viewRow = element("label");
  viewRow.style.cssText = `${styles.row}align-items:center;`;
  const viewOnly = element("input");
  viewOnly.type = "checkbox";
  viewOnly.checked = true;
  viewRow.append(viewOnly, document.createTextNode(" Search the current map area"));
  const status = element("div", "Enter a keyword to begin.");
  status.style.cssText = styles.status;
  const results = element("div");
  results.style.cssText = styles.results;
  const more = element("button", "Load more");
  more.type = "button";
  more.style.cssText = styles.button;
  more.hidden = true;
  panel.append(hint, form, viewRow, status, results, more);
  container.append(panel);

  let start = 1;
  let total = 0;
  let shown = 0;
  let controller: AbortController | null = null;
  let thumbnailPreview: HTMLImageElement | null = null;

  const removeThumbnailPreview = () => {
    thumbnailPreview?.remove();
    thumbnailPreview = null;
  };

  const positionThumbnailPreview = (event: MouseEvent) => {
    if (!thumbnailPreview) return;
    const gap = 14;
    const width = thumbnailPreview.offsetWidth || 360;
    const height = thumbnailPreview.offsetHeight || 270;
    const left =
      event.clientX + gap + width <= window.innerWidth
        ? event.clientX + gap
        : Math.max(gap, event.clientX - gap - width);
    const top = Math.min(
      Math.max(gap, event.clientY - height / 2),
      Math.max(gap, window.innerHeight - height - gap),
    );
    thumbnailPreview.style.left = `${left}px`;
    thumbnailPreview.style.top = `${top}px`;
  };

  const setBusy = (busy: boolean) => {
    submit.disabled = busy;
    more.disabled = busy;
    submit.textContent = busy ? "Searching…" : "Search";
  };

  const renderItem = (item: ArcGisHubItem) => {
    const card = element("article");
    card.style.cssText = styles.card;
    const thumbnailUrl = arcGisHubItemThumbnailUrl(item);
    if (thumbnailUrl) {
      const thumbnail = element("img");
      thumbnail.src = thumbnailUrl;
      thumbnail.alt = "";
      thumbnail.loading = "lazy";
      thumbnail.referrerPolicy = "no-referrer";
      thumbnail.style.cssText = styles.thumbnail;
      thumbnail.addEventListener(
        "error",
        () => {
          removeThumbnailPreview();
          thumbnail.remove();
        },
        { once: true },
      );
      thumbnail.addEventListener("mouseenter", (event) => {
        removeThumbnailPreview();
        thumbnailPreview = element("img");
        thumbnailPreview.src = thumbnailUrl;
        thumbnailPreview.alt = "";
        thumbnailPreview.referrerPolicy = "no-referrer";
        thumbnailPreview.style.cssText = styles.thumbnailPreview;
        thumbnailPreview.addEventListener("error", removeThumbnailPreview, { once: true });
        document.body.append(thumbnailPreview);
        positionThumbnailPreview(event);
      });
      thumbnail.addEventListener("mousemove", positionThumbnailPreview);
      thumbnail.addEventListener("mouseleave", removeThumbnailPreview);
      card.append(thumbnail);
    }
    const body = element("div");
    body.style.cssText = styles.cardBody;
    const title = element("div", item.title);
    title.style.cssText = styles.title;
    const meta = element("div", `${item.type} · ${item.owner}`);
    meta.style.cssText = styles.meta;
    const summary = element("div", item.snippet || "No description provided.");
    summary.style.cssText = styles.status;
    const actions = element("div");
    actions.style.cssText = styles.actions;
    if (canVisualize(item)) {
      const add = element("button", "Add to map");
      add.type = "button";
      add.style.cssText = styles.button;
      add.addEventListener("click", async () => {
        add.disabled = true;
        status.textContent = `Adding ${item.title}…`;
        try {
          await visualize(item);
          status.textContent = `Added ${item.title}.`;
        } catch (error) {
          status.textContent = error instanceof Error ? error.message : "Could not add dataset.";
        } finally {
          add.disabled = false;
        }
      });
      actions.append(add);
    }
    const zoom = element("button", "Zoom");
    zoom.type = "button";
    zoom.style.cssText = styles.button;
    const bounds = itemBounds(item);
    zoom.disabled = !bounds;
    zoom.addEventListener("click", () => {
      if (bounds) appRef?.fitBounds?.(bounds);
    });
    const save = element("button", "Download");
    save.type = "button";
    save.style.cssText = styles.button;
    save.addEventListener("click", async () => {
      save.disabled = true;
      status.textContent = `Preparing ${item.title}…`;
      try {
        await download(item);
        status.textContent = `Download started for ${item.title}.`;
      } catch (error) {
        status.textContent = error instanceof Error ? error.message : "Could not download dataset.";
      } finally {
        save.disabled = false;
      }
    });
    const details = element("button", "Details");
    details.type = "button";
    details.style.cssText = styles.button;
    details.addEventListener("click", () => appRef?.openExternalUrl?.(arcGisHubItemPageUrl(item)));
    actions.append(zoom, save, details);
    body.append(title, meta, summary, actions);
    card.append(body);
    results.append(card);
  };

  const runSearch = async (append: boolean) => {
    const query = input.value.trim();
    if (!query) {
      status.textContent = "Enter a search term.";
      return;
    }
    controller?.abort();
    controller = new AbortController();
    if (!append) {
      start = 1;
      shown = 0;
      results.replaceChildren();
    }
    setBusy(true);
    status.textContent = append ? "Loading more datasets…" : "Searching ArcGIS Hub…";
    try {
      const mapBounds = appRef?.getMap?.()?.getBounds();
      const bbox =
        viewOnly.checked && mapBounds
          ? ([
              mapBounds.getWest(),
              mapBounds.getSouth(),
              mapBounds.getEast(),
              mapBounds.getNorth(),
            ] as [number, number, number, number])
          : undefined;
      const page = await searchArcGisHub(query, {
        start,
        num: PAGE_SIZE,
        bbox,
        signal: controller.signal,
      });
      page.results.forEach(renderItem);
      total = page.total;
      shown += page.results.length;
      start = page.nextStart;
      status.textContent =
        shown === 0 ? "No public datasets found." : `Showing ${shown} of ${total} datasets.`;
      more.hidden = page.nextStart < 1 || shown >= total;
    } catch (error) {
      if ((error as Error).name !== "AbortError") {
        status.textContent =
          error instanceof Error ? error.message : "Could not search ArcGIS Hub.";
      }
    } finally {
      setBusy(false);
    }
  };

  const onSubmit = (event: SubmitEvent) => {
    event.preventDefault();
    void runSearch(false);
  };
  form.addEventListener("submit", onSubmit);
  more.addEventListener("click", () => void runSearch(true));
  input.focus();

  return () => {
    controller?.abort();
    removeThumbnailPreview();
    form.removeEventListener("submit", onSubmit);
    container.replaceChildren();
  };
}

export const maplibreArcGisHubPlugin: GeoLibrePlugin = {
  id: ARCGIS_HUB_PLUGIN_ID,
  name: "ArcGIS Hub",
  version: "0.1.0",
  activate: (app) => {
    appRef = app;
    unregisterPanel =
      app.registerRightPanel?.({
        id: PANEL_ID,
        title: "ArcGIS Hub",
        dock: "right-of-style",
        defaultWidth: 360,
        render: (container) => {
          disposePanel = buildPanel(container);
          return () => {
            disposePanel?.();
            disposePanel = null;
          };
        },
      }) ?? null;
    app.openRightPanel?.(PANEL_ID);
  },
  deactivate: (app) => {
    app.closeRightPanel?.(PANEL_ID);
    disposePanel?.();
    disposePanel = null;
    unregisterPanel?.();
    unregisterPanel = null;
    appRef = null;
  },
};

export default maplibreArcGisHubPlugin;
