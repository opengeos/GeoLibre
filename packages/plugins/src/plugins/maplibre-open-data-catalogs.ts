import type { FeatureCollection } from "geojson";
import type { GeoLibreAppAPI, GeoLibrePlugin } from "../types";

export const SOCRATA_PLUGIN_ID = "maplibre-gl-socrata";
export const CKAN_PLUGIN_ID = "maplibre-gl-ckan";
const FETCH_TIMEOUT_MS = 30_000;
const DOWNLOAD_TIMEOUT_MS = 120_000;

function boundedSignal(signal: AbortSignal, timeoutMs = FETCH_TIMEOUT_MS): AbortSignal {
  return AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
}

interface CatalogItem {
  id: string;
  title: string;
  description: string;
  organization: string;
  dataUrl: string | null;
  pageUrl: string;
}

interface CatalogPage {
  items: CatalogItem[];
  total: number;
}

export interface OpenDataCatalogLabels {
  socrataHint: string;
  ckanHint: string;
  searchPlaceholder: (name: string) => string;
  search: string;
  enterKeyword: string;
  loadMore: string;
  searching: string;
  noResults: string;
  showing: (shown: number, total: number) => string;
  noDescription: string;
  add: string;
  details: string;
  adding: (title: string) => string;
  added: (title: string) => string;
  addError: string;
  searchError: string;
}

let labels: OpenDataCatalogLabels = {
  socrataHint: "Search public Socrata open-data catalogs and add GeoJSON datasets.",
  ckanHint:
    "Search the Humanitarian Data Exchange CKAN catalog and add available GeoJSON resources.",
  searchPlaceholder: (name) => `Search ${name}`,
  search: "Search",
  enterKeyword: "Enter a keyword to begin.",
  loadMore: "Load more",
  searching: "Searching…",
  noResults: "No datasets found.",
  showing: (shown, total) => `Showing ${shown} of ${total} datasets.`,
  noDescription: "No description provided.",
  add: "Add to map",
  details: "Details",
  adding: (title) => `Adding ${title}…`,
  added: (title) => `Added ${title}.`,
  addError: "Could not add dataset.",
  searchError: "Search failed.",
};

export function setOpenDataCatalogLabels(next: Partial<OpenDataCatalogLabels>): void {
  labels = { ...labels, ...next };
}

async function searchSocrata(
  query: string,
  page: number,
  signal: AbortSignal,
): Promise<CatalogPage> {
  const url = new URL("https://api.us.socrata.com/api/catalog/v1");
  url.searchParams.set("search_context", "");
  url.searchParams.set("q", query);
  url.searchParams.set("limit", "20");
  url.searchParams.set("offset", String(page * 20));
  const response = await fetch(url, { signal: boundedSignal(signal) });
  if (!response.ok) throw new Error(`Socrata search failed (${response.status}).`);
  const payload = (await response.json()) as {
    resultSetSize?: number;
    results?: Array<{
      resource?: { id?: string; name?: string; description?: string };
      metadata?: { domain?: string };
      classification?: { domain_category?: string };
      permalink?: string;
    }>;
  };
  const items = (payload.results ?? []).flatMap((entry): CatalogItem[] => {
    const id = entry.resource?.id;
    const domain = entry.metadata?.domain;
    if (!id || !domain) return [];
    return [
      {
        id: `${domain}:${id}`,
        title: entry.resource?.name || id,
        description: entry.resource?.description || "",
        organization: entry.classification?.domain_category || domain,
        dataUrl: `https://${domain}/resource/${encodeURIComponent(id)}.geojson?$limit=50000`,
        pageUrl: entry.permalink || `https://${domain}/d/${encodeURIComponent(id)}`,
      },
    ];
  });
  return { items, total: payload.resultSetSize ?? items.length };
}

