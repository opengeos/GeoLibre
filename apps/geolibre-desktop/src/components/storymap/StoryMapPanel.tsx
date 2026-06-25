import {
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import {
  DEFAULT_STORY_MAP,
  createSampleStoryMap,
  parseStoryMapCsv,
  parseStoryMapJson,
  serializeStoryMapCsv,
  serializeStoryMapJson,
  storyMapHasContent,
  useAppStore,
  type StoryChapter,
  type StoryChapterAlignment,
  type StoryChapterAnimation,
  type StoryInsetPosition,
  type StoryLayerOpacityChange,
  type StoryMap,
} from "@geolibre/core";
import type { MapController } from "@geolibre/map";
import {
  Button,
  ColorField,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Input,
  Label,
  ScrollArea,
  Select,
  Separator,
  Slider,
  Textarea,
} from "@geolibre/ui";
import {
  ChevronDown,
  ChevronUp,
  Crosshair,
  Download,
  FileDown,
  Frame,
  MapPin,
  Play,
  Plus,
  RotateCcw,
  Sparkles,
  Trash2,
  Upload,
} from "lucide-react";
import { saveTextFileWithFallback } from "../../lib/tauri-io";
import { buildStoryMapHtml } from "../../lib/storymap-export";
import { StoryMapHandoutDialog } from "./StoryMapHandoutDialog";

interface StoryMapPanelProps {
  mapControllerRef: RefObject<MapController | null>;
}

function createId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `chapter-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

/**
 * Authoring panel for scroll-driven story maps.
 *
 * Lets the user capture the current map camera into ordered chapters, edit the
 * story metadata, control per-chapter layer fades, preview chapters on the live
 * map, present the story, and export a standalone HTML document.
 */
export function StoryMapPanel({ mapControllerRef }: StoryMapPanelProps) {
  const { t } = useTranslation();
  const open = useAppStore((s) => s.ui.storymapPanelOpen);
  const setOpen = useAppStore((s) => s.setStorymapPanelOpen);
  const setPresenting = useAppStore((s) => s.setStorymapPresenting);
  const setComposing = useAppStore((s) => s.setStorymapComposing);
  const storymap = useAppStore((s) => s.storymap);
  const layers = useAppStore((s) => s.layers);
  const basemapStyleUrl = useAppStore((s) => s.basemapStyleUrl);

  const setStorymap = useAppStore((s) => s.setStorymap);
  const updateSettings = useAppStore((s) => s.updateStorymapSettings);
  const addChapter = useAppStore((s) => s.addStoryChapter);
  const updateChapter = useAppStore((s) => s.updateStoryChapter);
  const removeChapter = useAppStore((s) => s.removeStoryChapter);
  const moveChapter = useAppStore((s) => s.moveStoryChapter);

  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const [handoutOpen, setHandoutOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const importFormatRef = useRef<"json" | "csv">("json");

  // Explicit dialog size once the user drags the bottom-right grip (null = the
  // default responsive size). The dialog element is read for its live size.
  const dialogRef = useRef<HTMLDivElement>(null);
  const [dialogSize, setDialogSize] = useState<{
    width: number;
    height: number;
  } | null>(null);
  // Tears down an in-progress resize drag (removes the window listeners and
  // cancels the pending RAF) so it can't leak if the dialog unmounts mid-drag.
  const resizeCleanupRef = useRef<(() => void) | null>(null);

  // Resize the whole dialog from its bottom-right grip. The dialog is centred
  // via a -50% transform, so the right/bottom edges move by half the size
  // change; growing by 2x the pointer delta keeps the grip under the cursor.
  const startDialogResize = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      event.stopPropagation();
      event.currentTarget.setPointerCapture?.(event.pointerId);
      const el = dialogRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const startX = event.clientX;
      const startY = event.clientY;
      const startW = rect.width;
      const startH = rect.height;
      let next = { width: startW, height: startH };
      let frame: number | null = null;
      const prevCursor = document.body.style.cursor;
      const prevSelect = document.body.style.userSelect;
      document.body.style.cursor = "nwse-resize";
      document.body.style.userSelect = "none";

      const onMove = (e: PointerEvent) => {
        next = {
          width: Math.max(
            360,
            Math.min(window.innerWidth - 16, startW + (e.clientX - startX) * 2),
          ),
          height: Math.max(
            320,
            Math.min(window.innerHeight - 16, startH + (e.clientY - startY) * 2),
          ),
        };
        if (frame !== null) return;
        frame = window.requestAnimationFrame(() => {
          frame = null;
          setDialogSize(next);
        });
      };
      const cleanup = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onUp);
        if (frame !== null) window.cancelAnimationFrame(frame);
        document.body.style.cursor = prevCursor;
        document.body.style.userSelect = prevSelect;
        resizeCleanupRef.current = null;
      };
      const onUp = () => {
        cleanup();
        setDialogSize(next);
      };
      resizeCleanupRef.current = cleanup;
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
    },
    [],
  );

  // Tear down an in-progress resize drag if the dialog unmounts mid-drag.
  useEffect(() => () => resizeCleanupRef.current?.(), []);

  const story: StoryMap = storymap ?? DEFAULT_STORY_MAP;
  const chapters = story.chapters;
  // Reset has something to clear when the story carries chapters or any
  // non-default setting, so it stays disabled in the empty state (where "Load
  // sample story" is the relevant action) even if a stale `storymap` object
  // lingers after the last chapter was deleted manually. Reuse the canonical
  // check from @geolibre/core so this stays in sync with how the project layer
  // decides a story is worth persisting.
  const hasStoryContent = storyMapHasContent(story);

  const handleAddChapter = useCallback(() => {
    const view = mapControllerRef.current?.readView();
    const chapter: StoryChapter = {
      id: createId(),
      title: t("storymap.defaultChapterTitle", {
        index: chapters.length + 1,
      }),
      description: "",
      alignment: "left",
      hidden: false,
      location: {
        center: view?.center ?? [0, 0],
        zoom: view?.zoom ?? 2,
        pitch: view?.pitch ?? 0,
        bearing: view?.bearing ?? 0,
      },
      mapAnimation: "flyTo",
      rotateAnimation: false,
      onChapterEnter: [],
      onChapterExit: [],
    };
    addChapter(chapter);
    setExpandedId(chapter.id);
  }, [addChapter, chapters.length, mapControllerRef, t]);

  const handleLoadSample = useCallback(() => {
    const sample = createSampleStoryMap();
    setStorymap(sample);
    setExpandedId(null);
    const first = sample.chapters[0];
    if (first) mapControllerRef.current?.flyToView(first.location);
  }, [mapControllerRef, setStorymap]);

  const handleReset = useCallback(() => {
    if (!window.confirm(t("storymap.resetConfirm"))) return;
    // Clearing the story drops back to the empty default (the panel falls back
    // to DEFAULT_STORY_MAP when `storymap` is null), so the empty state with the
    // "Load sample story" button reappears and users can build their own.
    setStorymap(null);
    setExpandedId(null);
  }, [setStorymap, t]);

  const handleCaptureView = useCallback(
    (id: string) => {
      const view = mapControllerRef.current?.readView();
      if (!view) return;
      updateChapter(id, {
        location: {
          center: view.center,
          zoom: view.zoom,
          pitch: view.pitch,
          bearing: view.bearing,
        },
      });
    },
    [mapControllerRef, updateChapter],
  );

  const handlePreview = useCallback(
    (chapter: StoryChapter) => {
      mapControllerRef.current?.flyToView(chapter.location);
    },
    [mapControllerRef],
  );

  const handleCompose = useCallback(
    (chapter: StoryChapter) => {
      // Reveal the live map by closing the dialog (its full-screen overlay
      // otherwise hides the map), fly to the chapter's saved view so composing
      // starts from where the slide currently sits, then enter compose mode.
      // The floating compose bar takes over from here to save or cancel.
      mapControllerRef.current?.flyToView(chapter.location);
      setComposing(chapter.id);
      setOpen(false);
    },
    [mapControllerRef, setComposing, setOpen],
  );

  const handlePresent = useCallback(() => {
    if (chapters.length === 0) return;
    setOpen(false);
    setPresenting(true);
  }, [chapters.length, setOpen, setPresenting]);

  const handleExport = useCallback(async () => {
    setExportError(null);
    if (chapters.length === 0) return;
    try {
      const html = buildStoryMapHtml({
        storymap: story,
        basemapStyleUrl,
        layers,
      });
      const slug =
        (story.title || "story-map")
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-+|-+$/g, "") || "story-map";
      await saveTextFileWithFallback(html, {
        defaultName: `${slug}.html`,
        filters: [{ name: t("storymap.htmlFile"), extensions: ["html"] }],
        browserTypes: [
          {
            description: t("storymap.htmlFile"),
            accept: { "text/html": [".html"] },
          },
        ],
        mimeType: "text/html",
      });
    } catch (error) {
      setExportError(
        error instanceof Error ? error.message : String(error),
      );
    }
  }, [basemapStyleUrl, chapters.length, layers, story, t]);

  const handleExportData = useCallback(
    async (format: "json" | "csv") => {
      setExportError(null);
      if (chapters.length === 0) return;
      const slug =
        (story.title || "story-map")
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-+|-+$/g, "") || "story-map";
      try {
        const content =
          format === "json"
            ? serializeStoryMapJson(story)
            : serializeStoryMapCsv(story);
        const mimeType = format === "json" ? "application/json" : "text/csv";
        await saveTextFileWithFallback(content, {
          defaultName: `${slug}.${format}`,
          filters: [{ name: format.toUpperCase(), extensions: [format] }],
          browserTypes: [
            {
              description: format.toUpperCase(),
              accept: { [mimeType]: [`.${format}`] },
            },
          ],
          mimeType,
        });
      } catch (error) {
        setExportError(error instanceof Error ? error.message : String(error));
      }
    },
    [chapters.length, story],
  );

  const triggerImport = useCallback((format: "json" | "csv") => {
    importFormatRef.current = format;
    fileInputRef.current?.click();
  }, []);

  const handleImportFile = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      setExportError(null);
      const file = event.target.files?.[0];
      // Reset so selecting the same file again re-triggers change.
      event.target.value = "";
      if (!file) return;
      try {
        const text = await file.text();
        // Detect by extension, falling back to the menu choice.
        const isCsv = file.name.toLowerCase().endsWith(".csv")
          ? true
          : file.name.toLowerCase().endsWith(".json")
            ? false
            : importFormatRef.current === "csv";
        const imported = isCsv
          ? parseStoryMapCsv(text, storymap)
          : parseStoryMapJson(text);
        setStorymap(imported);
        setExpandedId(null);
      } catch (error) {
        setExportError(
          error instanceof Error ? error.message : String(error),
        );
      }
    },
    [setStorymap, storymap],
  );

  return (
    <>
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent
        ref={dialogRef}
        className="flex max-h-[88vh] w-[min(92vw,46rem)] flex-col gap-0 p-0"
        style={
          dialogSize
            ? {
                width: dialogSize.width,
                height: dialogSize.height,
                maxWidth: "none",
                maxHeight: "none",
              }
            : undefined
        }
        bodyClassName="flex min-h-0 flex-1 flex-col gap-0 overflow-hidden p-0"
        resizeHandle={
          <div
            role="separator"
            aria-label={t("storymap.resizeDialog")}
            title={t("storymap.resizeDialog")}
            onPointerDown={startDialogResize}
            className="absolute bottom-0 right-0 z-10 hidden h-5 w-5 cursor-nwse-resize touch-none select-none text-muted-foreground hover:text-foreground md:block"
          >
            <svg viewBox="0 0 16 16" className="h-full w-full" aria-hidden="true">
              <path
                d="M11 15L15 11M6 15L15 6"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
              />
            </svg>
          </div>
        }
      >
        <DialogHeader className="border-b px-5 py-4">
          <DialogTitle className="flex items-center gap-2">
            <MapPin className="h-4 w-4" />
            {t("storymap.title")}
          </DialogTitle>
          <DialogDescription>{t("storymap.description")}</DialogDescription>
        </DialogHeader>

        <input
          ref={fileInputRef}
          type="file"
          accept=".json,.csv,application/json,text/csv,text/plain"
          className="hidden"
          onChange={(e) => void handleImportFile(e)}
        />

        {/* Force the Radix viewport's inner wrapper to `display:block`
            (it defaults to `display:table; min-width:100%`, which sizes to the
            content's intrinsic width and spawns a spurious horizontal scrollbar
            that, with the vertical one, covered the chapter action buttons —
            #775). `!block` overrides the inline style. */}
        <ScrollArea className="min-h-0 flex-1 [&_[data-radix-scroll-area-viewport]>div]:!block">
          {/* Pad the content (not the ScrollArea root) so the overlay
              scrollbar sits in the right gutter instead of over the content. */}
          <div className="px-5 py-4">
          <StorySettings story={story} onChange={updateSettings} t={t} />

          <Separator className="my-4" />

          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-semibold">
              {t("storymap.chapters", { count: chapters.length })}
            </h3>
            <div className="flex items-center gap-2">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button size="sm" variant="outline">
                    <Upload className="mr-1 h-4 w-4" />
                    {t("storymap.import")}
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onSelect={() => triggerImport("json")}>
                    {t("storymap.importJson")}
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => triggerImport("csv")}>
                    {t("storymap.importCsv")}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button size="sm" variant="outline" disabled={chapters.length === 0}>
                    <Download className="mr-1 h-4 w-4" />
                    {t("storymap.exportData")}
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onSelect={() => void handleExportData("json")}>
                    {t("storymap.exportJson")}
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => void handleExportData("csv")}>
                    {t("storymap.exportCsv")}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
              <Button size="sm" variant="outline" onClick={handleAddChapter}>
                <Plus className="mr-1 h-4 w-4" />
                {t("storymap.addChapter")}
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={!hasStoryContent}
                title={t("storymap.resetTitle")}
                onClick={handleReset}
              >
                <RotateCcw className="mr-1 h-4 w-4" />
                {t("storymap.reset")}
              </Button>
            </div>
          </div>

          {chapters.length === 0 ? (
            <div className="flex flex-col items-center gap-3 rounded-md border border-dashed px-3 py-6 text-center text-sm text-muted-foreground">
              <p>{t("storymap.empty")}</p>
              <Button size="sm" variant="secondary" onClick={handleLoadSample}>
                <Sparkles className="mr-1 h-4 w-4" />
                {t("storymap.loadSample")}
              </Button>
            </div>
          ) : (
            <div className="space-y-2">
              {chapters.map((chapter, index) => (
                <ChapterCard
                  key={chapter.id}
                  chapter={chapter}
                  index={index}
                  total={chapters.length}
                  expanded={expandedId === chapter.id}
                  layers={layers}
                  t={t}
                  onToggle={() =>
                    setExpandedId((id) =>
                      id === chapter.id ? null : chapter.id,
                    )
                  }
                  onUpdate={(patch) => updateChapter(chapter.id, patch)}
                  onRemove={() => removeChapter(chapter.id)}
                  onMove={(direction) =>
                    moveChapter(
                      chapter.id,
                      direction === "up" ? index - 1 : index + 1,
                    )
                  }
                  onCaptureView={() => handleCaptureView(chapter.id)}
                  onPreview={() => handlePreview(chapter)}
                  onCompose={() => handleCompose(chapter)}
                />
              ))}
            </div>
          )}
          </div>
        </ScrollArea>

        <div className="flex items-center justify-between gap-2 border-t px-5 py-3">
          <div className="min-h-[1.25rem] text-xs text-destructive">
            {exportError}
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={chapters.length === 0}
              onClick={() => void handleExport()}
            >
              <Download className="mr-1 h-4 w-4" />
              {t("storymap.exportHtml")}
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={chapters.length === 0}
              onClick={() => setHandoutOpen(true)}
            >
              <FileDown className="mr-1 h-4 w-4" />
              {t("storymap.handout.button")}
            </Button>
            <Button
              size="sm"
              disabled={chapters.length === 0}
              onClick={handlePresent}
            >
              <Play className="mr-1 h-4 w-4" />
              {t("storymap.present")}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
    <StoryMapHandoutDialog
      open={handoutOpen}
      onOpenChange={setHandoutOpen}
      story={story}
      mapControllerRef={mapControllerRef}
    />
    </>
  );
}

type TFn = TFunction;

function StorySettings({
  story,
  onChange,
  t,
}: {
  story: StoryMap;
  onChange: (patch: Partial<Omit<StoryMap, "chapters">>) => void;
  t: TFn;
}) {
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label={t("storymap.field.title")}>
          <Input
            value={story.title}
            onChange={(e) => onChange({ title: e.target.value })}
          />
        </Field>
        <Field label={t("storymap.field.subtitle")}>
          <Input
            value={story.subtitle}
            onChange={(e) => onChange({ subtitle: e.target.value })}
          />
        </Field>
        <Field label={t("storymap.field.byline")}>
          <Input
            value={story.byline}
            onChange={(e) => onChange({ byline: e.target.value })}
          />
        </Field>
        <Field label={t("storymap.field.theme")}>
          <Select
            value={story.theme}
            onChange={(e) =>
              onChange({ theme: e.target.value as StoryMap["theme"] })
            }
          >
            <option value="dark">{t("storymap.theme.dark")}</option>
            <option value="light">{t("storymap.theme.light")}</option>
          </Select>
        </Field>
      </div>
      <Field label={t("storymap.field.footer")}>
        <Input
          value={story.footer}
          onChange={(e) => onChange({ footer: e.target.value })}
        />
      </Field>
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={story.showMarkers}
            onChange={(e) => onChange({ showMarkers: e.target.checked })}
          />
          {t("storymap.field.showMarkers")}
        </label>
        {story.showMarkers ? (
          <ColorField
            fill={false}
            aria-label={t("storymap.field.markerColor")}
            eyedropperLabel={t("storymap.field.markerColor")}
            value={story.markerColor}
            onChange={(markerColor) => onChange({ markerColor })}
            className="h-7 w-10 cursor-pointer p-0.5"
            buttonClassName="h-7 w-7"
          />
        ) : null}
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={story.inset}
            onChange={(e) => onChange({ inset: e.target.checked })}
          />
          {t("storymap.field.inset")}
        </label>
        {story.inset ? (
          <Select
            className="w-40"
            value={story.insetPosition}
            onChange={(e) =>
              onChange({
                insetPosition: e.target.value as StoryInsetPosition,
              })
            }
          >
            <option value="top-left">{t("storymap.inset.topLeft")}</option>
            <option value="top-right">{t("storymap.inset.topRight")}</option>
            <option value="bottom-left">
              {t("storymap.inset.bottomLeft")}
            </option>
            <option value="bottom-right">
              {t("storymap.inset.bottomRight")}
            </option>
          </Select>
        ) : null}
      </div>
    </div>
  );
}

interface ChapterCardProps {
  chapter: StoryChapter;
  index: number;
  total: number;
  expanded: boolean;
  layers: { id: string; name: string }[];
  t: TFn;
  onToggle: () => void;
  onUpdate: (patch: Partial<StoryChapter>) => void;
  onRemove: () => void;
  onMove: (direction: "up" | "down") => void;
  onCaptureView: () => void;
  onPreview: () => void;
  onCompose: () => void;
}

function ChapterCard({
  chapter,
  index,
  total,
  expanded,
  layers,
  t,
  onToggle,
  onUpdate,
  onRemove,
  onMove,
  onCaptureView,
  onPreview,
  onCompose,
}: ChapterCardProps) {
  const { center, zoom, pitch, bearing } = chapter.location;
  return (
    <div className="rounded-md border">
      <div className="flex items-center gap-1 px-2 py-1.5">
        <button
          type="button"
          className="flex flex-1 items-center gap-2 truncate text-left text-sm font-medium"
          onClick={onToggle}
        >
          <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded bg-muted text-xs">
            {index + 1}
          </span>
          <span className="truncate">
            {chapter.title || t("storymap.untitledChapter")}
          </span>
        </button>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          title={t("storymap.composeOnMap")}
          onClick={onCompose}
        >
          <Frame className="h-4 w-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          title={t("storymap.preview")}
          onClick={onPreview}
        >
          <MapPin className="h-4 w-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          disabled={index === 0}
          title={t("storymap.moveUp")}
          onClick={() => onMove("up")}
        >
          <ChevronUp className="h-4 w-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          disabled={index === total - 1}
          title={t("storymap.moveDown")}
          onClick={() => onMove("down")}
        >
          <ChevronDown className="h-4 w-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 text-destructive"
          title={t("common.remove")}
          onClick={onRemove}
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      </div>

      {expanded ? (
        <div className="space-y-3 border-t px-3 py-3">
          <Field label={t("storymap.field.chapterTitle")}>
            <Input
              value={chapter.title}
              onChange={(e) => onUpdate({ title: e.target.value })}
            />
          </Field>
          <Field label={t("storymap.field.description")}>
            <Textarea
              rows={3}
              value={chapter.description}
              onChange={(e) => onUpdate({ description: e.target.value })}
            />
          </Field>
          <Field label={t("storymap.field.image")}>
            <Input
              placeholder={t("storymap.field.imagePlaceholder")}
              value={chapter.image ?? ""}
              onChange={(e) =>
                onUpdate({ image: e.target.value || undefined })
              }
            />
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label={t("storymap.field.alignment")}>
              <Select
                value={chapter.alignment}
                onChange={(e) =>
                  onUpdate({
                    alignment: e.target.value as StoryChapterAlignment,
                  })
                }
              >
                <option value="left">{t("storymap.align.left")}</option>
                <option value="center">{t("storymap.align.center")}</option>
                <option value="right">{t("storymap.align.right")}</option>
                <option value="full">{t("storymap.align.full")}</option>
              </Select>
            </Field>
            <Field label={t("storymap.field.animation")}>
              <Select
                value={chapter.mapAnimation}
                onChange={(e) =>
                  onUpdate({
                    mapAnimation: e.target.value as StoryChapterAnimation,
                  })
                }
              >
                <option value="flyTo">flyTo</option>
                <option value="easeTo">easeTo</option>
                <option value="jumpTo">jumpTo</option>
              </Select>
            </Field>
          </div>

          <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={chapter.hidden}
                onChange={(e) => onUpdate({ hidden: e.target.checked })}
              />
              {t("storymap.field.hidden")}
            </label>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={chapter.rotateAnimation}
                onChange={(e) =>
                  onUpdate({ rotateAnimation: e.target.checked })
                }
              />
              {t("storymap.field.rotate")}
            </label>
          </div>

          <div className="rounded-md bg-muted/50 px-3 py-2 text-xs">
            <div className="mb-2 flex items-center justify-between">
              <span className="font-mono">
                {center[0].toFixed(4)}, {center[1].toFixed(4)} · z
                {zoom.toFixed(1)} · p{pitch.toFixed(0)} · b{bearing.toFixed(0)}
              </span>
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7"
                  onClick={onCaptureView}
                >
                  <Crosshair className="mr-1 h-3.5 w-3.5" />
                  {t("storymap.captureView")}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7"
                  onClick={onCompose}
                >
                  <Frame className="mr-1 h-3.5 w-3.5" />
                  {t("storymap.composeOnMap")}
                </Button>
              </div>
            </div>
          </div>

          <LayerEffectsEditor
            label={t("storymap.onEnter")}
            changes={chapter.onChapterEnter}
            layers={layers}
            t={t}
            onChange={(onChapterEnter) => onUpdate({ onChapterEnter })}
          />
          <LayerEffectsEditor
            label={t("storymap.onExit")}
            changes={chapter.onChapterExit}
            layers={layers}
            t={t}
            onChange={(onChapterExit) => onUpdate({ onChapterExit })}
          />
        </div>
      ) : null}
    </div>
  );
}

function LayerEffectsEditor({
  label,
  changes,
  layers,
  t,
  onChange,
}: {
  label: string;
  changes: StoryLayerOpacityChange[];
  layers: { id: string; name: string }[];
  t: TFn;
  onChange: (changes: StoryLayerOpacityChange[]) => void;
}) {
  const layerName = useMemo(() => {
    const map = new Map(layers.map((l) => [l.id, l.name]));
    return (id: string) => map.get(id) ?? id;
  }, [layers]);

  // Nothing to add and nothing to clean up: hide the section entirely. When
  // stale effects remain after the last layer is deleted, keep rendering them so
  // the user can still remove the now-broken references.
  if (layers.length === 0 && changes.length === 0) return null;

  const update = (i: number, patch: Partial<StoryLayerOpacityChange>) =>
    onChange(changes.map((c, idx) => (idx === i ? { ...c, ...patch } : c)));

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <Label className="text-xs">{label}</Label>
        <Button
          size="sm"
          variant="ghost"
          className="h-6 px-2 text-xs"
          disabled={layers.length === 0}
          onClick={() =>
            onChange([
              ...changes,
              { id: createId(), layerId: layers[0].id, opacity: 1, duration: 1000 },
            ])
          }
        >
          <Plus className="mr-1 h-3 w-3" />
          {t("storymap.addEffect")}
        </Button>
      </div>
      {changes.map((change, i) => (
        <div key={change.id ?? `${change.layerId}-${i}`} className="flex items-center gap-2">
          <Select
            className="flex-1"
            value={change.layerId}
            onChange={(e) => update(i, { layerId: e.target.value })}
          >
            {/* Keep an orphaned layerId selectable so it can be inspected and
                removed even after its layer was deleted. */}
            {!layers.some((layer) => layer.id === change.layerId) ? (
              <option value={change.layerId}>{layerName(change.layerId)}</option>
            ) : null}
            {layers.map((layer) => (
              <option key={layer.id} value={layer.id}>
                {layerName(layer.id)}
              </option>
            ))}
          </Select>
          <Slider
            className="w-24"
            aria-label={t("storymap.opacityLabel")}
            min={0}
            max={1}
            step={0.1}
            value={[change.opacity]}
            onValueChange={([next]: number[]) => {
              if (typeof next === "number") update(i, { opacity: next });
            }}
          />
          <span className="w-8 shrink-0 text-right font-mono text-xs">
            {change.opacity.toFixed(1)}
          </span>
          <Input
            type="number"
            min={0}
            max={60000}
            step={100}
            className="h-7 w-20 shrink-0"
            aria-label={t("storymap.durationLabel")}
            title={t("storymap.durationLabel")}
            value={change.duration ?? 0}
            onChange={(e) => {
              // Cap at 60s so a typo can't produce a multi-minute transition.
              const ms = Math.min(60000, Math.max(0, Number(e.target.value) || 0));
              update(i, { duration: ms });
            }}
          />
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 text-destructive"
            title={t("common.remove")}
            onClick={() => onChange(changes.filter((_, idx) => idx !== i))}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      ))}
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1">
      <Label className="text-xs">{label}</Label>
      {children}
    </div>
  );
}
