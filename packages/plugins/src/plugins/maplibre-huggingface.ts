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

import { useAppStore, VECTOR_COLOR_RAMPS } from "@geolibre/core";
import type { GeoLibreAppAPI, GeoLibrePlugin } from "../types";
import { isVectorLayerSelectionCancelled } from "maplibre-gl-vector/errors";
import { addPMTilesLayerFromUrl } from "./maplibre-components";
import {
  addRasterToMap,
  type RasterRenderEngine,
  type RasterVisualizationDefaults,
} from "./maplibre-raster";
import { addVectorLayerFromUrl } from "./maplibre-vector";
import { RASTER_SOURCE_KIND } from "./raster-symbology-texture";
import {
  canStream,
  fileNote,
  formatBytes,
  HTTP_URL_RE,
  isAddable,
  isRasterIndexJson,
  isTooLargeToOpen,
  MAX_VECTOR_BYTES,
  usesDuckDB,
  type RemoteFileFormat,
  type RemoteIngestMode,
} from "./remote-file-formats";
import {
  buildBlobViewUrl,
  buildDownloadUrl,
  buildTreeViewUrl,
  canRenderFrom,
  createDatasetRepo,
  fetchDataset,
  HF_MAX_UPLOAD_BYTES,
  HF_MAX_UPLOAD_TOTAL_BYTES,
  HF_SITE,
  isOwnerName,
  listDatasetTree,
  listOwnerDatasets,
  parseRepoId,
  searchDatasets,
  synthesizeDataset,
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

/** Where the raster display defaults are kept, alongside the access token. */
const RASTER_DEFAULTS_STORAGE_KEY = "geolibre:huggingface-raster-defaults";

/**
 * The renderers offered in Settings.
 *
 * The values are the library's own engine ids; the labels are what those
 * actually mean to a user — the first decodes the COG on the GPU, the second in
 * a WebAssembly tiler, the third on a TiTiler server.
 */
const RENDER_ENGINES: {
  value: RasterRenderEngine;
  labelKey: "engineGpu" | "engineWasm" | "engineTitiler";
}[] = [
  { value: "maplibre-gl-raster", labelKey: "engineGpu" },
  { value: "cog-tiler-wasm", labelKey: "engineWasm" },
  { value: "titiler", labelKey: "engineTitiler" },
];

/** How a raster added from this panel is displayed before the user restyles it. */
interface HuggingFaceRasterDefaults {
  /** 1-indexed [R, G, B] used when the image has three or more bands. */
  rgbBands: [number, number, number];
  /** Colormap used when the image has a single band. */
  colormap: string;
  /** Which renderer decodes the imagery, or undefined to leave the control's own. */
  engine?: RasterRenderEngine;
}

const BUILT_IN_RASTER_DEFAULTS: HuggingFaceRasterDefaults = {
  // Bands 1/2/3 is what the control itself picks for a plain RGB image, so the
  // out-of-the-box behaviour is unchanged until the user sets something else.
  rgbBands: [1, 2, 3],
  // Jet: the default the user asked for — a familiar full-spectrum ramp for
  // single-band scientific imagery (chlorophyll, elevation, indices).
  colormap: "jet",
};

/**
 * Reads the saved raster defaults, falling back to the built-ins for anything
 * missing or malformed. Tolerant by design: these are display preferences, so a
 * partially corrupt entry should degrade to the default rather than break the
 * panel.
 */
function readRasterDefaults(): HuggingFaceRasterDefaults {
  if (typeof localStorage === "undefined") return { ...BUILT_IN_RASTER_DEFAULTS };
  try {
    const raw = localStorage.getItem(RASTER_DEFAULTS_STORAGE_KEY);
    if (!raw) return { ...BUILT_IN_RASTER_DEFAULTS };
    const parsed: unknown = JSON.parse(raw);
    const record = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
    const bands = Array.isArray(record.rgbBands) ? record.rgbBands : [];
    const rgbBands = BUILT_IN_RASTER_DEFAULTS.rgbBands.map((fallback, index) => {
      const value = Number(bands[index]);
      return Number.isFinite(value) && value >= 1 ? Math.round(value) : fallback;
    }) as [number, number, number];
    const engine = RENDER_ENGINES.some((option) => option.value === record.engine)
      ? (record.engine as RasterRenderEngine)
      : undefined;
    return {
      rgbBands,
      colormap:
        typeof record.colormap === "string" && record.colormap
          ? record.colormap
          : BUILT_IN_RASTER_DEFAULTS.colormap,
      ...(engine ? { engine } : {}),
    };
  } catch {
    return { ...BUILT_IN_RASTER_DEFAULTS };
  }
}

function writeRasterDefaults(defaults: HuggingFaceRasterDefaults): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(RASTER_DEFAULTS_STORAGE_KEY, JSON.stringify(defaults));
  } catch {
    // Storage unavailable: the defaults still apply for this session.
  }
}

