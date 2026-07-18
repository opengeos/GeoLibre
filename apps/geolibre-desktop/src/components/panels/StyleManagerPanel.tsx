// The Style Manager (issue #1294): a browsable library of reusable saved
// styles (full styles, symbols, label presets, color-ramp presets) with tags
// and previews. Entries live in the app-level library (persisted across
// projects via IndexedDB, see useStyleLibraryPersistence) or embedded in the
// current project file; built-in presets seed the library so it is never
// empty. Import accepts GeoLibre style-library bundles plus QGIS QML and OGC
// SLD (converted through the existing packages/map importers); export writes
// a shareable JSON bundle.
//
// Rendered as a floating, draggable panel over the map (mirroring
// RasterSubsetPanel) rather than a modal dialog, so the user can keep
// interacting with the map and the Layers/Style panels — e.g. select another
// layer and apply an entry to it — while browsing the library.

import {
  BUILT_IN_STYLE_PRESETS,
  createStyleLibraryEntryId,
  DEFAULT_LAYER_STYLE,
  extractStyleLibraryStyle,
  interpolateRampColors,
  isStyleLibraryTargetLayer,
  parseStyleLibrary,
  serializeStyleLibrary,
  styleValue,
  useAppStore,
  type StyleLibraryEntry,
  type StyleLibraryEntryKind,
} from "@geolibre/core";
import { applyQmlImport, applySldImport, parseQml, parseSld } from "@geolibre/map";
import { Button, cn, Input, Label, ScrollArea, Select } from "@geolibre/ui";
import { Check, Download, GripVertical, Palette, Save, Trash2, Upload, X } from "lucide-react";
import {
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { clamp } from "../../lib/clamp";
import { isQmlStyleXml } from "../../lib/style-format";
import { openLocalDataFileWithFallback, saveTextFileWithFallback } from "../../lib/tauri-io";
import { createCategorizedStops, createGraduatedStops } from "./StylePanel";

/** Default panel geometry (px); the user can drag it around the map area. */
const PANEL_DEFAULT_W = 384;
const PANEL_MARGIN = 12;

interface PanelPos {
  x: number;
  y: number;
}

type StatusNote = { type: "success" | "error"; text: string } | null;

/**
 * Render a small preview swatch for a library entry: a gradient strip for
 * ramp presets, a text specimen for label presets, and polygon/line/point
 * glyphs for symbol and full-style entries.
 */
function EntryPreview({ entry }: { entry: StyleLibraryEntry }) {
  const style = { ...DEFAULT_LAYER_STYLE, ...entry.style };
  if (entry.kind === "ramp") {
    // Clamp to the Style panel's class-count range: sanitization only checks
    // finiteness, so an absurd hand-edited count must not allocate a huge
    // preview array.
    const colors = interpolateRampColors(
      style.vectorStyleColorRamp,
      Math.min(Math.max(style.vectorStyleClassCount, 2), 12),
    );
    return (
      <div className="flex h-8 w-16 shrink-0 overflow-hidden rounded border border-border">
        {colors.map((color, index) => (
          <div key={index} className="flex-1" style={{ background: color }} />
        ))}
      </div>
    );
  }
  if (entry.kind === "labels") {
    return (
      <div className="flex h-8 w-16 shrink-0 items-center justify-center rounded border border-border bg-background">
        <span
          className="text-sm font-semibold"
          style={{
            color: style.labels.color,
            textShadow: `-1px -1px 2px ${style.labels.haloColor}, 1px -1px 2px ${style.labels.haloColor}, -1px 1px 2px ${style.labels.haloColor}, 1px 1px 2px ${style.labels.haloColor}`,
          }}
        >
          Abc
        </span>
      </div>
    );
  }
  const strokeWidth = Math.min(Math.max(style.strokeWidth, 0.5), 4);
  return (
    <svg
      className="h-8 w-16 shrink-0 rounded border border-border bg-background"
      viewBox="0 0 64 32"
      aria-hidden="true"
    >
      <rect
        x="4"
        y="6"
        width="20"
        height="20"
        rx="2"
        fill={style.fillColor}
        fillOpacity={style.fillOpacity}
        stroke={style.strokeColor}
        strokeWidth={strokeWidth}
      />
      <path
        d="M30 24 L40 10 L48 22"
        fill="none"
        stroke={style.strokeColor}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
      />
      <circle
        cx="56"
        cy="16"
        r={Math.min(Math.max(style.circleRadius, 2), 6)}
        fill={style.markerEnabled ? style.markerColor : style.fillColor}
        stroke={style.strokeColor}
        strokeWidth="1"
      />
    </svg>
  );
}

export function StyleManagerPanel() {
  const { t } = useTranslation();
  const open = useAppStore((s) => s.ui.styleManagerOpen);
  const setStyleManagerOpen = useAppStore((s) => s.setStyleManagerOpen);
  const styleLibrary = useAppStore((s) => s.styleLibrary);
  const projectStyleLibrary = useAppStore((s) => s.projectStyleLibrary);
  const saveStyleLibraryEntry = useAppStore((s) => s.saveStyleLibraryEntry);
  const setStyleLibrary = useAppStore((s) => s.setStyleLibrary);
  const deleteStyleLibraryEntry = useAppStore((s) => s.deleteStyleLibraryEntry);
  const layers = useAppStore((s) => s.layers);
  const selectedLayerId = useAppStore((s) => s.selectedLayerId);
  const setLayerStyle = useAppStore((s) => s.setLayerStyle);
  const updateLayer = useAppStore((s) => s.updateLayer);

  const [search, setSearch] = useState("");
  const [activeTag, setActiveTag] = useState<string | null>(null);
  const [status, setStatus] = useState<StatusNote>(null);
  const [saveFormOpen, setSaveFormOpen] = useState(false);
  const [saveName, setSaveName] = useState("");
  const [saveKind, setSaveKind] = useState<StyleLibraryEntryKind>("style");
  const [saveTags, setSaveTags] = useState("");
  const [saveScope, setSaveScope] = useState<"app" | "project">("app");

  // Floating-panel position; null means the default CSS position. Kept across
  // close/reopen within a session (the component stays mounted).
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<PanelPos | null>(null);

  // Dragging the panel by its header. Mirrors RasterSubsetPanel.
  const handleDragStart = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if ((event.target as HTMLElement).closest("button")) return;
      event.preventDefault();
      const el = panelRef.current;
      const parent = (el?.offsetParent as HTMLElement | null) ?? el?.parentElement ?? null;
      const pb = parent?.getBoundingClientRect();
      const eb = el?.getBoundingClientRect();
      const start: PanelPos = pos ?? {
        x: (eb?.left ?? 0) - (pb?.left ?? 0),
        y: (eb?.top ?? 0) - (pb?.top ?? 0),
      };
      if (!pos) setPos(start);
      const handle = event.currentTarget;
      handle.setPointerCapture(event.pointerId);
      const startX = event.clientX;
      const startY = event.clientY;
      const w = eb?.width ?? PANEL_DEFAULT_W;
      const h = eb?.height ?? 0;
      const move = (m: PointerEvent) => {
        if (!panelRef.current) return;
        const bounds = parent?.getBoundingClientRect();
        const maxX = bounds ? bounds.width - w - PANEL_MARGIN : Number.POSITIVE_INFINITY;
        const maxY = bounds ? bounds.height - h - PANEL_MARGIN : Number.POSITIVE_INFINITY;
        setPos({
          x: clamp(start.x + (m.clientX - startX), 0, Math.max(0, maxX)),
          y: clamp(start.y + (m.clientY - startY), 0, Math.max(0, maxY)),
        });
      };
      const end = () => {
        if (handle.hasPointerCapture(event.pointerId))
          handle.releasePointerCapture(event.pointerId);
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", end);
        handle.removeEventListener("pointercancel", end);
      };
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", end);
      handle.addEventListener("pointercancel", end);
    },
    [pos],
  );

  const layer = layers.find((l) => l.id === selectedLayerId);
  const canUseLayer = layer !== undefined && isStyleLibraryTargetLayer(layer.type);

  // The panel is non-modal, so the selection can change while the save form
  // is open. Re-seed the name from the newly selected layer (the save always
  // captures the currently selected layer's style), so switching from layer A
  // to layer B can never save B's style under A's stale name.
  useEffect(() => {
    if (saveFormOpen) {
      setSaveName(useAppStore.getState().layers.find((l) => l.id === selectedLayerId)?.name ?? "");
    }
    // Only selection changes re-seed; typing in the field must not.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedLayerId]);

  const kindLabels: Record<StyleLibraryEntryKind, string> = {
    style: t("styleManager.kindStyle"),
    symbol: t("styleManager.kindSymbol"),
    labels: t("styleManager.kindLabels"),
    ramp: t("styleManager.kindRamp"),
  };

  const allTags = useMemo(() => {
    const tags = new Set<string>();
    for (const entry of [...BUILT_IN_STYLE_PRESETS, ...styleLibrary, ...projectStyleLibrary]) {
      for (const tag of entry.tags) tags.add(tag);
    }
    return [...tags].sort((a, b) => a.localeCompare(b));
  }, [styleLibrary, projectStyleLibrary]);

  const matches = (entry: StyleLibraryEntry) => {
    if (activeTag && !entry.tags.includes(activeTag)) return false;
    const query = search.trim().toLowerCase();
    if (!query) return true;
    return (
      entry.name.toLowerCase().includes(query) ||
      entry.tags.some((tag) => tag.toLowerCase().includes(query))
    );
  };

  const sections: {
    key: string;
    title: string;
    entries: StyleLibraryEntry[];
    readOnly: boolean;
  }[] = [
    {
      key: "project",
      title: t("styleManager.projectSection"),
      entries: projectStyleLibrary.filter(matches),
      readOnly: false,
    },
    {
      key: "library",
      title: t("styleManager.librarySection"),
      entries: styleLibrary.filter(matches),
      readOnly: false,
    },
    {
      key: "presets",
      title: t("styleManager.presetsSection"),
      entries: BUILT_IN_STYLE_PRESETS.filter(matches),
      readOnly: true,
    },
  ];
  const visibleCount = sections.reduce((n, s) => n + s.entries.length, 0);

  const applyEntry = (entry: StyleLibraryEntry) => {
    if (!layer || !canUseLayer) return;
    // Clone so later library edits never alias the live layer style (and vice
    // versa). A full-style entry replaces the whole style (over defaults, so
    // fields older entries never saved reset instead of lingering); subset
    // entries merge onto the current style.
    const patch = structuredClone(entry.style);
    // A ramp entry deliberately excludes the classified attribute and the
    // concrete stops, so on its own it changes nothing until the next
    // classification. When the target layer is already classified, regenerate
    // its stops from the entry's ramp/count/scheme (same generators as the
    // Style panel) so the apply recolors the map immediately; otherwise show
    // the "switch to graduated/categorized" hint instead of implying a change.
    let rampPending = false;
    if (entry.kind === "ramp") {
      const mode = styleValue(layer.style, "vectorStyleMode");
      const property = styleValue(layer.style, "vectorStyleProperty");
      const classified = (mode === "graduated" || mode === "categorized") && property !== "";
      if (classified) {
        const classCount =
          patch.vectorStyleClassCount ?? styleValue(layer.style, "vectorStyleClassCount");
        const ramp = patch.vectorStyleColorRamp ?? styleValue(layer.style, "vectorStyleColorRamp");
        const scheme =
          patch.vectorStyleClassificationScheme ??
          styleValue(layer.style, "vectorStyleClassificationScheme");
        const stops =
          mode === "graduated"
            ? createGraduatedStops(layer, property, classCount, ramp, scheme)
            : createCategorizedStops(layer, property, classCount, ramp, scheme);
        if (stops.length > 0) patch.vectorStyleStops = stops;
      } else {
        rampPending = true;
      }
    }
    if (entry.kind === "style") {
      updateLayer(layer.id, { style: { ...DEFAULT_LAYER_STYLE, ...patch } });
    } else {
      setLayerStyle(layer.id, patch);
    }
    setStatus({
      type: "success",
      text: rampPending
        ? t("styleManager.appliedRampHint", { name: entry.name })
        : t("styleManager.applied", { name: entry.name, layer: layer.name }),
    });
  };

  const handleSave = () => {
    if (!layer || !canUseLayer) return;
    const entry: StyleLibraryEntry = {
      id: createStyleLibraryEntryId(),
      name: saveName.trim() || layer.name,
      kind: saveKind,
      tags: [
        ...new Set(
          saveTags
            .split(",")
            .map((tag) => tag.trim())
            .filter((tag) => tag !== ""),
        ),
      ],
      style: extractStyleLibraryStyle(layer.style, saveKind),
      updatedAt: new Date().toISOString(),
    };
    saveStyleLibraryEntry(entry, saveScope);
    setSaveFormOpen(false);
    setSaveName("");
    setSaveTags("");
    setStatus({
      type: "success",
      text: t("styleManager.saved", { name: entry.name }),
    });
  };

  const handleImport = async () => {
    try {
      const picked = await openLocalDataFileWithFallback({
        filters: [
          {
            name: t("styleManager.importFilterName"),
            extensions: ["json", "qml", "sld", "xml"],
          },
        ],
        accept: ".json,.qml,.sld,.xml,application/json,application/xml,text/xml",
        readText: true,
      });
      if (!picked || picked.text === undefined) return;
      const fileName =
        picked.path
          .split(/[\\/]/)
          .pop()
          ?.replace(/\.[^.]+$/, "") ?? "";
      const trimmed = picked.text.trimStart();
      if (trimmed.startsWith("<")) {
        // A QGIS QML or OGC SLD file: convert it to a full-style entry via the
        // shared importers, same content sniff as the LayerPanel import.
        const isQml = isQmlStyleXml(picked.text);
        let matched: number;
        let style: typeof DEFAULT_LAYER_STYLE;
        if (isQml) {
          const result = parseQml(picked.text);
          matched = result.matchedRuleCount;
          style = applyQmlImport({ ...DEFAULT_LAYER_STYLE }, result);
        } else {
          const result = parseSld(picked.text);
          matched = result.matchedRuleCount;
          style = applySldImport({ ...DEFAULT_LAYER_STYLE }, result);
        }
        if (matched === 0) {
          setStatus({ type: "error", text: t("styleManager.importNoMatch") });
          return;
        }
        saveStyleLibraryEntry(
          {
            id: createStyleLibraryEntryId(),
            name: fileName || t("styleManager.importedEntryName"),
            kind: "style",
            tags: [isQml ? "qml" : "sld"],
            style: extractStyleLibraryStyle(style, "style"),
            updatedAt: new Date().toISOString(),
          },
          "app",
        );
        setStatus({
          type: "success",
          text: t("styleManager.importedCount", { count: 1 }),
        });
        return;
      }
      const entries = parseStyleLibrary(picked.text);
      // Ids that must not be claimed by an app-scope import: built-in preset
      // ids, and ids of project-scoped entries (so one id never means two
      // different entries across the sections). A collision with an existing
      // app-library id is intentional upsert semantics, so re-importing an
      // exported bundle updates entries instead of duplicating them. Merge
      // into one setStyleLibrary call so the whole import costs a single
      // store update and a single IndexedDB flush.
      // Read both lists fresh from one store snapshot: the file-picker await
      // above can block while the store changes, and a render-time snapshot
      // could miss a project-scoped id created meanwhile.
      const state = useAppStore.getState();
      const projectIds = new Set(state.projectStyleLibrary.map((e) => e.id));
      const next = [...state.styleLibrary];
      for (const entry of entries) {
        const imported = {
          ...entry,
          id:
            entry.id.startsWith("preset-") || projectIds.has(entry.id)
              ? createStyleLibraryEntryId()
              : entry.id,
        };
        const index = next.findIndex((e) => e.id === imported.id);
        if (index >= 0) {
          next[index] = imported;
        } else {
          next.push(imported);
        }
      }
      setStyleLibrary(next);
      setStatus({
        type: "success",
        text: t("styleManager.importedCount", { count: entries.length }),
      });
    } catch (error) {
      setStatus({
        type: "error",
        text: error instanceof Error ? error.message : t("styleManager.importInvalid"),
      });
    }
  };

  const handleExport = async () => {
    // De-duplicate by id (project scope wins): the two scopes can legitimately
    // share an id after loading a project authored elsewhere, and a bundle
    // with duplicate ids would re-import as a single entry.
    const seenIds = new Set<string>();
    const entries = [...projectStyleLibrary, ...styleLibrary].filter((e) => {
      if (seenIds.has(e.id)) return false;
      seenIds.add(e.id);
      return true;
    });
    if (entries.length === 0) {
      setStatus({ type: "error", text: t("styleManager.exportEmpty") });
      return;
    }
    try {
      const savedPath = await saveTextFileWithFallback(serializeStyleLibrary(entries), {
        defaultName: "geolibre-styles.json",
        filters: [{ name: t("styleManager.exportFilterName"), extensions: ["json"] }],
        browserTypes: [
          {
            description: t("styleManager.exportFilterName"),
            accept: { "application/json": [".json"] },
          },
        ],
        mimeType: "application/json",
      });
      if (savedPath !== null) {
        setStatus({ type: "success", text: t("styleManager.exportSuccess") });
      }
    } catch (error) {
      setStatus({
        type: "error",
        text: error instanceof Error ? error.message : t("styleManager.exportFailed"),
      });
    }
  };

  if (!open) return null;

  return (
    <div
      ref={panelRef}
      // `resize` (CSS resize: both) gives the native bottom-end resize grip;
      // it writes inline width/height on drag, overriding the default width
      // class, and the min-/max- classes bound it. Requires the non-visible
      // overflow this container already has.
      className={cn(
        "pointer-events-auto absolute z-20 flex resize flex-col overflow-hidden rounded-lg border bg-background shadow-xl",
        "max-h-[calc(100%-1.5rem)] min-h-64 min-w-80 max-w-[calc(100%-1.5rem)]",
        "w-[min(24rem,calc(100vw-1.5rem))]",
        // Physical (not logical) anchor: the drag handler writes physical
        // left/top inline, and RasterSubsetPanel sets the same precedent.
        !pos && "left-3 top-3",
      )}
      style={pos ? { left: pos.x, top: pos.y } : undefined}
      role="region"
      aria-label={t("styleManager.title")}
      data-testid="style-manager-panel"
    >
      <div
        className="flex cursor-move touch-none select-none items-center justify-between gap-2 border-b px-3 py-2"
        onPointerDown={handleDragStart}
        title={t("styleManager.description")}
      >
        <div className="flex min-w-0 items-center gap-2 text-sm font-semibold">
          <GripVertical className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <Palette className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
          <span className="truncate">{t("styleManager.title")}</span>
        </div>
        <button
          type="button"
          className="rounded-sm opacity-70 transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring"
          onClick={() => {
            setStyleManagerOpen(false);
            setStatus(null);
            setSaveFormOpen(false);
          }}
          aria-label={t("common.close")}
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-2 p-3">
        <div className="flex flex-wrap items-center gap-2">
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={t("styleManager.searchPlaceholder")}
            className="h-8 min-w-32 flex-1"
            aria-label={t("styleManager.searchPlaceholder")}
          />
          <Button
            size="sm"
            variant="outline"
            className="h-8 px-2"
            disabled={!canUseLayer}
            title={canUseLayer ? t("styleManager.saveCurrent") : t("styleManager.noLayer")}
            aria-label={t("styleManager.saveCurrent")}
            onClick={() => {
              setSaveFormOpen((current) => !current);
              setSaveName(layer?.name ?? "");
            }}
          >
            <Save className="h-3.5 w-3.5" />
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-8 px-2"
            title={t("styleManager.import")}
            aria-label={t("styleManager.import")}
            onClick={() => void handleImport()}
          >
            <Upload className="h-3.5 w-3.5" />
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-8 px-2"
            title={t("styleManager.export")}
            aria-label={t("styleManager.export")}
            onClick={() => void handleExport()}
          >
            <Download className="h-3.5 w-3.5" />
          </Button>
        </div>

        {allTags.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {allTags.map((tag) => (
              <button
                key={tag}
                type="button"
                onClick={() => setActiveTag((current) => (current === tag ? null : tag))}
                className={cn(
                  "rounded-full border px-2 py-0.5 text-xs",
                  activeTag === tag
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border bg-muted text-muted-foreground hover:text-foreground",
                )}
              >
                {tag}
              </button>
            ))}
          </div>
        )}

        {saveFormOpen && canUseLayer && layer && (
          <div className="space-y-2 rounded-md border border-border bg-muted/40 p-3">
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1">
                <Label htmlFor="style-manager-save-name">{t("styleManager.nameLabel")}</Label>
                <Input
                  id="style-manager-save-name"
                  value={saveName}
                  onChange={(event) => setSaveName(event.target.value)}
                  placeholder={layer.name}
                  className="h-8"
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="style-manager-save-kind">{t("styleManager.kindLabel")}</Label>
                <Select
                  id="style-manager-save-kind"
                  value={saveKind}
                  onChange={(event) => setSaveKind(event.target.value as StyleLibraryEntryKind)}
                >
                  <option value="style">{kindLabels.style}</option>
                  <option value="symbol">{kindLabels.symbol}</option>
                  <option value="labels">{kindLabels.labels}</option>
                  <option value="ramp">{kindLabels.ramp}</option>
                </Select>
              </div>
              <div className="space-y-1">
                <Label htmlFor="style-manager-save-tags">{t("styleManager.tagsLabel")}</Label>
                <Input
                  id="style-manager-save-tags"
                  value={saveTags}
                  onChange={(event) => setSaveTags(event.target.value)}
                  placeholder={t("styleManager.tagsPlaceholder")}
                  className="h-8"
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="style-manager-save-scope">{t("styleManager.scopeLabel")}</Label>
                <Select
                  id="style-manager-save-scope"
                  value={saveScope}
                  onChange={(event) => setSaveScope(event.target.value as "app" | "project")}
                >
                  <option value="app">{t("styleManager.scopeApp")}</option>
                  <option value="project">{t("styleManager.scopeProject")}</option>
                </Select>
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="ghost" onClick={() => setSaveFormOpen(false)}>
                {t("styleManager.cancel")}
              </Button>
              <Button size="sm" onClick={handleSave}>
                <Check className="me-1.5 h-3.5 w-3.5" />
                {t("styleManager.saveButton")}
              </Button>
            </div>
          </div>
        )}

        {status && (
          <p
            role="status"
            className={cn(
              "text-xs",
              status.type === "error" ? "text-destructive" : "text-emerald-600",
            )}
          >
            {status.text}
          </p>
        )}

        {!canUseLayer && (
          <p className="text-xs text-muted-foreground">{t("styleManager.noLayer")}</p>
        )}

        <ScrollArea className="min-h-0 flex-1">
          <div className="space-y-4 pe-3">
            {visibleCount === 0 && (
              <p className="py-6 text-center text-sm text-muted-foreground">
                {t("styleManager.empty")}
              </p>
            )}
            {sections.map(
              (section) =>
                section.entries.length > 0 && (
                  <div key={section.key} className="space-y-1.5">
                    <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      {section.title}
                    </h3>
                    <ul className="space-y-1">
                      {section.entries.map((entry) => (
                        <li
                          key={entry.id}
                          className="flex items-center gap-3 rounded-md border border-border px-2 py-1.5"
                        >
                          <EntryPreview entry={entry} />
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-sm font-medium">{entry.name}</p>
                            <p className="truncate text-xs text-muted-foreground">
                              {kindLabels[entry.kind]}
                              {entry.tags.length > 0 ? ` · ${entry.tags.join(", ")}` : ""}
                            </p>
                          </div>
                          <Button
                            size="sm"
                            variant="secondary"
                            disabled={!canUseLayer}
                            onClick={() => applyEntry(entry)}
                          >
                            {t("styleManager.apply")}
                          </Button>
                          {!section.readOnly && (
                            <Button
                              size="icon"
                              variant="ghost"
                              className="h-8 w-8 shrink-0"
                              aria-label={t("styleManager.delete")}
                              title={t("styleManager.delete")}
                              onClick={() => {
                                // Scope-bound so deleting a project entry can
                                // never erase an app-library entry that
                                // happens to share the id (or vice versa).
                                deleteStyleLibraryEntry(
                                  entry.id,
                                  section.key === "project" ? "project" : "app",
                                );
                                setStatus({
                                  type: "success",
                                  text: t("styleManager.deleted", {
                                    name: entry.name,
                                  }),
                                });
                              }}
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          )}
                        </li>
                      ))}
                    </ul>
                  </div>
                ),
            )}
          </div>
        </ScrollArea>
      </div>
    </div>
  );
}
