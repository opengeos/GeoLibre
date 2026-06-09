import { Button, Input } from "@geolibre/ui";
import {
  AlertTriangle,
  Check,
  Download,
  ExternalLink,
  Loader2,
  RefreshCw,
  Search,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { getPluginManager } from "../../hooks/usePlugins";
import {
  fetchPluginRegistry,
  satisfiesMinVersion,
  type PluginRegistryEntry,
} from "../../lib/plugin-registry";

interface PluginMarketplaceProps {
  /** Manifest URLs currently staged for install (the draft list). */
  installedUrls: string[];
  /** Stage a plugin for install by recording its manifest URL. */
  onInstall: (manifestUrl: string) => void;
  /** Remove a staged manifest URL. */
  onRemove: (manifestUrl: string) => void;
}

type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; entries: PluginRegistryEntry[] };

const APP_VERSION = __GEOLIBRE_VERSION__;

export function PluginMarketplace({
  installedUrls,
  onInstall,
  onRemove,
}: PluginMarketplaceProps) {
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [query, setQuery] = useState("");
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    fetchPluginRegistry()
      .then((registry) => {
        if (!cancelled) setState({ status: "ready", entries: registry.entries });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setState({
          status: "error",
          message:
            error instanceof Error
              ? error.message
              : "Could not load the plugin registry.",
        });
      });
    return () => {
      cancelled = true;
    };
  }, [reloadToken]);

  // Versions of already-registered plugins, used to flag available updates.
  // Captured per load; a newly installed plugin reflects after the next reload.
  const loadedVersions = useMemo(() => {
    const versions = new Map<string, string>();
    for (const plugin of getPluginManager().list()) {
      versions.set(plugin.id, plugin.version);
    }
    return versions;
  }, [reloadToken, installedUrls]);

  const installedSet = useMemo(
    () => new Set(installedUrls.map((url) => url.trim())),
    [installedUrls],
  );

  const refresh = useCallback(() => setReloadToken((token) => token + 1), []);

  const entries = state.status === "ready" ? state.entries : [];
  const filtered = useMemo(() => {
    const term = query.trim().toLowerCase();
    if (!term) return entries;
    return entries.filter((entry) =>
      [entry.name, entry.id, entry.description, ...(entry.categories ?? [])]
        .filter(Boolean)
        .some((field) => field!.toLowerCase().includes(term)),
    );
  }, [entries, query]);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Marketplace
          </h4>
          <p className="text-xs text-muted-foreground">
            Install curated external plugins. Installed plugins are added to the
            manifest URLs below and load after you save.
          </p>
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={refresh}
          disabled={state.status === "loading"}
        >
          <RefreshCw
            className={`h-3.5 w-3.5 ${state.status === "loading" ? "animate-spin" : ""}`}
          />
          Refresh
        </Button>
      </div>

      {state.status !== "error" ? (
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            aria-label="Search plugins"
            placeholder="Search plugins"
            className="pl-8"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
      ) : null}

      {state.status === "loading" ? (
        <div className="flex items-center gap-2 rounded-md border border-dashed p-4 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading registry…
        </div>
      ) : null}

      {state.status === "error" ? (
        <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <div className="space-y-2">
            <p>{state.message}</p>
            <Button type="button" size="sm" variant="outline" onClick={refresh}>
              <RefreshCw className="h-3.5 w-3.5" />
              Retry
            </Button>
          </div>
        </div>
      ) : null}

      {state.status === "ready" && filtered.length === 0 ? (
        <div className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
          {entries.length === 0
            ? "No plugins are listed in the registry."
            : "No plugins match your search."}
        </div>
      ) : null}

      {state.status === "ready" && filtered.length > 0 ? (
        <div className="space-y-2">
          {filtered.map((entry) => {
            const installed = installedSet.has(entry.manifestUrl.trim());
            const compatible = satisfiesMinVersion(
              APP_VERSION,
              entry.minGeoLibreVersion,
            );
            const loadedVersion = loadedVersions.get(entry.id);
            const updateAvailable =
              installed &&
              loadedVersion !== undefined &&
              loadedVersion !== entry.version;
            return (
              <div
                key={entry.id}
                className="flex items-start justify-between gap-3 rounded-md border p-3"
              >
                <div className="min-w-0 space-y-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium">
                      {entry.name}
                    </span>
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
                      >
                        <ExternalLink className="h-3.5 w-3.5" />
                      </a>
                    ) : null}
                  </div>
                  {entry.description ? (
                    <p className="text-xs text-muted-foreground">
                      {entry.description}
                    </p>
                  ) : null}
                  <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
                    {entry.author ? <span>by {entry.author}</span> : null}
                    {(entry.categories ?? []).map((category) => (
                      <span
                        key={category}
                        className="rounded-full border px-1.5 py-0.5"
                      >
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
                </div>
                <div className="shrink-0">
                  {installed ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      aria-label={`Remove ${entry.name}`}
                      onClick={() => onRemove(entry.manifestUrl)}
                    >
                      <Check className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
                      Installed
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  ) : (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={!compatible}
                      aria-label={`Install ${entry.name}`}
                      onClick={() => onInstall(entry.manifestUrl)}
                    >
                      <Download className="h-3.5 w-3.5" />
                      Install
                    </Button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
