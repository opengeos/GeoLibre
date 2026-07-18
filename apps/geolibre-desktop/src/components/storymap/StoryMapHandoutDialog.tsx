import { type RefObject, useCallback, useEffect, useMemo, useRef, useState } from "react";
import maplibregl from "maplibre-gl";
import { useTranslation } from "react-i18next";
import type { StoryActiveSlideMode, StoryChapter, StoryMap } from "@geolibre/core";
import type { MapController } from "@geolibre/map";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  ScrollArea,
  Select,
  Separator,
} from "@geolibre/ui";
import { FileDown, Loader2 } from "lucide-react";
import { captureMapImage } from "../../lib/print-layout-export";
import { PAPER_SIZES, type Orientation, type PaperSizeId } from "../../lib/print-layout";
import { buildStoryMapHandoutPdf, singleLine, type HandoutChapter } from "../../lib/storymap-pdf";
import { saveBinaryFileWithFallback } from "../../lib/tauri-io";
import { promptDownloadNameIfNeeded } from "../../hooks/useFileNamePrompt";
import {
  STORY_END_STEP_ID,
  STORY_GLOBAL_VIEW,
  STORY_START_STEP_ID,
  storySlideCoverColor,
} from "../../lib/storymap-constants";

interface StoryMapHandoutDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  story: StoryMap;
  mapControllerRef: RefObject<MapController | null>;
}

/** One exportable screen: a chapter or an intro/outro slide. */
type HandoutScreen =
  | { id: string; kind: "chapter"; chapter: StoryChapter; index: number }
  | {
      id: string;
      kind: "slide";
      position: "start" | "end";
      mode: StoryActiveSlideMode;
    };

/**
 * Build the ordered list of exportable screens: the optional start slide, the
 * chapters, then the optional closing slide (#998).
 */
function buildScreens(story: StoryMap): HandoutScreen[] {
  const screens: HandoutScreen[] = [];
  if (story.startSlide !== "none") {
    screens.push({
      id: STORY_START_STEP_ID,
      kind: "slide",
      position: "start",
      mode: story.startSlide,
    });
  }
  story.chapters.forEach((chapter, index) =>
    screens.push({ id: chapter.id, kind: "chapter", chapter, index }),
  );
  if (story.endSlide !== "none") {
    screens.push({
      id: STORY_END_STEP_ID,
      kind: "slide",
      position: "end",
      mode: story.endSlide,
    });
  }
  return screens;
}

/**
 * Render a solid-color page-sized canvas for a blank/black slide page, so the
 * PDF has a real screen rather than an empty page.
 */
function solidColorCanvas(color: string): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = 1200;
  canvas.height = 900;
  const ctx = canvas.getContext("2d");
  // A null context (e.g. the browser hit its canvas-context limit) would leave
  // the canvas transparent and silently emit a blank slide page; throw instead
  // so the export's catch surfaces it. solidColorCanvas only runs on a
  // user-initiated export, so throwing is safe here.
  if (!ctx) {
    throw new Error("Could not get a 2D canvas context for the slide page.");
  }
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  return canvas;
}

/** The camera a global/adjacent slide captures. */
function slideLocation(
  screen: Extract<HandoutScreen, { kind: "slide" }>,
  chapters: StoryChapter[],
): StoryChapter["location"] {
  if (screen.mode === "global") return STORY_GLOBAL_VIEW;
  // Fall back to the global view when the story has no chapters (an adjacent
  // slide configured before any chapter exists), so the export never reads an
  // undefined chapter location.
  const index = screen.position === "start" ? 0 : chapters.length - 1;
  return chapters[index]?.location ?? STORY_GLOBAL_VIEW;
}

/** Maximum time to wait for the map to settle (tiles loaded) per chapter. */
const IDLE_TIMEOUT_MS = 5000;
/** Maximum time to wait for a chapter photo to load before falling back to
 * map-only. Shorter than the map-idle wait since a missing photo degrades
 * gracefully and shouldn't double the per-chapter stall. */
const PHOTO_TIMEOUT_MS = 3000;

