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
import type { ArcGISLayerType } from "./arcgis-layer";

export const ARCGIS_HUB_PLUGIN_ID = "maplibre-gl-arcgis-hub";
const PAGE_SIZE = 20;
// Start fetching the next page this far before the list's bottom edge, so the
// new cards are usually in place by the time the user scrolls to them.
const AUTO_LOAD_THRESHOLD_PX = 200;

export interface ArcGisHubLabels {
  hint: string;
  searchPlaceholder: string;
  search: string;
  searchCurrentView: string;
  enterKeyword: string;
  /** Shown when "current view only" is on but the map reports no extent. */
  viewUnavailable: string;
  loadMore: string;
  searching: string;
  loadingMore: string;
  noResults: string;
  searchError: string;
  showing: (shown: number, total: number) => string;
  noDescription: string;
  add: string;
  adding: (title: string) => string;
  added: (title: string) => string;
  addError: string;
  zoom: string;
  download: string;
  preparing: (title: string) => string;
  downloading: (completed: number, total: number, title: string) => string;
  downloadStarted: (title: string) => string;
  downloadFirstLayer: (title: string, layerCount: number) => string;
  downloadError: string;
  details: string;
}

export const DEFAULT_ARCGIS_HUB_LABELS: ArcGisHubLabels = {
  hint: "Search public datasets from ArcGIS Hub. Add supported layers to the map or download data.",
  searchPlaceholder: "Search ArcGIS Hub datasets",
  search: "Search",
  searchCurrentView: "Search the current map area",
  enterKeyword: "Enter a keyword to begin.",
  viewUnavailable: "The current map area is unavailable; turn off the map-area filter to search.",
  loadMore: "Load more",
  searching: "Searching…",
  loadingMore: "Loading more datasets…",
  noResults: "No public datasets found.",
  searchError: "Could not search ArcGIS Hub.",
  showing: (shown, total) => `Showing ${shown} of ${total} datasets.`,
  noDescription: "No description provided.",
  add: "Add to map",
  adding: (title) => `Adding ${title}…`,
  added: (title) => `Added ${title}.`,
  addError: "Could not add this dataset.",
  zoom: "Zoom",
  download: "Download",
  preparing: (title) => `Preparing ${title}…`,
  downloading: (completed, total, title) =>
    `Downloading ${title}: ${completed} of ${total} features…`,
  downloadStarted: (title) => `Download started for ${title}.`,
  downloadFirstLayer: (title, layerCount) =>
    `${title} has ${layerCount} layers; only the first was downloaded.`,
  downloadError: "Could not download this dataset.",
  details: "Details",
};

/** Configures one ArcGIS Hub catalog panel built by {@link createArcGisHubPlugin}. */
export interface ArcGisHubPluginConfig {
  /** Plugin id, also used as the right-panel id. */
  id: string;
  /** Plugin and panel title. */
  name: string;
  version?: string;
  /** English labels, replaced through the returned `setLabels`. */
  defaultLabels: ArcGisHubLabels;
  /** Origin of the site whose `/datasets/<id>/about` pages the Details button opens. */
  pageUrl?: string;
  /** Item types to search. Defaults to the global Hub set. */
  types?: readonly string[];
  /**
   * Resolves the groups that scope the search, for a Hub site's catalog. A
   * search calls it while no list is cached, so a rejection is retried by the
   * next search; the first list it resolves to (including any fallback the
   * resolver substitutes itself) is kept for the plugin's lifetime.
   */
  resolveGroups?: (signal: AbortSignal) => Promise<readonly string[]>;
  /**
   * List the whole (scoped) catalog when the keyword box is empty, and do so as
   * soon as the panel opens. Only sensible for a catalog small enough to browse.
   */
  browseWithoutKeyword?: boolean;
  /** Initial state of the "current map area" filter. Defaults to on. */
  viewOnlyByDefault?: boolean;
  /** Fallback download file name when a title sanitizes to nothing. */
  filenameFallback?: string;
}

