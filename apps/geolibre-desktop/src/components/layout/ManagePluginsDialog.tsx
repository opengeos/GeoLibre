import { isAllowedPluginManifestUrl } from "@geolibre/core";
import type { MapController } from "@geolibre/map";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Input,
} from "@geolibre/ui";
import {
  AlertTriangle,
  ArrowUpCircle,
  Check,
  Download,
  ExternalLink,
  FolderOpen,
  Loader2,
  Package,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  Upload,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type RefObject,
} from "react";
import { useTranslation } from "react-i18next";
import { useDesktopSettingsStore } from "../../hooks/useDesktopSettings";
import {
  getExternalPluginLoadIssues,
  getPluginManager,
  installPluginArchive,
  installPluginArchiveFromFile,
  listPluginArchivesFromFile,
  subscribeToExternalPluginLoads,
  uninstallPluginArchiveFromFile,
  upgradeExternalPlugin,
} from "../../hooks/usePlugins";
import type { InstalledWebPlugin } from "../../lib/external-plugins";
import {
  fetchPluginRegistry,
  isNewerVersion,
  satisfiesMinVersion,
  type PluginRegistryEntry,
} from "../../lib/plugin-registry";
import { mergeStringLists } from "../../lib/string-lists";
import {
  isTauri,
  openLocalDataFileWithFallback,
  pickLocalPathWithFallback,
} from "../../lib/tauri-io";
import { openExternalLink } from "../../lib/open-external";

type ManageSection = "all" | "installed" | "not-installed" | "upgradeable" | "settings";

type RegistryState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; entries: PluginRegistryEntry[] };

const APP_VERSION = __GEOLIBRE_VERSION__;

// Stable empty reference so the visibleEntries memo doesn't churn on every
// render while the registry is loading or errored.
const EMPTY_ENTRIES: PluginRegistryEntry[] = [];

// Module-level store bindings so useSyncExternalStore sees a stable subscribe /
// snapshot identity and doesn't re-subscribe on every render.
const subscribeToPluginManager = (listener: () => void) => getPluginManager().subscribe(listener);
const getPluginManagerVersion = () => getPluginManager().getVersion();

interface ManagePluginsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mapControllerRef: RefObject<MapController | null>;
}

