// The standalone Bookmark panel.
// Split out of maplibre-components.ts (opengeos/GeoLibre#2633).

import { useAppStore } from "@geolibre/core";
import type {
  BookmarkControl,
  BookmarkControlOptions,
  BookmarkExportMode,
  MapBookmark,
} from "maplibre-gl-components";
import type { GeoLibreAppAPI, GeoLibreMapControlPosition } from "../../types";
import { type BookmarkControlConstructor, getComponentsConstructors } from "./constructors";

const bookmarkControlPosition: GeoLibreMapControlPosition = "top-left";

/**
 * User-facing strings for the BookmarkControl. Defaults are English; the
 * desktop shell pushes translated values via {@link setBookmarkLabels} since
 * this package is framework-agnostic and has no react-i18next access.
 */
const bookmarkLabels = {
  captureStateLabel: "Include complete layer state (active, inactive, and layer order)",
  captureStateTooltip:
    "Applies to the bookmark you save next, not as a global setting. Leave it on to restore exactly this layer arrangement later.",
  exportLabel: "Export",
  exportSelectedLabel: "Export Selected",
  exportAllLabel: "Export All",
  newFolderLabel: "New Folder",
  defaultFolderName: "Folder",
};

/** Override the BookmarkControl labels with translated text. */
export function setBookmarkLabels(labels: Partial<typeof bookmarkLabels>): void {
  for (const [key, value] of Object.entries(labels)) {
    // Only overwrite when the caller actually supplied the key; an omitted key
    // keeps the English default rather than being blanked out.
    if (value !== undefined) bookmarkLabels[key as keyof typeof bookmarkLabels] = value;
  }
}

/**
 * Capture which layers are currently visible so a bookmark can restore the same
 * displayed set later. Always records the set (empty when no layers are
 * visible) so the restore faithfully reproduces the displayed state.
 */
function captureVisibleLayers(): Record<string, unknown> {
  const { layers } = useAppStore.getState();
  return {
    visibleLayerIds: layers.filter((layer) => layer.visible).map((l) => l.id),
  };
}

/**
 * Restore the visible-layer set captured with a bookmark: show the layers that
 * were visible, hide the rest. Captured layers that no longer exist are skipped
 * (they cannot be re-added from a view bookmark).
 */
function restoreVisibleLayers(extra: Record<string, unknown> | undefined): void {
  const ids = extra?.visibleLayerIds;
  if (!Array.isArray(ids)) return;
  const wanted = new Set(ids.filter((id): id is string => typeof id === "string"));
  const { layers } = useAppStore.getState();
  // Apply every visibility change in one store update (instead of one per layer)
  // so restoring a bookmark triggers a single re-render and layer-sync pass.
  // Unchanged layers keep their identity so the sync skips them.
  let changed = false;
  const next = layers.map((layer) => {
    const shouldShow = wanted.has(layer.id);
    if (layer.visible === shouldShow) return layer;
    changed = true;
    return { ...layer, visible: shouldShow };
  });
  if (changed) {
    useAppStore.setState({ layers: next, isDirty: true });
  }
  const present = new Set(layers.map((layer) => layer.id));
  const missing = [...wanted].filter((id) => !present.has(id)).length;
  if (missing > 0) {
    console.info(
      `BookmarkControl: ${missing} captured layer(s) are no longer present and were skipped.`,
    );
  }
}

const BOOKMARK_OPTIONS = {
  backgroundColor: "hsl(var(--popover))",
  className: "geolibre-bookmark-control",
  collapsed: false,
  fontColor: "hsl(var(--popover-foreground))",
  maxHeight: 520,
  panelWidth: 280,
  position: bookmarkControlPosition,
  storageKey: "geolibre-bookmarks",
  // Resizable panel and drag reordering are on by default upstream; enable
  // per-bookmark export selection and visible-layer capture here. Labels and
  // the capture tooltip are applied per-instance in createBookmarkControl so
  // they pick up the translated strings.
  selectable: true,
  // Always offer an explicit "Export All" plus a contextual "Export Selected"
  // (issue #794), and drop the low-value zoom/date metadata from each card.
  showExportAll: true,
  showMetadata: false,
  // Let users organize bookmarks into folders, mirroring the Layers panel's
  // groups: create a folder, drag bookmarks in/out, expand/collapse (issue
  // #794). Folder labels are applied per-instance in createBookmarkControl so
  // they pick up the translated strings.
  groupable: true,
  captureState: captureVisibleLayers,
  restoreState: restoreVisibleLayers,
} satisfies BookmarkControlOptions;

let bookmarkControl: BookmarkControl | null = null;
let bookmarkControlMounted = false;
let bookmarkPanelVisible = false;
const bookmarkPanelListeners = new Set<() => void>();

// Standalone Bookmark panel, opened on demand from the Controls menu.
export function openBookmarkPanel(app: GeoLibreAppAPI): void {
  void openStandaloneBookmarkControl(app);
}

export function closeBookmarkPanel(app: GeoLibreAppAPI): void {
  teardownBookmarkControl(app);
}

export function isBookmarkPanelVisible(): boolean {
  return bookmarkPanelVisible;
}

export function subscribeBookmarkPanel(listener: () => void): () => void {
  bookmarkPanelListeners.add(listener);
  return () => bookmarkPanelListeners.delete(listener);
}