/** A catalog panel plugin plus the hook that translates its labels. */
export interface ArcGisHubPluginInstance {
  plugin: GeoLibrePlugin;
  setLabels: (next: Partial<ArcGisHubLabels>) => void;
}

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

function safeFilename(title: string, fallback: string): string {
  const normalized = title
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-")
    .replace(/\s+/g, " ")
    .slice(0, 100);
  return normalized || fallback;
}

// Service item types that load through `addArcGISLayer` by portal item id.
const SERVICE_LAYER_TYPES: Record<string, ArcGISLayerType> = {
  "Feature Service": "feature",
  "Map Service": "map-service",
  "Image Service": "image-service",
};

function canVisualize(item: ArcGisHubItem): boolean {
  return Object.hasOwn(SERVICE_LAYER_TYPES, item.type) || item.type === "GeoJson";
}

// A Feature Service is downloaded by querying its FeatureServer URL; without one
// the item-data endpoint has nothing to hand back, so there is nothing to offer.
// Map and image services only render pictures, so they have no data to save.
function canDownload(item: ArcGisHubItem): boolean {
  if (item.type === "Map Service" || item.type === "Image Service") return false;
  return item.type !== "Feature Service" || Boolean(item.url);
}

/**
 * Build a Hub catalog panel plugin. Each call owns its own panel state, so the
 * global ArcGIS Hub browser and site-scoped portals can be open side by side.
 *
 * Args:
 *   config: The plugin's identity, labels, and search scope.
 *
 * Returns:
 *   The plugin and a setter for its translated labels.
 */