/**
 * The datasets the browse view opens on, so the panel is useful before the user
 * has typed anything.
 *
 * A pinned list rather than a seeded search: searching the Hub for a word like
 * "geospatial" matches on repo *name and description*, not on what a repo
 * actually holds, so it surfaced repos with no map-renderable file while
 * missing ones full of COG or GeoParquet that never use the word.
 *
 * Only the ids are hard-coded. Each entry's title, stats, and tags are fetched
 * live, and its file list is always the real repo listing — so there is no
 * second catalog here that can go stale against the Hub.
 */
const SUGGESTED_DATASET_IDS = [
  "giswqs/geospatial",
  "giswqs/PACE-Water-Quality",
  "HyperCoast/PACE_products",
  "HyperCoast/EMIT_products",
  "HyperCoast/MSI_products",
] as const;

/** User-facing strings. The host pushes translations in via {@link setHuggingFaceLabels}. */
export interface HuggingFaceLabels {
  browseTab: string;
  uploadTab: string;
  settingsTab: string;
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
  notRasterIndex: string;
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
  chooseLayer: string;
  chooseLayerTitle: string;
  layerPickerHeading: string;
  layerFeatures: (count: number) => string;
  layerOriginalFile: string;
  layerUnavailable: (name: string) => string;
  remoteRasterNote: string;
  noUploadableLayers: string;
  clearSelection: string;
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
  selectionTooLarge: (size: string, limit: string) => string;
  openUploaded: string;
  /** Settings half. */
  rgbHeading: string;
  rgbHint: string;
  bandR: string;
  bandG: string;
  bandB: string;
  colormapHeading: string;
  colormapHint: string;
  colormapLabel: string;
  engineHeading: string;
  engineHint: string;
  engineLabel: string;
  engineAuto: string;
  engineGpu: string;
  engineWasm: string;
  engineTitiler: string;
  resetDefaults: string;
}

