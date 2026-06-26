import {
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import maplibregl from "maplibre-gl";
import { useTranslation } from "react-i18next";
import type { StoryMap } from "@geolibre/core";
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
import {
  PAPER_SIZES,
  type Orientation,
  type PaperSizeId,
} from "../../lib/print-layout";
import {
  buildStoryMapHandoutPdf,
  singleLine,
  type HandoutChapter,
} from "../../lib/storymap-pdf";
import { saveBinaryFileWithFallback } from "../../lib/tauri-io";
import { promptDownloadNameIfNeeded } from "../../hooks/useFileNamePrompt";

interface StoryMapHandoutDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  story: StoryMap;
  mapControllerRef: RefObject<MapController | null>;
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
    if (
      before.lng === after.lng &&
      before.lat === after.lat &&
      map.areTilesLoaded()
    ) {
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

  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [paperSize, setPaperSize] = useState<PaperSizeId>("a4");
  const [orientation, setOrientation] = useState<Orientation>("landscape");
  const [title, setTitle] = useState("");
  const [footer, setFooter] = useState("");
  const [generating, setGenerating] = useState(false);
  const [progress, setProgress] = useState<{ current: number; total: number } | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  // Neutral status line (e.g. "Export cancelled"), distinct from an error.
  const [notice, setNotice] = useState<string | null>(null);
  // Set by the Stop button to break out of the capture loop mid-export. A ref so
  // the running loop sees the latest value without being re-created.
  const abortRef = useRef(false);

  // Seed the selection (all chapters) and the title/footer from the story each
  // time the dialog opens, so it reflects the latest story without clobbering
  // edits made while it is open.
  useEffect(() => {
    if (!open) return;
    setSelected(Object.fromEntries(chapters.map((c) => [c.id, true])));
    // Strip any HTML the story title/footer carry (the sample footer has links)
    // so the fields show readable text instead of raw markup.
    setTitle(singleLine(story.title));
    setFooter(singleLine(story.footer));
    setError(null);
    setNotice(null);
    setProgress(null);
    // Only re-seed on open; chapters/story are read at that moment.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const selectedCount = useMemo(
    () => chapters.filter((c) => selected[c.id]).length,
    [chapters, selected],
  );

  const allSelected = selectedCount === chapters.length && chapters.length > 0;

  const toggleAll = useCallback(() => {
    const next = !allSelected;
    setSelected(Object.fromEntries(chapters.map((c) => [c.id, next])));
  }, [allSelected, chapters]);

  const handleGenerate = useCallback(async () => {
    setError(null);
    setNotice(null);
    const map = mapControllerRef.current?.getMap();
    if (!map) {
      setError(t("storymap.handout.noMap"));
      return;
    }
    const chosen = chapters.filter((c) => selected[c.id]);
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
    try {
      const captures: HandoutChapter[] = [];
      for (let i = 0; i < chosen.length; i++) {
        if (abortRef.current) break;
        const chapter = chosen[i];
        setProgress({ current: i + 1, total: chosen.length });
        await jumpAndWaitIdle(map, chapter.location, () => abortRef.current);
        if (abortRef.current) break;
        const shot = captureMapImage(map);
        // Load the chapter's own photo (if any) so it appears beside the map.
        const photo = chapter.image
          ? await loadChapterPhoto(chapter.image)
          : null;
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
      // Always return the map to where the user left it, even on failure.
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
    selected,
    paperSize,
    orientation,
    title,
    footer,
    story.title,
    mapControllerRef,
    onOpenChange,
    t,
  ]);

  return (
    <Dialog
      open={open}
      onOpenChange={(next: boolean) => !generating && onOpenChange(next)}
    >
      <DialogContent className="flex max-h-[88vh] w-[min(92vw,34rem)] flex-col gap-0 p-0">
        <DialogHeader className="border-b px-5 py-4">
          <DialogTitle className="flex items-center gap-2">
            <FileDown className="h-4 w-4" />
            {t("storymap.handout.title")}
          </DialogTitle>
          <DialogDescription>
            {t("storymap.handout.description")}
          </DialogDescription>
        </DialogHeader>

        <ScrollArea className="min-h-0 flex-1">
          <div className="space-y-4 px-5 py-4">
            <div>
              <div className="mb-2 flex items-center justify-between">
                <h3 className="text-sm font-semibold">
                  {t("storymap.handout.screens", {
                    count: selectedCount,
                    total: chapters.length,
                  })}
                </h3>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 px-2 text-xs"
                  onClick={toggleAll}
                >
                  {allSelected
                    ? t("storymap.handout.selectNone")
                    : t("storymap.handout.selectAll")}
                </Button>
              </div>
              <div className="space-y-1 rounded-md border p-2">
                {chapters.map((chapter, index) => (
                  <label
                    key={chapter.id}
                    className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-muted"
                  >
                    <input
                      type="checkbox"
                      checked={selected[chapter.id] ?? false}
                      onChange={(e) =>
                        setSelected((prev) => ({
                          ...prev,
                          [chapter.id]: e.target.checked,
                        }))
                      }
                    />
                    <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded bg-muted text-xs">
                      {index + 1}
                    </span>
                    <span className="truncate">
                      {chapter.title || t("storymap.untitledChapter")}
                    </span>
                  </label>
                ))}
              </div>
            </div>

            <Separator />

            <div className="grid grid-cols-2 gap-3">
              <Field
                label={t("storymap.handout.paperSize")}
                htmlFor="storymap-handout-paper-size"
              >
                <Select
                  id="storymap-handout-paper-size"
                  value={paperSize}
                  onChange={(e) =>
                    setPaperSize(e.target.value as PaperSizeId)
                  }
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
                  onChange={(e) =>
                    setOrientation(e.target.value as Orientation)
                  }
                >
                  <option value="portrait">
                    {t("storymap.handout.portrait")}
                  </option>
                  <option value="landscape">
                    {t("storymap.handout.landscape")}
                  </option>
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
            <Field
              label={t("storymap.handout.footerText")}
              htmlFor="storymap-handout-footer"
            >
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
              onClick={() =>
                generating ? (abortRef.current = true) : onOpenChange(false)
              }
            >
              {generating
                ? t("storymap.handout.stop")
                : t("common.cancel")}
            </Button>
            <Button
              size="sm"
              disabled={generating || selectedCount === 0}
              onClick={() => void handleGenerate()}
            >
              {generating ? (
                <Loader2 className="mr-1 h-4 w-4 animate-spin" />
              ) : (
                <FileDown className="mr-1 h-4 w-4" />
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
