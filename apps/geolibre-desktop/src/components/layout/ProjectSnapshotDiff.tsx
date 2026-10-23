import {
  useAppStore,
  type AppState,
  type LayerDiff,
  type ProjectDiff,
  type ProjectValueChange,
} from "@geolibre/core";
import { Button, Label, Select } from "@geolibre/ui";
import { ArrowLeft, ArrowRight, ChevronRight } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { projectChanged } from "../../lib/project-broadcast-changed";
import { createProjectDiffClient, type ProjectDiffClient } from "../../lib/project-diff-client";
import type { ProjectHistorySnapshot } from "../../lib/project-history-store";

/** `targetId` value meaning "the live project". */
export const CURRENT_PROJECT_TARGET = "current";

/** Quiet time after a live project change before the comparison re-runs. */
const LIVE_DIFF_DEBOUNCE_MS = 300;

/** Worker cache key for one revision of the live project. */
function currentKey(revision: number, liveRevision: number): string {
  return `current:${revision}:${liveRevision}`;
}

interface ProjectSnapshotDiffProps {
  /** The snapshot the user chose to compare. */
  base: ProjectHistorySnapshot;
  /** Every snapshot of this project, for the "Compare with" picker. */
  snapshots: ProjectHistorySnapshot[];
  /** {@link CURRENT_PROJECT_TARGET} or another snapshot's id. */
  targetId: string;
  onTargetChange: (targetId: string) => void;
  onBack: () => void;
  /** Serializes the live project in its saved shape; may throw when too large. */
  getCurrentProjectContent: () => string;
  /**
   * Restores one layer from `base`; returns true on success. Offered only
   * when comparing against the current project.
   */
  onRestoreLayer?: (snapshot: ProjectHistorySnapshot, layerId: string) => boolean;
}

type DiffResult =
  | {
      ok: true;
      diff: ProjectDiff;
      beforeLabel: string;
      afterLabel: string;
      againstCurrent: boolean;
    }
  | { ok: false; error: "snapshot" | "current" };

/**
 * Whether a store change touches a field the current-project snapshot reads:
 * the autosave trigger set plus the fields it leaves to other channels.
 */
function snapshotInputsChanged(state: AppState, previous: AppState): boolean {
  return (
    projectChanged(state, previous) ||
    state.mapView !== previous.mapView ||
    state.comments !== previous.comments ||
    state.printLayout !== previous.printLayout ||
    state.projectPlugins !== previous.projectPlugins ||
    state.projectInteraction !== previous.projectInteraction
  );
}

/**
 * Grouped, collapsible summary of what changed between a snapshot and the
 * current project (or a second snapshot), with per-layer restore.
 */
