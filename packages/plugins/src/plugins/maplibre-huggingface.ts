/**
 * Hugging Face dataset browser (Plugins > Web Services).
 *
 * A right panel with two halves:
 *
 *  - **Browse** — search the Hub or name an account, walk a dataset repo's
 *    folders, and put its vector/raster files on the map. Adding delegates to
 *    the controls that already know each format (`addPMTilesLayerFromUrl` for
 *    PMTiles, `addVectorLayerFromUrl` for GeoParquet and friends,
 *    `app.addCogLayer` for COG), so a Hugging Face file lands in the Layers
 *    panel, styles, and persists exactly like the same file added by hand
 *    through Add Data.
 *
 *  - **Upload** — with a user access token, create a dataset repo and push
 *    files into it. This is the one panel in the Web Services menu that writes,
 *    which is why the token handling here is deliberately conservative: the
 *    token lives in `localStorage` under the user's control, is sent only as a
 *    bearer header by `huggingface-api.ts`, and is never written into a layer's
 *    URL or a saved project.
 *
 * The API client it drives lives in `huggingface-api.ts`; that module's comment
 * covers the wire details. This module owns everything that touches the map or
 * the document.
 */

import { useAppStore } from "@geolibre/core";
import type { GeoLibreAppAPI, GeoLibrePlugin } from "../types";
import { isVectorLayerSelectionCancelled } from "maplibre-gl-vector/errors";
import { addPMTilesLayerFromUrl } from "./maplibre-components";
import { addVectorLayerFromUrl } from "./maplibre-vector";
import {
  canStream,
  fileNote,
  formatBytes,
  HTTP_URL_RE,
  isAddable,
  isTooLargeToOpen,
  MAX_VECTOR_BYTES,
  usesDuckDB,
  type RemoteFileFormat,
  type RemoteIngestMode,
} from "./remote-file-formats";
import {
  buildDownloadUrl,
  canRenderFrom,
  createDatasetRepo,
  fetchDataset,
  HF_MAX_UPLOAD_BYTES,
  HF_SITE,
  isOwnerName,
  listDatasetTree,
  listOwnerDatasets,
  parseRepoId,
  searchDatasets,
  uploadDatasetFiles,
  whoAmI,
  type HfClientOptions,
  type HfDataset,
  type HfFile,
  type HfIdentity,
  type HfUploadProgress,
} from "./huggingface-api";

export const HUGGINGFACE_PLUGIN_ID = "maplibre-gl-huggingface";

/** Where the user's access token is kept. Mirrors the Mapillary plugin's key. */
const TOKEN_STORAGE_KEY = "geolibre:huggingface-token";

/** Where the panel sends a user who has no token yet. */
const TOKEN_SETTINGS_URL = `${HF_SITE}/settings/tokens`;

/**
 * The query the browse view opens on, so the panel is useful before the user
 * has typed anything. Deliberately a plain search rather than a curated list:
 * the Hub has a real search endpoint, so there is no second catalog here that
 * could go stale.
 */
const DEFAULT_QUERY = "geospatial";

/** User-facing strings. The host pushes translations in via {@link setHuggingFaceLabels}. */
export interface HuggingFaceLabels {
  browseTab: string;
  uploadTab: string;
  hint: string;
  searchPlaceholder: string;
  search: string;
  searching: string;
  loadError: (message: string) => string;
  noResults: string;
  retry: string;
  suggestions: string;
  showing: (count: number) => string;
  browseOwner: (owner: string) => string;
  back: string;
  private: string;
  gated: string;
  privateHint: string;
  stats: (likes: number, downloads: number) => string;
  noFiles: string;
  loadingFiles: string;
  loadMore: string;
  parent: string;
  add: string;
  adding: string;
  stream: string;
  streaming: string;
  remove: string;
  download: string;
  copyUrl: string;
  copied: string;
  openDataset: string;
  addTitle: string;
  streamTitle: string;
  removeTitle: string;
  downloadTitle: string;
  copyUrlTitle: string;
  openDatasetTitle: string;
  unsupportedTitle: string;
  addError: (message: string) => string;
  largeFileWarning: (size: string) => string;
  streamHint: (size: string) => string;
  tooLargeToOpen: (size: string, limit: string) => string;
  /** Upload half. */
  tokenLabel: string;
  tokenHint: string;
  tokenPlaceholder: string;
  tokenSave: string;
  tokenClear: string;
  tokenHelp: string;
  tokenChecking: string;
  tokenError: (message: string) => string;
  signedInAs: (name: string) => string;
  readOnlyToken: string;
  createHeading: string;
  ownerLabel: string;
  datasetNameLabel: string;
  datasetNamePlaceholder: string;
  privateLabel: string;
  create: string;
  creating: string;
  createdRepo: (repoId: string) => string;
  createError: (message: string) => string;
  uploadHeading: string;
  targetLabel: string;
  targetPlaceholder: string;
  folderLabel: string;
  folderPlaceholder: string;
  chooseFiles: string;
  selectedFiles: (count: number, size: string) => string;
  commitMessageLabel: string;
  commitMessagePlaceholder: string;
  upload: string;
  uploadPreparing: string;
  uploadHashing: (name: string, index: number, total: number) => string;
  uploadSending: (name: string, index: number, total: number) => string;
  uploadCommitting: string;
  uploadDone: (count: number) => string;
  uploadError: (message: string) => string;
  fileTooLarge: (name: string, limit: string) => string;
  openUploaded: string;
}

