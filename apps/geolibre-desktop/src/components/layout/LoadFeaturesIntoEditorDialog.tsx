import { Button, cn, Input, Label, Select } from "@geolibre/ui";
import { useAppStore } from "@geolibre/core";
import type { MapController } from "@geolibre/map";
import {
  buildEditorSaveCollection,
  getGeoEditorFeatureCount,
  getGeometryEditTargetLayerId,
  hasViewImportBaseline,
  isGeoEditorAvailableForImport,
  loadViewFeaturesIntoEditor,
  queryViewLayerFeatures,
  resolveStoreLayerViewSource,
  SKETCHES_SOURCE_KIND,
  subscribeGeometryEdit,
  type ViewImportMap,
  type ViewVectorLayer,
} from "@geolibre/plugins";
import type { Feature } from "geojson";
import { ChevronDown, ChevronUp, GripVertical, RefreshCw, X } from "lucide-react";
import {
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { clamp } from "../../lib/clamp";
import { createAppAPI, getPluginManager } from "../../hooks/usePlugins";
import { exportVectorLayer } from "../../lib/vector-export";

interface LoadFeaturesIntoEditorDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mapControllerRef: React.RefObject<MapController | null>;
  /** Store layer to preselect (set when opened from a layer's context menu). */
  initialLayerId: string | null;
}

/** localStorage key for the optional editor-name field (stamped onto changes). */
const EDITOR_NAME_KEY = "geolibre-editor-name";

/**
 * Above this many features, warn before loading: Geoman keeps every feature
 * individually editable, so large collections make the editor sluggish.
 */
const LOAD_WARN_THRESHOLD = 2000;

const PANEL_WIDTH = 340;
const EDGE_MARGIN = 16;
/** Gap kept between the panel's bottom and the status bar / map bottom edge. */
const STATUS_BAR_GAP = 24;

/** A Layers-panel vector layer that can be queried into the editor. */
interface EligibleLayer {
  id: string;
  name: string;
  source: ViewVectorLayer;
}

type StatusKind = "success" | "error" | "info";
interface Status {
  message: string;
  kind: StatusKind;
}

/** A short filesystem-safe timestamp for the default download name. */
function timestampSlug(iso: string): string {
  return iso.replace(/[:.]/g, "-").replace("T", "_").replace("Z", "");
}

/**
 * A draggable, non-modal panel that loads the features of a Layers-panel vector
 * layer visible in the current map view into the GeoEditor, then saves them back
 * out as GeoJSON — every feature, or only the ones the user added, changed, or
 * deleted. It is a floating panel rather than a modal so the map and GeoEditor
 * tools stay interactive: the user loads features, edits them on the map, and
 * saves from this same panel without it blocking the map. Basemap layers are
 * excluded; the source list is the project's own vector layers.
 */