/**
 * Jump the map to a chapter location and resolve once it has rendered all
 * tiles (the `idle` event), with a timeout so a chapter that never fully loads
 * (e.g. a throttled tab) cannot stall the whole export. Also resolves promptly
 * when `isAborted()` becomes true so the Stop button takes effect mid-wait
 * instead of after the full timeout.
 */
function jumpAndWaitIdle(
  map: maplibregl.Map,
  location: StoryMap["chapters"][number]["location"],
  isAborted: () => boolean,
): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      map.off("idle", finish);
      clearTimeout(timer);
      clearInterval(poll);
      resolve();
    };
    const timer = setTimeout(finish, IDLE_TIMEOUT_MS);
    // Poll the abort flag so Stop takes effect mid-wait instead of after the
    // full timeout.
    const poll = setInterval(() => {
      if (isAborted()) finish();
    }, 150);
    const before = map.getCenter();
    map.jumpTo({
      center: location.center,
      zoom: location.zoom,
      pitch: location.pitch,
      bearing: location.bearing,
    });
    // A no-op jump (an adjacent chapter sharing this exact location) changes
    // nothing, so MapLibre fires no `idle` and the wait would hit the full
    // timeout. The current frame is already rendered with tiles loaded, so
    // resolve on the next frame instead.
    const after = map.getCenter();
    if (before.lng === after.lng && before.lat === after.lat && map.areTilesLoaded()) {
      requestAnimationFrame(finish);
    }
    // Register after jumpTo so a pre-existing idle event isn't consumed before
    // the new camera has started rendering.
    map.on("idle", finish);
  });
}

/**
 * Load a chapter image URL (or data URI) into a canvas for embedding in the
 * PDF. Resolves to null when the image fails to load or is cross-origin without
 * CORS headers (so it would taint the canvas), letting the export proceed with
 * just the map rather than failing the whole handout.
 */
type LoadedPhoto = { data: HTMLCanvasElement; width: number; height: number };

function loadChapterPhoto(url: string): Promise<LoadedPhoto | null> {
  return new Promise((resolve) => {
    const img = new Image();
    let settled = false;
    // Resolve exactly once and tear down handlers/timer, so a slow or hung
    // remote image can't stall the whole export (it falls back to map-only).
    const finish = (value: LoadedPhoto | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      img.onload = null;
      img.onerror = null;
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), PHOTO_TIMEOUT_MS);
    // Only request CORS for real remote URLs. A data: URI has no origin, and
    // some browsers fire `onerror` for `crossOrigin` data images, which would
    // wrongly drop an embedded photo.
    if (!url.startsWith("data:")) img.crossOrigin = "anonymous";
    img.onload = () => {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        const ctx = canvas.getContext("2d");
        if (!ctx || canvas.width === 0 || canvas.height === 0) {
          finish(null);
          return;
        }
        ctx.drawImage(img, 0, 0);
        // Throws if the canvas is tainted by a cross-origin image; treat that
        // as "no photo" rather than letting it break the PDF capture.
        ctx.getImageData(0, 0, 1, 1);
        finish({ data: canvas, width: canvas.width, height: canvas.height });
      } catch {
        finish(null);
      }
    };
    img.onerror = () => finish(null);
    img.src = url;
  });
}

function slugify(title: string): string {
  return (
    title
      // Decompose accented Latin (é -> e) before the ASCII strip so titles like
      // "São Paulo" keep their skeleton instead of losing characters silently.
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "story-map"
  );
}

/**
 * Export selected story-map chapters as a multi-page PDF handout (GH #830).
 *
 * The user picks which chapter views to include, the paper size and
 * orientation, and a document title and footer. Generating flies the live map
 * to each selected chapter, captures the rendered view, and assembles a clean
 * PDF (one chapter per page) that is saved to disk. The map is returned to its
 * original view when the export finishes.
 */