export function ManagePluginsDialog({
  open,
  onOpenChange,
  mapControllerRef,
}: ManagePluginsDialogProps) {
  const { t } = useTranslation();
  const desktopSettings = useDesktopSettingsStore((s) => s.desktopSettings);
  const setDesktopSettings = useDesktopSettingsStore((s) => s.setDesktopSettings);

  const [section, setSection] = useState<ManageSection>("all");
  const [registry, setRegistry] = useState<RegistryState>({
    status: "loading",
  });
  const [query, setQuery] = useState("");
  const [reloadToken, setReloadToken] = useState(0);
  const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<{
    id: string;
    message: string;
  } | null>(null);
  const [newDirectory, setNewDirectory] = useState("");
  const [newManifestUrl, setNewManifestUrl] = useState("");
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [installing, setInstalling] = useState(false);
  const [installError, setInstallError] = useState<string | null>(null);
  const [installNotice, setInstallNotice] = useState<string | null>(null);
  const [webPlugins, setWebPlugins] = useState<InstalledWebPlugin[]>([]);

  // Plugins installed from a file on the web build live in IndexedDB, so the
  // dialog tracks them separately from the registry-driven list. Desktop file
  // installs persist on disk and are not listed here.
  const refreshWebPlugins = useCallback(async () => {
    if (isTauri()) return;
    try {
      setWebPlugins(await listPluginArchivesFromFile());
    } catch {
      setWebPlugins([]);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    void refreshWebPlugins();
  }, [open, refreshWebPlugins]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const abortController = new AbortController();
    setRegistry({ status: "loading" });
    setConfirmRemoveId(null);
    setInstallError(null);
    setInstallNotice(null);
    // Don't reset busyId here: an in-flight upgrade's finally block owns it.
    // Clearing it on Refresh would re-enable the Update button mid-flight and
    // could start a second concurrent upgrade for the same manifest URL.
    // Note: closing and reopening the dialog mid-upgrade remounts the component
    // with busyId null, so the button is briefly clickable again; the per-URL
    // coalescing lock in reloadExternalUrlPlugin keeps that from double-running.
    setActionError(null);
    fetchPluginRegistry(undefined, abortController.signal)
      .then((result) => {
        if (!cancelled) {
          setRegistry({ status: "ready", entries: result.entries });
        }
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        const timedOut = error instanceof DOMException && error.name === "AbortError";
        setRegistry({
          status: "error",
          message: timedOut
            ? "Plugin registry request timed out. Check your connection and try again."
            : error instanceof Error
              ? error.message
              : "Could not load the plugin registry.",
        });
      });
    return () => {
      cancelled = true;
      // Abort the in-flight request so closing/refreshing the dialog doesn't
      // leave it running to completion on a slow connection.
      abortController.abort();
    };
  }, [open, reloadToken]);

  // Re-render when the plugin manager changes so installed/version state stays
  // live as plugins register, unregister, or upgrade. The version drives the
  // loadedVersions memo so it only rebuilds when the manager actually changes.
  const managerVersion = useSyncExternalStore(
    subscribeToPluginManager,
    getPluginManagerVersion,
    getPluginManagerVersion,
  );
  const loadedVersions = useMemo(() => {
    const versions = new Map<string, string>();
    for (const plugin of getPluginManager().list()) {
      versions.set(plugin.id, plugin.version);
    }
    return versions;
  }, [managerVersion]);
  const externalLoadIssues = useSyncExternalStore(
    subscribeToExternalPluginLoads,
    getExternalPluginLoadIssues,
    getExternalPluginLoadIssues,
  );

  const installedSet = useMemo(
    () => new Set(desktopSettings.pluginManifestUrls.map((url) => url.trim())),
    [desktopSettings.pluginManifestUrls],
  );

  // entry.manifestUrl is already trimmed/absolute (normalizeEntry resolves it
  // through new URL(...)), so only the user-supplied installedSet needs trimming.
  const isInstalled = useCallback(
    (entry: PluginRegistryEntry) => installedSet.has(entry.manifestUrl),
    [installedSet],
  );
  // An update is available only when the registry version is strictly newer
  // than the loaded one (directional, not any mismatch). isNewerVersion orders
  // a pre-release below its release, so an rc user is offered the GA build.
  const isUpgradeable = useCallback(
    (entry: PluginRegistryEntry) => {
      const loaded = loadedVersions.get(entry.id);
      return isInstalled(entry) && loaded !== undefined && isNewerVersion(entry.version, loaded);
    },
    [isInstalled, loadedVersions],
  );

  // True when the entry is in settings (so the badge reads "Installed") but the
  // plugin manager has not registered it yet — the async load is still pending
  // or failed. Used to show a "Loading…" state instead of a premature
  // "Installed" confirmation.
  const isLoadPending = useCallback(
    (entry: PluginRegistryEntry) => isInstalled(entry) && !loadedVersions.has(entry.id),
    [isInstalled, loadedVersions],
  );

  const refresh = useCallback(() => setReloadToken((token) => token + 1), []);

  const installUrl = useCallback(
    (url: string) => {
      const current = useDesktopSettingsStore.getState().desktopSettings;
      setDesktopSettings({
        ...current,
        pluginManifestUrls: mergeStringLists(current.pluginManifestUrls, [url.trim()]),
      });
    },
    [setDesktopSettings],
  );

  const uninstallUrl = useCallback(
    (url: string) => {
      const trimmed = url.trim();
      const current = useDesktopSettingsStore.getState().desktopSettings;
      setDesktopSettings({
        ...current,
        pluginManifestUrls: current.pluginManifestUrls.filter((entry) => entry.trim() !== trimmed),
      });
    },
    [setDesktopSettings],
  );

  const handleUpgrade = useCallback(
    async (entry: PluginRegistryEntry) => {
      setActionError(null);
      setBusyId(entry.id);
      try {
        await upgradeExternalPlugin(entry.manifestUrl, mapControllerRef);
      } catch (error: unknown) {
        setActionError({
          id: entry.id,
          message: error instanceof Error ? error.message : "Could not update plugin.",
        });
      } finally {
        setBusyId(null);
      }
    },
    [mapControllerRef],
  );

  const addDirectory = useCallback(
    (path: string) => {
      const trimmed = path.trim();
      if (!trimmed) return;
      const current = useDesktopSettingsStore.getState().desktopSettings;
      setDesktopSettings({
        ...current,
        additionalPluginDirectories: mergeStringLists(current.additionalPluginDirectories, [
          trimmed,
        ]),
      });
      setNewDirectory("");
      setSettingsError(null);
    },
    [setDesktopSettings],
  );

  const removeDirectory = useCallback(
    (path: string) => {
      const current = useDesktopSettingsStore.getState().desktopSettings;
      setDesktopSettings({
        ...current,
        additionalPluginDirectories: current.additionalPluginDirectories.filter(
          (entry) => entry !== path,
        ),
      });
    },
    [setDesktopSettings],
  );

  const browseDirectory = useCallback(async () => {
    try {
      const path = await pickLocalPathWithFallback({ directory: true });
      if (path) addDirectory(path);
    } catch (error) {
      setSettingsError(
        error instanceof Error ? error.message : "Could not open the directory picker.",
      );
    }
  }, [addDirectory]);

  const installFromFile = useCallback(async () => {
    setInstallError(null);
    setInstallNotice(null);
    try {
      if (isTauri()) {
        // Desktop: pick a path and let the backend validate and copy the zip
        // into the app-data plugins directory (persisted via the startup scan).
        const path = await pickLocalPathWithFallback({
          filters: [{ name: "GeoLibre plugin", extensions: ["zip"] }],
        });
        if (!path) return;
        setInstalling(true);
        const id = await installPluginArchive(path, mapControllerRef);
        setInstallNotice(`Installed plugin "${id}".`);
      } else {
        // Web: read the uploaded bytes, unpack and register client-side, and
        // persist the bundle in IndexedDB so it reloads on the next visit.
        const picked = await openLocalDataFileWithFallback({
          accept: ".zip",
          filters: [{ name: "GeoLibre plugin", extensions: ["zip"] }],
          readBinary: true,
        });
        if (!picked?.data) return;
        setInstalling(true);
        const id = await installPluginArchiveFromFile(
          picked.path,
          new Uint8Array(picked.data),
          mapControllerRef,
        );
        setInstallNotice(`Installed plugin "${id}".`);
        await refreshWebPlugins();
      }
    } catch (error) {
      setInstallError(error instanceof Error ? error.message : "Could not install the plugin.");
    } finally {
      setInstalling(false);
    }
  }, [mapControllerRef, refreshWebPlugins]);

  const removeWebPlugin = useCallback(
    async (id: string) => {
      setInstallError(null);
      setInstallNotice(null);
      try {
        await uninstallPluginArchiveFromFile(id, mapControllerRef);
        await refreshWebPlugins();
      } catch (error) {
        setInstallError(error instanceof Error ? error.message : "Could not uninstall the plugin.");
      }
    },
    [mapControllerRef, refreshWebPlugins],
  );

  const addManifestUrl = useCallback(() => {
    const trimmed = newManifestUrl.trim();
    if (!trimmed) return;
    if (!isAllowedPluginManifestUrl(trimmed)) {
      setSettingsError("Manifest URLs must use HTTPS, or HTTP on localhost, 127.0.0.1, or [::1].");
      return;
    }
    installUrl(trimmed);
    setNewManifestUrl("");
    setSettingsError(null);
  }, [newManifestUrl, installUrl]);

  const entries = registry.status === "ready" ? registry.entries : EMPTY_ENTRIES;
  const installedCount = useMemo(() => entries.filter(isInstalled).length, [entries, isInstalled]);
  const upgradeableCount = useMemo(
    () => entries.filter(isUpgradeable).length,
    [entries, isUpgradeable],
  );

  const sectionItems: Array<{ id: ManageSection; label: string }> = [
    { id: "all", label: `All (${entries.length})` },
    { id: "installed", label: `Installed (${installedCount})` },
    {
      id: "not-installed",
      label: `Not installed (${entries.length - installedCount})`,
    },
    { id: "upgradeable", label: `Upgradeable (${upgradeableCount})` },
    { id: "settings", label: "Settings" },
  ];

  const visibleEntries = useMemo(() => {
    const term = query.trim().toLowerCase();
    const matches = (entry: PluginRegistryEntry) =>
      !term ||
      [entry.name, entry.id, entry.description, ...(entry.categories ?? [])]
        .filter((field): field is string => Boolean(field))
        .some((field) => field.toLowerCase().includes(term));
    return (
      entries
        .filter((entry) => {
          if (!matches(entry)) return false;
          switch (section) {
            case "installed":
              return isInstalled(entry);
            case "not-installed":
              return !isInstalled(entry);
            case "upgradeable":
              return isUpgradeable(entry);
            default:
              return true;
          }
        })
        // Locale-aware, case-insensitive sort; plugin id breaks name ties.
        .sort(
          (a, b) =>
            a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) ||
            a.id.localeCompare(b.id),
        )
    );
  }, [entries, isInstalled, isUpgradeable, query, section]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-h-[min(88vh,760px)] max-w-3xl"
        bodyClassName="overflow-hidden p-0"
      >
        <DialogHeader className="border-b px-6 pb-4 pt-6">
          <DialogTitle>Manage Plugins</DialogTitle>
          <DialogDescription>
            Browse, install, update, and remove external GeoLibre plugins. Plugins are listed in the{" "}
            <a
              href="https://plugins.geolibre.app"
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 font-medium text-foreground underline underline-offset-2 hover:text-primary"
              onClick={(event) => {
                event.preventDefault();
                void openExternalLink("https://plugins.geolibre.app");
              }}
            >
              GeoLibre plugin registry
              <ExternalLink className="h-3 w-3" />
            </a>
            .
          </DialogDescription>
        </DialogHeader>
        <div className="grid min-h-0 grid-cols-1 md:grid-cols-[12rem_1fr]">
          <nav className="flex gap-1 overflow-x-auto border-b p-3 md:flex-col md:overflow-x-visible md:border-b-0 md:border-e">
            {sectionItems.map((item) => (
              <Button
                key={item.id}
                className="justify-start whitespace-nowrap"
                size="sm"
                type="button"
                variant={section === item.id ? "secondary" : "ghost"}
                onClick={() => {
                  setSection(item.id);
                  setConfirmRemoveId(null);
                  setActionError(null);
                }}
              >
                {item.label}
              </Button>
            ))}
          </nav>
          <div className="min-h-0 space-y-3 overflow-y-auto p-6">
            {section === "settings" ? (
              <SettingsTab
                directories={desktopSettings.additionalPluginDirectories}
                manifestUrls={desktopSettings.pluginManifestUrls}
                newDirectory={newDirectory}
                newManifestUrl={newManifestUrl}
                error={settingsError}
                installing={installing}
                installError={installError}
                installNotice={installNotice}
                installedFromFile={webPlugins}
                onInstallFromFile={() => void installFromFile()}
                onUninstallFromFile={(id) => void removeWebPlugin(id)}
                onNewDirectoryChange={setNewDirectory}
                onNewManifestUrlChange={(value) => {
                  setNewManifestUrl(value);
                  setSettingsError(null);
                }}
                onAddDirectory={() => addDirectory(newDirectory)}
                onBrowseDirectory={() => void browseDirectory()}
                onRemoveDirectory={removeDirectory}
                onAddManifestUrl={addManifestUrl}
                onRemoveManifestUrl={uninstallUrl}
              />
            ) : (
              <>
                <div className="flex items-center justify-between gap-3">
                  <div className="relative flex-1">
                    <Search className="pointer-events-none absolute start-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      aria-label="Search plugins"
                      placeholder="Search plugins"
                      className="ps-8"
                      value={query}
                      onChange={(event) => setQuery(event.target.value)}
                    />
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={refresh}
                    disabled={registry.status === "loading"}
                  >
                    <RefreshCw
                      className={`h-3.5 w-3.5 ${registry.status === "loading" ? "animate-spin" : ""}`}
                    />
                    Refresh
                  </Button>
                </div>

                {registry.status === "loading" ? (
                  <div className="flex items-center gap-2 rounded-md border border-dashed p-4 text-sm text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Loading registry…
                  </div>
                ) : null}

                {registry.status === "error" ? (
                  <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive">
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                    <div className="space-y-2">
                      <p>{registry.message}</p>
                      <Button type="button" size="sm" variant="outline" onClick={refresh}>
                        <RefreshCw className="h-3.5 w-3.5" />
                        Retry
                      </Button>
                    </div>
                  </div>
                ) : null}

                {registry.status === "ready" && visibleEntries.length === 0 ? (
                  <div className="flex flex-col items-center gap-2 rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
                    <Package className="h-5 w-5" />
                    {entries.length === 0
                      ? "No plugins are listed in the registry."
                      : "No plugins here."}
                  </div>
                ) : null}

                {registry.status === "ready" &&
                  visibleEntries.map((entry) => {
                    const installed = isInstalled(entry);
                    const compatible = satisfiesMinVersion(APP_VERSION, entry.minGeoLibreVersion);
                    const updateAvailable = isUpgradeable(entry);
                    const loadPending = isLoadPending(entry);
                    const loadIssue = externalLoadIssues.get(entry.manifestUrl);
                    return (
                      <div
                        key={entry.id}
                        className="flex items-start justify-between gap-3 rounded-md border p-3"
                      >
                        <div className="min-w-0 space-y-1">
                          <div className="flex items-center gap-2">
                            <span className="truncate text-sm font-medium">{entry.name}</span>
                            <span className="shrink-0 text-xs text-muted-foreground">
                              v{entry.version}
                            </span>
                            {entry.homepage ? (
                              <a
                                href={entry.homepage}
                                target="_blank"
                                rel="noreferrer"
                                className="shrink-0 text-muted-foreground hover:text-foreground"
                                aria-label={`Open ${entry.name} homepage`}
                                onClick={(event) => {
                                  event.preventDefault();
                                  if (entry.homepage) {
                                    void openExternalLink(entry.homepage);
                                  }
                                }}
                              >
                                <ExternalLink className="h-3.5 w-3.5" />
                              </a>
                            ) : null}
                          </div>
                          {entry.description ? (
                            <p className="text-xs text-muted-foreground">{entry.description}</p>
                          ) : null}
                          <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
                            {entry.author ? <span>by {entry.author}</span> : null}
                            {(entry.categories ?? []).map((category) => (
                              <span key={category} className="rounded-full border px-1.5 py-0.5">
                                {category}
                              </span>
                            ))}
                            {updateAvailable ? (
                              <span className="rounded-full border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-amber-600 dark:text-amber-400">
                                update available
                              </span>
                            ) : null}
                            {!compatible ? (
                              <span className="text-destructive">
                                requires GeoLibre {entry.minGeoLibreVersion}+
                              </span>
                            ) : null}
                          </div>
                          {actionError?.id === entry.id ? (
                            <p className="text-[11px] text-destructive">{actionError.message}</p>
                          ) : null}
                          {installed && loadIssue ? (
                            <p className="text-[11px] text-destructive">
                              {t("managePlugins.failedToLoad", {
                                message: loadIssue,
                              })}
                            </p>
                          ) : null}
                        </div>
                        <div className="flex shrink-0 items-center gap-1.5">
                          {!installed ? (
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              disabled={!compatible}
                              aria-label={`Install ${entry.name}`}
                              onClick={() => installUrl(entry.manifestUrl)}
                            >
                              <Download className="h-3.5 w-3.5" />
                              Install
                            </Button>
                          ) : confirmRemoveId === entry.id ? (
                            <>
                              <span className="text-xs text-muted-foreground">Remove?</span>
                              <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                className="text-destructive"
                                aria-label={`Confirm uninstall ${entry.name}`}
                                onClick={() => {
                                  uninstallUrl(entry.manifestUrl);
                                  setConfirmRemoveId(null);
                                }}
                              >
                                Uninstall
                              </Button>
                              <Button
                                type="button"
                                size="sm"
                                variant="ghost"
                                onClick={() => setConfirmRemoveId(null)}
                              >
                                Cancel
                              </Button>
                            </>
                          ) : (
                            <>
                              {updateAvailable ? (
                                <Button
                                  type="button"
                                  size="sm"
                                  variant="outline"
                                  disabled={busyId === entry.id}
                                  aria-label={`Update ${entry.name}`}
                                  onClick={() => void handleUpgrade(entry)}
                                >
                                  {busyId === entry.id ? (
                                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                  ) : (
                                    <ArrowUpCircle className="h-3.5 w-3.5" />
                                  )}
                                  Update
                                </Button>
                              ) : null}
                              {loadIssue ? (
                                <span className="flex items-center gap-1 text-xs text-destructive">
                                  <AlertTriangle className="h-3.5 w-3.5" />
                                  {t("managePlugins.failed")}
                                </span>
                              ) : loadPending ? (
                                <span className="flex items-center gap-1 text-xs text-muted-foreground">
                                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                  Loading…
                                </span>
                              ) : (
                                <span className="flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400">
                                  <Check className="h-3.5 w-3.5" />
                                  Installed
                                </span>
                              )}
                              <Button
                                type="button"
                                size="icon"
                                variant="ghost"
                                className="h-8 w-8"
                                disabled={busyId === entry.id}
                                aria-label={`Uninstall ${entry.name}`}
                                onClick={() => {
                                  setActionError(null);
                                  setConfirmRemoveId(entry.id);
                                }}
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </Button>
                            </>
                          )}
                        </div>
                      </div>
                    );
                  })}
              </>
            )}
          </div>
        </div>
        <div className="flex justify-end border-t px-6 py-4">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

interface SettingsTabProps {
  directories: string[];
  manifestUrls: string[];
  newDirectory: string;
  newManifestUrl: string;
  error: string | null;
  installing: boolean;
  installError: string | null;
  installNotice: string | null;
  installedFromFile: InstalledWebPlugin[];
  onInstallFromFile: () => void;
  onUninstallFromFile: (id: string) => void;
  onNewDirectoryChange: (value: string) => void;
  onNewManifestUrlChange: (value: string) => void;
  onAddDirectory: () => void;
  onBrowseDirectory: () => void;
  onRemoveDirectory: (path: string) => void;
  onAddManifestUrl: () => void;
  onRemoveManifestUrl: (url: string) => void;
}

function SettingsTab({
  directories,
  manifestUrls,
  newDirectory,
  newManifestUrl,
  error,
  installing,
  installError,
  installNotice,
  installedFromFile,
  onInstallFromFile,
  onUninstallFromFile,
  onNewDirectoryChange,
  onNewManifestUrlChange,
  onAddDirectory,
  onBrowseDirectory,
  onRemoveDirectory,
  onAddManifestUrl,
  onRemoveManifestUrl,
}: SettingsTabProps) {
  return (
    <div className="space-y-5">
      <div className="rounded-md border bg-muted/40 p-3 text-xs text-muted-foreground">
        GeoLibre always scans its app data plugins directory. Install a packaged plugin (.zip) from
        a file, or add additional local directories (desktop-only). Manifest URLs (including
        marketplace installs) are loaded over the network; changes here apply immediately.
      </div>

      <div className="space-y-3">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Install from file
        </h4>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="shrink-0"
            disabled={installing}
            onClick={onInstallFromFile}
          >
            {installing ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Upload className="h-3.5 w-3.5" />
            )}
            Choose .zip…
          </Button>
          <p className="text-xs text-muted-foreground">
            {isTauri()
              ? "Copy a packaged plugin archive into GeoLibre's plugins directory."
              : "Load a packaged plugin archive; it is stored in your browser and reloads on your next visit."}
          </p>
        </div>
        {installError ? <p className="text-xs text-destructive">{installError}</p> : null}
        {installNotice ? (
          <p className="text-xs text-emerald-600 dark:text-emerald-400">{installNotice}</p>
        ) : null}
        {installedFromFile.length > 0 ? (
          <div className="space-y-2">
            {installedFromFile.map((plugin) => (
              <div key={plugin.id} className="flex items-center gap-2 rounded-md border p-2">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-xs font-medium">{plugin.name}</span>
                    <span className="shrink-0 text-[11px] text-muted-foreground">
                      v{plugin.version}
                    </span>
                  </div>
                  <span className="truncate text-[11px] text-muted-foreground">
                    {plugin.archiveName}
                  </span>
                </div>
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className="h-8 w-8 shrink-0"
                  aria-label={`Uninstall ${plugin.name}`}
                  onClick={() => onUninstallFromFile(plugin.id)}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            ))}
          </div>
        ) : null}
      </div>

      <div className="space-y-3">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Local directories
        </h4>
        <div className="flex items-center gap-2">
          <Input
            aria-label="Plugin directory"
            placeholder="/path/to/geolibre-plugin"
            value={newDirectory}
            onChange={(event) => onNewDirectoryChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") onAddDirectory();
            }}
          />
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="h-8 w-8 shrink-0"
            aria-label="Browse plugin directory"
            onClick={onBrowseDirectory}
          >
            <FolderOpen className="h-3.5 w-3.5" />
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="shrink-0"
            onClick={onAddDirectory}
          >
            <Plus className="h-3.5 w-3.5" />
            Add
          </Button>
        </div>
        {directories.length === 0 ? (
          <div className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
            No additional plugin directories configured.
          </div>
        ) : (
          <div className="space-y-2">
            {directories.map((directory) => (
              <div key={directory} className="flex items-center gap-2 rounded-md border p-2">
                <span className="min-w-0 flex-1 truncate text-xs">{directory}</span>
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className="h-8 w-8 shrink-0"
                  aria-label={`Remove ${directory}`}
                  onClick={() => onRemoveDirectory(directory)}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="space-y-3">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Manifest URLs
        </h4>
        <div className="flex items-center gap-2">
          <Input
            aria-label="Plugin manifest URL"
            placeholder="https://example.com/plugin/plugin.json"
            value={newManifestUrl}
            onChange={(event) => onNewManifestUrlChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") onAddManifestUrl();
            }}
          />
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="shrink-0"
            onClick={onAddManifestUrl}
          >
            <Plus className="h-3.5 w-3.5" />
            Add
          </Button>
        </div>
        {error ? <p className="text-xs text-destructive">{error}</p> : null}
        {manifestUrls.length === 0 ? (
          <div className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
            No plugin manifest URLs configured.
          </div>
        ) : (
          <div className="space-y-2">
            {manifestUrls.map((url) => (
              <div key={url} className="flex items-center gap-2 rounded-md border p-2">
                <span className="min-w-0 flex-1 truncate text-xs">{url}</span>
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className="h-8 w-8 shrink-0"
                  aria-label={`Remove ${url}`}
                  onClick={() => onRemoveManifestUrl(url)}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