export function LoadFeaturesIntoEditorDialog({
  open,
  onOpenChange,
  mapControllerRef,
  initialLayerId,
}: LoadFeaturesIntoEditorDialogProps) {
  const { t } = useTranslation();
  const storeLayers = useAppStore((s) => s.layers);
  // While an in-place "Edit geometry" session is active the shared editor holds
  // that layer's geometry (not the loaded view features), so loading/saving here
  // would be wrong; the panel disables its actions and shows a note instead.
  const geometryEditActive =
    useSyncExternalStore(subscribeGeometryEdit, getGeometryEditTargetLayerId) !== null;
  const [eligible, setEligible] = useState<EligibleLayer[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [editorName, setEditorName] = useState("");
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false);
  // Feature count in the editor when the user hits Load, driving the
  // append/replace confirmation. Null hides the prompt.
  const [confirmCount, setConfirmCount] = useState<number | null>(null);
  // A load deferred behind the "too many features" warning: the already-queried
  // features and how they should be applied. Null hides the warning.
  const [pendingLoad, setPendingLoad] = useState<{
    replace: boolean;
    features: Feature[];
  } | null>(null);
  const [changesAvailable, setChangesAvailable] = useState(false);
  // Default placement: bottom-left of the map, anchored by `bottom` so the panel
  // grows upward and always keeps a gap above the status bar. Once the user
  // drags it, `dragPos` (a top/left position) takes over.
  const [anchor, setAnchor] = useState<{ x: number; bottom: number } | null>(null);
  const [dragPos, setDragPos] = useState<{ x: number; y: number } | null>(null);
  const [collapsed, setCollapsed] = useState(false);

  // Vector layers that resolve to a queryable vector/geojson map source. The
  // Sketches layer (the editor's own output) is excluded. Recomputed when the
  // Layers panel changes or the dialog reopens.
  const computeEligible = useCallback((): EligibleLayer[] => {
    const style = mapControllerRef.current?.getMap()?.getStyle();
    const result: EligibleLayer[] = [];
    for (const layer of storeLayers) {
      if (layer.metadata.sourceKind === SKETCHES_SOURCE_KIND) continue;
      const source = resolveStoreLayerViewSource(layer, style);
      if (source) result.push({ id: layer.id, name: layer.name, source });
    }
    return result;
  }, [mapControllerRef, storeLayers]);

  const refreshLayers = useCallback(() => {
    const next = computeEligible();
    setEligible(next);
    setSelectedId((current) =>
      current && next.some((entry) => entry.id === current) ? current : "",
    );
  }, [computeEligible]);

  // Tracks the true open transition (false -> true). Without this the effect
  // below would also re-run whenever `computeEligible` changes identity (i.e.
  // whenever the Layers panel changes), resetting the drag position, collapse
  // state, and any in-progress status while the panel is already open.
  const wasOpenRef = useRef(false);

  // On the open transition: repopulate the eligible list, preselect any
  // context-menu target, restore the saved editor name, and dock the panel at
  // the bottom-left of the map canvas.
  useEffect(() => {
    if (!open) {
      wasOpenRef.current = false;
      return;
    }
    if (wasOpenRef.current) return;
    wasOpenRef.current = true;
    const next = computeEligible();
    setEligible(next);
    setSelectedId(
      initialLayerId && next.some((entry) => entry.id === initialLayerId) ? initialLayerId : "",
    );
    setStatus(null);
    setConfirmCount(null);
    setPendingLoad(null);
    setCollapsed(false);
    setChangesAvailable(hasViewImportBaseline());
    // Open at the bottom-left of the map canvas by default (measured from the
    // map container, so it clears the left Layers panel), leaving a gap above
    // the status bar. Anchored by `bottom` so growing content extends upward.
    const mapRect = mapControllerRef.current?.getMap()?.getContainer()?.getBoundingClientRect();
    const left = mapRect ? mapRect.left + EDGE_MARGIN : EDGE_MARGIN;
    const bottomOffset = (mapRect ? window.innerHeight - mapRect.bottom : 0) + STATUS_BAR_GAP;
    setAnchor({ x: left, bottom: bottomOffset });
    setDragPos(null);
    try {
      setEditorName(localStorage.getItem(EDITOR_NAME_KEY) ?? "");
    } catch {
      // Persistence unavailable (e.g. privacy mode); leave the field empty.
    }
  }, [open, initialLayerId, computeEligible]);

  const selectedLayer = useMemo(
    () => eligible.find((entry) => entry.id === selectedId) ?? null,
    [eligible, selectedId],
  );

  const persistEditorName = (value: string) => {
    setEditorName(value);
    try {
      if (value.trim()) localStorage.setItem(EDITOR_NAME_KEY, value.trim());
      else localStorage.removeItem(EDITOR_NAME_KEY);
    } catch {
      // Persistence unavailable; ignore.
    }
  };

  /** Activate the GeoEditor plugin if needed; returns whether it is ready. */
  const ensureEditorActive = useCallback((): boolean => {
    if (isGeoEditorAvailableForImport()) return true;
    const appAPI = createAppAPI(mapControllerRef);
    const manager = getPluginManager();
    if (!manager.isActive("maplibre-gl-geo-editor")) {
      manager.activate("maplibre-gl-geo-editor", appAPI);
    }
    return isGeoEditorAvailableForImport();
  }, [mapControllerRef]);

  // Load already-queried features into the editor (past the warning gate).
  const commitLoad = useCallback(
    async (features: Feature[], replace: boolean, layerName: string) => {
      setBusy(true);
      setStatus({ message: t("loadEditorFeatures.loading"), kind: "info" });
      try {
        if (!ensureEditorActive()) {
          setStatus({
            message: t("loadEditorFeatures.editorUnavailable"),
            kind: "error",
          });
          return;
        }
        const { imported, dropped } = await loadViewFeaturesIntoEditor(features, { replace });
        setChangesAvailable(hasViewImportBaseline());
        if (imported === 0) {
          setStatus({ message: t("loadEditorFeatures.noEditable"), kind: "error" });
          return;
        }
        const base = replace
          ? t("loadEditorFeatures.loaded", { count: imported, layer: layerName })
          : t("loadEditorFeatures.appended", {
              count: imported,
              layer: layerName,
            });
        setStatus({
          message:
            dropped > 0
              ? t("loadEditorFeatures.loadedWithDropped", {
                  message: base,
                  dropped,
                })
              : base,
          kind: "success",
        });
      } catch (error) {
        setStatus({
          message: error instanceof Error ? error.message : t("loadEditorFeatures.loadFailed"),
          kind: "error",
        });
      } finally {
        setBusy(false);
      }
    },
    [ensureEditorActive, t],
  );

  // Query the selected layer's in-view features, then either warn (too many),
  // load immediately, or report that none are in view.
  const runLoad = useCallback(
    (replace: boolean) => {
      const map = mapControllerRef.current?.getMap();
      if (!map || !selectedLayer) {
        setStatus({ message: t("loadEditorFeatures.selectLayer"), kind: "error" });
        return;
      }
      // Mark busy for the query window too, so the form (and Load button) is
      // disabled while the query runs — a second click can't fire a concurrent
      // query.
      setBusy(true);
      setStatus({ message: t("loadEditorFeatures.loading"), kind: "info" });
      // Query on the next tick so the "Loading…" status can paint first.
      window.setTimeout(() => {
        let features: Feature[];
        try {
          features = queryViewLayerFeatures(map as unknown as ViewImportMap, selectedLayer.source);
        } catch (error) {
          // e.g. the layer's source was removed between selecting and loading.
          setStatus({
            message: error instanceof Error ? error.message : t("loadEditorFeatures.loadFailed"),
            kind: "error",
          });
          setBusy(false);
          return;
        }
        if (features.length === 0) {
          setStatus({ message: t("loadEditorFeatures.noneInView"), kind: "error" });
          setBusy(false);
          return;
        }
        if (features.length > LOAD_WARN_THRESHOLD) {
          setPendingLoad({ replace, features });
          setStatus(null);
          setBusy(false);
          return;
        }
        // Hand off to commitLoad, which manages `busy` for the load itself.
        setBusy(false);
        void commitLoad(features, replace, selectedLayer.name);
      }, 0);
    },
    [commitLoad, mapControllerRef, selectedLayer, t],
  );

  const runSave = useCallback(
    async (changedOnly: boolean) => {
      const now = new Date().toISOString();
      const result = buildEditorSaveCollection({
        changedOnly,
        editorName,
        now,
      });
      if (!result || result.collection.features.length === 0) {
        setStatus({
          message: changedOnly
            ? t("loadEditorFeatures.noChanges")
            : t("loadEditorFeatures.nothingToSave"),
          kind: changedOnly ? "info" : "error",
        });
        return;
      }

      setBusy(true);
      try {
        const baseName = `${changedOnly ? "feature-changes" : "features"}_${timestampSlug(now)}`;
        const saved = await exportVectorLayer(result.collection, "geojson", baseName);
        if (saved === null) return; // user cancelled the save dialog
        const { added, modified, deleted } = result.counts;
        setStatus({
          message: changedOnly
            ? t("loadEditorFeatures.savedChanges", { added, modified, deleted })
            : t("loadEditorFeatures.saved", {
                count: result.collection.features.length,
              }),
          kind: "success",
        });
      } catch (error) {
        setStatus({
          message: error instanceof Error ? error.message : t("loadEditorFeatures.saveFailed"),
          kind: "error",
        });
      } finally {
        setBusy(false);
      }
    },
    [editorName, t],
  );

  const handleLoadClick = () => {
    if (!selectedLayer) {
      setStatus({ message: t("loadEditorFeatures.selectLayer"), kind: "error" });
      return;
    }
    setConfirmCount(null);
    setPendingLoad(null);
    const count = ensureEditorActive() ? getGeoEditorFeatureCount() : 0;
    if (count > 0) {
      setConfirmCount(count);
    } else {
      runLoad(true);
    }
  };

  // Drag the panel by its header, clamped to the viewport (mirrors the plugin
  // floating-panel behavior). Pointer capture keeps the drag alive off the header.
  const handleDragStart = (event: ReactPointerEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest("button")) return;
    event.preventDefault();
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    const card = handle.parentElement as HTMLElement;
    const startX = event.clientX;
    const startY = event.clientY;
    // Switch from the bottom anchor to an absolute top/left origin read from the
    // card's current on-screen position, so the drag continues from where it is.
    const rect = card.getBoundingClientRect();
    const origin = { x: rect.left, y: rect.top };
    setDragPos(origin);
    const handleMove = (move: PointerEvent) => {
      const maxX = window.innerWidth - card.offsetWidth - EDGE_MARGIN;
      const maxY = window.innerHeight - card.offsetHeight - EDGE_MARGIN;
      setDragPos({
        x: clamp(origin.x + (move.clientX - startX), 0, Math.max(0, maxX)),
        y: clamp(origin.y + (move.clientY - startY), 0, Math.max(0, maxY)),
      });
    };
    const handleEnd = () => {
      if (handle.hasPointerCapture(event.pointerId)) {
        handle.releasePointerCapture(event.pointerId);
      }
      handle.removeEventListener("pointermove", handleMove);
      handle.removeEventListener("pointerup", handleEnd);
      handle.removeEventListener("pointercancel", handleEnd);
    };
    handle.addEventListener("pointermove", handleMove);
    handle.addEventListener("pointerup", handleEnd);
    handle.addEventListener("pointercancel", handleEnd);
  };

  if (!open || !anchor) return null;

  const positionStyle = dragPos
    ? { left: dragPos.x, top: dragPos.y, width: PANEL_WIDTH }
    : { left: anchor.x, bottom: anchor.bottom, width: PANEL_WIDTH };

  const statusColor =
    status?.kind === "error"
      ? "text-destructive"
      : status?.kind === "success"
        ? "text-emerald-600 dark:text-emerald-400"
        : "text-muted-foreground";

  return createPortal(
    <section
      aria-label={t("loadEditorFeatures.title")}
      className="pointer-events-auto fixed z-30 flex max-h-[calc(100vh-6rem)] flex-col overflow-hidden rounded-lg border bg-card shadow-xl"
      style={positionStyle}
    >
      <div
        className="flex cursor-move touch-none select-none items-center gap-2 border-b px-3 py-2"
        onPointerDown={handleDragStart}
      >
        <GripVertical className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
        <span className="flex-1 truncate text-sm font-semibold">
          {t("loadEditorFeatures.title")}
        </span>
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6"
          title={t(collapsed ? "loadEditorFeatures.expand" : "loadEditorFeatures.collapse")}
          aria-label={t(collapsed ? "loadEditorFeatures.expand" : "loadEditorFeatures.collapse")}
          aria-expanded={!collapsed}
          onClick={() => setCollapsed((value) => !value)}
        >
          {collapsed ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6"
          title={t("common.cancel")}
          aria-label={t("common.cancel")}
          onClick={() => onOpenChange(false)}
        >
          <X className="h-4 w-4" />
        </Button>
      </div>

      <div className={cn("min-h-0 flex-1 space-y-4 overflow-auto p-4", collapsed && "hidden")}>
        <p className="text-xs text-muted-foreground">{t("loadEditorFeatures.description")}</p>

        {geometryEditActive && (
          <p className="rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-xs">
            {t("loadEditorFeatures.editSessionActive")}
          </p>
        )}

        <div className="space-y-1.5">
          <Label htmlFor="load-editor-layer">{t("loadEditorFeatures.vectorLayer")}</Label>
          <div className="flex items-center gap-2">
            <Select
              id="load-editor-layer"
              className="flex-1"
              value={selectedId}
              disabled={busy}
              onChange={(event) => setSelectedId(event.target.value)}
            >
              <option value="" disabled>
                {t("loadEditorFeatures.selectPlaceholder")}
              </option>
              {eligible.map((layer) => (
                <option key={layer.id} value={layer.id}>
                  {layer.name}
                </option>
              ))}
            </Select>
            <Button
              type="button"
              variant="outline"
              size="icon"
              title={t("loadEditorFeatures.refresh")}
              aria-label={t("loadEditorFeatures.refresh")}
              disabled={busy}
              onClick={refreshLayers}
            >
              <RefreshCw className="h-4 w-4" aria-hidden="true" />
            </Button>
          </div>
          {eligible.length === 0 && (
            <p className="text-xs text-muted-foreground">{t("loadEditorFeatures.noLayers")}</p>
          )}
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="load-editor-name">{t("loadEditorFeatures.editorName")}</Label>
          <Input
            id="load-editor-name"
            value={editorName}
            placeholder={t("loadEditorFeatures.editorNamePlaceholder")}
            disabled={busy}
            onChange={(event) => persistEditorName(event.target.value)}
          />
        </div>

        {pendingLoad != null ? (
          <div className="space-y-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3">
            <p className="text-sm">
              {t("loadEditorFeatures.tooMany", {
                count: pendingLoad.features.length,
              })}
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => {
                  const { features, replace } = pendingLoad;
                  setPendingLoad(null);
                  void commitLoad(features, replace, selectedLayer?.name ?? "");
                }}
              >
                {t("loadEditorFeatures.loadAnyway")}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => setPendingLoad(null)}
              >
                {t("common.cancel")}
              </Button>
            </div>
          </div>
        ) : confirmCount != null ? (
          <div className="space-y-2 rounded-md border bg-muted/40 p-3">
            <p className="text-sm">
              {t("loadEditorFeatures.confirmExisting", { count: confirmCount })}
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={busy}
                title={t("loadEditorFeatures.appendHint")}
                onClick={() => {
                  setConfirmCount(null);
                  runLoad(false);
                }}
              >
                {t("loadEditorFeatures.append")}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={busy}
                title={t("loadEditorFeatures.discardHint")}
                onClick={() => {
                  setConfirmCount(null);
                  runLoad(true);
                }}
              >
                {t("loadEditorFeatures.discard")}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => setConfirmCount(null)}
              >
                {t("common.cancel")}
              </Button>
            </div>
          </div>
        ) : (
          <Button
            type="button"
            className="w-full"
            disabled={busy || !selectedId || geometryEditActive}
            onClick={handleLoadClick}
          >
            {t("loadEditorFeatures.loadFeatures")}
          </Button>
        )}

        {status && (
          <p className={cn("text-sm", statusColor)} aria-live="polite">
            {status.message}
          </p>
        )}

        <div className="flex flex-wrap justify-end gap-2 border-t pt-4">
          <Button
            type="button"
            variant="outline"
            disabled={busy || !changesAvailable || geometryEditActive}
            title={t("loadEditorFeatures.saveChangesHint")}
            onClick={() => void runSave(true)}
          >
            {t("loadEditorFeatures.saveChanges")}
          </Button>
          <Button
            type="button"
            disabled={busy || geometryEditActive}
            onClick={() => void runSave(false)}
          >
            {t("loadEditorFeatures.saveAll")}
          </Button>
        </div>
      </div>
    </section>,
    document.body,
  );
}