async function searchCkan(query: string, page: number, signal: AbortSignal): Promise<CatalogPage> {
  const portal = "https://data.humdata.org";
  const url = new URL("https://tiles.geolibre.app/ckan/search");
  url.searchParams.set("q", query);
  url.searchParams.set("rows", "20");
  url.searchParams.set("start", String(page * 20));
  const response = await fetch(url, { signal: boundedSignal(signal) });
  if (!response.ok) throw new Error(`CKAN search failed (${response.status}).`);
  const payload = (await response.json()) as {
    success?: boolean;
    result?: {
      count?: number;
      results?: Array<{
        id?: string;
        name?: string;
        title?: string;
        notes?: string;
        organization?: { title?: string };
        resources?: Array<{ url?: string; format?: string; mimetype?: string }>;
      }>;
    };
  };
  if (!payload.success) throw new Error("CKAN returned an unsuccessful response.");
  const items = (payload.result?.results ?? []).flatMap((entry): CatalogItem[] => {
    if (!entry.id) return [];
    const resource = entry.resources?.find((candidate) =>
      /geojson|json/i.test(`${candidate.format ?? ""} ${candidate.mimetype ?? ""}`),
    );
    return [
      {
        id: entry.id,
        title: entry.title || entry.name || entry.id,
        description: entry.notes || "",
        organization: entry.organization?.title || "CKAN",
        dataUrl: resource?.url ?? null,
        pageUrl: `${portal}/dataset/${encodeURIComponent(entry.name || entry.id)}`,
      },
    ];
  });
  return { items, total: payload.result?.count ?? items.length };
}

