/**
 * S3 Browser (Plugins > Web Services).
 *
 * A right panel that browses Amazon S3 and S3-compatible buckets and puts files
 * on the map. Private buckets are listed and read with the S3 connections in
 * Settings > Cloud Storage (through the signer `@geolibre/core` holds); any
 * other bucket is read anonymously, so public open-data buckets work with no
 * setup.
 *
 * Like the Source Cooperative browser, adding delegates to the controls that
 * already know each format (`addRasterToMap`, `addVectorLayerFromUrl`,
 * `addPMTilesLayerFromUrl`), so an S3 file lands in the Layers panel, styles,
 * and persists exactly like one added through Add Data. Layers keep the
 * `s3://` URI (or the object URL), never a signature: each load signs again.
 */

import { explainS3ReadError, getS3UrlSigner, s3ObjectHttpsUrl, useAppStore } from "@geolibre/core";
import { pluginDisplayTitle } from "../plugin-i18n";
import type { GeoLibreAppAPI, GeoLibrePlugin } from "../types";
import { addLidarLayerFromUrl, addPMTilesLayerFromUrl } from "./maplibre-components";
import { addRasterToMap } from "./maplibre-raster";
import { addVectorLayerFromUrl } from "./maplibre-vector";
import { formatBytes, isAddable, isTooLargeToOpen, usesDuckDB } from "./remote-file-formats";
import {
  createS3BrowserClient,
  describeObjects,
  formatS3BrowseLocation,
  parentPrefix,
  parseS3BrowseLocation,
  prefixLabel,
  type S3BrowseLocation,
  type S3BrowserObject,
  type S3TextFetch,
} from "./s3-browser-api";

export const S3_BROWSER_PLUGIN_ID = "geolibre-s3-browser";

const LAST_LOCATION_KEY = "geolibre:s3-browser:location";

export interface S3BrowserLabels {
  hint: string;
  noConnections: string;
  connection: string;
  listBuckets: string;
  locationPlaceholder: string;
  go: string;
  up: string;
  loading: string;
  empty: string;
  loadMore: string;
  add: string;
  added: string;
  adding: string;
  copyUri: string;
  copied: string;
  tooLarge: string;
  notAddable: string;
  signed: string;
  anonymous: string;
  setDefault: string;
  isDefault: string;
  pointCloud: string;
  project: string;
  openProject: string;
  openingProject: string;
  openProjectUnsupported: string;
  openProjectFailed: (name: string, message: string) => string;
  select: string;
  selectAll: string;
  addSelected: (count: number) => string;
  addingProgress: (index: number, total: number) => string;
  addFailed: (name: string, message: string) => string;
  error: (message: string) => string;
}

export const DEFAULT_S3_BROWSER_LABELS: S3BrowserLabels = {
  hint: "Browse an S3 bucket, add GeoTIFF/COG, GeoParquet, GeoJSON, FlatGeobuf, GeoPackage, CSV, PMTiles, or COPC/LAZ point cloud files to the map, or open a .geolibre or .geolibre.json project. Enter s3://bucket/prefix/.",
  noConnections:
    "No S3 connections are configured, so only public buckets can be read. Add credentials in Settings > Cloud Storage.",
  connection: "Connection",
  listBuckets: "List buckets",
  locationPlaceholder: "s3://bucket/prefix/",
  go: "Go",
  up: "Up",
  loading: "Loading…",
  empty: "This folder is empty.",
  loadMore: "Load more",
  add: "Add",
  added: "Added",
  adding: "Adding…",
  copyUri: "Copy URI",
  copied: "Copied",
  tooLarge: "Too large to open in the browser.",
  notAddable: "No map renderer for this file type.",
  signed: "Read with your S3 connection's credentials",
  anonymous: "Public (anonymous) access",
  setDefault: "Set as default",
  isDefault: "Default",
  pointCloud: "point cloud",
  project: "project",
  openProject: "Open project",
  openingProject: "Opening…",
  openProjectUnsupported: "This app cannot open projects from here.",
  openProjectFailed: (name, message) => `Could not open ${name}: ${message}`,
  select: "Select",
  selectAll: "Select all",
  addSelected: (count) => `Add selected (${count})`,
  addingProgress: (index, total) => `Adding ${index} of ${total}…`,
  addFailed: (name, message) => `Could not add ${name}: ${message}`,
  error: (message) => `Could not list this location: ${message}`,
};