export const DEFAULT_HUGGINGFACE_LABELS: HuggingFaceLabels = {
  browseTab: "Browse",
  uploadTab: "Upload",
  hint: "Search Hugging Face for dataset repos, or enter an account name or owner/dataset id.",
  searchPlaceholder: "Search datasets, account, or owner/dataset",
  search: "Search",
  searching: "Searching…",
  loadError: (message) => `Could not reach Hugging Face: ${message}. Please try again.`,
  noResults: "No matching datasets.",
  retry: "Retry",
  suggestions: "Suggested datasets",
  showing: (count) => `${count} dataset${count === 1 ? "" : "s"}.`,
  browseOwner: (owner) => `Browse all ${owner} datasets`,
  back: "Back",
  private: "Private",
  gated: "Gated",
  privateHint:
    "This dataset is private or gated. Its files need an authenticated request, " +
    "which a map source cannot make, so they cannot be added or downloaded here.",
  stats: (likes, downloads) => `${likes} likes · ${downloads} downloads`,
  noFiles: "No files in this folder.",
  loadingFiles: "Loading files…",
  loadMore: "Load more",
  parent: "Up one level",
  add: "Add",
  adding: "Adding…",
  stream: "Stream",
  streaming: "Streaming",
  remove: "Remove",
  download: "Download",
  copyUrl: "Copy URL",
  copied: "Copied",
  openDataset: "Open on Hugging Face",
  addTitle: "Add this file to the map",
  streamTitle:
    "Query this file where it sits, reading only the parts in view. " +
    "The whole file is never copied into DuckDB — best for large files.",
  removeTitle: "Remove this file from the map",
  downloadTitle: "Download this file",
  copyUrlTitle: "Copy this file's URL",
  openDatasetTitle: "Open this dataset's page on huggingface.co",
  unsupportedTitle: "GeoLibre cannot render this format — download it instead",
  addError: (message) => `Could not add this file: ${message}`,
  largeFileWarning: (size) =>
    `This file is ${size}. It streams from the source, so only the parts in view are read.`,
  streamHint: (size) =>
    `This file is ${size}. Add copies it into memory; Stream reads only the parts in view.`,
  tooLargeToOpen: (size, limit) =>
    `This file is ${size} — too large for the browser to open (${limit} limit). ` +
    `Download it, or use a partitioned version of this dataset.`,
  tokenLabel: "Access token",
  tokenHint:
    "Creating a dataset repo and uploading files needs a Hugging Face access token with write access. " +
    "It is stored in this browser only and sent to huggingface.co alone.",
  tokenPlaceholder: "hf_…",
  tokenSave: "Save token",
  tokenClear: "Clear",
  tokenHelp: "Get a token",
  tokenChecking: "Checking token…",
  tokenError: (message) => `Could not verify this token: ${message}`,
  signedInAs: (name) => `Signed in as ${name}`,
  readOnlyToken: "This token is read-only. Create a token with write access to upload.",
  createHeading: "Create a dataset repo",
  ownerLabel: "Owner",
  datasetNameLabel: "Dataset name",
  datasetNamePlaceholder: "my-geodata",
  privateLabel: "Private",
  create: "Create",
  creating: "Creating…",
  createdRepo: (repoId) => `Created ${repoId}.`,
  createError: (message) => `Could not create this dataset: ${message}`,
  uploadHeading: "Upload files",
  targetLabel: "Dataset",
  targetPlaceholder: "owner/dataset",
  folderLabel: "Folder (optional)",
  folderPlaceholder: "data/",
  chooseFiles: "Choose files",
  selectedFiles: (count, size) => `${count} file${count === 1 ? "" : "s"} selected (${size}).`,
  commitMessageLabel: "Commit message (optional)",
  commitMessagePlaceholder: "Upload with GeoLibre",
  upload: "Upload",
  uploadPreparing: "Preparing upload…",
  uploadHashing: (name, index, total) => `Hashing ${name} (${index}/${total})…`,
  uploadSending: (name, index, total) => `Uploading ${name} (${index}/${total})…`,
  uploadCommitting: "Committing…",
  uploadDone: (count) => `Uploaded ${count} file${count === 1 ? "" : "s"}.`,
  uploadError: (message) => `Upload failed: ${message}`,
  fileTooLarge: (name, limit) => `${name} is larger than the ${limit} upload limit.`,
  openUploaded: "Open the dataset",
};

let labels: HuggingFaceLabels = { ...DEFAULT_HUGGINGFACE_LABELS };

// The theme tokens are HSL channel triplets (shadcn convention), so they must be
// wrapped in hsl(); using them bare yields an invalid value that drops the rule.
// Spacing uses logical properties (inline-start/-end) so the panel mirrors
// correctly in right-to-left locales.
const CSS = {
  panel:
    "display:flex;flex-direction:column;gap:8px;padding:8px;font-size:12px;" +
    "height:100%;box-sizing:border-box;color:hsl(var(--foreground));",
  hint: "font-size:11px;color:hsl(var(--muted-foreground));line-height:1.4;",
  tabs: "display:flex;gap:4px;",
  tab:
    "flex:1 1 0;padding:5px 8px;border-radius:6px;font-size:12px;cursor:pointer;" +
    "border:1px solid hsl(var(--border));background:hsl(var(--background));" +
    "color:hsl(var(--foreground));",
  tabActive:
    "flex:1 1 0;padding:5px 8px;border-radius:6px;font-size:12px;cursor:pointer;" +
    "border:1px solid hsl(var(--primary));background:hsl(var(--primary));" +
    "color:hsl(var(--primary-foreground));",
  searchRow: "display:flex;gap:4px;",
  input:
    "flex:1 1 auto;min-width:0;box-sizing:border-box;padding:5px 8px;" +
    "font-size:12px;border-radius:6px;border:1px solid hsl(var(--border));" +
    "background:hsl(var(--background));color:hsl(var(--foreground));",
  fieldInput:
    "width:100%;box-sizing:border-box;padding:5px 8px;font-size:12px;" +
    "border-radius:6px;border:1px solid hsl(var(--border));" +
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
  error: "font-size:11px;color:hsl(var(--destructive));line-height:1.4;word-break:break-word;",
  list:
    "display:flex;flex-direction:column;gap:6px;flex:1 1 auto;min-height:0;" + "overflow-y:auto;",
  form:
    "display:flex;flex-direction:column;gap:8px;flex:1 1 auto;min-height:0;" + "overflow-y:auto;",
  card:
    "display:flex;flex-direction:column;gap:4px;padding:6px;border-radius:6px;" +
    "border:1px solid hsl(var(--border));background:hsl(var(--muted));",
  cardButton:
    "display:flex;flex-direction:column;gap:4px;padding:6px;border-radius:6px;" +
    "border:1px solid hsl(var(--border));background:hsl(var(--muted));" +
    "color:hsl(var(--foreground));text-align:start;cursor:pointer;font:inherit;",
  section:
    "display:flex;flex-direction:column;gap:6px;padding:8px;border-radius:6px;" +
    "border:1px solid hsl(var(--border));",
  sectionTitle: "font-size:12px;font-weight:600;",
  field: "display:flex;flex-direction:column;gap:3px;",
  fieldLabel: "font-size:10px;color:hsl(var(--muted-foreground));",
  checkRow: "display:flex;align-items:center;gap:6px;font-size:11px;",
  title: "font-size:12px;font-weight:600;line-height:1.3;",
  titleRow: "display:flex;align-items:baseline;gap:6px;",
  sub:
    "font-size:10px;color:hsl(var(--muted-foreground));white-space:nowrap;" +
    "overflow:hidden;text-overflow:ellipsis;",
  // Like `sub`, but wraps: the advisory lines under a file's size are whole
  // sentences, which `sub`'s nowrap+ellipsis would cut off at the first line.
  note: "font-size:10px;color:hsl(var(--muted-foreground));line-height:1.4;",
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
  crumbs: "font-size:10px;color:hsl(var(--muted-foreground));word-break:break-all;",
  success: "font-size:11px;color:hsl(var(--foreground));line-height:1.4;",
} as const;

