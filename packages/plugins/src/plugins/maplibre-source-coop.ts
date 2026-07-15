/**
 * Source Cooperative browser (Plugins > Web Services).
 *
 * A right panel that searches Source Cooperative (https://source.coop), browses
 * a product's files, and puts them on the map or downloads them. The API client
 * it drives lives in `source-coop-api.ts`; that module's comment explains the
 * two constraints that shape this one:
 *
 *  - the metadata API sends no CORS headers, so reads go through the tiles
 *    Worker on web and over native HTTP on desktop (see {@link clientOptions});
 *  - there is no search endpoint, so the panel fetches a catalog once and
 *    filters it client-side, and resolves `account/product` queries directly.
 *
 * Adding a layer deliberately delegates to the controls that already know each
 * format — `addPMTilesLayerFromUrl` for PMTiles, `addVectorLayerFromUrl` for
 * GeoParquet and friends, `app.addCogLayer` for COG — so Source Cooperative
 * data lands in the Layers panel, styles, and persists exactly like the same
 * file added by hand through Add Data.
 *
 * `createSourceCoopPlugin` also backs the **Natural Earth** entry in the same
 * menu, as this panel pinned to `opengeos/natural-earth`. A pinned panel drops
 * the catalog and search and opens straight into the product's files, but is
 * otherwise this browser exactly — so its layer list is the live bucket listing
 * and there is no second catalog to keep in step.
 */

import { useAppStore } from "@geolibre/core";
import type { GeoLibreAppAPI, GeoLibrePlugin } from "../types";
import { addPMTilesLayerFromUrl } from "./maplibre-components";
import { addVectorLayerFromUrl } from "./maplibre-vector";
import {
  fetchAccountProducts,
  fetchCatalog,
  fetchProduct,
  filterProducts,
  formatBytes,
  HTTP_URL_RE,
  isAddable,
  listProductObjects,
  parseProductRef,
  SOURCE_COOP_API_BASE,
  SOURCE_COOP_FEED_URL,
  SOURCE_COOP_PROXY_ENDPOINT,
  synthesizeProduct,
  type SourceCoopClientOptions,
  type SourceCoopFetch,
  type SourceCoopFormat,
  type SourceCoopObject,
  type SourceCoopProduct,
} from "./source-coop-api";

export const SOURCE_COOP_PLUGIN_ID = "maplibre-gl-source-coop";

/** User-facing strings. The host pushes translations in via {@link setSourceCoopLabels}. */
export interface SourceCoopLabels {
  hint: string;
  searchPlaceholder: string;
  search: string;
  searching: string;
  loading: string;
  loadError: (message: string) => string;
  noResults: string;
  retry: string;
  featured: string;
  showing: (shown: number, total: number) => string;
  browseAccount: (account: string) => string;
  back: string;
  files: string;
  noFiles: string;
  loadingFiles: string;
  loadMore: string;
  parent: string;
  add: string;
  adding: string;
  added: string;
  remove: string;
  download: string;
  copyUrl: string;
  copied: string;
  openProduct: string;
  addTitle: string;
  removeTitle: string;
  downloadTitle: string;
  copyUrlTitle: string;
  openProductTitle: string;
  unsupportedTitle: string;
  addError: (message: string) => string;
  largeFileWarning: (size: string) => string;
}

export const DEFAULT_SOURCE_COOP_LABELS: SourceCoopLabels = {
  hint: "Search Source Cooperative for open geospatial data, or enter an account/product id.",
  searchPlaceholder: "Search data, or account/product",
  search: "Search",
  searching: "Searching…",
  loading: "Loading catalog…",
  loadError: (message) =>
    `Could not reach Source Cooperative: ${message}. Please try again.`,
  noResults: "No matching products.",
  retry: "Retry",
  featured: "Featured",
  showing: (shown, total) => `Showing ${shown} of ${total} products.`,
  browseAccount: (account) => `Browse all ${account} products`,
  back: "Back",
  files: "Files",
  noFiles: "No files in this folder.",
  loadingFiles: "Loading files…",
  loadMore: "Load more",
  parent: "Up one level",
  add: "Add",
  adding: "Adding…",
  added: "Added",
  remove: "Remove",
  download: "Download",
  copyUrl: "Copy URL",
  copied: "Copied",
  openProduct: "Open on source.coop",
  addTitle: "Add this file to the map",
  removeTitle: "Remove this file from the map",
  downloadTitle: "Download this file",
  copyUrlTitle: "Copy this file's URL",
  openProductTitle: "Open this product's page on source.coop",
  unsupportedTitle: "GeoLibre cannot render this format — download it instead",
  addError: (message) => `Could not add this file: ${message}`,
  largeFileWarning: (size) =>
    `This file is ${size}. It streams from the source, so only the parts in view are read.`,
};