let labels: S3BrowserLabels = DEFAULT_S3_BROWSER_LABELS;
const mountedPanels = new Set<() => void>();

/** Replaces the panel's strings (the host passes translations) and repaints open panels. */
export function setS3BrowserLabels(next: Partial<S3BrowserLabels>): void {
  labels = { ...labels, ...next };
  for (const remount of mountedPanels) remount();
}

const CSS = {
  panel:
    "display:flex;flex-direction:column;gap:8px;padding:8px;font-size:12px;" +
    "height:100%;box-sizing:border-box;color:hsl(var(--foreground));",
  hint: "font-size:11px;color:hsl(var(--muted-foreground));line-height:1.4;",
  row: "display:flex;gap:4px;align-items:center;",
  input:
    "flex:1 1 auto;min-width:0;box-sizing:border-box;padding:5px 8px;" +
    "font-size:12px;border-radius:6px;border:1px solid hsl(var(--border));" +
    "background:hsl(var(--background));color:hsl(var(--foreground));",
  primaryButton:
    "padding:5px 10px;border-radius:6px;border:1px solid hsl(var(--primary));" +
    "background:hsl(var(--primary));color:hsl(var(--primary-foreground));" +
    "font-size:12px;cursor:pointer;white-space:nowrap;",
  button:
    "padding:5px 10px;border-radius:6px;border:1px solid hsl(var(--border));" +
    "background:hsl(var(--background));color:hsl(var(--foreground));" +
    "font-size:12px;cursor:pointer;white-space:nowrap;",
  status: "font-size:11px;color:hsl(var(--muted-foreground));line-height:1.4;",
  error:
    "font-size:11px;color:hsl(var(--destructive));line-height:1.4;word-break:break-word;" +
    "white-space:pre-line;",
  list: "display:flex;flex-direction:column;gap:4px;flex:1 1 auto;min-height:0;overflow-y:auto;",
  folder:
    "display:flex;align-items:center;gap:6px;padding:6px;border-radius:6px;" +
    "border:1px solid hsl(var(--border));background:hsl(var(--background));" +
    "color:hsl(var(--foreground));text-align:start;cursor:pointer;font:inherit;",
  card:
    "display:flex;flex-direction:column;gap:4px;padding:6px;border-radius:6px;" +
    "border:1px solid hsl(var(--border));background:hsl(var(--muted));",
  title: "font-size:12px;font-weight:600;line-height:1.3;word-break:break-all;",
  sub: "font-size:10px;color:hsl(var(--muted-foreground));",
  badge:
    "font-size:9px;padding:1px 5px;border-radius:4px;flex:0 0 auto;" +
    "background:hsl(var(--accent));color:hsl(var(--accent-foreground));" +
    "text-transform:uppercase;letter-spacing:0.03em;",
  actions: "display:flex;gap:4px;flex-wrap:wrap;",
  action:
    "padding:2px 8px;font-size:11px;border-radius:4px;cursor:pointer;" +
    "border:1px solid hsl(var(--border));background:hsl(var(--background));" +
    "color:hsl(var(--foreground));",
  location: "font-size:10px;color:hsl(var(--muted-foreground));word-break:break-all;",
  selectLabel: "display:flex;align-items:center;gap:4px;font-size:11px;cursor:pointer;",
} as const;

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