async function openStandaloneBookmarkControl(app: GeoLibreAppAPI): Promise<boolean> {
  const { BookmarkControl: BookmarkControlClass } = await getComponentsConstructors();

  bookmarkControl ??= createBookmarkControl(BookmarkControlClass, app);

  if (!bookmarkControlMounted) {
    const added = app.addMapControl(bookmarkControl, bookmarkControlPosition);
    if (!added) {
      bookmarkControl = null;
      return false;
    }
    bookmarkControlMounted = true;
  }

  setTimeout(() => {
    if (!bookmarkControl) return;
    bookmarkControl.show();
    bookmarkControl.expand();
    setBookmarkPanelVisible(true);
  }, 0);
  return true;
}

function createBookmarkControl(
  BookmarkControlClass: BookmarkControlConstructor,
  app: GeoLibreAppAPI,
): BookmarkControl {
  const control = new BookmarkControlClass({
    ...BOOKMARK_OPTIONS,
    captureStateLabel: bookmarkLabels.captureStateLabel,
    captureStateTooltip: bookmarkLabels.captureStateTooltip,
    exportLabel: bookmarkLabels.exportLabel,
    exportSelectedLabel: bookmarkLabels.exportSelectedLabel,
    exportAllLabel: bookmarkLabels.exportAllLabel,
    newFolderLabel: bookmarkLabels.newFolderLabel,
    defaultFolderName: bookmarkLabels.defaultFolderName,
  });
  routeBookmarkFileIoThroughHost(control, app);
  return control;
}

/**
 * The BookmarkControl's built-in Import/Export use a Blob `<a download>` and a
 * hidden `<input type="file">`, which do not work inside the Tauri WebView.
 * Override the control's instance file-I/O methods so the host's runtime-aware
 * helpers (a native dialog under Tauri, a download/file-input on the web) are
 * used instead. Falls back to the control's originals if the host does not
 * provide the helpers.
 */
function routeBookmarkFileIoThroughHost(control: BookmarkControl, app: GeoLibreAppAPI): void {
  // `_exportToFile`/`_importFromFile` are private (underscore-prefixed) members
  // of BookmarkControl as of maplibre-gl-components@0.21.0. If a future version
  // renames them, the overrides below silently stop being called and file I/O
  // regresses to the WebView-incompatible Blob/file-input path — so warn loudly
  // to flag it when bumping the dependency. The public `exportBookmarks(mode?)`
  // signature is load-bearing too (added in 0.22.6): if a future version drops
  // the `mode` arg, "Export Selected" would silently export everything, since
  // the extra argument becomes a no-op. Re-verify both when bumping.
  const io = control as unknown as {
    _exportToFile?: (mode?: BookmarkExportMode) => void;
    _importFromFile?: () => void;
    exportBookmarks: (mode?: BookmarkExportMode) => string;
    importBookmarks: (bookmarks: MapBookmark[]) => unknown;
  };
  if (!io._exportToFile || !io._importFromFile) {
    console.warn(
      "BookmarkControl: _exportToFile/_importFromFile not found; Tauri-aware " +
        "Import/Export overrides are inactive. Check maplibre-gl-components.",
    );
    return;
  }
  const originalExport = io._exportToFile.bind(control);
  const originalImport = io._importFromFile.bind(control);
  const dialogOptions = {
    description: "Bookmarks",
    extensions: ["json"],
    mimeType: "application/json",
    // Let the user name the export when the browser has no native save picker
    // (Firefox, Safari); Tauri and Chromium already prompt for a name.
    promptName: true,
  };

  io._exportToFile = (mode) => {
    if (!app.exportTextFile) {
      originalExport(mode);
      return;
    }
    app.exportTextFile("bookmarks.json", io.exportBookmarks(mode), dialogOptions);
  };

  io._importFromFile = () => {
    if (!app.importTextFile) {
      originalImport();
      return;
    }
    app
      .importTextFile(dialogOptions)
      .then((text) => {
        if (!text || control !== bookmarkControl) return;
        let data: unknown;
        try {
          data = JSON.parse(text);
        } catch {
          console.warn("BookmarkControl: failed to parse imported file");
          return;
        }
        if (!Array.isArray(data)) {
          console.warn("BookmarkControl: imported data is not an array");
          return;
        }
        const valid = data.filter(
          (bookmark): bookmark is MapBookmark =>
            !!bookmark &&
            typeof (bookmark as MapBookmark).name === "string" &&
            Number.isFinite((bookmark as MapBookmark).lng) &&
            Number.isFinite((bookmark as MapBookmark).lat) &&
            Number.isFinite((bookmark as MapBookmark).zoom),
        );
        if (valid.length === 0) {
          console.warn("BookmarkControl: no valid bookmarks found in file");
          return;
        }
        io.importBookmarks(valid);
      })
      .catch((error) => {
        console.warn("BookmarkControl: import failed", error);
      });
  };
}

export function teardownBookmarkControl(app: GeoLibreAppAPI): void {
  if (bookmarkControl && bookmarkControlMounted) {
    app.removeMapControl(bookmarkControl);
  }
  bookmarkControl = null;
  bookmarkControlMounted = false;
  setBookmarkPanelVisible(false);
}

function setBookmarkPanelVisible(visible: boolean): void {
  if (bookmarkPanelVisible === visible) return;
  bookmarkPanelVisible = visible;
  for (const listener of bookmarkPanelListeners) {
    listener();
  }
}