export function ProjectSnapshotDiff({
  base,
  snapshots,
  targetId,
  onTargetChange,
  onBack,
  getCurrentProjectContent,
  onRestoreLayer,
}: ProjectSnapshotDiffProps) {
  const { t, i18n } = useTranslation();
  // Bumped after a layer restore so the comparison re-reads the live project.
  const [revision, setRevision] = useState(0);
  const [restoredName, setRestoredName] = useState<string | null>(null);
  const formatDate = useMemo(() => {
    const format = new Intl.DateTimeFormat(i18n.language, {
      dateStyle: "medium",
      timeStyle: "medium",
    });
    return (iso: string) => format.format(new Date(iso));
  }, [i18n.language]);

  // The live project is re-read after a layer restore or whenever a persisted
  // project field changes in the store (an Undo, a basemap switch, a sync
  // edit), so the diff and its restore buttons never describe a stale
  // project. Changes are debounced: a burst (a camera animation behind the
  // dialog, a collaborator typing) costs one re-serialization, not one each.
  const [liveRevision, setLiveRevision] = useState(0);
  useEffect(() => {
    if (targetId !== CURRENT_PROJECT_TARGET) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = useAppStore.subscribe((state, previous) => {
      if (!snapshotInputsChanged(state, previous)) return;
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        setLiveRevision((value) => value + 1);
      }, LIVE_DIFF_DEBOUNCE_MS);
    });
    return () => {
      unsubscribe();
      if (timer !== null) clearTimeout(timer);
    };
  }, [targetId]);

  // Parsing and diffing run in a worker, which keeps each parsed snapshot so
  // the differ's per-feature hash cache hits on the next comparison. One
  // worker per open compare view.
  const [client, setClient] = useState<ProjectDiffClient | null>(null);
  useEffect(() => {
    const next = createProjectDiffClient();
    setClient(next);
    return () => next.dispose();
  }, []);

  // The view holds its snapshots' content, so it keeps working when autosave
  // evicts one; but when the history list is refreshed without the snapshot
  // being viewed, leave the view rather than compare against a snapshot that
  // is no longer in the history. A compared snapshot that is gone falls back
  // to the current project. The worker drops what it no longer needs.
  const snapshotIds = snapshots.map((snapshot) => snapshot.id).join("\n");
  useEffect(() => {
    const ids = new Set(snapshotIds.split("\n"));
    if (!ids.has(base.id)) {
      onBack();
      return;
    }
    if (targetId !== CURRENT_PROJECT_TARGET && !ids.has(targetId)) {
      onTargetChange(CURRENT_PROJECT_TARGET);
      return;
    }
    // Keep the live project's current key too, so the next comparison does
    // not have to re-serialize it.
    client?.retain([...ids, currentKey(revision, liveRevision)]);
    // The navigation callbacks are recreated by the parent on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshotIds, base.id, targetId, client, revision, liveRevision]);

  // The shown result stays up while a newer comparison runs (`computing`).
  const [result, setResult] = useState<DiffResult | null>(null);
  const [computing, setComputing] = useState(true);
  // Read inside the comparison effect without re-running it on every
  // history refresh; eviction is handled by the effect above.
  const snapshotsRef = useRef(snapshots);
  useEffect(() => {
    snapshotsRef.current = snapshots;
  }, [snapshots]);
  useEffect(() => {
    if (!client) return;
    let cancelled = false;
    const settle = (next: DiffResult) => {
      if (cancelled) return;
      setResult(next);
      setComputing(false);
    };
    setComputing(true);
    const source = (snapshot: ProjectHistorySnapshot) => ({
      key: snapshot.id,
      content: () => snapshot.content,
    });
    void (async () => {
      if (targetId === CURRENT_PROJECT_TARGET) {
        let outcome;
        try {
          outcome = await client.compare(source(base), {
            key: currentKey(revision, liveRevision),
            content: getCurrentProjectContent,
          });
        } catch (error) {
          // Serializing the live project can fail on its own (a project too
          // large to serialize throws RangeError), which is not the
          // snapshot's fault.
          console.error("Could not read the current project.", error);
          settle({ ok: false, error: "current" });
          return;
        }
        settle(
          outcome.ok
            ? {
                ok: true,
                diff: outcome.diff,
                beforeLabel: formatDate(base.createdAt),
                afterLabel: t("projectHistory.diff.current"),
                againstCurrent: true,
              }
            : { ok: false, error: outcome.side === "after" ? "current" : "snapshot" },
        );
        return;
      }
      const other = snapshotsRef.current.find((snapshot) => snapshot.id === targetId);
      if (!other) {
        settle({ ok: false, error: "snapshot" });
        return;
      }
      // Always read oldest to newest, whichever row was picked first.
      const [older, newer] = other.createdAt < base.createdAt ? [other, base] : [base, other];
      const outcome = await client.compare(source(older), source(newer));
      settle(
        outcome.ok
          ? {
              ok: true,
              diff: outcome.diff,
              beforeLabel: formatDate(older.createdAt),
              afterLabel: formatDate(newer.createdAt),
              againstCurrent: false,
            }
          : { ok: false, error: "snapshot" },
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [client, base, targetId, getCurrentProjectContent, formatDate, t, revision, liveRevision]);

  // Not while a newer comparison runs: the shown diff may already be out of
  // date, and a restore must act on what the user is looking at.
  const restoreLayer =
    !computing && result?.ok && result.againstCurrent && onRestoreLayer
      ? (layer: LayerDiff) => {
          if (onRestoreLayer(base, layer.id)) {
            setRestoredName(layer.name);
            setRevision((value) => value + 1);
          }
        }
      : undefined;

  return (
    <div className="space-y-3" data-testid="project-snapshot-diff">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <Button size="sm" variant="ghost" onClick={onBack} className="gap-1">
          <ArrowLeft className="h-4 w-4 rtl:rotate-180" aria-hidden="true" />
          {t("projectHistory.diff.back")}
        </Button>
        <div className="flex min-w-56 flex-col gap-1">
          <Label htmlFor="project-diff-target" className="text-xs">
            {t("projectHistory.diff.compareWith")}
          </Label>
          <Select
            id="project-diff-target"
            value={targetId}
            onChange={(event) => {
              setRestoredName(null);
              onTargetChange(event.target.value);
            }}
          >
            <option value={CURRENT_PROJECT_TARGET}>{t("projectHistory.diff.current")}</option>
            {snapshots
              .filter((snapshot) => snapshot.id !== base.id)
              .map((snapshot) => (
                <option key={snapshot.id} value={snapshot.id}>
                  {t("projectHistory.diff.snapshotOption", {
                    date: formatDate(snapshot.createdAt),
                  })}
                </option>
              ))}
          </Select>
        </div>
      </div>
      {restoredName !== null ? (
        <p role="status" className="rounded-md border p-2 text-sm">
          {t("projectHistory.diff.layerRestored", { name: restoredName })}
        </p>
      ) : null}
      {result === null ? (
        <p role="status" className="py-6 text-center text-sm text-muted-foreground">
          {t("projectHistory.diff.comparing")}
        </p>
      ) : !result.ok ? (
        <p
          role="alert"
          className="rounded-md border border-destructive/50 p-3 text-sm text-destructive"
        >
          {result.error === "current"
            ? t("projectHistory.diff.currentError")
            : t("projectHistory.diff.parseError")}
        </p>
      ) : (
        <DiffSummary
          busy={computing}
          diff={result.diff}
          beforeLabel={result.beforeLabel}
          afterLabel={result.afterLabel}
          onRestoreLayer={restoreLayer}
        />
      )}
    </div>
  );
}

function DiffSummary({
  busy,
  diff,
  beforeLabel,
  afterLabel,
  onRestoreLayer,
}: {
  /** A newer comparison is running; the shown one may be out of date. */
  busy: boolean;
  diff: ProjectDiff;
  beforeLabel: string;
  afterLabel: string;
  onRestoreLayer?: (layer: LayerDiff) => void;
}) {
  const { t } = useTranslation();
  const { layers } = diff;
  const layerCount = layers.added.length + layers.removed.length + layers.changed.length;
  const mapCount = diff.camera.length + diff.basemap.length + diff.projection.length;
  const pluginCount =
    diff.plugins.length + diff.pluginManifests.added.length + diff.pluginManifests.removed.length;
  const projectCount = diff.metadata.length + diff.preferences.length + diff.sections.length;
  return (
    <div className="space-y-2" aria-busy={busy}>
      <p className="text-sm text-muted-foreground">
        {t("projectHistory.diff.range", { before: beforeLabel, after: afterLabel })}
        {" · "}
        {t("projectHistory.diff.changeCount", { count: diff.changeCount })}
        {busy ? (
          <>
            {" · "}
            {t("projectHistory.diff.updating")}
          </>
        ) : null}
      </p>
      {diff.changeCount === 0 ? (
        <p className="py-6 text-center text-sm text-muted-foreground">
          {t("projectHistory.diff.noChanges")}
        </p>
      ) : null}
      {layerCount > 0 || layers.reordered ? (
        <DiffGroup title={t("projectHistory.diff.layers")} count={layerCount}>
          {layers.reordered ? (
            <p className="text-xs text-muted-foreground">{t("projectHistory.diff.layerOrder")}</p>
          ) : null}
          {layers.added.map((layer) => (
            <LayerRow key={layer.id} layer={layer} />
          ))}
          {layers.removed.map((layer) => (
            <LayerRow key={layer.id} layer={layer} onRestore={onRestoreLayer} />
          ))}
          {layers.changed.map((layer) => (
            <LayerRow key={layer.id} layer={layer} onRestore={onRestoreLayer} />
          ))}
        </DiffGroup>
      ) : null}
      {mapCount > 0 ? (
        <DiffGroup title={t("projectHistory.diff.map")} count={mapCount}>
          <ChangeList title={t("projectHistory.diff.camera")} changes={diff.camera} />
          <ChangeList title={t("projectHistory.diff.basemap")} changes={diff.basemap} />
          <ChangeList title={t("projectHistory.diff.projection")} changes={diff.projection} />
        </DiffGroup>
      ) : null}
      {pluginCount > 0 ? (
        <DiffGroup title={t("projectHistory.diff.plugins")} count={pluginCount}>
          {diff.plugins.map((plugin) => (
            <ChangeList
              key={plugin.id}
              title={plugin.id}
              badge={
                plugin.status === "added"
                  ? t("projectHistory.diff.pluginEnabled")
                  : plugin.status === "removed"
                    ? t("projectHistory.diff.pluginDisabled")
                    : t("projectHistory.diff.changed")
              }
              changes={plugin.changes}
              showEmpty
            />
          ))}
          {diff.pluginManifests.added.length + diff.pluginManifests.removed.length > 0 ? (
            <ChangeList
              title={t("projectHistory.diff.manifests")}
              changes={[
                ...diff.pluginManifests.added.map((url) => ({ path: url, after: url })),
                ...diff.pluginManifests.removed.map((url) => ({ path: url, before: url })),
              ]}
              urlsOnly
            />
          ) : null}
        </DiffGroup>
      ) : null}
      {projectCount > 0 ? (
        <DiffGroup title={t("projectHistory.diff.project")} count={projectCount}>
          <ChangeList title={t("projectHistory.diff.details")} changes={diff.metadata} />
          <ChangeList title={t("projectHistory.diff.preferences")} changes={diff.preferences} />
          {diff.sections.length > 0 ? (
            <div className="text-xs">
              <p className="font-medium">{t("projectHistory.diff.sections")}</p>
              <p className="font-mono text-muted-foreground" dir="ltr">
                {diff.sections.join(", ")}
              </p>
            </div>
          ) : null}
        </DiffGroup>
      ) : null}
    </div>
  );
}

function DiffGroup({
  title,
  count,
  children,
}: {
  title: string;
  count: number;
  children: ReactNode;
}) {
  return (
    <details open className="group rounded-md border">
      <summary className="flex cursor-pointer list-none items-center gap-2 p-2 text-sm font-medium [&::-webkit-details-marker]:hidden">
        <ChevronRight
          className="h-4 w-4 shrink-0 transition-transform group-open:rotate-90 rtl:rotate-180 rtl:group-open:rotate-90"
          aria-hidden="true"
        />
        <span className="flex-1 text-start">{title}</span>
        <span className="rounded-full bg-muted px-2 text-xs text-muted-foreground">{count}</span>
      </summary>
      <div className="space-y-2 border-t p-2">{children}</div>
    </details>
  );
}

function StatusBadge({ status }: { status: LayerDiff["status"] }) {
  const { t } = useTranslation();
  const tone =
    status === "added"
      ? "border-emerald-500/50 text-emerald-700 dark:text-emerald-300"
      : status === "removed"
        ? "border-destructive/50 text-destructive"
        : "border-amber-500/50 text-amber-700 dark:text-amber-300";
  return (
    <span className={`shrink-0 rounded border px-1.5 text-[11px] ${tone}`}>
      {t(`projectHistory.diff.${status}`)}
    </span>
  );
}

function LayerRow({
  layer,
  onRestore,
}: {
  layer: LayerDiff;
  onRestore?: (layer: LayerDiff) => void;
}) {
  const { t, i18n } = useTranslation();
  const restoreButton = onRestore ? (
    <Button
      size="sm"
      variant="outline"
      className="h-7 shrink-0 text-xs"
      aria-label={t("projectHistory.diff.restoreLayerAria", { name: layer.name })}
      onClick={() => onRestore(layer)}
    >
      {t("projectHistory.diff.restoreLayer")}
    </Button>
  ) : null;
  const header = (
    <>
      <StatusBadge status={layer.status} />
      <span className="min-w-0 flex-1 truncate text-start">{layer.name}</span>
      <span className="shrink-0 text-xs text-muted-foreground">{layer.type}</span>
    </>
  );
  if (layer.status !== "changed") {
    return (
      <div className="flex items-center gap-2 rounded border p-2 text-sm" data-layer-id={layer.id}>
        {header}
        {layer.featureCount !== undefined ? (
          <span className="shrink-0 text-xs text-muted-foreground">
            {t("projectHistory.diff.featureCount", { count: layer.featureCount })}
          </span>
        ) : null}
        {layer.status === "removed" ? restoreButton : null}
      </div>
    );
  }
  const number = new Intl.NumberFormat(i18n.language);
  return (
    <details className="group/layer rounded border" data-layer-id={layer.id}>
      <summary className="flex cursor-pointer list-none items-center gap-2 p-2 text-sm [&::-webkit-details-marker]:hidden">
        <ChevronRight
          className="h-3.5 w-3.5 shrink-0 transition-transform group-open/layer:rotate-90 rtl:rotate-180 rtl:group-open/layer:rotate-90"
          aria-hidden="true"
        />
        {header}
      </summary>
      <div className="space-y-2 border-t p-2 text-xs">
        {restoreButton ? <div className="flex justify-end">{restoreButton}</div> : null}
        {layer.renamed ? (
          <p>{t("projectHistory.diff.renamed", { name: layer.renamed.before })}</p>
        ) : null}
        {layer.moved ? <p>{t("projectHistory.diff.moved")}</p> : null}
        {layer.visibility ? (
          <ValueLine
            label={t("projectHistory.diff.visibility")}
            before={
              layer.visibility.before
                ? t("projectHistory.diff.visible")
                : t("projectHistory.diff.hidden")
            }
            after={
              layer.visibility.after
                ? t("projectHistory.diff.visible")
                : t("projectHistory.diff.hidden")
            }
          />
        ) : null}
        {layer.opacity ? (
          <ValueLine
            label={t("projectHistory.diff.opacity")}
            before={formatPercent(layer.opacity.before, i18n.language)}
            after={formatPercent(layer.opacity.after, i18n.language)}
          />
        ) : null}
        {layer.features ? (
          <div>
            <p>
              {t("projectHistory.diff.features", {
                added: number.format(layer.features.added),
                removed: number.format(layer.features.removed),
                modified: number.format(layer.features.modified),
              })}
            </p>
            {layer.features.matchedBy !== "id" ? (
              <p className="text-muted-foreground">{t("projectHistory.diff.featuresByGeometry")}</p>
            ) : null}
          </div>
        ) : null}
        <ChangeList title={t("projectHistory.diff.style")} changes={layer.style} />
        <ChangeList title={t("projectHistory.diff.labels")} changes={layer.labels} />
        <ChangeList title={t("projectHistory.diff.filter")} changes={layer.filter} />
        <ChangeList title={t("projectHistory.diff.source")} changes={layer.source} />
        <ChangeList title={t("projectHistory.diff.other")} changes={layer.other} />
      </div>
    </details>
  );
}

function formatPercent(value: number, locale: string): string {
  return typeof value === "number"
    ? new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 0 }).format(value)
    : String(value);
}

function ValueLine({ label, before, after }: { label: string; before?: string; after?: string }) {
  const { t } = useTranslation();
  return (
    <div className="grid grid-cols-[minmax(6rem,auto)_1fr] gap-x-2">
      <span className="font-medium">{label}</span>
      <span className="min-w-0 break-words">
        <span className="text-muted-foreground line-through">
          {before ?? t("projectHistory.diff.none")}
        </span>
        <ArrowRight
          className="mx-1 inline h-3 w-3 align-[-2px] rtl:rotate-180"
          aria-hidden="true"
        />
        <span>{after ?? t("projectHistory.diff.none")}</span>
      </span>
    </div>
  );
}

function ChangeList({
  title,
  changes,
  badge,
  showEmpty = false,
  urlsOnly = false,
}: {
  title: string;
  changes: ProjectValueChange[];
  badge?: string;
  showEmpty?: boolean;
  urlsOnly?: boolean;
}) {
  const { t } = useTranslation();
  if (changes.length === 0 && !showEmpty) return null;
  return (
    <div className="text-xs">
      <p className="flex items-center gap-2 font-medium">
        <span className="truncate">{title}</span>
        {badge ? (
          <span className="rounded border px-1.5 text-[11px] font-normal text-muted-foreground">
            {badge}
          </span>
        ) : null}
      </p>
      <ul className="mt-1 space-y-0.5 ps-3">
        {changes.map((change) =>
          urlsOnly ? (
            <li key={change.path} className="break-all font-mono" dir="ltr">
              {change.after !== undefined
                ? `+ ${change.after}`
                : `− ${change.before ?? t("projectHistory.diff.none")}`}
            </li>
          ) : (
            <li key={change.path}>
              <ValueLine label={change.path} before={change.before} after={change.after} />
            </li>
          ),
        )}
      </ul>
    </div>
  );
}