function button(text: string, style: string): HTMLButtonElement {
  const node = el("button", style, text);
  node.type = "button";
  return node;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

const browserFetch: S3TextFetch = async (url, signal) => {
  const response = await fetch(url, { signal });
  return { status: response.status, body: await response.text() };
};

function readLastLocation(): string {
  try {
    return window.localStorage.getItem(LAST_LOCATION_KEY) ?? "";
  } catch {
    return "";
  }
}

function writeLastLocation(value: string): void {
  try {
    window.localStorage.setItem(LAST_LOCATION_KEY, value);
  } catch {
    // Remembering the location is a convenience only.
  }
}

/**
 * Whether a store layer reads this object. Layers keep the `s3://` URI
 * (rasters, point clouds), the object URL (vector files), or a `pmtiles://`
 * URL wrapping the URI (PMTiles source layers). Read from the store each time,
 * so removing the layer re-enables Add.
 */
function isOnMap(object: S3BrowserObject, bucket: string): boolean {
  const objectUrl = s3ObjectHttpsUrl({ bucket, key: object.key });
  // PMTiles normalizes its URL with `new URL(…).href`, which percent-encodes
  // a key with spaces or other reserved characters.
  let encodedUri = object.uri;
  try {
    encodedUri = new URL(object.uri).href;
  } catch {
    // Keep the raw URI.
  }
  const sources = new Set([
    object.uri,
    encodedUri,
    objectUrl,
    `pmtiles://${object.uri}`,
    `pmtiles://${encodedUri}`,
  ]);
  return useAppStore
    .getState()
    .layers.some(
      (layer) =>
        (typeof layer.source.url === "string" && sources.has(layer.source.url)) ||
        (typeof layer.sourcePath === "string" && sources.has(layer.sourcePath)),
    );
}

/** Whether the panel has a way to put this object on the map. */
function canAdd(object: S3BrowserObject): boolean {
  return object.pointCloud || isAddable(object.format);
}

/**
 * Puts one object on the map through the control that owns its format.
 * Vector files go by object URL because the vector panel's URL loader is where
 * GeoLibre signs downloads; rasters, PMTiles, and point clouds take the
 * `s3://` URI.
 */
async function addObjectToMap(
  app: GeoLibreAppAPI,
  location: S3BrowseLocation,
  object: S3BrowserObject,
): Promise<boolean> {
  if (object.pointCloud) return (await addLidarLayerFromUrl(app, object.uri)) !== null;
  switch (object.format) {
    case "cog":
      await addRasterToMap(app, object.uri, { name: object.name });
      return true;
    case "pmtiles":
      return addPMTilesLayerFromUrl(app, object.uri);
    default:
      if (!usesDuckDB(object.format)) return false;
      return addVectorLayerFromUrl(
        app,
        s3ObjectHttpsUrl({ bucket: location.bucket, key: object.key }),
        { name: object.name },
      );
  }
}

function buildPanel(container: HTMLElement, app: GeoLibreAppAPI | null): () => void {
  const signer = getS3UrlSigner();
  const client = createS3BrowserClient(signer, browserFetch);
  const connections = signer?.connections() ?? [];
  let controller: AbortController | null = null;
  let current: S3BrowseLocation | null = null;
  let continuationToken: string | undefined;

  const root = el("div", CSS.panel);
  root.dataset.testid = "s3-browser";
  root.append(el("div", CSS.hint, labels.hint));

  if (connections.length === 0) {
    root.append(el("div", CSS.hint, labels.noConnections));
  } else {
    const connectionRow = el("div", CSS.row);
    const select = el("select", CSS.input);
    select.setAttribute("aria-label", labels.connection);
    for (const connection of connections) {
      const option = document.createElement("option");
      option.value = connection.id;
      option.textContent =
        connection.buckets.length > 0
          ? `${connection.name} (${connection.buckets.join(", ")})`
          : connection.name;
      select.append(option);
    }
    const listBuckets = button(labels.listBuckets, CSS.button);
    listBuckets.addEventListener("click", () => void showBuckets(select.value));
    connectionRow.append(select, listBuckets);
    root.append(connectionRow);
  }

  const locationRow = el("div", CSS.row);
  const input = el("input", CSS.input);
  input.type = "text";
  input.placeholder = labels.locationPlaceholder;
  input.value = signer?.defaultLocation?.() || readLastLocation();
  input.setAttribute("aria-label", labels.locationPlaceholder);
  const go = button(labels.go, CSS.primaryButton);
  locationRow.append(input, go);
  root.append(locationRow);

  // Navigation for the folder being shown, apart from the location box.
  const navRow = el("div", CSS.row);
  const up = button(`↑ ${labels.up}`, CSS.button);
  up.disabled = true;
  // The persisted default location (Settings > Cloud Storage). Hosts without a
  // settings store fall back to the last location browsed.
  const makeDefault = button(labels.setDefault, CSS.button);
  makeDefault.style.display = signer?.setDefaultLocation ? "" : "none";
  navRow.append(up, makeDefault);
  root.append(navRow);
  makeDefault.addEventListener("click", () => {
    if (!current) return;
    signer?.setDefaultLocation?.(formatS3BrowseLocation(current));
    refreshDefaultButton();
  });

  function refreshDefaultButton(): void {
    const isDefault =
      current !== null && signer?.defaultLocation?.() === formatS3BrowseLocation(current);
    makeDefault.textContent = isDefault ? labels.isDefault : labels.setDefault;
    makeDefault.disabled = current === null || isDefault;
    up.disabled = current === null || current.prefix === "";
  }

  /** An addable file's controls. Re-synced whenever the store's layers change. */
  interface AddableEntry {
    location: S3BrowseLocation;
    object: S3BrowserObject;
    add: HTMLButtonElement;
    select: HTMLInputElement;
    pending: boolean;
  }
  const addable: AddableEntry[] = [];

  // Open project buttons of the folder shown; at most one open runs at a time.
  const openProjects: HTMLButtonElement[] = [];
  let openingProject = false;
  let projectAbort: AbortController | null = null;

  function syncEntry(entry: AddableEntry): void {
    const onMap = isOnMap(entry.object, entry.location.bucket);
    entry.add.textContent = entry.pending ? labels.adding : onMap ? labels.added : labels.add;
    // No adds while a project opens: they would land in the project it replaces.
    entry.add.disabled = entry.pending || onMap || openingProject;
    entry.select.disabled = entry.pending || onMap || openingProject;
    if (entry.select.disabled) entry.select.checked = false;
  }

  /** Selectable entries: addable files not yet on the map nor being added. */
  function selectableEntries(): AddableEntry[] {
    return addable.filter((entry) => !entry.select.disabled);
  }

  function syncSelectionBar(): void {
    const selectable = selectableEntries();
    const selected = selectable.filter((entry) => entry.select.checked);
    selectionBar.style.display = addable.length > 0 ? "flex" : "none";
    selectAll.disabled = selectable.length === 0 || batchRunning || openingProject;
    selectAll.checked = selectable.length > 0 && selected.length === selectable.length;
    selectAll.indeterminate = selected.length > 0 && selected.length < selectable.length;
    addSelected.textContent = labels.addSelected(selected.length);
    addSelected.disabled = selected.length === 0 || batchRunning || openingProject;
  }

  function syncAll(): void {
    for (const entry of addable) syncEntry(entry);
    syncSelectionBar();
  }

  const unsubscribeLayers = useAppStore.subscribe((state, previous) => {
    if (state.layers !== previous.layers) syncAll();
  });

  /**
   * Every add, single or batch, runs through this one queue, so adds never
   * overlap: each control mounts and loads on first use, and several rasters
   * starting at once would race that setup.
   */
  let addQueue: Promise<unknown> = Promise.resolve();

  /**
   * Queues one file. It is marked pending at once (so its Add button and
   * checkbox cannot queue it twice) and skipped if it reached the map while it
   * waited.
   *
   * @returns The failure message, or null when the file was added or skipped.
   */
  function enqueueAdd(entry: AddableEntry): Promise<string | null> {
    entry.pending = true;
    entry.select.checked = false;
    syncEntry(entry);
    syncSelectionBar();
    const run = addQueue.then(async (): Promise<string | null> => {
      try {
        // Inside the try so `finally` clears `pending` for a skipped file too.
        if (!app || isOnMap(entry.object, entry.location.bucket)) return null;
        const added = await addObjectToMap(app, entry.location, entry.object);
        return added ? null : labels.addFailed(entry.object.name, labels.notAddable);
      } catch (error) {
        // The add paths already turn a CORS refusal into an explanation.
        return labels.addFailed(entry.object.name, errorMessage(error));
      } finally {
        entry.pending = false;
        syncEntry(entry);
        syncSelectionBar();
      }
    });
    addQueue = run;
    return run;
  }

  function showFailures(failures: string[]): void {
    if (failures.length === 0) {
      setStatus("");
      return;
    }
    status.style.cssText = CSS.error;
    status.textContent = failures.join("\n");
  }

  // Multi-select: tick files, then add them in one go, one after another.
  let batchRunning = false;
  const selectionBar = el("div", CSS.row);
  selectionBar.style.display = "none";
  const selectAllLabel = el("label", CSS.selectLabel);
  const selectAll = el("input", "");
  selectAll.type = "checkbox";
  selectAllLabel.append(selectAll, document.createTextNode(labels.selectAll));
  const addSelected = button(labels.addSelected(0), CSS.primaryButton);
  addSelected.style.marginInlineStart = "auto";
  selectionBar.append(selectAllLabel, addSelected);
  selectAll.addEventListener("change", () => {
    for (const entry of selectableEntries()) entry.select.checked = selectAll.checked;
    syncSelectionBar();
  });
  addSelected.addEventListener("click", () => {
    const batch = selectableEntries().filter((entry) => entry.select.checked);
    if (batch.length === 0) return;
    batchRunning = true;
    syncSelectionBar();
    let done = 0;
    setStatus(labels.addingProgress(1, batch.length));
    void Promise.all(
      batch.map((entry) =>
        enqueueAdd(entry).then((failure) => {
          done += 1;
          if (done < batch.length) setStatus(labels.addingProgress(done + 1, batch.length));
          return failure;
        }),
      ),
    ).then((results) => {
      batchRunning = false;
      // Kept until the batch ends, so an early failure is not lost under the
      // progress line, and listed together.
      showFailures(results.filter((failure): failure is string => failure !== null));
      syncSelectionBar();
    });
  });

  const accessLine = el("div", CSS.location);
  const status = el("div", CSS.status);
  const list = el("div", CSS.list);
  const more = button(labels.loadMore, CSS.button);
  more.style.display = "none";
  root.append(accessLine, selectionBar, status, list, more);
  container.append(root);

  function setError(error: unknown): void {
    status.style.cssText = CSS.error;
    status.textContent = labels.error(errorMessage(error));
  }

  function setStatus(text: string): void {
    status.style.cssText = CSS.status;
    status.textContent = text;
  }

  function describeAccess(bucket: string): void {
    accessLine.textContent = signer?.covers(bucket) ? labels.signed : labels.anonymous;
  }

  function renderFolder(text: string, onOpen: () => void): HTMLButtonElement {
    const node = button("", CSS.folder);
    node.append(el("span", CSS.title, `${text}/`));
    node.addEventListener("click", onOpen);
    return node;
  }

  function renderObject(location: S3BrowseLocation, object: S3BrowserObject): HTMLElement {
    const card = el("div", CSS.card);
    card.dataset.key = object.key;
    const titleRow = el("div", CSS.row);
    titleRow.append(el("span", CSS.title, object.name));
    if (object.project) titleRow.append(el("span", CSS.badge, labels.project));
    else if (object.pointCloud) titleRow.append(el("span", CSS.badge, labels.pointCloud));
    else if (object.format !== "other") titleRow.append(el("span", CSS.badge, object.format));
    card.append(titleRow);
    const date = object.lastModified ? ` · ${object.lastModified.slice(0, 10)}` : "";
    card.append(el("div", CSS.sub, `${formatBytes(object.size)}${date}`));

    const actions = el("div", CSS.actions);
    if (object.project) {
      // A project replaces the whole map, so it opens rather than joining the
      // batch of layers.
      if (app?.openProjectFromUrl) {
        const openProject = button(labels.openProject, CSS.action);
        openProjects.push(openProject);
        openProject.disabled = openingProject;
        openProject.addEventListener("click", () => {
          const openProjectFromUrl = app.openProjectFromUrl;
          if (!openProjectFromUrl || openingProject) return;
          // One open at a time, cancelled with the panel: a project replaces
          // the whole map, so a slower second open must not overwrite the first.
          const abort = new AbortController();
          projectAbort = abort;
          openingProject = true;
          for (const other of openProjects) other.disabled = true;
          syncAll();
          openProject.textContent = labels.openingProject;
          setStatus("");
          // Let adds already queued finish first, so none lands in the new
          // project (the queue never rejects).
          void addQueue
            .then(() =>
              abort.signal.aborted ? undefined : openProjectFromUrl(object.uri, abort.signal),
            )
            .catch((error: unknown) => {
              if (!abort.signal.aborted) {
                showFailures([labels.openProjectFailed(object.name, errorMessage(error))]);
              }
            })
            .finally(() => {
              if (projectAbort === abort) projectAbort = null;
              openingProject = false;
              openProject.textContent = labels.openProject;
              for (const other of openProjects) other.disabled = false;
              syncAll();
            });
        });
        actions.append(openProject);
      } else {
        card.append(el("div", CSS.sub, labels.openProjectUnsupported));
      }
    } else if (app && canAdd(object)) {
      if (!object.pointCloud && isTooLargeToOpen(object.format, object.size)) {
        card.append(el("div", CSS.sub, labels.tooLarge));
      } else {
        const select = el("input", "");
        select.type = "checkbox";
        select.setAttribute("aria-label", `${labels.select} ${object.name}`);
        titleRow.prepend(select);
        const entry: AddableEntry = {
          location,
          object,
          add: button(labels.add, CSS.action),
          select,
          pending: false,
        };
        addable.push(entry);
        syncEntry(entry);
        select.addEventListener("change", syncSelectionBar);
        entry.add.addEventListener("click", () => {
          void enqueueAdd(entry).then((failure) => {
            if (failure) showFailures([failure]);
          });
        });
        actions.append(entry.add);
      }
    } else if (!canAdd(object)) {
      card.append(el("div", CSS.sub, labels.notAddable));
    }
    const copy = button(labels.copyUri, CSS.action);
    copy.title = object.uri;
    copy.addEventListener("click", () => {
      void navigator.clipboard?.writeText(object.uri).then(() => {
        copy.textContent = labels.copied;
      });
    });
    actions.append(copy);
    card.append(actions);
    return card;
  }

  async function showBuckets(connectionId: string): Promise<void> {
    controller?.abort();
    controller = new AbortController();
    const { signal } = controller;
    current = null;
    refreshDefaultButton();
    more.style.display = "none";
    list.replaceChildren();
    addable.length = 0;
    openProjects.length = 0;
    syncSelectionBar();
    accessLine.textContent = "";
    setStatus(labels.loading);
    try {
      const buckets = await client.listBuckets(connectionId, signal);
      if (signal.aborted) return;
      setStatus(buckets.length === 0 ? labels.empty : "");
      for (const bucket of buckets) {
        list.append(renderFolder(bucket, () => void open({ bucket, prefix: "" })));
      }
    } catch (error) {
      if (!isAbort(error)) setError(error);
    }
  }

  async function open(location: S3BrowseLocation, append = false): Promise<void> {
    controller?.abort();
    controller = new AbortController();
    const { signal } = controller;
    if (!append) {
      current = location;
      continuationToken = undefined;
      list.replaceChildren();
      addable.length = 0;
      openProjects.length = 0;
      input.value = formatS3BrowseLocation(location);
      writeLastLocation(input.value);
      describeAccess(location.bucket);
      refreshDefaultButton();
    }
    more.style.display = "none";
    setStatus(labels.loading);
    try {
      const page = await client.list(location, continuationToken, signal);
      if (signal.aborted) return;
      continuationToken = page.nextContinuationToken;
      for (const prefix of page.prefixes) {
        list.append(
          renderFolder(prefixLabel(prefix), () => void open({ bucket: location.bucket, prefix })),
        );
      }
      for (const object of describeObjects(location, page)) {
        list.append(renderObject(location, object));
      }
      setStatus(list.childElementCount === 0 ? labels.empty : "");
      syncSelectionBar();
      more.style.display = continuationToken ? "" : "none";
    } catch (error) {
      // On the web a bucket without a CORS rule for this origin fails as
      // "Failed to fetch"; explain that instead.
      if (!isAbort(error) && !signal.aborted) {
        const explained = await explainS3ReadError(
          `s3://${location.bucket}/`,
          error,
          app?.translate,
        );
        // The explanation makes its own requests; another folder may have
        // been opened meanwhile.
        if (!signal.aborted) setError(explained);
      }
    }
  }

  function openTyped(): void {
    const location = parseS3BrowseLocation(input.value);
    if (!location) {
      setError(new Error(labels.locationPlaceholder));
      return;
    }
    // A typed key without a trailing slash is treated as a folder.
    const prefix =
      location.prefix && !location.prefix.endsWith("/") ? `${location.prefix}/` : location.prefix;
    void open({ bucket: location.bucket, prefix });
  }

  go.addEventListener("click", openTyped);
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") openTyped();
  });
  up.addEventListener("click", () => {
    if (current) void open({ bucket: current.bucket, prefix: parentPrefix(current.prefix) });
  });
  more.addEventListener("click", () => {
    if (current && continuationToken) void open(current, true);
  });

  refreshDefaultButton();
  const initial = parseS3BrowseLocation(input.value);
  if (initial) void open(initial);

  return () => {
    controller?.abort();
    projectAbort?.abort();
    unsubscribeLayers();
    root.remove();
  };
}