export function createArcGisHubPlugin(config: ArcGisHubPluginConfig): ArcGisHubPluginInstance {
  const panelId = config.id;
  const pageUrl = config.pageUrl;
  const filenameFallback = config.filenameFallback ?? "arcgis-hub-data";
  let appRef: GeoLibreAppAPI | null = null;
  let unregisterPanel: (() => void) | null = null;
  let disposePanel: (() => void) | null = null;
  let panelContainer: HTMLElement | null = null;
  let labels: ArcGisHubLabels = { ...config.defaultLabels };
  let groups: readonly string[] | null = null;

  async function visualize(item: ArcGisHubItem): Promise<void> {
    const app = appRef;
    if (!app) return;
    // Own keys only: `type` comes from the portal, and a value such as
    // "constructor" must not resolve to an Object.prototype member.
    const serviceLayerType = Object.hasOwn(SERVICE_LAYER_TYPES, item.type)
      ? SERVICE_LAYER_TYPES[item.type]
      : undefined;
    if (serviceLayerType) {
      await addArcGISLayer(app, {
        layerType: serviceLayerType,
        sourceType: "portal-item",
        itemId: item.id,
        name: item.title,
      });
    } else if (item.type === "GeoJson") {
      const dataUrl = arcGisHubItemDataUrl(item);
      const response = await fetch(dataUrl);
      if (!response.ok) throw new Error(`GeoJSON download failed with ${response.status}.`);
      // A portal behind sign-in can answer 200 with an HTML login page, so read
      // the body as text first and say so, rather than letting JSON.parse raise a
      // bare `SyntaxError: Unexpected token '<'` (matches fetchArcGISGeoJson).
      const text = await response.text();
      if (/^\s*</.test(text)) {
        throw new Error(
          "The portal returned HTML instead of GeoJSON (the item may require a token or sign-in).",
        );
      }
      const data = JSON.parse(text);
      if (data?.type !== "FeatureCollection" || !Array.isArray(data.features)) {
        throw new Error("The item is not valid GeoJSON.");
      }
      // deactivate() nulls appRef, which can happen while the fetch above is in
      // flight; bail explicitly instead of adding a layer to a torn-down host.
      if (!appRef) return;
      app.addGeoJsonLayer(item.title, data, dataUrl);
      const bounds = itemBounds(item);
      if (bounds) app.fitBounds?.(bounds);
    } else {
      throw new Error("This item cannot be visualized directly.");
    }
  }

  /**
   * Export the item, resolving to the service's layer count when the export
   * covers only the first of several layers, and 0 when nothing was left behind.
   */
  async function download(
    item: ArcGisHubItem,
    signal?: AbortSignal,
    onProgress?: (completed: number, total: number) => void,
  ): Promise<number> {
    const app = appRef;
    if (!app) return 0;
    if (item.type === "Feature Service" && item.url) {
      let skippedLayers = 0;
      const data = await fetchFeatureServiceGeoJson(item.url, signal, onProgress, (layerCount) => {
        skippedLayers = layerCount;
      });
      // deactivate() nulls appRef, which can land while a large service download
      // is still in flight; bail rather than exporting through a torn-down host.
      if (!appRef) return 0;
      app.exportTextFile?.(
        `${safeFilename(item.title, filenameFallback)}.geojson`,
        JSON.stringify(data),
        {
          description: "GeoJSON",
          extensions: ["geojson", "json"],
          mimeType: "application/geo+json",
          promptName: true,
        },
      );
      return skippedLayers;
    }
    app.openExternalUrl?.(arcGisHubItemDataUrl(item));
    return 0;
  }

  function buildPanel(container: HTMLElement): () => void {
    container.replaceChildren();
    const panel = element("div");
    panel.style.cssText = styles.panel;
    const hint = element("div", labels.hint);
    hint.style.cssText = styles.status;
    const form = element("form");
    form.style.cssText = styles.row;
    const input = element("input");
    input.type = "search";
    input.placeholder = labels.searchPlaceholder;
    input.ariaLabel = labels.searchPlaceholder;
    input.style.cssText = styles.input;
    const submit = element("button", labels.search);
    submit.type = "submit";
    submit.style.cssText = styles.primary;
    form.append(input, submit);
    const viewRow = element("label");
    viewRow.style.cssText = `${styles.row}align-items:center;`;
    const viewOnly = element("input");
    viewOnly.type = "checkbox";
    viewOnly.checked = config.viewOnlyByDefault ?? true;
    viewRow.append(viewOnly, document.createTextNode(` ${labels.searchCurrentView}`));
    const status = element("div", labels.enterKeyword);
    status.style.cssText = styles.status;
    const results = element("div");
    results.style.cssText = styles.results;
    const more = element("button", labels.loadMore);
    more.type = "button";
    more.style.cssText = styles.button;
    more.hidden = true;
    panel.append(hint, form, viewRow, status, results, more);
    container.append(panel);

    let start = 1;
    let total = 0;
    let shown = 0;
    let controller: AbortController | null = null;
    let generation = 0;
    let activeQuery = "";
    // Snapshotted with activeQuery: `start` is an offset into one specific result
    // set, so Load more has to repeat the filter the offset was measured against.
    let activeBbox: [number, number, number, number] | undefined;
    let thumbnailPreview: HTMLImageElement | null = null;
    const downloadControllers = new Set<AbortController>();

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

    let busy = false;
    const setBusy = (next: boolean) => {
      busy = next;
      submit.disabled = next;
      more.disabled = next;
      submit.textContent = next ? labels.searching : labels.search;
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
      const summary = element("div", item.snippet || labels.noDescription);
      summary.style.cssText = styles.status;
      const actions = element("div");
      actions.style.cssText = styles.actions;
      if (canVisualize(item)) {
        const add = element("button", labels.add);
        add.type = "button";
        add.style.cssText = styles.button;
        add.addEventListener("click", async () => {
          add.disabled = true;
          status.textContent = labels.adding(item.title);
          try {
            await visualize(item);
            status.textContent = labels.added(item.title);
          } catch (error) {
            console.error(`Could not add the ${config.name} dataset.`, error);
            status.textContent = labels.addError;
          } finally {
            add.disabled = false;
          }
        });
        actions.append(add);
      }
      const zoom = element("button", labels.zoom);
      zoom.type = "button";
      zoom.style.cssText = styles.button;
      const bounds = itemBounds(item);
      zoom.disabled = !bounds;
      zoom.addEventListener("click", () => {
        if (bounds) appRef?.fitBounds?.(bounds);
      });
      const save = element("button", labels.download);
      save.type = "button";
      save.style.cssText = styles.button;
      save.disabled = !canDownload(item);
      save.addEventListener("click", async () => {
        save.disabled = true;
        status.textContent = labels.preparing(item.title);
        const downloadController = new AbortController();
        downloadControllers.add(downloadController);
        try {
          const layerCount = await download(item, downloadController.signal, (completed, total) => {
            status.textContent = labels.downloading(completed, total, item.title);
          });
          status.textContent =
            layerCount > 1
              ? labels.downloadFirstLayer(item.title, layerCount)
              : labels.downloadStarted(item.title);
        } catch (error) {
          if ((error as Error).name !== "AbortError") {
            console.error(`Could not download the ${config.name} dataset.`, error);
            status.textContent = labels.downloadError;
          }
        } finally {
          downloadControllers.delete(downloadController);
          save.disabled = !canDownload(item);
        }
      });
      const details = element("button", labels.details);
      details.type = "button";
      details.style.cssText = styles.button;
      details.addEventListener("click", () =>
        appRef?.openExternalUrl?.(arcGisHubItemPageUrl(item, pageUrl)),
      );
      actions.append(zoom, save, details);
      body.append(title, meta, summary, actions);
      card.append(body);
      results.append(card);
    };

    const runSearch = async (append: boolean) => {
      const query = append ? activeQuery : input.value.trim();
      if (!query && !config.browseWithoutKeyword) {
        status.textContent = labels.enterKeyword;
        return;
      }
      // Read the extent through `getViewBounds`, not `getMap()?.getBounds()`:
      // this plugin declares `engines: ["maplibre", "cesium", "mapbox", "arcgis"]`,
      // and `getMap()` is null on the globe, Mapbox and ArcGIS — so the bounds
      // came back undefined there and every search covered the whole world with
      // "current view only" still ticked.
      //
      // `getViewBounds` has its own null: no map mounted yet, the globe mid-morph
      // between scene modes, or a camera pointed away from Earth. Widening to the
      // whole world there would reproduce the same lie in a second place, so a
      // view-only search with no extent is refused and says so instead. Checked
      // before the abort below, like the empty-query guard, so a refused search
      // leaves the running one alone.
      const viewBounds = !append && viewOnly.checked ? (appRef?.getViewBounds?.() ?? null) : null;
      if (!append && viewOnly.checked && !viewBounds) {
        status.textContent = labels.viewUnavailable;
        return;
      }
      controller?.abort();
      controller = new AbortController();
      const token = ++generation;
      if (!append) {
        activeQuery = query;
        // Hold the map filter for the whole search. Re-deriving it on Load more
        // would page a stale `start` offset into a differently filtered result
        // set if the user panned, silently skipping or repeating datasets.
        activeBbox = viewBounds ? [...viewBounds] : undefined;
        start = 1;
        shown = 0;
        removeThumbnailPreview();
        results.replaceChildren();
      }
      let succeeded = false;
      setBusy(true);
      status.textContent = append ? labels.loadingMore : labels.searching;
      try {
        if (config.resolveGroups && !groups) {
          const resolved = await config.resolveGroups(controller.signal);
          // An empty group list would silently widen the search to all of
          // ArcGIS Online, which is not this catalog.
          if (resolved.length === 0) throw new Error(`${config.name} has no catalog groups.`);
          groups = resolved;
        }
        const page = await searchArcGisHub(query, {
          start,
          num: PAGE_SIZE,
          bbox: activeBbox,
          groups: groups ?? undefined,
          types: config.types,
          signal: controller.signal,
        });
        if (token !== generation) return;
        page.results.forEach(renderItem);
        total = page.total;
        shown += page.results.length;
        start = page.nextStart;
        status.textContent = shown === 0 ? labels.noResults : labels.showing(shown, total);
        more.hidden = page.nextStart < 1 || shown >= total;
        // Only after a successful page: a failing request must not retry
        // itself in a loop. The button stays as the manual retry.
        succeeded = true;
      } catch (error) {
        if ((error as Error).name !== "AbortError") {
          console.error(`Could not search ${config.name}.`, error);
          status.textContent = labels.searchError;
        }
      } finally {
        if (token === generation) setBusy(false);
      }
      // A page that does not fill the list leaves nothing to scroll, so the
      // scroll handler would never fire; keep loading until it overflows.
      if (succeeded && token === generation) loadMoreIfNearBottom();
    };

    // Fetch the next page once the user scrolls near the end of the list. The
    // Load more button stays for keyboard users and as a retry after an error.
    const loadMoreIfNearBottom = () => {
      if (busy || more.hidden) return;
      // A collapsed or hidden panel lays the list out with zero height, which
      // would otherwise read as "at the bottom" and page through everything.
      if (results.clientHeight === 0) return;
      const remaining = results.scrollHeight - results.scrollTop - results.clientHeight;
      if (remaining <= AUTO_LOAD_THRESHOLD_PX) void runSearch(true);
    };

    const onSubmit = (event: SubmitEvent) => {
      event.preventDefault();
      void runSearch(false);
    };
    form.addEventListener("submit", onSubmit);
    more.addEventListener("click", () => void runSearch(true));
    results.addEventListener("scroll", loadMoreIfNearBottom, { passive: true });
    input.focus();
    if (config.browseWithoutKeyword) void runSearch(false);

    return () => {
      controller?.abort();
      generation += 1;
      downloadControllers.forEach((downloadController) => downloadController.abort());
      downloadControllers.clear();
      removeThumbnailPreview();
      form.removeEventListener("submit", onSubmit);
      results.removeEventListener("scroll", loadMoreIfNearBottom);
      container.replaceChildren();
    };
  }

  function setLabels(next: Partial<ArcGisHubLabels>): void {
    labels = { ...labels, ...next };
    if (panelContainer) {
      disposePanel?.();
      disposePanel = buildPanel(panelContainer);
    }
  }

  const plugin: GeoLibrePlugin = {
    id: config.id,
    name: config.name,
    version: config.version ?? "0.1.0",
    engines: ["maplibre", "cesium", "mapbox", "arcgis"],
    activate: (app) => {
      appRef = app;
      unregisterPanel =
        app.registerRightPanel?.({
          id: panelId,
          title: config.name,
          dock: "replace-style",
          defaultWidth: 360,
          render: (container) => {
            panelContainer = container;
            disposePanel = buildPanel(container);
            return () => {
              disposePanel?.();
              disposePanel = null;
              if (panelContainer === container) panelContainer = null;
            };
          },
        }) ?? null;
      app.openRightPanel?.(panelId);
    },
    deactivate: (app) => {
      app.closeRightPanel?.(panelId);
      disposePanel?.();
      disposePanel = null;
      unregisterPanel?.();
      unregisterPanel = null;
      appRef = null;
    },
  };

  return { plugin, setLabels };
}

const arcGisHub = createArcGisHubPlugin({
  id: ARCGIS_HUB_PLUGIN_ID,
  name: "ArcGIS Hub",
  defaultLabels: DEFAULT_ARCGIS_HUB_LABELS,
});

export const maplibreArcGisHubPlugin: GeoLibrePlugin = arcGisHub.plugin;
export const setArcGisHubLabels = arcGisHub.setLabels;

export default maplibreArcGisHubPlugin;