function createCatalogPlugin(options: {
  id: string;
  name: string;
  hint: () => string;
  search: (query: string, page: number, signal: AbortSignal) => Promise<CatalogPage>;
}): GeoLibrePlugin {
  let unregister: (() => void) | null = null;
  let dispose: (() => void) | null = null;

  return {
    id: options.id,
    name: options.name,
    version: "0.1.0",
    activate(app) {
      unregister =
        app.registerRightPanel?.({
          id: options.id,
          title: options.name,
          dock: "right-of-style",
          defaultWidth: 360,
          render(container) {
            container.replaceChildren();
            const panel = document.createElement("div");
            panel.style.cssText =
              "display:flex;flex-direction:column;gap:8px;padding:8px;height:100%;box-sizing:border-box;font-size:12px;color:hsl(var(--foreground))";
            const hint = document.createElement("p");
            hint.textContent = options.hint();
            hint.style.cssText = "margin:0;color:hsl(var(--muted-foreground))";
            const form = document.createElement("form");
            form.style.cssText = "display:flex;gap:6px";
            const input = document.createElement("input");
            input.type = "search";
            input.placeholder = labels.searchPlaceholder(options.name);
            input.ariaLabel = input.placeholder;
            input.style.cssText =
              "min-width:0;flex:1;padding:6px 8px;border:1px solid hsl(var(--border));border-radius:6px;background:hsl(var(--background));color:hsl(var(--foreground))";
            const submit = document.createElement("button");
            submit.type = "submit";
            submit.textContent = labels.search;
            submit.style.cssText =
              "padding:6px 10px;border:1px solid hsl(var(--primary));border-radius:6px;background:hsl(var(--primary));color:hsl(var(--primary-foreground));cursor:pointer";
            form.append(input, submit);
            const status = document.createElement("div");
            status.textContent = labels.enterKeyword;
            status.style.cssText = "font-size:11px;color:hsl(var(--muted-foreground))";
            const results = document.createElement("div");
            results.style.cssText =
              "display:flex;flex:1;min-height:0;overflow:auto;flex-direction:column;gap:6px";
            const more = document.createElement("button");
            more.type = "button";
            more.textContent = labels.loadMore;
            more.hidden = true;
            panel.append(hint, form, status, results, more);
            container.append(panel);

            let page = 0;
            let shown = 0;
            let total = 0;
            let activeQuery = "";
            let controller: AbortController | null = null;
            let generation = 0;
            let active = true;
            const downloads = new Set<AbortController>();

            const render = (item: CatalogItem) => {
              const card = document.createElement("article");
              card.style.cssText =
                "padding:8px;border:1px solid hsl(var(--border));border-radius:6px;background:hsl(var(--muted))";
              const title = document.createElement("strong");
              title.textContent = item.title;
              const meta = document.createElement("div");
              meta.textContent = item.organization;
              meta.style.cssText = "font-size:10px;color:hsl(var(--muted-foreground))";
              const description = document.createElement("p");
              description.textContent = item.description || labels.noDescription;
              description.style.cssText = "margin:5px 0;font-size:11px";
              const actions = document.createElement("div");
              actions.style.cssText = "display:flex;gap:5px";
              const add = document.createElement("button");
              add.type = "button";
              add.textContent = labels.add;
              add.disabled = !item.dataUrl;
              add.addEventListener("click", async () => {
                if (!item.dataUrl) return;
                const downloadController = new AbortController();
                downloads.add(downloadController);
                add.disabled = true;
                status.textContent = labels.adding(item.title);
                try {
                  const response = await fetch(item.dataUrl, {
                    signal: boundedSignal(downloadController.signal, DOWNLOAD_TIMEOUT_MS),
                  });
                  if (!response.ok) throw new Error(`Download failed (${response.status}).`);
                  const data = (await response.json()) as FeatureCollection;
                  if (data.type !== "FeatureCollection" || !Array.isArray(data.features)) {
                    throw new Error("The resource is not GeoJSON.");
                  }
                  if (!active) return;
                  app.addGeoJsonLayer(item.title, data, item.dataUrl);
                  status.textContent = labels.added(item.title);
                } catch (error) {
                  if (active && (error as Error).name !== "AbortError") {
                    status.textContent = labels.addError;
                  }
                } finally {
                  downloads.delete(downloadController);
                  if (active) add.disabled = !item.dataUrl;
                }
              });
              const details = document.createElement("button");
              details.type = "button";
              details.textContent = labels.details;
              details.addEventListener("click", () => app.openExternalUrl?.(item.pageUrl));
              actions.append(add, details);
              card.append(title, meta, description, actions);
              results.append(card);
            };

            const run = async (append: boolean) => {
              const query = append ? activeQuery : input.value.trim();
              if (!query) return;
              if (!append) {
                activeQuery = query;
                page = 0;
                shown = 0;
                results.replaceChildren();
                more.hidden = true;
              }
              controller?.abort();
              controller = new AbortController();
              const token = ++generation;
              submit.disabled = true;
              status.textContent = labels.searching;
              try {
                const result = await options.search(query, page, controller.signal);
                if (token !== generation) return;
                result.items.forEach(render);
                shown += result.items.length;
                total = result.total;
                page += 1;
                status.textContent = shown ? labels.showing(shown, total) : labels.noResults;
                more.hidden = shown >= total || result.items.length === 0;
              } catch (error) {
                if ((error as Error).name !== "AbortError") {
                  status.textContent = labels.searchError;
                }
              } finally {
                if (token === generation) submit.disabled = false;
              }
            };
            const onSubmit = (event: SubmitEvent) => {
              event.preventDefault();
              void run(false);
            };
            form.addEventListener("submit", onSubmit);
            more.addEventListener("click", () => void run(true));
            input.focus();
            const cleanup = () => {
              active = false;
              controller?.abort();
              downloads.forEach((download) => download.abort());
              downloads.clear();
              container.replaceChildren();
            };
            dispose = cleanup;
            // The shell holds its own reference to this cleanup and runs it when
            // the panel unmounts, which deactivate() triggers via closeRightPanel.
            // Null the module-level handle first so deactivate() cannot run it twice.
            return () => {
              dispose = null;
              cleanup();
            };
          },
        }) ?? null;
      app.openRightPanel?.(options.id);
    },
    deactivate(app: GeoLibreAppAPI) {
      app.closeRightPanel?.(options.id);
      dispose?.();
      dispose = null;
      unregister?.();
      unregister = null;
    },
  };
}

export const maplibreSocrataPlugin = createCatalogPlugin({
  id: SOCRATA_PLUGIN_ID,
  name: "Socrata",
  hint: () => labels.socrataHint,
  search: searchSocrata,
});

export const maplibreCkanPlugin = createCatalogPlugin({
  id: CKAN_PLUGIN_ID,
  name: "CKAN",
  hint: () => labels.ckanHint,
  search: searchCkan,
});