let labels: SourceCoopLabels = { ...DEFAULT_SOURCE_COOP_LABELS };

// The theme tokens are HSL channel triplets (shadcn convention), so they must be
// wrapped in hsl(); using them bare yields an invalid value that drops the rule.
// Spacing uses logical properties (inline-start/-end) so the panel mirrors
// correctly in right-to-left locales.
const CSS = {
  panel:
    "display:flex;flex-direction:column;gap:8px;padding:8px;font-size:12px;" +
    "height:100%;box-sizing:border-box;color:hsl(var(--foreground));",
  hint: "font-size:11px;color:hsl(var(--muted-foreground));line-height:1.4;",
  searchRow: "display:flex;gap:4px;",
  input:
    "flex:1 1 auto;min-width:0;box-sizing:border-box;padding:5px 8px;" +
    "font-size:12px;border-radius:6px;border:1px solid hsl(var(--border));" +
    "background:hsl(var(--background));color:hsl(var(--foreground));",
  primaryButton:
    "padding:5px 10px;border-radius:6px;border:1px solid hsl(var(--primary));" +
    "background:hsl(var(--primary));color:hsl(var(--primary-foreground));" +
    "font-size:12px;cursor:pointer;white-space:nowrap;",
  secondaryButton:
    "width:100%;padding:6px 10px;border-radius:6px;" +
    "border:1px solid hsl(var(--border));background:hsl(var(--background));" +
    "color:hsl(var(--foreground));font-size:12px;cursor:pointer;",
  status: "font-size:11px;color:hsl(var(--muted-foreground));line-height:1.4;",
  error:
    "font-size:11px;color:hsl(var(--destructive));line-height:1.4;" +
    "word-break:break-word;",
  list:
    "display:flex;flex-direction:column;gap:6px;flex:1 1 auto;min-height:0;" +
    "overflow-y:auto;",
  card:
    "display:flex;flex-direction:column;gap:4px;padding:6px;border-radius:6px;" +
    "border:1px solid hsl(var(--border));background:hsl(var(--muted));",
  cardButton:
    "display:flex;flex-direction:column;gap:4px;padding:6px;border-radius:6px;" +
    "border:1px solid hsl(var(--border));background:hsl(var(--muted));" +
    "color:hsl(var(--foreground));text-align:start;cursor:pointer;font:inherit;",
  title: "font-size:12px;font-weight:600;line-height:1.3;",
  titleRow: "display:flex;align-items:baseline;gap:6px;",
  sub:
    "font-size:10px;color:hsl(var(--muted-foreground));white-space:nowrap;" +
    "overflow:hidden;text-overflow:ellipsis;",
  desc:
    "font-size:11px;color:hsl(var(--muted-foreground));line-height:1.4;" +
    "display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;" +
    "overflow:hidden;",
  tagRow: "display:flex;gap:4px;flex-wrap:wrap;",
  tag:
    "font-size:9px;padding:1px 5px;border-radius:999px;" +
    "background:hsl(var(--accent));color:hsl(var(--accent-foreground));",
  badge:
    "font-size:9px;padding:1px 5px;border-radius:999px;flex:0 0 auto;" +
    "background:hsl(var(--primary));color:hsl(var(--primary-foreground));",
  formatBadge:
    "font-size:9px;padding:1px 5px;border-radius:4px;flex:0 0 auto;" +
    "background:hsl(var(--accent));color:hsl(var(--accent-foreground));" +
    "text-transform:uppercase;letter-spacing:0.03em;",
  actions: "display:flex;gap:4px;flex-wrap:wrap;",
  action:
    "padding:2px 8px;font-size:11px;border-radius:4px;cursor:pointer;" +
    "border:1px solid hsl(var(--border));background:hsl(var(--background));" +
    "color:hsl(var(--foreground));",
  actionActive:
    "padding:2px 8px;font-size:11px;border-radius:4px;cursor:pointer;" +
    "border:1px solid hsl(var(--primary));background:hsl(var(--primary));" +
    "color:hsl(var(--primary-foreground));",
  header: "display:flex;flex-direction:column;gap:4px;",
  crumbs:
    "font-size:10px;color:hsl(var(--muted-foreground));word-break:break-all;",
} as const;

