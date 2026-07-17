// The Style Manager (issue #1294): a browsable library of reusable saved
// styles (full styles, symbols, label presets, color-ramp presets) with tags
// and previews. Entries live in the app-level library (persisted across
// projects via IndexedDB, see useStyleLibraryPersistence) or embedded in the
// current project file; built-in presets seed the library so it is never
// empty. Import accepts GeoLibre style-library bundles plus QGIS QML and OGC
// SLD (converted through the existing packages/map importers); export writes
// a shareable JSON bundle.

import {
  BUILT_IN_STYLE_PRESETS,
  createStyleLibraryEntryId,
  DEFAULT_LAYER_STYLE,
  extractStyleLibraryStyle,
  interpolateRampColors,
  parseStyleLibrary,
  serializeStyleLibrary,
  useAppStore,
  type GeoLibreLayer,
  type StyleLibraryEntry,
  type StyleLibraryEntryKind,
} from "@geolibre/core";
import {
  applyQmlImport,
  applySldImport,
  parseQml,
  parseSld,
} from "@geolibre/map";
import {
  Button,
  cn,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  ScrollArea,
  Select,
} from "@geolibre/ui";
import { Check, Download, Save, Trash2, Upload } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  openLocalDataFileWithFallback,
  saveTextFileWithFallback,
} from "../../lib/tauri-io";

/**
 * Layer types whose symbology is driven by the vector {@link LayerStyle}
 * fields, and can therefore receive a saved style. Mirrors the LayerPanel's
 * style-import gate.
 */
const STYLABLE_LAYER_TYPES = new Set<GeoLibreLayer["type"]>([
  "geojson",
  "vector-tiles",
]);

type StatusNote = { type: "success" | "error"; text: string } | null;

/**
 * Render a small preview swatch for a library entry: a gradient strip for
 * ramp presets, a text specimen for label presets, and polygon/line/point
 * glyphs for symbol and full-style entries.
 */