/**
 * Rebuild callbacks for the panels currently mounted, so a language change can
 * repaint each in place (see {@link setHuggingFaceLabels}).
 */
const mountedPanels = new Set<() => void>();

// ---------------------------------------------------------------------------
// Access token
// ---------------------------------------------------------------------------

/**
 * Reads the saved token. Wrapped in try/catch because `localStorage` throws
 * outright in a partitioned or storage-blocked context rather than returning
 * null, which would take the whole panel down on mount.
 */
function readToken(): string {
  if (typeof localStorage === "undefined") return "";
  try {
    return localStorage.getItem(TOKEN_STORAGE_KEY)?.trim() ?? "";
  } catch {
    return "";
  }
}

function writeToken(token: string): void {
  if (typeof localStorage === "undefined") return;
  try {
    if (token) localStorage.setItem(TOKEN_STORAGE_KEY, token);
    else localStorage.removeItem(TOKEN_STORAGE_KEY);
  } catch {
    // Storage unavailable: the token still works for this session, held in the
    // panel's own state, so a failure to persist is not worth surfacing.
  }
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

/** A labelled text input, the shape every field in the upload view takes. */
function field(
  labelText: string,
  options: { value?: string; placeholder?: string; type?: string } = {},
): { row: HTMLDivElement; input: HTMLInputElement } {
  const row = el("div", CSS.field);
  row.appendChild(el("label", CSS.fieldLabel, labelText));
  const input = el("input", CSS.fieldInput);
  input.type = options.type ?? "text";
  if (options.placeholder) input.placeholder = options.placeholder;
  input.value = options.value ?? "";
  row.appendChild(input);
  return { row, input };
}

/**
 * Finds the store layer backing a file, if it is already on the map. Derived
 * from the store rather than remembered in module state so the Add/Remove
 * button stays correct across a project reload, and after the user removes the
 * layer from the Layers panel.
 */
function findAddedLayer(file: HfFile) {
  return useAppStore.getState().layers.find((layer) => layer.sourcePath === file.url);
}

/**
 * The mode a layer was actually added with, read off the record the vector
 * control synced into the store. The control downgrades `stream` to `table`
 * whenever a file cannot be streamed, so this reports what happened rather than
 * what was asked for.
 */
function ingestModeOf(layer: ReturnType<typeof findAddedLayer>): RemoteIngestMode | undefined {
  const vectorState = layer?.metadata.vectorState;
  if (typeof vectorState !== "object" || vectorState === null) return undefined;
  const mode = (vectorState as { ingestMode?: unknown }).ingestMode;
  return mode === "stream" || mode === "table" ? mode : undefined;
}

/**
 * Puts one file on the map, routing by format to the control that already
 * handles it. Returns false when the format has no renderer, which the caller
 * renders as download-only.
 */
async function addFileToMap(
  app: GeoLibreAppAPI | null,
  file: HfFile,
  ingestMode: RemoteIngestMode = "table",
): Promise<boolean> {
  // The URL is built by buildResolveUrl from an https base, but re-check at the
  // point it becomes a map source so this security-sensitive step stands alone.
  if (!app || !HTTP_URL_RE.test(file.url)) return false;

  switch (file.format) {
    case "pmtiles":
      return addPMTilesLayerFromUrl(app, file.url);
    case "cog":
      if (!app.addCogLayer) return false;
      await app.addCogLayer(file.name, file.url);
      return true;
    default:
      if (!usesDuckDB(file.format)) return false;
      return addVectorLayerFromUrl(app, file.url, { name: file.name, ingestMode });
  }
}

/**
 * Triggers a browser download. The Hub honours `?download=true` by sending
 * `Content-Disposition: attachment` on the redirect target, so the browser
 * saves the file rather than navigating to it — which a `.csv` or `.geojson`
 * would otherwise do.
 */
function downloadFile(file: HfFile): void {
  // Re-checked here because this value becomes an `<a href>`: it blocks a
  // `javascript:`/`data:` URL from ever reaching a click.
  if (!HTTP_URL_RE.test(file.url)) return;
  const link = document.createElement("a");
  link.href = buildDownloadUrl(file.url);
  link.download = file.name;
  link.target = "_blank";
  link.rel = "noopener";
  link.style.display = "none";
  document.body.appendChild(link);
  link.click();
  link.remove();
}

function formatLabel(format: RemoteFileFormat): string {
  return format === "other" ? "file" : format;
}

/**
 * Renders {@link fileNote}'s decision with the current translations, against
 * what the card is currently doing — a note has to agree with the buttons
 * beside it, and both of these notes describe something the card may have
 * already moved past.
 */
function noteText(file: HfFile, state: { added: boolean; pending: boolean }): string {
  const size = formatBytes(file.size);
  switch (fileNote(file.format, file.size)) {
    case "streams":
      // A fact about the file rather than about a choice — true whether or not
      // it is on the map, so it always stands.
      return labels.largeFileWarning(size);
    case "streamChoice":
      // A decision aid for two buttons that are disabled the moment the choice
      // is made and gone once the file is on the map.
      return state.added || state.pending ? "" : labels.streamHint(size);
    case "tooLarge":
      // A file already on the map is demonstrably openable, and its Remove
      // button works — claiming it is too large would contradict that button.
      return state.added ? "" : labels.tooLargeToOpen(size, formatBytes(MAX_VECTOR_BYTES));
    default:
      return "";
  }
}

/** Merges dataset lists, keeping the first record seen for a duplicate id. */
function mergeDatasets(...groups: HfDataset[][]): HfDataset[] {
  const byId = new Map<string, HfDataset>();
  for (const group of groups) {
    for (const dataset of group) {
      if (!byId.has(dataset.id)) byId.set(dataset.id, dataset);
    }
  }
  return [...byId.values()];
}

/**
 * Builds the panel DOM.
 *
 * All view state lives in this closure, so the panel is self-contained and
 * `mountPanel` can rebuild it wholesale on a language change.
 */
function buildPanel(container: HTMLElement, app: GeoLibreAppAPI | null): () => void {
  type View =
    | { kind: "browse" }
    | { kind: "dataset"; dataset: HfDataset; path: string }
    | { kind: "upload" };

  let view: View = { kind: "browse" };
  let query = "";
  let results: HfDataset[] = [];
  /** True until the first search runs, so the seeded list is labelled as suggestions. */
  let showingSuggestions = true;
  let status = "";
  let error = "";
  let busy = false;

  // Files for the current dataset view, appended across "Load more" pages.
  let files: HfFile[] = [];
  let folders: string[] = [];
  let nextCursor: string | null = null;
  let filesLoading = false;

  // Upload state.
  let token = readToken();
  let identity: HfIdentity | null = null;
  let tokenBusy = false;
  let tokenError = "";
  let createOwner = "";
  let createName = "";
  let createPrivate = false;
  let createBusy = false;
  let createMessage = "";
  let uploadTarget = "";
  let uploadFolder = "";
  let uploadCommitMessage = "";
  let selectedFiles: File[] = [];
  let uploadBusy = false;
  let uploadStatus = "";
  let uploadedUrl = "";

  // Ignore results from a superseded request, and cancel the in-flight one.
  let generation = 0;
  let inflight: AbortController | null = null;
  /** Files being added, mapped to the mode they are being added with, so the
   * card can show the pending label on the button the user actually clicked. */
  const addInFlight = new Map<string, RemoteIngestMode>();

  const root = el("div", CSS.panel);
  container.appendChild(root);

  function beginRequest(): { signal: AbortSignal; token: number } {
    inflight?.abort();
    inflight = new AbortController();
    generation += 1;
    return { signal: inflight.signal, token: generation };
  }

  /** Read options. The token is passed so the user's own repos are listed too. */
  function readOptions(signal?: AbortSignal): HfClientOptions {
    return { signal, ...(token ? { token } : {}) };
  }

  /**
   * Runs a search.
   *
   * A query shaped like `owner/dataset` resolves to that repo and opens it
   * directly. Anything else is ambiguous between an account name and a keyword,
   * so both are asked and merged with the account's own repos first — typing
   * `giswqs` should show that account's datasets, not just repos with the word
   * in their name.
   */
  async function runSearch(rawQuery: string, options: { seed?: boolean } = {}): Promise<void> {
    const trimmed = rawQuery.trim();
    if (!trimmed) return;
    const { signal, token: requestToken } = beginRequest();
    busy = true;
    error = "";
    status = labels.searching;
    render();

    try {
      const ref = parseRepoId(trimmed);
      if (ref) {
        const dataset = await fetchDataset(`${ref.owner}/${ref.name}`, readOptions(signal));
        if (requestToken !== generation) return;
        if (dataset) {
          openDataset(dataset);
          return;
        }
        // Not a repo id after all (or not visible): fall through and treat the
        // text as a search, which is what the user most likely meant.
      }

      const [owned, matched] = await Promise.allSettled([
        isOwnerName(trimmed)
          ? listOwnerDatasets(trimmed, readOptions(signal))
          : Promise.resolve<HfDataset[]>([]),
        searchDatasets(trimmed, readOptions(signal)),
      ]);
      if (requestToken !== generation) return;
      // A partial result beats an empty panel, so one source failing is only an
      // error when both did.
      if (owned.status === "rejected" && matched.status === "rejected") {
        throw matched.reason instanceof Error
          ? matched.reason
          : new Error("Hugging Face is unreachable");
      }
      results = mergeDatasets(
        owned.status === "fulfilled" ? owned.value : [],
        matched.status === "fulfilled" ? matched.value : [],
      );
      showingSuggestions = options.seed === true;
      status = "";
    } catch (caught) {
      if (isAbort(caught) || requestToken !== generation) return;
      error = labels.loadError(errorMessage(caught));
      status = "";
    } finally {
      if (requestToken === generation) {
        busy = false;
        render();
      }
    }
  }

  async function openOwner(owner: string): Promise<void> {
    const { signal, token: requestToken } = beginRequest();
    busy = true;
    error = "";
    status = labels.searching;
    render();
    try {
      const owned = await listOwnerDatasets(owner, readOptions(signal));
      if (requestToken !== generation) return;
      results = owned;
      showingSuggestions = false;
      query = owner;
      status = "";
    } catch (caught) {
      if (isAbort(caught) || requestToken !== generation) return;
      error = labels.loadError(errorMessage(caught));
      status = "";
    } finally {
      if (requestToken === generation) {
        busy = false;
        render();
      }
    }
  }

  /**
   * Loads one page of files for the current dataset view. `append` continues a
   * truncated listing; otherwise the list is replaced.
   */
  async function loadFiles(append = false): Promise<void> {
    if (view.kind !== "dataset") return;
    const { dataset, path } = view;
    const { signal, token: requestToken } = beginRequest();
    filesLoading = true;
    error = "";
    render();
    try {
      const listing = await listDatasetTree(
        { repoId: dataset.id, path, cursor: append ? nextCursor : null },
        readOptions(signal),
      );
      if (requestToken !== generation) return;
      files = append ? [...files, ...listing.files] : listing.files;
      folders = append ? [...folders, ...listing.folders] : listing.folders;
      nextCursor = listing.nextCursor;
    } catch (caught) {
      if (isAbort(caught) || requestToken !== generation) return;
      error = labels.loadError(errorMessage(caught));
    } finally {
      if (requestToken === generation) {
        filesLoading = false;
        render();
      }
    }
  }

  function openDataset(dataset: HfDataset): void {
    view = { kind: "dataset", dataset, path: "" };
    files = [];
    folders = [];
    nextCursor = null;
    busy = false;
    status = "";
    void loadFiles();
    render();
  }

  function openPath(path: string): void {
    if (view.kind !== "dataset") return;
    view = { ...view, path };
    files = [];
    folders = [];
    nextCursor = null;
    void loadFiles();
    render();
  }

  async function handleAdd(file: HfFile, mode: RemoteIngestMode = "table"): Promise<void> {
    const existing = findAddedLayer(file);
    if (existing) {
      useAppStore.getState().removeLayer(existing.id);
      render();
      return;
    }
    addInFlight.set(file.path, mode);
    error = "";
    render();
    try {
      const added = await addFileToMap(app, file, mode);
      if (!added) error = labels.addError(labels.unsupportedTitle);
    } catch (caught) {
      // Dismissing the vector control's multi-layer picker rejects the add, but
      // the user chose to load nothing: leave the card as it was.
      if (!isVectorLayerSelectionCancelled(caught)) {
        error = labels.addError(errorMessage(caught));
      }
    } finally {
      addInFlight.delete(file.path);
      render();
    }
  }

  // -------------------------------------------------------------------------
  // Browse view
  // -------------------------------------------------------------------------

  function renderDatasetCard(dataset: HfDataset): HTMLElement {
    const card = el("button", CSS.cardButton);
    card.type = "button";
    card.addEventListener("click", () => openDataset(dataset));

    const titleRow = el("div", CSS.titleRow);
    const name = el("span", CSS.title, dataset.name);
    name.style.overflow = "hidden";
    name.style.textOverflow = "ellipsis";
    name.style.whiteSpace = "nowrap";
    titleRow.appendChild(name);
    if (dataset.private) titleRow.appendChild(el("span", CSS.badge, labels.private));
    else if (dataset.gated) titleRow.appendChild(el("span", CSS.badge, labels.gated));
    card.appendChild(titleRow);
    card.appendChild(el("div", CSS.sub, dataset.id));
    card.appendChild(el("div", CSS.sub, labels.stats(dataset.likes, dataset.downloads)));

    // Hub tags are mostly machine-generated bookkeeping (`region:us`,
    // `library:datasets`); the `format:` and `modality:` ones are the two that
    // tell a user something about the data, so only those are surfaced.
    const interesting = dataset.tags.filter((tag) => /^(format|modality|license):/.test(tag));
    if (interesting.length > 0) {
      const tagRow = el("div", CSS.tagRow);
      for (const tag of interesting.slice(0, 6)) tagRow.appendChild(el("span", CSS.tag, tag));
      card.appendChild(tagRow);
    }
    return card;
  }

  function renderBrowse(): void {
    root.appendChild(el("div", CSS.hint, labels.hint));

    const searchRow = el("div", CSS.searchRow);
    const input = el("input", CSS.input);
    input.type = "search";
    input.placeholder = labels.searchPlaceholder;
    input.value = query;
    input.addEventListener("input", () => {
      query = input.value;
    });
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") void runSearch(query);
    });
    searchRow.appendChild(input);

    const searchButton = button(labels.search, CSS.primaryButton);
    searchButton.addEventListener("click", () => void runSearch(query));
    searchRow.appendChild(searchButton);
    root.appendChild(searchRow);

    const statusNode = el("div", CSS.status);
    root.appendChild(statusNode);
    const errorNode = el("div", CSS.error);
    root.appendChild(errorNode);
    const list = el("div", CSS.list);
    root.appendChild(list);

    function renderResults(): void {
      list.replaceChildren();
      statusNode.textContent = busy
        ? status || labels.searching
        : results.length === 0
          ? ""
          : showingSuggestions
            ? labels.suggestions
            : labels.showing(results.length);
      errorNode.textContent = error;
      errorNode.style.display = error ? "" : "none";

      if (error && results.length === 0) {
        const retry = button(labels.retry, CSS.secondaryButton);
        retry.addEventListener("click", () => void runSearch(query || DEFAULT_QUERY));
        list.appendChild(retry);
        return;
      }
      if (busy && results.length === 0) return;
      if (results.length === 0) {
        list.appendChild(el("div", CSS.status, labels.noResults));
      }
      for (const dataset of results) list.appendChild(renderDatasetCard(dataset));

      // A keyword query that also reads as an account name gets a shortcut to
      // that account's full repo list — the one bulk listing the API offers.
      const owner = query.trim().replace(/\/.*$/, "");
      if (owner && isOwnerName(owner) && !busy && !showingSuggestions) {
        const more = button(labels.browseOwner(owner), CSS.secondaryButton);
        more.addEventListener("click", () => void openOwner(owner));
        list.appendChild(more);
      }
    }

    // Attached so later state changes can repaint just the results.
    renderCurrentView = renderResults;
    renderResults();
  }

  // -------------------------------------------------------------------------
  // Dataset (files) view
  // -------------------------------------------------------------------------

  function renderFileCard(file: HfFile, renderable: boolean): HTMLElement {
    const card = el("div", CSS.card);
    // One store lookup per card: both questions the card asks — is this on the
    // map, and how was it read — are answered by the same layer record.
    const addedLayer = findAddedLayer(file);
    const added = addedLayer !== undefined;

    const titleRow = el("div", CSS.titleRow);
    const name = el("span", CSS.title, file.name);
    name.style.overflow = "hidden";
    name.style.textOverflow = "ellipsis";
    name.style.whiteSpace = "nowrap";
    titleRow.appendChild(name);
    titleRow.appendChild(el("span", CSS.formatBadge, formatLabel(file.format)));
    // Reports how the layer is actually being read, which the control decides.
    if (ingestModeOf(addedLayer) === "stream") {
      titleRow.appendChild(el("span", CSS.badge, labels.streaming));
    }
    card.appendChild(titleRow);
    card.appendChild(el("div", CSS.sub, formatBytes(file.size)));

    const pendingMode = addInFlight.get(file.path);
    const pending = pendingMode !== undefined;

    const note = noteText(file, { added, pending });
    if (note) card.appendChild(el("div", CSS.note, note));

    const actions = el("div", CSS.actions);
    if (renderable && isAddable(file.format)) {
      // Kept visible but inert past the 2 GiB limit: the note above says why,
      // which is more use than a card that silently drops the button.
      const tooLarge = isTooLargeToOpen(file.format, file.size);

      const addButton = button(
        pendingMode === "table" ? labels.adding : added ? labels.remove : labels.add,
        added ? CSS.actionActive : CSS.action,
        // `added` wins over `tooLarge`: the button reads Remove and removal
        // works, so the title has to describe that rather than the size gate.
        added
          ? labels.removeTitle
          : tooLarge
            ? labels.tooLargeToOpen(formatBytes(file.size), formatBytes(MAX_VECTOR_BYTES))
            : labels.addTitle,
      );
      addButton.disabled = pending || (tooLarge && !added);
      addButton.addEventListener("click", () => void handleAdd(file, "table"));
      actions.appendChild(addButton);

      // A second door onto the same layer, so it is offered only while the file
      // is off the map — once added, Remove above governs either mode.
      if (canStream(file.format) && !added && !tooLarge) {
        const streamButton = button(
          pendingMode === "stream" ? labels.adding : labels.stream,
          CSS.action,
          labels.streamTitle,
        );
        streamButton.disabled = pending;
        streamButton.addEventListener("click", () => void handleAdd(file, "stream"));
        actions.appendChild(streamButton);
      }
    }

    if (renderable) {
      const downloadButton = button(
        labels.download,
        CSS.action,
        isAddable(file.format) ? labels.downloadTitle : labels.unsupportedTitle,
      );
      downloadButton.addEventListener("click", () => downloadFile(file));
      actions.appendChild(downloadButton);

      const copyButton = button(labels.copyUrl, CSS.action, labels.copyUrlTitle);
      copyButton.addEventListener("click", () => {
        void navigator.clipboard?.writeText(file.url).then(() => {
          copyButton.textContent = labels.copied;
          window.setTimeout(() => {
            copyButton.textContent = labels.copyUrl;
          }, 1500);
        });
      });
      actions.appendChild(copyButton);
    }

    if (actions.childElementCount > 0) card.appendChild(actions);
    return card;
  }

  function renderDataset(dataset: HfDataset, path: string): void {
    // Private and gated repos are listed but their files cannot be fetched
    // without an Authorization header, which a map source has no place for.
    const renderable = canRenderFrom(dataset);

    const header = el("div", CSS.header);
    const back = button(labels.back, CSS.secondaryButton);
    back.addEventListener("click", () => {
      view = { kind: "browse" };
      render();
    });
    header.appendChild(back);

    const titleRow = el("div", CSS.titleRow);
    titleRow.appendChild(el("span", CSS.title, dataset.name));
    if (dataset.private) titleRow.appendChild(el("span", CSS.badge, labels.private));
    else if (dataset.gated) titleRow.appendChild(el("span", CSS.badge, labels.gated));
    header.appendChild(titleRow);
    header.appendChild(el("div", CSS.sub, dataset.id));
    header.appendChild(el("div", CSS.sub, labels.stats(dataset.likes, dataset.downloads)));
    if (!renderable) header.appendChild(el("div", CSS.note, labels.privateHint));

    const open = button(labels.openDataset, CSS.action, labels.openDatasetTitle);
    open.addEventListener("click", () => {
      window.open(dataset.url, "_blank", "noopener");
    });
    const openRow = el("div", CSS.actions);
    openRow.appendChild(open);
    header.appendChild(openRow);
    root.appendChild(header);

    root.appendChild(el("div", CSS.crumbs, `/${path}`));

    const errorNode = el("div", CSS.error);
    root.appendChild(errorNode);

    const list = el("div", CSS.list);
    root.appendChild(list);

    function renderFiles(): void {
      list.replaceChildren();
      errorNode.textContent = error;
      errorNode.style.display = error ? "" : "none";

      if (path) {
        const up = button(labels.parent, CSS.secondaryButton);
        up.addEventListener("click", () => {
          const segments = path.split("/");
          segments.pop();
          openPath(segments.join("/"));
        });
        list.appendChild(up);
      }

      for (const folder of folders) {
        const name = folder.split("/").pop() ?? folder;
        const card = el("button", CSS.cardButton);
        card.type = "button";
        card.appendChild(el("span", CSS.title, `${name}/`));
        card.addEventListener("click", () => openPath(folder));
        list.appendChild(card);
      }

      for (const file of files) list.appendChild(renderFileCard(file, renderable));

      if (filesLoading) {
        list.appendChild(el("div", CSS.status, labels.loadingFiles));
      } else if (files.length === 0 && folders.length === 0) {
        list.appendChild(el("div", CSS.status, labels.noFiles));
      }

      if (nextCursor && !filesLoading) {
        const more = button(labels.loadMore, CSS.secondaryButton);
        more.addEventListener("click", () => void loadFiles(true));
        list.appendChild(more);
      }
    }

    renderCurrentView = renderFiles;
    renderFiles();
  }

  // -------------------------------------------------------------------------
  // Upload view
  // -------------------------------------------------------------------------

  async function verifyToken(next: string): Promise<void> {
    token = next.trim();
    writeToken(token);
    identity = null;
    tokenError = "";
    if (!token) {
      render();
      return;
    }
    tokenBusy = true;
    render();
    try {
      identity = await whoAmI({ token });
      // Default the create form's namespace to the token's own account, which
      // is the one namespace every token can write to.
      createOwner ||= identity.name;
    } catch (caught) {
      // A bad token is a user-correctable mistake, not a panel failure — keep
      // it saved so the field still shows what was entered and can be edited.
      tokenError = labels.tokenError(errorMessage(caught));
    } finally {
      tokenBusy = false;
      render();
    }
  }

  async function handleCreate(): Promise<void> {
    createBusy = true;
    createMessage = "";
    tokenError = "";
    render();
    try {
      const { repoId } = await createDatasetRepo(
        {
          name: createName,
          // The token's own account is the implicit namespace, so it is sent
          // only when the user picked an organization instead.
          ...(createOwner && createOwner !== identity?.name ? { owner: createOwner } : {}),
          private: createPrivate,
        },
        { token },
      );
      createMessage = labels.createdRepo(repoId);
      // Point the upload form at what was just created — creating a repo and
      // then filling its id in by hand is the obvious next step.
      uploadTarget = repoId;
      createName = "";
    } catch (caught) {
      tokenError = labels.createError(errorMessage(caught));
    } finally {
      createBusy = false;
      render();
    }
  }

  function uploadProgressText(progress: HfUploadProgress): string {
    switch (progress.phase) {
      case "preparing":
        return labels.uploadPreparing;
      case "hashing":
        return labels.uploadHashing(progress.path, progress.index, progress.total);
      case "uploading":
        return labels.uploadSending(progress.path, progress.index, progress.total);
      case "committing":
        return labels.uploadCommitting;
    }
  }

  async function handleUpload(): Promise<void> {
    const target = uploadTarget.trim();
    const ref = parseRepoId(target);
    if (!ref) {
      tokenError = labels.uploadError(labels.targetPlaceholder);
      render();
      return;
    }
    const oversized = selectedFiles.find((file) => file.size > HF_MAX_UPLOAD_BYTES);
    if (oversized) {
      tokenError = labels.fileTooLarge(oversized.name, formatBytes(HF_MAX_UPLOAD_BYTES));
      render();
      return;
    }

    uploadBusy = true;
    tokenError = "";
    uploadedUrl = "";
    uploadStatus = labels.uploadPreparing;
    render();
    try {
      const prefix = uploadFolder.trim().replace(/^\/+|\/+$/g, "");
      const payload = await Promise.all(
        selectedFiles.map(async (file) => ({
          path: prefix ? `${prefix}/${file.name}` : file.name,
          content: new Uint8Array(await file.arrayBuffer()),
        })),
      );
      const repoId = `${ref.owner}/${ref.name}`;
      await uploadDatasetFiles(
        {
          repoId,
          files: payload,
          commitMessage: uploadCommitMessage,
          onProgress: (progress) => {
            uploadStatus = uploadProgressText(progress);
            renderCurrentView();
          },
        },
        { token },
      );
      uploadStatus = labels.uploadDone(payload.length);
      uploadedUrl = `${HF_SITE}/datasets/${repoId}`;
      selectedFiles = [];
    } catch (caught) {
      tokenError = labels.uploadError(errorMessage(caught));
      uploadStatus = "";
    } finally {
      uploadBusy = false;
      render();
    }
  }

  function renderUpload(): void {
    const form = el("div", CSS.form);
    root.appendChild(form);

    // --- Token ---
    const tokenSection = el("div", CSS.section);
    tokenSection.appendChild(el("div", CSS.sectionTitle, labels.tokenLabel));
    tokenSection.appendChild(el("div", CSS.hint, labels.tokenHint));
    // A token is a secret, so the field is masked — a previously saved token
    // reopened in a shared screen share should not be readable.
    const tokenField = field(labels.tokenLabel, {
      value: token,
      placeholder: labels.tokenPlaceholder,
      type: "password",
    });
    tokenSection.appendChild(tokenField.row);

    const tokenActions = el("div", CSS.actions);
    const saveToken = button(labels.tokenSave, CSS.action);
    saveToken.disabled = tokenBusy;
    saveToken.addEventListener("click", () => void verifyToken(tokenField.input.value));
    tokenActions.appendChild(saveToken);

    const clearToken = button(labels.tokenClear, CSS.action);
    clearToken.disabled = tokenBusy || !token;
    clearToken.addEventListener("click", () => void verifyToken(""));
    tokenActions.appendChild(clearToken);

    const help = button(labels.tokenHelp, CSS.action);
    help.addEventListener("click", () => {
      window.open(TOKEN_SETTINGS_URL, "_blank", "noopener");
    });
    tokenActions.appendChild(help);
    tokenSection.appendChild(tokenActions);

    if (tokenBusy) tokenSection.appendChild(el("div", CSS.status, labels.tokenChecking));
    else if (identity) {
      tokenSection.appendChild(el("div", CSS.status, labels.signedInAs(identity.name)));
      if (!identity.canWrite) {
        tokenSection.appendChild(el("div", CSS.error, labels.readOnlyToken));
      }
    }
    form.appendChild(tokenSection);

    const errorNode = el("div", CSS.error, tokenError);
    errorNode.style.display = tokenError ? "" : "none";
    form.appendChild(errorNode);

    // Every control below writes to the Hub, so without a verified token there
    // is nothing here the user could successfully do.
    if (!identity) return;

    // --- Create repo ---
    const createSection = el("div", CSS.section);
    createSection.appendChild(el("div", CSS.sectionTitle, labels.createHeading));

    const ownerRow = el("div", CSS.field);
    ownerRow.appendChild(el("label", CSS.fieldLabel, labels.ownerLabel));
    const ownerSelect = el("select", CSS.fieldInput);
    // The token's account first, then its organizations: the namespaces this
    // token could actually create a repo under.
    for (const owner of [identity.name, ...identity.orgs]) {
      const option = document.createElement("option");
      option.value = owner;
      option.textContent = owner;
      option.selected = owner === createOwner;
      ownerSelect.appendChild(option);
    }
    ownerSelect.addEventListener("change", () => {
      createOwner = ownerSelect.value;
    });
    ownerRow.appendChild(ownerSelect);
    createSection.appendChild(ownerRow);

    // Built before the field that gates it so the input handler can re-enable
    // it as the user types. Repainting the whole form on each keystroke would
    // be the alternative, and that drops the caret out of the field.
    const createButton = button(createBusy ? labels.creating : labels.create, CSS.primaryButton);
    const syncCreateEnabled = () => {
      createButton.disabled = createBusy || !createName.trim();
    };

    const nameField = field(labels.datasetNameLabel, {
      value: createName,
      placeholder: labels.datasetNamePlaceholder,
    });
    nameField.input.addEventListener("input", () => {
      createName = nameField.input.value;
      syncCreateEnabled();
    });
    // Enter in the name field is the obvious way to submit a one-field form.
    nameField.input.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !createButton.disabled) void handleCreate();
    });
    createSection.appendChild(nameField.row);

    const privateRow = el("label", CSS.checkRow);
    const privateBox = document.createElement("input");
    privateBox.type = "checkbox";
    privateBox.checked = createPrivate;
    privateBox.addEventListener("change", () => {
      createPrivate = privateBox.checked;
    });
    privateRow.appendChild(privateBox);
    privateRow.appendChild(document.createTextNode(labels.privateLabel));
    createSection.appendChild(privateRow);

    syncCreateEnabled();
    createButton.addEventListener("click", () => void handleCreate());
    createSection.appendChild(createButton);
    if (createMessage) createSection.appendChild(el("div", CSS.success, createMessage));
    form.appendChild(createSection);

    // --- Upload files ---
    const uploadSection = el("div", CSS.section);
    uploadSection.appendChild(el("div", CSS.sectionTitle, labels.uploadHeading));

    // Built ahead of the fields that gate it, for the same reason as the Create
    // button above: the handlers below re-enable it in place as the user types
    // or picks files, without repainting the form under the caret.
    const uploadButton = button(labels.upload, CSS.primaryButton);
    const selectionNode = el("div", CSS.status);
    const syncUploadEnabled = () => {
      uploadButton.disabled =
        uploadBusy || selectedFiles.length === 0 || parseRepoId(uploadTarget) === null;
      selectionNode.textContent =
        selectedFiles.length === 0
          ? ""
          : labels.selectedFiles(
              selectedFiles.length,
              formatBytes(selectedFiles.reduce((sum, file) => sum + file.size, 0)),
            );
    };

    const targetField = field(labels.targetLabel, {
      value: uploadTarget,
      placeholder: labels.targetPlaceholder,
    });
    targetField.input.addEventListener("input", () => {
      uploadTarget = targetField.input.value;
      syncUploadEnabled();
    });
    uploadSection.appendChild(targetField.row);

    const folderField = field(labels.folderLabel, {
      value: uploadFolder,
      placeholder: labels.folderPlaceholder,
    });
    folderField.input.addEventListener("input", () => {
      uploadFolder = folderField.input.value;
    });
    uploadSection.appendChild(folderField.row);

    const messageField = field(labels.commitMessageLabel, {
      value: uploadCommitMessage,
      placeholder: labels.commitMessagePlaceholder,
    });
    messageField.input.addEventListener("input", () => {
      uploadCommitMessage = messageField.input.value;
    });
    uploadSection.appendChild(messageField.row);

    // A hidden input driven by a styled button, so the file picker matches the
    // rest of the panel instead of rendering the browser's default control.
    const filePicker = document.createElement("input");
    filePicker.type = "file";
    filePicker.multiple = true;
    filePicker.style.display = "none";
    filePicker.addEventListener("change", () => {
      selectedFiles = filePicker.files ? [...filePicker.files] : [];
      syncUploadEnabled();
    });
    uploadSection.appendChild(filePicker);

    const chooseButton = button(labels.chooseFiles, CSS.action);
    chooseButton.disabled = uploadBusy;
    chooseButton.addEventListener("click", () => filePicker.click());
    uploadSection.appendChild(chooseButton);
    uploadSection.appendChild(selectionNode);

    syncUploadEnabled();
    uploadButton.addEventListener("click", () => void handleUpload());
    uploadSection.appendChild(uploadButton);

    const uploadStatusNode = el("div", CSS.status, uploadStatus);
    uploadSection.appendChild(uploadStatusNode);
    if (uploadedUrl) {
      const openUploaded = button(labels.openUploaded, CSS.action);
      openUploaded.addEventListener("click", () => {
        window.open(uploadedUrl, "_blank", "noopener");
      });
      uploadSection.appendChild(openUploaded);
    }
    form.appendChild(uploadSection);

    // Progress ticks arrive several times per upload, and repainting the form
    // for each would rebuild every field mid-operation. Only the two things
    // that actually change are touched.
    renderCurrentView = () => {
      uploadStatusNode.textContent = uploadStatus;
      syncUploadEnabled();
    };
  }

  // -------------------------------------------------------------------------
  // Shell
  // -------------------------------------------------------------------------

  function renderTabs(): void {
    const tabs = el("div", CSS.tabs);
    // The dataset view is reached from Browse, so it keeps Browse highlighted.
    const onUpload = view.kind === "upload";

    const browseTab = button(labels.browseTab, onUpload ? CSS.tab : CSS.tabActive);
    browseTab.addEventListener("click", () => {
      if (view.kind === "upload") {
        view = { kind: "browse" };
        render();
      }
    });
    tabs.appendChild(browseTab);

    const uploadTab = button(labels.uploadTab, onUpload ? CSS.tabActive : CSS.tab);
    uploadTab.addEventListener("click", () => {
      if (view.kind === "upload") return;
      // Carry the dataset being browsed into the upload form: uploading into
      // the repo you are looking at is the common case.
      if (view.kind === "dataset" && !uploadTarget) uploadTarget = view.dataset.id;
      view = { kind: "upload" };
      render();
    });
    tabs.appendChild(uploadTab);
    root.appendChild(tabs);
  }

  // Set by whichever view is mounted, so state changes repaint the list in
  // place instead of rebuilding the whole panel (which would drop input focus).
  let renderCurrentView: () => void = () => {};

  function render(): void {
    root.replaceChildren();
    renderTabs();
    if (view.kind === "browse") renderBrowse();
    else if (view.kind === "dataset") renderDataset(view.dataset, view.path);
    else renderUpload();
  }

  render();
  // Seed the browse list so the panel is useful before anything is typed.
  void runSearch(DEFAULT_QUERY, { seed: true });
  // A saved token is verified on mount so the upload tab is ready when opened,
  // and so a revoked token is reported before the user fills in a form.
  if (token) void verifyToken(token);

  // Repaint when the layer store changes, so Add/Remove reflects a layer the
  // user removed from the Layers panel. Guarded on the layers array identity so
  // unrelated store writes (basemap, view state) do not repaint the list.
  const unsubscribe = useAppStore.subscribe((state, previous) => {
    if (state.layers !== previous.layers) renderCurrentView();
  });

  return () => {
    inflight?.abort();
    inflight = null;
    unsubscribe?.();
    root.remove();
  };
}