export const DEFAULT_HUGGINGFACE_LABELS: HuggingFaceLabels = {
  browseTab: "Browse",
  uploadTab: "Upload",
  settingsTab: "Settings",
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
  notRasterIndex:
    "This JSON file does not index any rasters, so there is nothing to put on the map. " +
    "MosaicJSON and STAC collections are supported.",
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
  chooseLayer: "Choose layer",
  chooseLayerTitle: "Upload a map layer's features as a GeoJSON file",
  layerPickerHeading: "Upload a layer as GeoJSON",
  layerFeatures: (count) => `${count} feature${count === 1 ? "" : "s"}`,
  layerOriginalFile: "Original file",
  layerUnavailable: (name) => `${name} is no longer available to upload.`,
  remoteRasterNote:
    "Rasters loaded from a URL are not listed: their data is not in the browser, " +
    "and they already have a link you can share. Only files opened locally can be uploaded.",
  noUploadableLayers:
    "No layer on the map holds features that can be uploaded. Add a vector layer first.",
  clearSelection: "Clear",
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
  selectionTooLarge: (size, limit) =>
    `The selected files total ${size}, over the ${limit} limit for one upload. ` +
    `Upload them in smaller batches.`,
  openUploaded: "Open the dataset",
  rgbHeading: "Multiband imagery",
  rgbHint:
    "Which bands become red, green and blue when an image has three or more of them. " +
    "1-indexed; the Style panel can still change any layer afterwards.",
  bandR: "Red",
  bandG: "Green",
  bandB: "Blue",
  colormapHeading: "Single-band imagery",
  colormapHint: "The colormap applied when an image has one band.",
  colormapLabel: "Colormap",
  engineHeading: "Rendering engine",
  engineHint:
    "Which renderer decodes the imagery. Unlike the settings above this is not per layer: " +
    "it applies to every raster on the map, including ones already added.",
  engineLabel: "Engine",
  engineAuto: "Leave unchanged",
  engineGpu: "GPU (deck.gl)",
  engineWasm: "WebAssembly tiler",
  engineTitiler: "TiTiler server",
  resetDefaults: "Reset to defaults",
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

/**
 * Mints a document-unique id for a form control, so its `<label for>` can point
 * at it. A counter rather than a content-derived id because a panel is rebuilt
 * wholesale on every render and the same field would otherwise collide with the
 * copy still being torn down.
 */
let fieldIdCounter = 0;
function nextFieldId(): string {
  fieldIdCounter += 1;
  return `geolibre-hf-field-${fieldIdCounter}`;
}

/**
 * Associates a label with the control it names.
 *
 * Paired by `for`/`id` rather than by nesting the control inside the label:
 * the row is a column flexbox with the two as siblings, and nesting would
 * reflow the input into the label's inline box.
 *
 * @param label - The label element
 * @param control - The control it names
 */
function labelControl(label: HTMLLabelElement, control: HTMLElement): void {
  const id = nextFieldId();
  control.id = id;
  label.htmlFor = id;
}

/** A labelled text input, the shape every field in the upload view takes. */
function field(
  labelText: string,
  options: { value?: string; placeholder?: string; type?: string } = {},
): { row: HTMLDivElement; input: HTMLInputElement } {
  const row = el("div", CSS.field);
  const label = el("label", CSS.fieldLabel, labelText);
  row.appendChild(label);
  const input = el("input", CSS.fieldInput);
  input.type = options.type ?? "text";
  if (options.placeholder) input.placeholder = options.placeholder;
  input.value = options.value ?? "";
  labelControl(label, input);
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
  rasterDefaults?: RasterVisualizationDefaults,
): Promise<boolean> {
  // The URL is built by buildResolveUrl from an https base, but re-check at the
  // point it becomes a map source so this security-sensitive step stands alone.
  if (!app || !HTTP_URL_RE.test(file.url)) return false;

  switch (file.format) {
    case "pmtiles":
      return addPMTilesLayerFromUrl(app, file.url);
    case "cog":
      // Deliberately the Add Raster Layer control rather than `app.addCogLayer`.
      // Both render a COG, but they are different controls: `addCogLayer` goes
      // to the components CogLayerControl, whose store layer does not carry
      // RASTER_SOURCE_KIND, so the Style panel shows only opacity. This one
      // syncs through raster-layer-sync and gets the full Raster symbology
      // section (band pickers, colormap, classification).
      await addRasterToMap(app, file.url, { name: file.name, defaults: rasterDefaults });
      return true;
    case "mosaic": {
      // The extension made this a candidate; the body decides. Without this a
      // repo's config.json would offer an Add that fails inside the control.
      const body: unknown = await fetch(file.url).then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json();
      });
      if (!isRasterIndexJson(body)) throw new Error(labels.notRasterIndex);
      // The same control takes the sidecar's URL directly and stitches the
      // scenes it points at at read time.
      await addRasterToMap(app, file.url, { name: file.name, defaults: rasterDefaults });
      return true;
    }
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

/** A map layer whose data this panel can upload, and how to get its bytes. */
interface UploadableLayer {
  id: string;
  name: string;
  kind: "geojson" | "raster";
  /** Features in the layer; 0 for a raster. */
  featureCount: number;
  /** The path this layer would take inside the commit. */
  fileName: string;
  /** Blob URL holding a file-backed raster's original bytes. */
  bytesUrl?: string;
}

/**
 * Lists the layers whose data this panel can upload, and counts the rasters it
 * had to leave out.
 *
 * Two kinds qualify, for the same underlying reason — the bytes are already in
 * the browser, complete:
 *
 *  - **vector layers carrying their features in the store's `geojson` field.**
 *    A tile-backed layer is excluded because reading it from the MapLibre
 *    source returns only the features in loaded tiles, so it would upload a
 *    silently truncated dataset that looks complete.
 *  - **file-backed rasters**, which the raster control keeps behind a blob URL
 *    (surfaced as `metadata.localBytesUrl`). This is the COG a user opened from
 *    disk, or one a processing tool just produced — the case where publishing
 *    it is the natural next step, and where the original file can be sent
 *    byte-for-byte rather than re-encoded.
 *
 * A **URL-backed raster is deliberately not offered.** Its bytes are not here:
 * uploading would mean pulling the whole remote file through the tab only to
 * push it back out to another host, which is slow, can be many GB, and is
 * pointless for the common case of a COG that already lives on the Hub. That
 * layer already has a URL worth sharing, so the count is returned and the
 * picker says so instead of silently omitting it.
 *
 * @returns The uploadable layers, and how many remote rasters were skipped
 */
function listUploadableLayers(): { layers: UploadableLayer[]; skippedRemote: number } {
  const layers: UploadableLayer[] = [];
  let skippedRemote = 0;

  for (const layer of useAppStore.getState().layers) {
    const bytesUrl = layer.metadata.localBytesUrl;
    if (typeof bytesUrl === "string" && bytesUrl) {
      layers.push({
        id: layer.id,
        name: layer.name,
        kind: "raster",
        featureCount: 0,
        fileName: rasterFileName(layer.sourcePath ?? "", layer.name),
        bytesUrl,
      });
      continue;
    }
    // A raster with no local bytes is one backed by a remote URL.
    if (layer.metadata.sourceKind === RASTER_SOURCE_KIND) {
      skippedRemote += 1;
      continue;
    }
    const features = layer.geojson?.features;
    if (Array.isArray(features) && features.length > 0) {
      layers.push({
        id: layer.id,
        name: layer.name,
        kind: "geojson",
        featureCount: features.length,
        fileName: layerFileName(layer.name),
      });
    }
  }

  return { layers, skippedRemote };
}

/**
 * Reduces a name to characters that are safe in a commit path.
 *
 * The result becomes a path inside a git commit, so anything that could change
 * the path's meaning — separators, `..`, leading dots — has to go, not merely
 * be escaped.
 */
function slugifyFileName(raw: string): string {
  return (
    raw
      .trim()
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      .replace(/^[-.]+|[-.]+$/g, "")
      .replace(/-{2,}/g, "-")
      // Drop separators left sitting against a dot, so "dem (2024).tif" reads as
      // "dem-2024.tif" rather than "dem-2024-.tif".
      .replace(/-+\./g, ".")
      .slice(0, 80)
  );
}

/**
 * Turns a layer name into a safe `.geojson` filename.
 *
 * @param name - The layer's display name
 * @returns A filename ending in `.geojson`
 */
export function layerFileName(name: string): string {
  return `${slugifyFileName(name) || "layer"}.geojson`;
}

/**
 * Picks the filename for a file-backed raster, preferring the name it was
 * opened under so the uploaded file matches what the user has on disk.
 *
 * @param sourcePath - The layer's `sourcePath`, which holds the original file name
 * @param layerName - Fallback when that name is missing or unusable
 * @returns A filename with an extension
 */
export function rasterFileName(sourcePath: string, layerName: string): string {
  // Keep a name only when it still carries an extension; a slug that lost it
  // (or never had one) would upload a file the Hub cannot type.
  const hasExtension = (name: string) => /\.[A-Za-z0-9]+$/.test(name);

  const base = slugifyFileName(sourcePath.split(/[/\\]/).pop() ?? "");
  if (base && hasExtension(base)) return base;

  // The same check applies to the fallback: a raster layer is very often named
  // after its own file ("clip_output.tif"), so appending unconditionally would
  // produce "clip_output.tif.tif".
  const fallback = slugifyFileName(layerName);
  if (fallback && hasExtension(fallback)) return fallback;
  return `${fallback || "raster"}.tif`;
}

/**
 * Reads one layer's data into an upload-ready file.
 *
 * @param entry - The layer to serialize, from {@link listUploadableLayers}
 * @returns The file, or null when the layer's data is no longer reachable
 */
async function layerToUploadFile(entry: UploadableLayer): Promise<File | null> {
  if (entry.kind === "raster") {
    if (!entry.bytesUrl) return null;
    try {
      // A blob URL, so this is a read from memory rather than a network fetch.
      // It can still fail: the raster control revokes the URL when its layer
      // goes away, which can race a click on an already-stale list.
      const response = await fetch(entry.bytesUrl);
      if (!response.ok) return null;
      return new File([await response.blob()], entry.fileName);
    } catch {
      return null;
    }
  }

  const layer = useAppStore.getState().layers.find((candidate) => candidate.id === entry.id);
  const features = layer?.geojson?.features;
  if (!layer?.geojson || !Array.isArray(features) || features.length === 0) return null;
  return new File([JSON.stringify(layer.geojson)], entry.fileName, {
    type: "application/geo+json",
  });
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
    | { kind: "upload" }
    | { kind: "settings" };

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
  /** Whether the inline layer picker is expanded under "Choose layer". */
  let layerPickerOpen = false;
  let rasterDefaults = readRasterDefaults();
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
  async function runSearch(rawQuery: string): Promise<void> {
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
      showingSuggestions = false;
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
   * Loads the pinned suggestions the panel opens on.
   *
   * Each id resolves independently and falls back to a synthesized record, so
   * one unreachable repo (renamed, made private, or a metadata blip) costs its
   * own card's title and stats rather than emptying the list — the entry still
   * opens, because the file listing needs only the id.
   */
  async function loadSuggested(): Promise<void> {
    const { signal, token: requestToken } = beginRequest();
    busy = true;
    error = "";
    status = labels.searching;
    render();
    try {
      const fetched = await Promise.all(
        SUGGESTED_DATASET_IDS.map((id) =>
          fetchDataset(id, readOptions(signal)).then(
            (dataset) => dataset ?? synthesizeDataset(id),
            () => synthesizeDataset(id),
          ),
        ),
      );
      if (requestToken !== generation) return;
      results = fetched.filter((dataset): dataset is HfDataset => dataset !== null);
      showingSuggestions = true;
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
      const added = await addFileToMap(app, file, mode, rasterDefaults);
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
        retry.addEventListener("click", () =>
          query.trim() ? void runSearch(query) : void loadSuggested(),
        );
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
        void navigator.clipboard
          ?.writeText(file.url)
          .then(() => {
            copyButton.textContent = labels.copied;
            window.setTimeout(() => {
              copyButton.textContent = labels.copyUrl;
            }, 1500);
          })
          // writeText rejects outside a secure context and when the permission
          // is refused. Left silent — the URL is still on screen to copy by
          // hand — but caught, so it does not surface as an unhandled rejection
          // in the diagnostics panel.
          .catch(() => {});
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

  /**
   * Adds files to the pending selection, keyed by name.
   *
   * Additive so a local file and a map layer can go up in one commit, and
   * keyed by name because two entries sharing a name would resolve to one
   * path in that commit — the later one is what would survive, so it is what
   * the list shows.
   */
  function stageFiles(next: File[]): void {
    const byName = new Map(selectedFiles.map((file) => [file.name, file]));
    for (const file of next) byName.set(file.name, file);
    selectedFiles = [...byName.values()];
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
    // Checked as well as the per-file limit above, because the two bound
    // different things: every file is read into memory before the one commit
    // that carries them all, so a selection of individually-legal files can
    // still exhaust the tab.
    const totalBytes = selectedFiles.reduce((sum, file) => sum + file.size, 0);
    if (totalBytes > HF_MAX_UPLOAD_TOTAL_BYTES) {
      tokenError = labels.selectionTooLarge(
        formatBytes(totalBytes),
        formatBytes(HF_MAX_UPLOAD_TOTAL_BYTES),
      );
      render();
      return;
    }

    uploadBusy = true;
    // Closed rather than left open with inert cards: the "Choose layer" toggle
    // is disabled during an upload, so an open picker could not be dismissed.
    layerPickerOpen = false;
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
      // Land on what was just uploaded, not the repo's front page: a single
      // file opens its own page, several open the folder that now holds them
      // (the root tree when no folder was given).
      uploadedUrl =
        payload.length === 1
          ? buildBlobViewUrl(repoId, payload[0].path)
          : buildTreeViewUrl(repoId, prefix);
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
    const ownerLabel = el("label", CSS.fieldLabel, labels.ownerLabel);
    ownerRow.appendChild(ownerLabel);
    const ownerSelect = el("select", CSS.fieldInput);
    labelControl(ownerLabel, ownerSelect);
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
      stageFiles(filePicker.files ? [...filePicker.files] : []);
      // Cleared so re-picking the same file fires `change` again; without this
      // the input keeps the value and a removed-then-reselected file is a no-op.
      filePicker.value = "";
      render();
    });
    uploadSection.appendChild(filePicker);

    const pickRow = el("div", CSS.actions);
    const chooseButton = button(labels.chooseFiles, CSS.action);
    chooseButton.disabled = uploadBusy;
    chooseButton.addEventListener("click", () => filePicker.click());
    pickRow.appendChild(chooseButton);

    // The map's own layers are the other place upload data comes from, so they
    // are offered beside the filesystem rather than requiring an export first.
    const { layers: uploadableLayers, skippedRemote: skippedRemoteRasters } =
      listUploadableLayers();
    const chooseLayerButton = button(
      labels.chooseLayer,
      layerPickerOpen ? CSS.actionActive : CSS.action,
      labels.chooseLayerTitle,
    );
    chooseLayerButton.disabled = uploadBusy;
    chooseLayerButton.addEventListener("click", () => {
      layerPickerOpen = !layerPickerOpen;
      render();
    });
    pickRow.appendChild(chooseLayerButton);

    if (selectedFiles.length > 0) {
      const clearButton = button(labels.clearSelection, CSS.action);
      clearButton.disabled = uploadBusy;
      clearButton.addEventListener("click", () => {
        selectedFiles = [];
        render();
      });
      pickRow.appendChild(clearButton);
    }
    uploadSection.appendChild(pickRow);

    if (layerPickerOpen) {
      const picker = el("div", CSS.section);
      picker.appendChild(el("div", CSS.fieldLabel, labels.layerPickerHeading));
      if (uploadableLayers.length === 0) {
        picker.appendChild(el("div", CSS.status, labels.noUploadableLayers));
      }
      for (const entry of uploadableLayers) {
        const card = el("button", CSS.cardButton);
        card.type = "button";
        card.appendChild(el("span", CSS.title, entry.name));
        const detail =
          entry.kind === "raster"
            ? labels.layerOriginalFile
            : labels.layerFeatures(entry.featureCount);
        card.appendChild(el("span", CSS.sub, `${detail} · ${entry.fileName}`));
        card.addEventListener("click", () => {
          void (async () => {
            const file = await layerToUploadFile(entry);
            // An upload may have started while this read was in flight (a
            // raster's bytes are read asynchronously). Its payload is already
            // snapshotted, so staging now would be wiped by the reset on
            // success instead of being uploaded — drop it rather than lose it
            // silently.
            if (uploadBusy) return;
            // Null when the layer went away, or a raster's blob URL was revoked,
            // between this list being rendered and the click.
            if (file) stageFiles([file]);
            else tokenError = labels.layerUnavailable(entry.name);
            layerPickerOpen = false;
            render();
          })();
        });
        picker.appendChild(card);
      }
      // Said out loud rather than left as a silent omission: a user looking for
      // their remote COG should learn why it is not here.
      if (skippedRemoteRasters > 0) {
        picker.appendChild(el("div", CSS.note, labels.remoteRasterNote));
      }
      uploadSection.appendChild(picker);
    }

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
  // Settings view
  // -------------------------------------------------------------------------

  /**
   * How a raster added from this panel should be displayed.
   *
   * These are defaults, not a lock: everything here is the *initial* state of a
   * layer, and the Style panel's Raster symbology section still governs it
   * afterwards. Saved to localStorage on every change, so there is no Save
   * button to forget.
   */
  function renderSettings(): void {
    const form = el("div", CSS.form);
    root.appendChild(form);

    const persist = () => writeRasterDefaults(rasterDefaults);

    // --- Multiband: which bands become R, G and B ---
    const rgbSection = el("div", CSS.section);
    rgbSection.appendChild(el("div", CSS.sectionTitle, labels.rgbHeading));
    rgbSection.appendChild(el("div", CSS.hint, labels.rgbHint));

    const bandRow = el("div", CSS.searchRow);
    const channelLabels = [labels.bandR, labels.bandG, labels.bandB];
    rasterDefaults.rgbBands.forEach((band, index) => {
      const cell = el("div", CSS.field);
      cell.style.flex = "1 1 0";
      const label = el("label", CSS.fieldLabel, channelLabels[index]);
      cell.appendChild(label);
      const input = el("input", CSS.fieldInput);
      input.type = "number";
      input.min = "1";
      input.step = "1";
      input.value = String(band);
      labelControl(label, input);
      input.addEventListener("change", () => {
        const value = Number(input.value);
        // A band index is 1-based; anything else would ask the renderer for a
        // band that cannot exist.
        const next = Number.isFinite(value) && value >= 1 ? Math.round(value) : 1;
        input.value = String(next);
        rasterDefaults.rgbBands[index] = next;
        persist();
      });
      cell.appendChild(input);
      bandRow.appendChild(cell);
    });
    rgbSection.appendChild(bandRow);
    form.appendChild(rgbSection);

    // --- Single band: which colormap ---
    const colormapSection = el("div", CSS.section);
    colormapSection.appendChild(el("div", CSS.sectionTitle, labels.colormapHeading));
    colormapSection.appendChild(el("div", CSS.hint, labels.colormapHint));
    const colormapRow = el("div", CSS.field);
    const colormapLabel = el("label", CSS.fieldLabel, labels.colormapLabel);
    colormapRow.appendChild(colormapLabel);
    const colormapSelect = el("select", CSS.fieldInput);
    labelControl(colormapLabel, colormapSelect);
    // GeoLibre's own curated ramps, which the raster renderer treats as
    // built-in colormap names. Read from core rather than from the renderer so
    // opening Settings does not pull in the deck.gl raster bundle.
    for (const ramp of VECTOR_COLOR_RAMPS) {
      const option = document.createElement("option");
      option.value = ramp.value;
      option.textContent = ramp.label;
      option.selected = ramp.value === rasterDefaults.colormap;
      colormapSelect.appendChild(option);
    }
    colormapSelect.addEventListener("change", () => {
      rasterDefaults.colormap = colormapSelect.value;
      persist();
    });
    colormapRow.appendChild(colormapSelect);
    colormapSection.appendChild(colormapRow);
    form.appendChild(colormapSection);

    // --- Which renderer decodes the imagery ---
    const engineSection = el("div", CSS.section);
    engineSection.appendChild(el("div", CSS.sectionTitle, labels.engineHeading));
    engineSection.appendChild(el("div", CSS.hint, labels.engineHint));
    const engineRow = el("div", CSS.field);
    const engineLabel = el("label", CSS.fieldLabel, labels.engineLabel);
    engineRow.appendChild(engineLabel);
    const engineSelect = el("select", CSS.fieldInput);
    labelControl(engineLabel, engineSelect);
    // An explicit "leave it alone" entry, so the panel does not silently own a
    // control-wide setting the user never asked it to change.
    const autoOption = document.createElement("option");
    autoOption.value = "";
    autoOption.textContent = labels.engineAuto;
    autoOption.selected = !rasterDefaults.engine;
    engineSelect.appendChild(autoOption);
    for (const engine of RENDER_ENGINES) {
      const option = document.createElement("option");
      option.value = engine.value;
      option.textContent = labels[engine.labelKey];
      option.selected = engine.value === rasterDefaults.engine;
      engineSelect.appendChild(option);
    }
    engineSelect.addEventListener("change", () => {
      const value = engineSelect.value;
      if (value) rasterDefaults.engine = value as RasterRenderEngine;
      else delete rasterDefaults.engine;
      persist();
    });
    engineRow.appendChild(engineSelect);
    engineSection.appendChild(engineRow);
    form.appendChild(engineSection);

    const reset = button(labels.resetDefaults, CSS.secondaryButton);
    reset.addEventListener("click", () => {
      rasterDefaults = {
        ...BUILT_IN_RASTER_DEFAULTS,
        rgbBands: [...BUILT_IN_RASTER_DEFAULTS.rgbBands],
      };
      persist();
      render();
    });
    form.appendChild(reset);

    // Nothing here updates outside a full repaint, and the fields write back on
    // change, so the store subscription has no work to do in this view.
    renderCurrentView = () => {};
  }

  // -------------------------------------------------------------------------
  // Shell
  // -------------------------------------------------------------------------

  function renderTabs(): void {
    const tabs = el("div", CSS.tabs);
    // The dataset view is reached from Browse, so it keeps Browse highlighted.
    const onBrowse = view.kind === "browse" || view.kind === "dataset";

    const browseTab = button(labels.browseTab, onBrowse ? CSS.tabActive : CSS.tab);
    browseTab.addEventListener("click", () => {
      if (onBrowse) return;
      view = { kind: "browse" };
      render();
    });
    tabs.appendChild(browseTab);

    const uploadTab = button(labels.uploadTab, view.kind === "upload" ? CSS.tabActive : CSS.tab);
    uploadTab.addEventListener("click", () => {
      if (view.kind === "upload") return;
      // Carry the dataset being browsed into the upload form: uploading into
      // the repo you are looking at is the common case.
      if (view.kind === "dataset" && !uploadTarget) uploadTarget = view.dataset.id;
      view = { kind: "upload" };
      render();
    });
    tabs.appendChild(uploadTab);

    const settingsTab = button(
      labels.settingsTab,
      view.kind === "settings" ? CSS.tabActive : CSS.tab,
    );
    settingsTab.addEventListener("click", () => {
      if (view.kind === "settings") return;
      view = { kind: "settings" };
      render();
    });
    tabs.appendChild(settingsTab);
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
    else if (view.kind === "upload") renderUpload();
    else renderSettings();
  }

  render();
  // Open on the pinned suggestions so the panel is useful before anything is typed.
  void loadSuggested();
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