function EntryPreview({ entry }: { entry: StyleLibraryEntry }) {
  const style = { ...DEFAULT_LAYER_STYLE, ...entry.style };
  if (entry.kind === "ramp") {
    const colors = interpolateRampColors(
      style.vectorStyleColorRamp,
      Math.max(style.vectorStyleClassCount, 2),
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

export function StyleManagerDialog() {
  const { t } = useTranslation();
  const open = useAppStore((s) => s.ui.styleManagerOpen);
  const setStyleManagerOpen = useAppStore((s) => s.setStyleManagerOpen);
  const styleLibrary = useAppStore((s) => s.styleLibrary);
  const projectStyleLibrary = useAppStore((s) => s.projectStyleLibrary);
  const saveStyleLibraryEntry = useAppStore((s) => s.saveStyleLibraryEntry);
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

  const layer = layers.find((l) => l.id === selectedLayerId);
  const canUseLayer = layer !== undefined && STYLABLE_LAYER_TYPES.has(layer.type);

  const kindLabels: Record<StyleLibraryEntryKind, string> = {
    style: t("styleManager.kindStyle"),
    symbol: t("styleManager.kindSymbol"),
    labels: t("styleManager.kindLabels"),
    ramp: t("styleManager.kindRamp"),
  };

  const allTags = useMemo(() => {
    const tags = new Set<string>();
    for (const entry of [
      ...BUILT_IN_STYLE_PRESETS,
      ...styleLibrary,
      ...projectStyleLibrary,
    ]) {
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
    if (entry.kind === "style") {
      updateLayer(layer.id, { style: { ...DEFAULT_LAYER_STYLE, ...patch } });
    } else {
      setLayerStyle(layer.id, patch);
    }
    setStatus({
      type: "success",
      text: t("styleManager.applied", { name: entry.name, layer: layer.name }),
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
            name: "Style library / QML / SLD",
            extensions: ["json", "qml", "sld", "xml"],
          },
        ],
        accept:
          ".json,.qml,.sld,.xml,application/json,application/xml,text/xml",
        readText: true,
      });
      if (!picked || picked.text === undefined) return;
      const fileName =
        picked.path.split(/[\\/]/).pop()?.replace(/\.[^.]+$/, "") ?? "";
      const trimmed = picked.text.trimStart();
      if (trimmed.startsWith("<")) {
        // A QGIS QML or OGC SLD file: convert it to a full-style entry via the
        // shared importers, same content sniff as the LayerPanel import.
        const isQml = /<qgis[\s>]|<renderer-v2[\s>]/.test(picked.text);
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
      // ids, and ids of project-scoped entries (the app-scope upsert would
      // silently pull those out of the project file). A collision with an
      // existing app-library id is intentional upsert semantics, so
      // re-importing an exported bundle updates entries instead of
      // duplicating them.
      const projectIds = new Set(projectStyleLibrary.map((e) => e.id));
      for (const entry of entries) {
        saveStyleLibraryEntry(
          {
            ...entry,
            id:
              entry.id.startsWith("preset-") || projectIds.has(entry.id)
                ? createStyleLibraryEntryId()
                : entry.id,
          },
          "app",
        );
      }
      setStatus({
        type: "success",
        text: t("styleManager.importedCount", { count: entries.length }),
      });
    } catch (error) {
      setStatus({
        type: "error",
        text:
          error instanceof Error
            ? error.message
            : t("styleManager.importInvalid"),
      });
    }
  };

  const handleExport = async () => {
    const entries = [...projectStyleLibrary, ...styleLibrary];
    if (entries.length === 0) {
      setStatus({ type: "error", text: t("styleManager.exportEmpty") });
      return;
    }
    try {
      const savedPath = await saveTextFileWithFallback(
        serializeStyleLibrary(entries),
        {
          defaultName: "geolibre-styles.json",
          filters: [{ name: "GeoLibre style library", extensions: ["json"] }],
          browserTypes: [
            {
              description: "GeoLibre style library",
              accept: { "application/json": [".json"] },
            },
          ],
          mimeType: "application/json",
        },
      );
      if (savedPath !== null) {
        setStatus({ type: "success", text: t("styleManager.exportSuccess") });
      }
    } catch (error) {
      setStatus({
        type: "error",
        text:
          error instanceof Error ? error.message : t("styleManager.exportEmpty"),
      });
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setStyleManagerOpen(false);
          setStatus(null);
          setSaveFormOpen(false);
        }
      }}
    >
      <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("styleManager.title")}</DialogTitle>
          <DialogDescription>{t("styleManager.description")}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-wrap items-center gap-2">
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={t("styleManager.searchPlaceholder")}
            className="h-8 w-48 flex-1"
            aria-label={t("styleManager.searchPlaceholder")}
          />
          <Button
            size="sm"
            variant="outline"
            disabled={!canUseLayer}
            title={canUseLayer ? undefined : t("styleManager.noLayer")}
            onClick={() => {
              setSaveFormOpen((current) => !current);
              setSaveName(layer?.name ?? "");
            }}
          >
            <Save className="me-1.5 h-3.5 w-3.5" />
            {t("styleManager.saveCurrent")}
          </Button>
          <Button size="sm" variant="outline" onClick={() => void handleImport()}>
            <Upload className="me-1.5 h-3.5 w-3.5" />
            {t("styleManager.import")}
          </Button>
          <Button size="sm" variant="outline" onClick={() => void handleExport()}>
            <Download className="me-1.5 h-3.5 w-3.5" />
            {t("styleManager.export")}
          </Button>
        </div>

        {allTags.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {allTags.map((tag) => (
              <button
                key={tag}
                type="button"
                onClick={() =>
                  setActiveTag((current) => (current === tag ? null : tag))
                }
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
                <Label htmlFor="style-manager-save-name">
                  {t("styleManager.nameLabel")}
                </Label>
                <Input
                  id="style-manager-save-name"
                  value={saveName}
                  onChange={(event) => setSaveName(event.target.value)}
                  placeholder={layer.name}
                  className="h-8"
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="style-manager-save-kind">
                  {t("styleManager.kindLabel")}
                </Label>
                <Select
                  id="style-manager-save-kind"
                  value={saveKind}
                  onChange={(event) =>
                    setSaveKind(event.target.value as StyleLibraryEntryKind)
                  }
                >
                  <option value="style">{kindLabels.style}</option>
                  <option value="symbol">{kindLabels.symbol}</option>
                  <option value="labels">{kindLabels.labels}</option>
                  <option value="ramp">{kindLabels.ramp}</option>
                </Select>
              </div>
              <div className="space-y-1">
                <Label htmlFor="style-manager-save-tags">
                  {t("styleManager.tagsLabel")}
                </Label>
                <Input
                  id="style-manager-save-tags"
                  value={saveTags}
                  onChange={(event) => setSaveTags(event.target.value)}
                  placeholder={t("styleManager.tagsPlaceholder")}
                  className="h-8"
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="style-manager-save-scope">
                  {t("styleManager.scopeLabel")}
                </Label>
                <Select
                  id="style-manager-save-scope"
                  value={saveScope}
                  onChange={(event) =>
                    setSaveScope(event.target.value as "app" | "project")
                  }
                >
                  <option value="app">{t("styleManager.scopeApp")}</option>
                  <option value="project">
                    {t("styleManager.scopeProject")}
                  </option>
                </Select>
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setSaveFormOpen(false)}
              >
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
          <p className="text-xs text-muted-foreground">
            {t("styleManager.noLayer")}
          </p>
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
                            <p className="truncate text-sm font-medium">
                              {entry.name}
                            </p>
                            <p className="truncate text-xs text-muted-foreground">
                              {kindLabels[entry.kind]}
                              {entry.tags.length > 0
                                ? ` · ${entry.tags.join(", ")}`
                                : ""}
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
                                deleteStyleLibraryEntry(entry.id);
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
      </DialogContent>
    </Dialog>
  );
}