export function StoryMapHandoutDialog({
  open,
  onOpenChange,
  story,
  mapControllerRef,
}: StoryMapHandoutDialogProps) {
  const { t } = useTranslation();
  const chapters = story.chapters;
  // Chapters plus the optional start/closing slides, in export order.
  const screens = useMemo(() => buildScreens(story), [story]);

  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [paperSize, setPaperSize] = useState<PaperSizeId>("a4");
  const [orientation, setOrientation] = useState<Orientation>("landscape");
  const [title, setTitle] = useState("");
  const [subtitle, setSubtitle] = useState("");
  const [byline, setByline] = useState("");
  const [footer, setFooter] = useState("");
  const [generating, setGenerating] = useState(false);
  const [progress, setProgress] = useState<{ current: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Neutral status line (e.g. "Export cancelled"), distinct from an error.
  const [notice, setNotice] = useState<string | null>(null);
  // Set by the Stop button to break out of the capture loop mid-export. A ref so
  // the running loop sees the latest value without being re-created.
  const abortRef = useRef(false);

  // Seed the selection (all screens) and the title/subtitle/byline/footer from
  // the story each time the dialog opens, so it reflects the latest story
  // without clobbering edits made while it is open. The subtitle and byline
  // mirror the main Story Map settings so the export matches the screen (#996).
  useEffect(() => {
    if (!open) return;
    setSelected(Object.fromEntries(screens.map((s) => [s.id, true])));
    // Strip any HTML the story fields carry (the sample footer has links) so the
    // inputs show readable text instead of raw markup.
    setTitle(singleLine(story.title));
    setSubtitle(singleLine(story.subtitle));
    setByline(singleLine(story.byline));
    setFooter(singleLine(story.footer));
    setError(null);
    setNotice(null);
    setProgress(null);
    // Only re-seed on open; screens/story are read at that moment.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const selectedCount = useMemo(
    () => screens.filter((s) => selected[s.id]).length,
    [screens, selected],
  );

  const allSelected = selectedCount === screens.length && screens.length > 0;

  const toggleAll = useCallback(() => {
    const next = !allSelected;
    setSelected(Object.fromEntries(screens.map((s) => [s.id, next])));
  }, [allSelected, screens]);

  const handleGenerate = useCallback(async () => {
    setError(null);
    setNotice(null);
    const controller = mapControllerRef.current;
    const map = controller?.getMap();
    if (!controller || !map) {
      setError(t("storymap.handout.noMap"));
      return;
    }
    const chosen = screens.filter((s) => selected[s.id]);
    if (chosen.length === 0) {
      setError(t("storymap.handout.noneSelected"));
      return;
    }

    // Ask for the file name up front (browsers without a native save picker
    // would otherwise auto-download a fixed name) so a cancel skips the slow
    // capture entirely (#921).
    const defaultName = await promptDownloadNameIfNeeded(
      `${slugify(title || story.title)}-handout.pdf`,
      ["pdf"],
    );
    if (defaultName === null) return;

    const original = mapControllerRef.current?.readView();
    abortRef.current = false;
    setGenerating(true);
    // Replay chapter layer-opacity effects so each captured page shows the
    // same "change view" (e.g. a before/after imagery fade) the reader sees at
    // that chapter, instead of freezing every page at the live map's current
    // opacities (#1272). Mirrors the presenter's enterChapter replay: exit the
    // chapter being left, enter+exit each skipped chapter, then enter the
    // target. Duration 0 makes each change instant so the capture never grabs
    // a mid-fade frame.
    const effectsApplied = chapters.some(
      (chapter) => chapter.onChapterEnter.length > 0 || chapter.onChapterExit.length > 0,
    );
    // Reset to the store-backed layer styles first so the replay starts from
    // the same baseline as a fresh presentation, not whatever opacities a
    // prior preview or presentation left on the live map.
    if (effectsApplied) controller.restoreLayerStyles();
    const applyEffects = (changes: StoryChapter["onChapterEnter"]) => {
      for (const change of changes) {
        controller.setStoryLayerOpacity(change.layerId, change.opacity, 0);
      }
    };
    let lastChapterIndex = -1;
    try {
      const captures: HandoutChapter[] = [];
      for (let i = 0; i < chosen.length; i++) {
        if (abortRef.current) break;
        const screen = chosen[i];
        setProgress({ current: i + 1, total: chosen.length });

        if (screen.kind === "slide") {
          // Blank/black slides need no map capture: paint a solid full-page
          // color. Global/adjacent slides capture the map at the slide camera
          // with no title or text overlay (#998).
          const color = storySlideCoverColor(screen.mode, story.theme);
          if (color) {
            const canvas = solidColorCanvas(color);
            captures.push({
              title: "",
              map: { data: canvas, width: canvas.width, height: canvas.height },
              fullBleed: true,
            });
            continue;
          }
          await jumpAndWaitIdle(map, slideLocation(screen, chapters), () => abortRef.current);
          if (abortRef.current) break;
          const slideShot = captureMapImage(map);
          captures.push({
            title: "",
            map: {
              data: slideShot.image,
              width: slideShot.width,
              height: slideShot.height,
            },
            fullBleed: true,
          });
          continue;
        }

        const chapter = screen.chapter;
        if (lastChapterIndex !== screen.index) {
          if (lastChapterIndex >= 0) {
            applyEffects(chapters[lastChapterIndex]?.onChapterExit ?? []);
          }
          for (let k = lastChapterIndex + 1; k < screen.index; k++) {
            applyEffects(chapters[k]?.onChapterEnter ?? []);
            applyEffects(chapters[k]?.onChapterExit ?? []);
          }
          applyEffects(chapter.onChapterEnter);
          lastChapterIndex = screen.index;
        }
        await jumpAndWaitIdle(map, chapter.location, () => abortRef.current);
        if (abortRef.current) break;
        const shot = captureMapImage(map);
        // Load the chapter's own photo (if any) so it appears beside the map.
        const photo = chapter.image ? await loadChapterPhoto(chapter.image) : null;
        captures.push({
          title: chapter.title,
          description: chapter.description,
          map: { data: shot.image, width: shot.width, height: shot.height },
          ...(photo ? { photo } : {}),
        });
      }
      // Stopped: discard the export entirely rather than saving a partial PDF
      // (the finally block still restores the map view), and tell the user it
      // was cancelled rather than silently returning to idle.
      if (abortRef.current || captures.length === 0) {
        if (abortRef.current) setNotice(t("storymap.handout.cancelled"));
        return;
      }
      const bytes = buildStoryMapHandoutPdf(captures, {
        paperSize,
        orientation,
        title,
        subtitle,
        byline,
        footer,
      });
      const saved = await saveBinaryFileWithFallback(bytes, {
        defaultName,
        filters: [{ name: t("storymap.handout.pdfFile"), extensions: ["pdf"] }],
        browserTypes: [
          {
            description: t("storymap.handout.pdfFile"),
            accept: { "application/pdf": [".pdf"] },
          },
        ],
        mimeType: "application/pdf",
      });
      if (saved !== null) onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      // Undo the replayed opacity effects (like the presenter does on exit) and
      // return the map to where the user left it, even on failure.
      if (effectsApplied) controller.restoreLayerStyles();
      if (original) {
        map.jumpTo({
          center: original.center,
          zoom: original.zoom,
          bearing: original.bearing,
          pitch: original.pitch,
        });
      }
      setGenerating(false);
      setProgress(null);
    }
  }, [
    chapters,
    screens,
    selected,
    paperSize,
    orientation,
    title,
    subtitle,
    byline,
    footer,
    story.title,
    story.theme,
    mapControllerRef,
    onOpenChange,
    t,
  ]);

  return (
    <Dialog open={open} onOpenChange={(next: boolean) => !generating && onOpenChange(next)}>
      <DialogContent className="flex max-h-[88vh] w-[min(92vw,34rem)] flex-col gap-0 p-0">
        <DialogHeader className="border-b px-5 py-4">
          <DialogTitle className="flex items-center gap-2">
            <FileDown className="h-4 w-4" />
            {t("storymap.handout.title")}
          </DialogTitle>
          <DialogDescription>{t("storymap.handout.description")}</DialogDescription>
        </DialogHeader>

        <ScrollArea className="min-h-0 flex-1">
          <div className="space-y-4 px-5 py-4">
            <div>
              <div className="mb-2 flex items-center justify-between">
                <h3 className="text-sm font-semibold">
                  {t("storymap.handout.screens", {
                    count: selectedCount,
                    total: screens.length,
                  })}
                </h3>
                <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={toggleAll}>
                  {allSelected ? t("storymap.handout.selectNone") : t("storymap.handout.selectAll")}
                </Button>
              </div>
              <div className="space-y-1 rounded-md border p-2">
                {screens.map((screen) => {
                  const isSlide = screen.kind === "slide";
                  const label = isSlide
                    ? screen.position === "start"
                      ? t("storymap.handout.startSlide")
                      : t("storymap.handout.endSlide")
                    : screen.chapter.title || t("storymap.untitledChapter");
                  return (
                    <label
                      key={screen.id}
                      className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-muted"
                    >
                      <input
                        type="checkbox"
                        checked={selected[screen.id] ?? false}
                        onChange={(e) =>
                          setSelected((prev) => ({
                            ...prev,
                            [screen.id]: e.target.checked,
                          }))
                        }
                      />
                      <span
                        className={`flex h-5 w-5 shrink-0 items-center justify-center rounded text-xs ${
                          isSlide ? "bg-primary/15 text-primary" : "bg-muted"
                        }`}
                      >
                        {isSlide ? (screen.position === "start" ? "▶" : "■") : screen.index + 1}
                      </span>
                      <span className="truncate">{label}</span>
                    </label>
                  );
                })}
              </div>
            </div>

            <Separator />

            <div className="grid grid-cols-2 gap-3">
              <Field label={t("storymap.handout.paperSize")} htmlFor="storymap-handout-paper-size">
                <Select
                  id="storymap-handout-paper-size"
                  value={paperSize}
                  onChange={(e) => setPaperSize(e.target.value as PaperSizeId)}
                >
                  {PAPER_SIZES.filter((p) => p.group === "paper").map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field
                label={t("storymap.handout.orientation")}
                htmlFor="storymap-handout-orientation"
              >
                <Select
                  id="storymap-handout-orientation"
                  value={orientation}
                  onChange={(e) => setOrientation(e.target.value as Orientation)}
                >
                  <option value="portrait">{t("storymap.handout.portrait")}</option>
                  <option value="landscape">{t("storymap.handout.landscape")}</option>
                </Select>
              </Field>
            </div>

            <Field
              label={t("storymap.handout.documentTitle")}
              htmlFor="storymap-handout-document-title"
            >
              <Input
                id="storymap-handout-document-title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder={t("storymap.handout.documentTitlePlaceholder")}
              />
            </Field>
            <Field label={t("storymap.handout.subtitle")} htmlFor="storymap-handout-subtitle">
              <Input
                id="storymap-handout-subtitle"
                value={subtitle}
                onChange={(e) => setSubtitle(e.target.value)}
                placeholder={t("storymap.handout.subtitlePlaceholder")}
              />
            </Field>
            <Field label={t("storymap.handout.byline")} htmlFor="storymap-handout-byline">
              <Input
                id="storymap-handout-byline"
                value={byline}
                onChange={(e) => setByline(e.target.value)}
                placeholder={t("storymap.handout.bylinePlaceholder")}
              />
            </Field>
            <Field label={t("storymap.handout.footerText")} htmlFor="storymap-handout-footer">
              <Input
                id="storymap-handout-footer"
                value={footer}
                onChange={(e) => setFooter(e.target.value)}
                placeholder={t("storymap.handout.footerPlaceholder")}
              />
            </Field>
          </div>
        </ScrollArea>

        <div className="flex items-center justify-between gap-2 border-t px-5 py-3">
          <div className="min-h-[1.25rem] text-xs">
            {error ? (
              <span className="text-destructive">{error}</span>
            ) : progress ? (
              <span className="text-muted-foreground">
                {t("storymap.handout.progress", {
                  current: progress.current,
                  total: progress.total,
                })}
              </span>
            ) : notice ? (
              <span className="text-muted-foreground">{notice}</span>
            ) : null}
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => (generating ? (abortRef.current = true) : onOpenChange(false))}
            >
              {generating ? t("storymap.handout.stop") : t("common.cancel")}
            </Button>
            <Button
              size="sm"
              disabled={generating || selectedCount === 0}
              onClick={() => void handleGenerate()}
            >
              {generating ? (
                <Loader2 className="me-1 h-4 w-4 animate-spin" />
              ) : (
                <FileDown className="me-1 h-4 w-4" />
              )}
              {t("storymap.handout.generate")}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Field({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1">
      <Label className="text-xs" htmlFor={htmlFor}>
        {label}
      </Label>
      {children}
    </div>
  );
}