/**
 * Rebuild callbacks for the panels currently mounted, so a language change can
 * repaint each in place (see {@link setSourceCoopLabels}). A set rather than a
 * single slot because this panel is mounted more than once: the Natural Earth
 * plugin reuses it pinned to one product (see {@link createSourceCoopPlugin}).
 */
const mountedPanels = new Set<() => void>();

/**
 * The catalog, cached across panel opens. Fetching it costs two network reads
 * and it changes only when products are published, so re-fetching on every
 * open would be pure latency for the user.
 */
let catalog: SourceCoopProduct[] | null = null;
/** Products discovered by browsing an account or resolving an id, merged into search. */
const extraProducts = new Map<string, SourceCoopProduct>();

function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/**
 * Reads the metadata API the way this build can.
 *
 * Desktop goes straight to source.coop over Tauri's native HTTP, which is not
 * subject to CORS and keeps the query on-device. Web, dev, and embed builds go
 * through the tiles Worker, which re-emits the JSON with CORS — source.coop
 * sends none, so a direct browser fetch is blocked outright.
 */
function clientOptions(
  app: GeoLibreAppAPI | null,
  signal?: AbortSignal,
): SourceCoopClientOptions {
  const fetchArrayBuffer = app?.fetchArrayBuffer;
  if (isTauri() && fetchArrayBuffer) {
    const fetchImpl: SourceCoopFetch = async (url) => {
      const buffer = await fetchArrayBuffer(url);
      const body = new TextDecoder().decode(buffer);
      // fetchArrayBuffer rejects on a non-2xx, so reaching here means success.
      return { ok: true, status: 200, text: async () => body };
    };
    return {
      endpoint: SOURCE_COOP_API_BASE,
      feedUrl: SOURCE_COOP_FEED_URL,
      fetchImpl,
      signal,
    };
  }
  return { endpoint: SOURCE_COOP_PROXY_ENDPOINT, signal };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** True when an error is just an aborted in-flight request, not a failure. */
function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  style: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.style.cssText = style;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(text: string, style: string, title?: string): HTMLButtonElement {
  const node = el("button", style, text);
  node.type = "button";
  if (title) node.title = title;
  return node;
}

/**
 * Finds the store layer backing a file, if it is already on the map. Derived
 * from the store rather than remembered in module state so the Add/Remove
 * button stays correct across a project reload, and after the user removes the
 * layer from the Layers panel.
 */
function findAddedLayerId(object: SourceCoopObject): string | undefined {
  return useAppStore
    .getState()
    .layers.find((layer) => layer.sourcePath === object.url)?.id;
}

function isAdded(object: SourceCoopObject): boolean {
  return findAddedLayerId(object) !== undefined;
}

/**
 * Puts one file on the map, routing by format to the control that already
 * handles it (see the module comment). Returns false when the format has no
 * renderer, which the caller renders as download-only.
 */
async function addObjectToMap(
  app: GeoLibreAppAPI | null,
  object: SourceCoopObject,
): Promise<boolean> {
  // The URL is built by buildObjectUrl from an https base, but re-check at the
  // point it becomes a map source so this security-sensitive step stands alone.
  if (!app || !HTTP_URL_RE.test(object.url)) return false;

  switch (object.format) {
    case "pmtiles":
      return addPMTilesLayerFromUrl(app, object.url);
    case "cog":
      if (!app.addCogLayer) return false;
      await app.addCogLayer(object.name, object.url);
      return true;
    case "geoparquet":
    case "geojson":
    case "flatgeobuf":
    case "gpkg":
    case "csv":
      return addVectorLayerFromUrl(app, object.url, { name: object.name });
    default:
      return false;
  }
}

/**
 * Triggers a browser download of a file.
 *
 * `data.source.coop` is a different origin and sends no `Content-Disposition`,
 * so the `download` attribute below is advisory only — the spec has browsers
 * ignore it cross-origin. The download still happens, because the objects
 * offered here are served as `octet-stream` (or another type the browser will
 * not render), and the saved name matches `object.name` anyway since that is
 * the URL's own last segment. The attribute is kept for the same-origin case.
 *
 * Routing this through a proxy to force `Content-Disposition: attachment` would
 * mean streaming whole archives (100+ GB for some products) through the tiles
 * Worker, so the direct link is deliberate.
 */
function downloadObject(object: SourceCoopObject): void {
  // Re-checked here because this value becomes an `<a href>`: it blocks a
  // `javascript:`/`data:` URL from ever reaching a click.
  if (!HTTP_URL_RE.test(object.url)) return;
  const link = document.createElement("a");
  link.href = object.url;
  link.download = object.name;
  link.target = "_blank";
  link.rel = "noopener";
  link.style.display = "none";
  document.body.appendChild(link);
  link.click();
  link.remove();
}

/** Formats a file's secondary line: size, then date when known. */
function objectSubtitle(object: SourceCoopObject): string {
  const size = formatBytes(object.size);
  if (!object.lastModified) return size;
  const date = new Date(object.lastModified);
  return Number.isNaN(date.getTime())
    ? size
    : `${size} · ${date.toLocaleDateString()}`;
}

/** Files at or above this size get a note that they stream rather than download. */
const LARGE_FILE_BYTES = 2 * 1024 ** 3;

function formatLabel(format: SourceCoopFormat): string {
  return format === "other" ? "file" : format;
}

/**
 * Builds the panel DOM.
 *
 * All view state lives in this closure, so the panel is self-contained and
 * `mountPanel` can rebuild it wholesale on a language change.
 */
function buildPanel(
  container: HTMLElement,
  app: GeoLibreAppAPI | null,
  pinned?: SourceCoopPinnedProduct,
): () => void {
  type View =
    | { kind: "browse" }
    | { kind: "product"; product: SourceCoopProduct; prefix: string };

  // A pinned panel skips the catalog entirely and opens straight into its
  // product, which is why the record is synthesized rather than fetched: the
  // file listing needs only `accountId`/`productId`, and those are known. The
  // metadata API is consulted afterwards purely to enrich the title and
  // description (see `enrichPinnedProduct`), so the panel still works when that
  // API — or the Worker proxy in front of it — is unreachable.
  let view: View = pinned
    ? {
        kind: "product",
        product: synthesizeProduct(pinned.accountId, pinned.productId, pinned.title),
        prefix: `${pinned.productId}/`,
      }
    : { kind: "browse" };
  let query = "";
  let status = "";
  let error = "";
  let busy = false;

  // Files for the current product view, appended across "Load more" pages.
  let objects: SourceCoopObject[] = [];
  let folders: string[] = [];
  let nextToken: string | null = null;
  let filesLoading = false;

  // Ignore results from a superseded request, and cancel the in-flight one.
  let generation = 0;
  let inflight: AbortController | null = null;
  // The pinned enrichment fetch runs *alongside* the first `loadFiles()` call,
  // so it cannot share `inflight`: `beginRequest()` would abort the file
  // listing it races. It gets its own controller, torn down with the rest.
  let enrichInflight: AbortController | null = null;
  const addInFlight = new Set<string>();

  const root = el("div", CSS.panel);
  container.appendChild(root);

  function beginRequest(): { signal: AbortSignal; token: number } {
    inflight?.abort();
    inflight = new AbortController();
    generation += 1;
    return { signal: inflight.signal, token: generation };
  }

  /** Everything searchable: the cached catalog plus anything browsed since. */
  function searchableProducts(): SourceCoopProduct[] {
    const products = [...(catalog ?? [])];
    const seen = new Set(products.map((p) => `${p.accountId}/${p.productId}`));
    for (const [id, product] of extraProducts) {
      if (!seen.has(id)) products.push(product);
    }
    return products;
  }

  async function loadCatalog(): Promise<void> {
    if (catalog) return;
    const { signal, token } = beginRequest();
    busy = true;
    error = "";
    status = labels.loading;
    render();
    try {
      const products = await fetchCatalog(clientOptions(app, signal));
      if (token !== generation) return;
      catalog = products;
      status = "";
    } catch (caught) {
      if (isAbort(caught) || token !== generation) return;
      error = labels.loadError(errorMessage(caught));
      status = "";
    } finally {
      if (token === generation) {
        busy = false;
        render();
      }
    }
  }

  /**
   * Runs a search. A query shaped like `account/product` is resolved against
   * the API first — that is the only way to reach a product outside the
   * catalog, since no search endpoint exists (see source-coop-api.ts).
   */
  async function runSearch(): Promise<void> {
    const ref = parseProductRef(query);
    if (!ref) {
      await loadCatalog();
      render();
      return;
    }
    const id = `${ref.accountId}/${ref.productId}`;
    if (
      catalog?.some((p) => `${p.accountId}/${p.productId}` === id) ||
      extraProducts.has(id)
    ) {
      await loadCatalog();
      render();
      return;
    }
    const { signal, token } = beginRequest();
    busy = true;
    error = "";
    status = labels.searching;
    render();
    try {
      const product = await fetchProduct(
        ref.accountId,
        ref.productId,
        clientOptions(app, signal),
      );
      if (token !== generation) return;
      if (product) extraProducts.set(id, product);
      status = "";
      // A miss is not an error: the id may simply not exist, and the catalog
      // filter below will say "no matching products" on its own.
      if (!catalog) await loadCatalog();
    } catch (caught) {
      if (isAbort(caught) || token !== generation) return;
      error = labels.loadError(errorMessage(caught));
      status = "";
    } finally {
      if (token === generation) {
        busy = false;
        render();
      }
    }
  }

  async function openAccount(accountId: string): Promise<void> {
    const { signal, token } = beginRequest();
    busy = true;
    error = "";
    status = labels.searching;
    render();
    try {
      const products = await fetchAccountProducts(
        accountId,
        clientOptions(app, signal),
      );
      if (token !== generation) return;
      for (const product of products) {
        extraProducts.set(`${product.accountId}/${product.productId}`, product);
      }
      query = `${accountId}/`;
      status = "";
    } catch (caught) {
      if (isAbort(caught) || token !== generation) return;
      error = labels.loadError(errorMessage(caught));
      status = "";
    } finally {
      if (token === generation) {
        busy = false;
        render();
      }
    }
  }

  /**
   * Loads one page of files for the current product view. `append` continues a
   * truncated listing; otherwise the list is replaced.
   */
  async function loadFiles(append = false): Promise<void> {
    if (view.kind !== "product") return;
    const { product, prefix } = view;
    const { signal, token } = beginRequest();
    filesLoading = true;
    error = "";
    render();
    try {
      const listing = await listProductObjects(
        {
          accountId: product.accountId,
          prefix,
          token: append ? nextToken : null,
        },
        undefined,
        signal,
      );
      if (token !== generation) return;
      objects = append ? [...objects, ...listing.objects] : listing.objects;
      folders = append ? folders : listing.folders;
      nextToken = listing.nextToken;
    } catch (caught) {
      if (isAbort(caught) || token !== generation) return;
      error = labels.loadError(errorMessage(caught));
    } finally {
      if (token === generation) {
        filesLoading = false;
        render();
      }
    }
  }

  function openProduct(product: SourceCoopProduct): void {
    view = { kind: "product", product, prefix: `${product.productId}/` };
    objects = [];
    folders = [];
    nextToken = null;
    void loadFiles();
    render();
  }

  function openPrefix(prefix: string): void {
    if (view.kind !== "product") return;
    view = { ...view, prefix };
    objects = [];
    folders = [];
    nextToken = null;
    void loadFiles();
    render();
  }

  async function handleAdd(object: SourceCoopObject): Promise<void> {
    const existing = findAddedLayerId(object);
    if (existing) {
      useAppStore.getState().removeLayer(existing);
      render();
      return;
    }
    addInFlight.add(object.key);
    error = "";
    render();
    try {
      const added = await addObjectToMap(app, object);
      if (!added) error = labels.addError(labels.unsupportedTitle);
    } catch (caught) {
      error = labels.addError(errorMessage(caught));
    } finally {
      addInFlight.delete(object.key);
      render();
    }
  }

  function renderProductCard(product: SourceCoopProduct): HTMLElement {
    const card = el("button", CSS.cardButton);
    card.type = "button";
    card.addEventListener("click", () => openProduct(product));

    const titleRow = el("div", CSS.titleRow);
    titleRow.appendChild(el("span", CSS.title, product.title));
    if (product.featured) {
      titleRow.appendChild(el("span", CSS.badge, labels.featured));
    }
    card.appendChild(titleRow);
    card.appendChild(
      el("div", CSS.sub, `${product.accountId}/${product.productId}`),
    );
    if (product.description) {
      card.appendChild(el("div", CSS.desc, product.description));
    }
    if (product.tags.length > 0) {
      const tagRow = el("div", CSS.tagRow);
      for (const tag of product.tags.slice(0, 6)) {
        tagRow.appendChild(el("span", CSS.tag, tag));
      }
      card.appendChild(tagRow);
    }
    return card;
  }

  function renderObjectCard(object: SourceCoopObject): HTMLElement {
    const card = el("div", CSS.card);

    const titleRow = el("div", CSS.titleRow);
    const name = el("span", CSS.title, object.name);
    name.style.overflow = "hidden";
    name.style.textOverflow = "ellipsis";
    name.style.whiteSpace = "nowrap";
    titleRow.appendChild(name);
    titleRow.appendChild(el("span", CSS.formatBadge, formatLabel(object.format)));
    card.appendChild(titleRow);
    card.appendChild(el("div", CSS.sub, objectSubtitle(object)));

    if (isAddable(object.format) && object.size >= LARGE_FILE_BYTES) {
      card.appendChild(
        el("div", CSS.sub, labels.largeFileWarning(formatBytes(object.size))),
      );
    }

    const actions = el("div", CSS.actions);
    if (isAddable(object.format)) {
      const added = isAdded(object);
      const pending = addInFlight.has(object.key);
      const addButton = button(
        pending ? labels.adding : added ? labels.remove : labels.add,
        added ? CSS.actionActive : CSS.action,
        added ? labels.removeTitle : labels.addTitle,
      );
      addButton.disabled = pending;
      addButton.addEventListener("click", () => void handleAdd(object));
      actions.appendChild(addButton);
    }

    const downloadButton = button(
      labels.download,
      CSS.action,
      isAddable(object.format) ? labels.downloadTitle : labels.unsupportedTitle,
    );
    downloadButton.addEventListener("click", () => downloadObject(object));
    actions.appendChild(downloadButton);

    const copyButton = button(labels.copyUrl, CSS.action, labels.copyUrlTitle);
    copyButton.addEventListener("click", () => {
      void navigator.clipboard?.writeText(object.url).then(() => {
        copyButton.textContent = labels.copied;
        window.setTimeout(() => {
          copyButton.textContent = labels.copyUrl;
        }, 1500);
      });
    });
    actions.appendChild(copyButton);

    card.appendChild(actions);
    return card;
  }

  function renderBrowse(): void {
    const hint = el("div", CSS.hint, labels.hint);
    root.appendChild(hint);

    const searchRow = el("div", CSS.searchRow);
    const input = el("input", CSS.input);
    input.type = "search";
    input.placeholder = labels.searchPlaceholder;
    input.value = query;
    input.addEventListener("input", () => {
      query = input.value;
      // Filtering is local, so re-render as the user types; only an
      // `account/product` id needs the network, and that waits for Enter.
      renderResults();
    });
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") void runSearch();
    });
    searchRow.appendChild(input);

    const searchButton = button(labels.search, CSS.primaryButton);
    searchButton.addEventListener("click", () => void runSearch());
    searchRow.appendChild(searchButton);
    root.appendChild(searchRow);

    const statusNode = el("div", CSS.status);
    root.appendChild(statusNode);
    const errorNode = el("div", CSS.error);
    root.appendChild(errorNode);
    const list = el("div", CSS.list);
    root.appendChild(list);

    function renderResults(): void {
      const all = searchableProducts();
      const matches = filterProducts(all, query);
      list.replaceChildren();

      statusNode.textContent = busy
        ? status || labels.searching
        : all.length === 0
          ? ""
          : labels.showing(matches.length, all.length);
      errorNode.textContent = error;
      errorNode.style.display = error ? "" : "none";

      if (error && all.length === 0) {
        const retry = button(labels.retry, CSS.secondaryButton);
        retry.addEventListener("click", () => {
          catalog = null;
          void loadCatalog();
        });
        list.appendChild(retry);
        return;
      }
      if (busy && all.length === 0) return;
      if (matches.length === 0) {
        list.appendChild(el("div", CSS.status, labels.noResults));
      }
      for (const product of matches) list.appendChild(renderProductCard(product));

      // A query naming an account the catalog only partly covers can pull in
      // that account's full product list — the one bulk listing the API offers.
      const ref = query.trim().replace(/\/.*$/, "");
      if (ref && /^[a-z0-9][a-z0-9-_.]*$/i.test(ref) && !busy) {
        const known = all.some((p) => p.accountId === ref);
        if (known || matches.length === 0) {
          const more = button(labels.browseAccount(ref), CSS.secondaryButton);
          more.addEventListener("click", () => void openAccount(ref));
          list.appendChild(more);
        }
      }
    }

    // Attached so later state changes can repaint just the results.
    renderCurrentView = renderResults;
    renderResults();
  }

  function renderProduct(product: SourceCoopProduct, prefix: string): void {
    const header = el("div", CSS.header);
    // A pinned panel has no catalog behind it, so Back would lead nowhere; the
    // "Up one level" control below still walks back out of subfolders.
    if (!pinned) {
      const back = button(labels.back, CSS.secondaryButton);
      back.addEventListener("click", () => {
        view = { kind: "browse" };
        render();
      });
      header.appendChild(back);
    }
    header.appendChild(el("div", CSS.title, product.title));
    header.appendChild(
      el("div", CSS.sub, `${product.accountId}/${product.productId}`),
    );
    if (product.description) {
      header.appendChild(el("div", CSS.desc, product.description));
    }

    const open = button(labels.openProduct, CSS.action, labels.openProductTitle);
    open.addEventListener("click", () => {
      window.open(product.url, "_blank", "noopener");
    });
    const openRow = el("div", CSS.actions);
    openRow.appendChild(open);
    header.appendChild(openRow);
    root.appendChild(header);

    // Everything after the product root, so the crumb reads as a path inside
    // the product rather than repeating its id.
    const relative = prefix.slice(`${product.productId}/`.length);
    root.appendChild(el("div", CSS.crumbs, `/${relative}`));

    const errorNode = el("div", CSS.error, error);
    errorNode.style.display = error ? "" : "none";
    root.appendChild(errorNode);

    const list = el("div", CSS.list);
    root.appendChild(list);

    function renderFiles(): void {
      list.replaceChildren();
      errorNode.textContent = error;
      errorNode.style.display = error ? "" : "none";

      if (relative) {
        const up = button(labels.parent, CSS.secondaryButton);
        up.addEventListener("click", () => {
          const segments = prefix.replace(/\/$/, "").split("/");
          segments.pop();
          openPrefix(`${segments.join("/")}/`);
        });
        list.appendChild(up);
      }

      for (const folder of folders) {
        const name = folder.replace(/\/$/, "").split("/").pop() ?? folder;
        const card = el("button", CSS.cardButton);
        card.type = "button";
        card.appendChild(el("span", CSS.title, `${name}/`));
        card.addEventListener("click", () => openPrefix(folder));
        list.appendChild(card);
      }

      for (const object of objects) list.appendChild(renderObjectCard(object));

      if (filesLoading) {
        list.appendChild(el("div", CSS.status, labels.loadingFiles));
      } else if (objects.length === 0 && folders.length === 0) {
        list.appendChild(el("div", CSS.status, labels.noFiles));
      }

      if (nextToken && !filesLoading) {
        const more = button(labels.loadMore, CSS.secondaryButton);
        more.addEventListener("click", () => void loadFiles(true));
        list.appendChild(more);
      }
    }

    renderCurrentView = renderFiles;
    renderFiles();
  }

  // Set by whichever view is mounted, so state changes repaint the list in
  // place instead of rebuilding the whole panel (which would drop input focus).
  let renderCurrentView: () => void = () => {};

  function render(): void {
    root.replaceChildren();
    if (view.kind === "browse") renderBrowse();
    else renderProduct(view.product, view.prefix);
  }

  /**
   * Replaces a pinned panel's synthesized product record with the real one, so
   * the header shows the published title and description instead of the
   * fallback. Best-effort: `fetchProduct` already resolves to null rather than
   * throwing, and a miss simply leaves the synthesized record in place — the
   * file listing never depended on this.
   */
  async function enrichPinnedProduct(): Promise<void> {
    if (!pinned) return;
    const controller = new AbortController();
    enrichInflight = controller;
    const product = await fetchProduct(
      pinned.accountId,
      pinned.productId,
      clientOptions(app, controller.signal),
    );
    // The panel was torn down (or rebuilt for a language change) while this was
    // in flight — `root` is detached, so rendering into it would be wasted work.
    // Checked explicitly rather than relying on the abort: `fetchProduct` maps a
    // rejection to null, so an abort that lands mid-flight is already handled
    // below, but one that lands after the fetch resolves is not.
    if (controller.signal.aborted) return;
    // The user may have navigated into a subfolder meanwhile, so keep the
    // current prefix and swap only the record.
    if (!product || view.kind !== "product") return;
    view = { ...view, product };
    render();
  }

  render();
  if (pinned) {
    void loadFiles();
    void enrichPinnedProduct();
  } else {
    void loadCatalog();
  }

  // Repaint when the layer store changes, so Add/Remove reflects a layer the
  // user removed from the Layers panel. Guarded on the layers array identity so
  // unrelated store writes (basemap, view state) do not repaint the list.
  const unsubscribe = useAppStore.subscribe((state, previous) => {
    if (state.layers !== previous.layers) renderCurrentView();
  });

  return () => {
    inflight?.abort();
    inflight = null;
    enrichInflight?.abort();
    enrichInflight = null;
    unsubscribe?.();
    root.remove();
  };
}