/** The S3 Browser panel plugin. */
function createS3BrowserPlugin(): GeoLibrePlugin {
  let appRef: GeoLibreAppAPI | null = null;
  let unregisterPanel: (() => void) | null = null;
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
    id: S3_BROWSER_PLUGIN_ID,
    name: "S3 Browser",
    version: "0.1.0",
    engines: ["maplibre", "cesium", "mapbox", "arcgis"],
    // Opening a project from the panel must not close it.
    sessionScoped: true,
    activate: (app: GeoLibreAppAPI) => {
      appRef = app;
      mountedPanels.add(remount);
      unregisterPanel =
        app.registerRightPanel?.({
          id: S3_BROWSER_PLUGIN_ID,
          title: pluginDisplayTitle(app, S3_BROWSER_PLUGIN_ID, "S3 Browser"),
          dock: "replace-style",
          defaultWidth: 360,
          render: (container) => {
            mountPanel(container);
            return () => {
              disposePanel?.();
              disposePanel = null;
              if (panelContainer === container) panelContainer = null;
            };
          },
        }) ?? null;
      app.openRightPanel?.(S3_BROWSER_PLUGIN_ID);
    },
    deactivate: (app: GeoLibreAppAPI) => {
      app.closeRightPanel?.(S3_BROWSER_PLUGIN_ID);
      unregisterPanel?.();
      unregisterPanel = null;
      mountedPanels.delete(remount);
      appRef = null;
    },
  };
}

export const maplibreS3BrowserPlugin: GeoLibrePlugin = createS3BrowserPlugin();

export default maplibreS3BrowserPlugin;