/**
 * Replaces the panel's user-facing strings. The host calls this with
 * translations on activation and every language change; any open panel is
 * rebuilt so the new strings take effect immediately.
 *
 * @param next - The strings to override
 */
export function setHuggingFaceLabels(next: Partial<HuggingFaceLabels>): void {
  labels = { ...labels, ...next };
  for (const remount of mountedPanels) remount();
}

/**
 * Hugging Face (https://huggingface.co): browse dataset repos and put their
 * vector/raster files on the map, and — with an access token — create a dataset
 * repo and upload files to it.
 */
export const maplibreHuggingFacePlugin: GeoLibrePlugin = (() => {
  let appRef: GeoLibreAppAPI | null = null;
  let unregisterPanel: (() => void) | null = null;
  // The mounted container and its teardown, tracked so a language change can
  // rebuild the panel in place (see setHuggingFaceLabels).
  let panelContainer: HTMLElement | null = null;
  let disposePanel: (() => void) | null = null;

  function mountPanel(container: HTMLElement): void {
    disposePanel?.();
    container.replaceChildren();
    panelContainer = container;
    disposePanel = buildPanel(container, appRef);
  }

  const remount = (): void => {
    if (panelContainer) mountPanel(panelContainer);
  };

  return {
    id: HUGGINGFACE_PLUGIN_ID,
    name: "Hugging Face",
    version: "0.1.0",
    activate: (app: GeoLibreAppAPI) => {
      appRef = app;
      mountedPanels.add(remount);
      unregisterPanel =
        app.registerRightPanel?.({
          id: HUGGINGFACE_PLUGIN_ID,
          title: "Hugging Face",
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
      app.openRightPanel?.(HUGGINGFACE_PLUGIN_ID);
    },
    deactivate: (app: GeoLibreAppAPI) => {
      app.closeRightPanel?.(HUGGINGFACE_PLUGIN_ID);
      unregisterPanel?.();
      unregisterPanel = null;
      mountedPanels.delete(remount);
      // Layers the user added stay on the map: they are ordinary GeoLibre
      // layers now, owned by the Layers panel, not by this browser.
      appRef = null;
    },
  };
})();

export default maplibreHuggingFacePlugin;