/**
 * Replaces the panels' user-facing strings. The host calls this with
 * translations on activation and every language change; any open panel is
 * rebuilt so the new strings take effect immediately.
 */
export function setSourceCoopLabels(next: Partial<SourceCoopLabels>): void {
  labels = { ...labels, ...next };
  for (const remount of mountedPanels) remount();
}

/** A product this panel opens directly into, instead of the catalog. */
export interface SourceCoopPinnedProduct {
  accountId: string;
  productId: string;
  /** Fallback title, shown until the metadata API supplies the published one. */
  title: string;
}

interface SourceCoopPluginConfig {
  id: string;
  /** Plugin and panel display name. */
  name: string;
  /** When set, the panel skips the catalog and opens at this product. */
  pinnedProduct?: SourceCoopPinnedProduct;
}

/**
 * Builds a panel plugin over the Source Cooperative browser.
 *
 * Exists so a curated entry point — Natural Earth, say — is a *configuration*
 * of this browser rather than a second copy of it: same API client, same file
 * listing, same add/download routing, so the two can never drift. All state is
 * per-instance, so several of these can be active at once.
 */
function createSourceCoopPlugin(config: SourceCoopPluginConfig): GeoLibrePlugin {
  let appRef: GeoLibreAppAPI | null = null;
  let unregisterPanel: (() => void) | null = null;
  // The mounted container and its teardown, tracked so a language change can
  // rebuild the panel in place (see setSourceCoopLabels).
  let panelContainer: HTMLElement | null = null;
  let disposePanel: (() => void) | null = null;

  function mountPanel(container: HTMLElement): void {
    disposePanel?.();
    container.replaceChildren();
    panelContainer = container;
    disposePanel = buildPanel(container, appRef, config.pinnedProduct);
  }

  const remount = (): void => {
    if (panelContainer) mountPanel(panelContainer);
  };

  return {
    id: config.id,
    name: config.name,
    version: "0.1.0",
    activate: (app: GeoLibreAppAPI) => {
      appRef = app;
      mountedPanels.add(remount);
      unregisterPanel =
        app.registerRightPanel?.({
          id: config.id,
          title: config.name,
          dock: "right-of-style",
          defaultWidth: 340,
          render: (container) => {
            mountPanel(container);
            return () => {
              disposePanel?.();
              disposePanel = null;
              if (panelContainer === container) panelContainer = null;
            };
          },
        }) ?? null;
      app.openRightPanel?.(config.id);
    },
    deactivate: (app: GeoLibreAppAPI) => {
      app.closeRightPanel?.(config.id);
      unregisterPanel?.();
      unregisterPanel = null;
      mountedPanels.delete(remount);
      // Layers the user added stay on the map: they are ordinary GeoLibre layers
      // now, owned by the Layers panel, not by this browser.
      appRef = null;
    },
  };
}

export const maplibreSourceCoopPlugin: GeoLibrePlugin = createSourceCoopPlugin({
  id: SOURCE_COOP_PLUGIN_ID,
  name: "Source Cooperative",
});

export const NATURAL_EARTH_PLUGIN_ID = "maplibre-gl-natural-earth";

/**
 * Natural Earth (https://source.coop/opengeos/natural-earth): the public-domain
 * small-scale basemap dataset, re-exported as PMTiles, GeoParquet, GeoJSON, and
 * shapefiles. It is the Source Cooperative browser pinned to one product, so
 * the layer list comes from the live bucket listing and needs no catalog here.
 */
export const maplibreNaturalEarthPlugin: GeoLibrePlugin = createSourceCoopPlugin({
  id: NATURAL_EARTH_PLUGIN_ID,
  name: "Natural Earth",
  pinnedProduct: {
    accountId: "opengeos",
    productId: "natural-earth",
    title: "Natural Earth",
  },
});

export default maplibreSourceCoopPlugin;
