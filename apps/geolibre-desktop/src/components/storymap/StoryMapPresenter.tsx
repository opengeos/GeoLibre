import {
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import maplibregl from "maplibre-gl";
import {
  useAppStore,
  type StoryActiveSlideMode,
  type StoryChapter,
  type StoryMap,
} from "@geolibre/core";
import type { MapController } from "@geolibre/map";
import { Button, cn } from "@geolibre/ui";
import { GripVertical, List, X } from "lucide-react";
import { sanitizeStoryHtml } from "../../lib/sanitize-html";
import {
  STORY_END_STEP_ID,
  STORY_GLOBAL_VIEW,
  STORY_INSET_STYLE_URL,
  STORY_START_STEP_ID,
  storySlideCoverColor,
} from "../../lib/storymap-constants";

interface StoryMapPresenterProps {
  mapControllerRef: RefObject<MapController | null>;
}

/** One scroll step in the presentation: a chapter card or an intro/outro slide. */
type PresenterStep =
  | { key: string; kind: "chapter"; chapter: StoryChapter; chapterIndex: number }
  | {
      key: string;
      kind: "slide";
      position: "start" | "end";
      mode: StoryActiveSlideMode;
    };

/**
 * Expand a story into its ordered scroll steps, inserting the optional start and
 * closing slides around the chapters (#998).
 */
function buildPresenterSteps(story: StoryMap): PresenterStep[] {
  const steps: PresenterStep[] = [];
  if (story.startSlide !== "none") {
    steps.push({
      key: STORY_START_STEP_ID,
      kind: "slide",
      position: "start",
      mode: story.startSlide,
    });
  }
  story.chapters.forEach((chapter, chapterIndex) =>
    steps.push({ key: chapter.id, kind: "chapter", chapter, chapterIndex }),
  );
  if (story.endSlide !== "none") {
    steps.push({
      key: STORY_END_STEP_ID,
      kind: "slide",
      position: "end",
      mode: story.endSlide,
    });
  }
  return steps;
}

const ALIGNMENT_CLASS: Record<StoryChapter["alignment"], string> = {
  left: "glsm-lefty",
  center: "glsm-centered",
  right: "glsm-righty",
  full: "glsm-fully",
};

const INSET_POSITION_CLASS: Record<string, string> = {
  "top-left": "top-3 left-3",
  "top-right": "top-3 right-3",
  // Raised so the inset clears the map's scale control in the bottom corners.
  "bottom-left": "bottom-10 left-3",
  "bottom-right": "bottom-10 right-3",
};

/**
 * Full-screen scroll-driven presentation overlay for a story map.
 *
 * Drives the live GeoLibre map underneath: as the reader scrolls each chapter
 * into view the map flies to the chapter's camera and applies its layer fades,
 * mirroring the standalone storytelling template. Rendering nothing unless a
 * presentation is active keeps it inert the rest of the time.
 */
export function StoryMapPresenter({ mapControllerRef }: StoryMapPresenterProps) {
  const { t } = useTranslation();
  const presenting = useAppStore((s) => s.ui.storymapPresenting);
  const setPresenting = useAppStore((s) => s.setStorymapPresenting);
  const setPanelOpen = useAppStore((s) => s.setStorymapPanelOpen);
  const storymap = useAppStore((s) => s.storymap);

  // Exit the presentation, reopening the editor when it was launched from there
  // so the user lands back in the editor instead of the bare map (#918). Reads
  // the flag before clearing it via setPresenting(false).
  const exitPresentation = useCallback(() => {
    const reopenEditor = useAppStore.getState().ui.storymapReturnToEditor;
    setPresenting(false);
    if (reopenEditor) setPanelOpen(true);
  }, [setPanelOpen, setPresenting]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const insetRef = useRef<HTMLDivElement>(null);
  const insetMapRef = useRef<maplibregl.Map | null>(null);
  const insetMarkerRef = useRef<maplibregl.Marker | null>(null);
  const markerRef = useRef<maplibregl.Marker | null>(null);
  // Active scroll step (chapters + slides); -1 before the first enter.
  const activeStepRef = useRef<number>(-1);
  // Last chapter entered (skipping slides), so layer-fade replay still steps
  // through chapters in order even when slides sit between them.
  const activeChapterRef = useRef<number>(-1);
  // Mirror of the active chapter as state so the navigation pane can highlight
  // the current chapter (-1 while a start/closing slide is showing).
  const [activeChapter, setActiveChapter] = useState(0);
  // Solid color a blank/black slide paints over the map, or null when the map
  // stays visible.
  const [coverColor, setCoverColor] = useState<string | null>(null);
  const [navOpen, setNavOpen] = useState(true);

  // Memoized so the render path and `hasChapters` get a stable reference.
  const chapters = useMemo(() => storymap?.chapters ?? [], [storymap]);
  // The ordered scroll steps, recomputed when the story changes (it is frozen
  // during a presentation, so this is stable while presenting).
  const steps = useMemo(() => (storymap ? buildPresenterSteps(storymap) : []), [storymap]);
  const hasChapters = presenting && chapters.length > 0;

  // Scroll a step into view; the IntersectionObserver then activates it and
  // flies the camera, so clicking the nav reuses the same scroll-driven path.
  // Holds the playback effect's enterStep so the nav pane can drive the camera
  // deterministically rather than waiting on a scroll-triggered observer.
  const enterStepRef = useRef<(index: number) => void>(() => {});
  // While true, the scroll observer ignores transient intersections caused by a
  // programmatic jump so they can't override the target we just entered.
  const jumpingRef = useRef(false);
  const goToStep = useCallback((stepIndex: number) => {
    const step = scrollRef.current?.querySelector<HTMLElement>(`[data-step-index="${stepIndex}"]`);
    // Center the card, not the step: the step carries a tall bottom padding, so
    // centering it would push the card (and its drag bar) above the viewport.
    const target = step?.querySelector<HTMLElement>(".glsm-card") ?? step;
    jumpingRef.current = true;
    target?.scrollIntoView({ block: "center" });
    // Enter the target directly so its camera move always runs, then let the
    // observer take over once the programmatic scroll has settled.
    enterStepRef.current(stepIndex);
    window.setTimeout(() => {
      jumpingRef.current = false;
    }, 500);
  }, []);

  // Per-chapter drag offset / explicit size so the reader can move and resize a
  // chapter card out of the way to explore the map beneath it.
  const [cardLayouts, setCardLayouts] = useState<
    Record<string, { dx: number; dy: number; w: number | null; h: number | null }>
  >({});
  const gestureRef = useRef<{
    id: string;
    mode: "drag" | "resize";
    startX: number;
    startY: number;
    base: { dx: number; dy: number; w: number | null; h: number | null };
  } | null>(null);
  // Detaches the active gesture's window listeners; set while a drag is live.
  const gestureCleanupRef = useRef<(() => void) | null>(null);

  const startGesture = useCallback(
    (event: ReactPointerEvent, id: string, mode: "drag" | "resize", cardEl: HTMLElement | null) => {
      event.preventDefault();
      event.stopPropagation();
      const existing = cardLayouts[id];
      const rect = cardEl?.getBoundingClientRect();
      // Bounds of the visible map area and the card's flow (un-offset) position,
      // captured once so a drag can be clamped to keep the title bar reachable.
      const viewport = scrollRef.current?.getBoundingClientRect() ?? null;
      const baseDx = existing?.dx ?? 0;
      const baseDy = existing?.dy ?? 0;
      const flowLeft = rect ? rect.left - baseDx : 0;
      const flowTop = rect ? rect.top - baseDy : 0;
      gestureRef.current = {
        id,
        mode,
        startX: event.clientX,
        startY: event.clientY,
        base: {
          dx: baseDx,
          dy: baseDy,
          w: existing?.w ?? (mode === "resize" ? (rect?.width ?? null) : null),
          h: existing?.h ?? (mode === "resize" ? (rect?.height ?? null) : null),
        },
      };

      // Keep at least this much of the card on screen, and clear the top
      // control row so the drag bar never hides behind Exit/the map controls.
      const TOP_INSET = 52;
      const EDGE_KEEP = 80;
      // Left boundary clears the nav pane (matches the `.glsm-with-nav` reserve)
      // so a dragged card can't slip behind it.
      const leftBoundary = (viewport?.left ?? 0) + (navOpen ? 14 * 16 : 0);

      const onMove = (e: PointerEvent) => {
        const g = gestureRef.current;
        if (!g) return;
        const ddx = e.clientX - g.startX;
        const ddy = e.clientY - g.startY;
        if (g.mode === "resize") {
          setCardLayouts((prev) => ({
            ...prev,
            [g.id]: {
              ...g.base,
              w: Math.max(200, (g.base.w ?? 280) + ddx),
              h: Math.max(120, (g.base.h ?? 200) + ddy),
            },
          }));
          return;
        }
        let dx = g.base.dx + ddx;
        let dy = g.base.dy + ddy;
        if (viewport) {
          // Clamp the title bar within [top control row, bottom] and keep part
          // of the card horizontally on screen.
          const minTop = viewport.top + TOP_INSET;
          const maxTop = viewport.bottom - TOP_INSET;
          dy = Math.min(maxTop - flowTop, Math.max(minTop - flowTop, dy));
          const maxLeft = viewport.right - EDGE_KEEP;
          dx = Math.min(maxLeft - flowLeft, Math.max(leftBoundary - flowLeft, dx));
        }
        setCardLayouts((prev) => ({ ...prev, [g.id]: { ...g.base, dx, dy } }));
      };
      const onUp = () => {
        gestureCleanupRef.current = null;
        gestureRef.current = null;
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
      };
      // Remembered so an unmount mid-drag (e.g. Exit while dragging) can detach
      // the window listeners instead of leaking them until the next pointerup.
      gestureCleanupRef.current = onUp;
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [cardLayouts, navOpen],
  );

  // Detach any in-flight drag/resize listeners when the presenter unmounts.
  useEffect(() => () => gestureCleanupRef.current?.(), []);

  const resetCard = useCallback((id: string) => {
    setCardLayouts((prev) => {
      if (!prev[id]) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }, []);

  // The playback effect reads the story through a ref so it only sets up on
  // present/exit (hasChapters) and not on every edit. Edits cannot happen mid-
  // presentation anyway (the builder is closed first), so the story is frozen.
  const storymapRef = useRef(storymap);
  storymapRef.current = storymap;

  // Initialize nav visibility, the slide cover, and the active-chapter highlight
  // from the first step *before* the browser paints, so the opening frame never
  // flashes the previous session's nav (defeating hideChapterNav) or an
  // uncovered map for a blank/black start slide before the playback effect's
  // enterStep(0) runs (#998 review). The playback effect re-applies these.
  useLayoutEffect(() => {
    if (!hasChapters) return;
    const story = storymapRef.current;
    if (!story) return;
    // Start with the chapter list collapsed when the author chose discoverable
    // chapters, so the itinerary is not revealed up front (#995).
    setNavOpen(!story.hideChapterNav);
    const first = buildPresenterSteps(story)[0];
    if (first?.kind === "slide") {
      setActiveChapter(-1);
      setCoverColor(storySlideCoverColor(first.mode, story.theme));
    } else {
      setActiveChapter(0);
      setCoverColor(null);
    }
  }, [hasChapters]);

  // Set up scroll observation and the live map side-effects while presenting.
  useEffect(() => {
    if (!hasChapters) return;
    const controller = mapControllerRef.current;
    const map = controller?.getMap();
    const container = scrollRef.current;
    const story = storymapRef.current;
    if (!controller || !map || !container || !story) return;
    // Frozen snapshot for this presentation run (edits are blocked while
    // presenting), shadowing the outer memoized `chapters`/`steps` deliberately.
    const chapters = story.chapters;
    const steps = buildPresenterSteps(story);

    const stepEls = Array.from(container.querySelectorAll<HTMLElement>("[data-step-index]"));

    // Main-map marker, created once and moved per chapter.
    if (story.showMarkers) {
      markerRef.current = new maplibregl.Marker({
        color: story.markerColor,
      })
        .setLngLat(chapters[0].location.center)
        .addTo(map);
    }

    // Optional inset minimap.
    if (story.inset && insetRef.current) {
      const insetMap = new maplibregl.Map({
        container: insetRef.current,
        style: STORY_INSET_STYLE_URL,
        center: chapters[0].location.center,
        zoom: 1,
        interactive: false,
        attributionControl: false,
      });
      insetMapRef.current = insetMap;
      const el = document.createElement("div");
      el.className = "glsm-inset-marker";
      insetMarkerRef.current = new maplibregl.Marker({ element: el })
        .setLngLat(chapters[0].location.center)
        .addTo(insetMap);
    }

    const applyEffects = (changes: StoryChapter["onChapterEnter"]) => {
      for (const change of changes) {
        controller.setStoryLayerOpacity(change.layerId, change.opacity, change.duration);
      }
    };

    const moveCameraTo = (location: StoryChapter["location"]) => {
      markerRef.current?.setLngLat(location.center);
      if (insetMapRef.current) {
        insetMapRef.current.setCenter(location.center);
        insetMarkerRef.current?.setLngLat(location.center);
      }
    };

    // Hide or show the map (and inset) markers. The "global" overview slide is a
    // clean world view, so its marker is hidden; chapters and the adjacent
    // preview keep theirs.
    const setMarkersVisible = (visible: boolean) => {
      const value = visible ? "" : "hidden";
      const marker = markerRef.current?.getElement();
      if (marker) marker.style.visibility = value;
      const insetMarker = insetMarkerRef.current?.getElement();
      if (insetMarker) insetMarker.style.visibility = value;
    };

    const enterChapter = (chapter: StoryChapter, index: number) => {
      const previous = activeChapterRef.current;
      activeChapterRef.current = index;
      setActiveChapter(index);
      setCoverColor(null);

      // Drive the camera through the controller (which handles the optional
      // rotation) rather than mutating the MapLibre instance directly.
      controller.applyStoryChapterCamera(
        chapter.location,
        chapter.mapAnimation || "flyTo",
        chapter.rotateAnimation,
      );
      // Re-show the marker in case it was hidden by a preceding global slide.
      setMarkersVisible(true);
      moveCameraTo(chapter.location);

      // Replay the chapters between the old and new position as if scrolled
      // through (exit the one we leave, then enter+exit each skipped chapter in
      // order) so a fast scroll or nav jump reaches the same layer state as
      // stepping one chapter at a time, without firing exits for chapters whose
      // enter never ran. `previous` is -1 before the first chapter (e.g. jumping
      // straight from the start slide to chapter N), which replays 0..N-1 so the
      // skipped chapters' fades still run.
      if (previous !== index) {
        // Chapter indices are always >= 0: a `previous` of -1 means "before
        // chapter 0", so the loop starts at i = 0 and only moves toward `index`.
        const dir = previous < index ? 1 : -1;
        if (previous >= 0) applyEffects(chapters[previous]?.onChapterExit ?? []);
        for (let i = previous + dir; i !== index; i += dir) {
          applyEffects(chapters[i]?.onChapterEnter ?? []);
          applyEffects(chapters[i]?.onChapterExit ?? []);
        }
      }
      applyEffects(chapter.onChapterEnter);
    };

    const enterSlide = (step: Extract<PresenterStep, { kind: "slide" }>) => {
      // A slide is not a chapter, so clear the nav highlight. Keep
      // `activeChapterRef` pointing at the last real chapter (it is the replay
      // anchor): a closing "hold" slide keeps that state, and jumping from a
      // slide back to a chapter still replays the intermediate chapters' fades.
      setActiveChapter(-1);
      setCoverColor(storySlideCoverColor(step.mode, story.theme));
      if (step.mode === "blank" || step.mode === "black") return;
      // Global zooms out to the whole map; "adjacent" previews/holds the
      // neighboring chapter's camera with all text hidden.
      const location =
        step.mode === "global"
          ? STORY_GLOBAL_VIEW
          : step.position === "start"
            ? (chapters[0]?.location ?? STORY_GLOBAL_VIEW)
            : (chapters[chapters.length - 1]?.location ?? STORY_GLOBAL_VIEW);
      controller.applyStoryChapterCamera(location, "flyTo", false);
      // The global overview shows no marker; the adjacent preview keeps the
      // chapter's marker and moves it to that chapter.
      if (step.mode === "global") {
        setMarkersVisible(false);
      } else {
        setMarkersVisible(true);
        moveCameraTo(location);
      }
    };

    const enterStep = (index: number) => {
      if (index === activeStepRef.current) return;
      const step = steps[index];
      if (!step) return;
      activeStepRef.current = index;

      stepEls.forEach((el, i) => el.classList.toggle("glsm-active", i === index));

      if (step.kind === "chapter") {
        enterChapter(step.chapter, step.chapterIndex);
      } else {
        enterSlide(step);
      }
    };
    // Expose enterStep so the nav pane can jump directly.
    enterStepRef.current = enterStep;

    const observer = new IntersectionObserver(
      (entries) => {
        // Ignore intersections triggered by a programmatic nav jump; the jump
        // already entered the target directly.
        if (jumpingRef.current) return;
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const index = Number((entry.target as HTMLElement).dataset.stepIndex);
          if (Number.isFinite(index)) enterStep(index);
        }
      },
      {
        root: container,
        // Treat a step as active once it crosses the vertical center.
        rootMargin: "-45% 0px -45% 0px",
        threshold: 0,
      },
    );
    for (const el of stepEls) observer.observe(el);

    // Kick off the first step immediately.
    enterStep(0);

    return () => {
      observer.disconnect();
      markerRef.current?.remove();
      markerRef.current = null;
      insetMarkerRef.current?.remove();
      insetMarkerRef.current = null;
      insetMapRef.current?.remove();
      insetMapRef.current = null;
      activeStepRef.current = -1;
      activeChapterRef.current = -1;
      // Reset nav highlight (mirroring activeChapterRef = -1), slide cover, and
      // any card drag/resize so the next presentation starts clean.
      setActiveChapter(-1);
      setCoverColor(null);
      setCardLayouts({});
      // Undo any direct opacity changes made during playback.
      controller.restoreLayerStyles();
    };
  }, [hasChapters, mapControllerRef]);

  // Allow Escape to exit the presentation.
  useEffect(() => {
    if (!presenting) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") exitPresentation();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [presenting, exitPresentation]);

  // A presentation with no chapters has nothing to show; close it (routing
  // through exitPresentation so it still honors the return-to-editor intent).
  useEffect(() => {
    if (presenting && chapters.length === 0) exitPresentation();
  }, [presenting, chapters.length, exitPresentation]);

  if (!presenting || chapters.length === 0) return null;

  // Render into the MapLibre container so the presentation is clipped to the
  // map canvas instead of overlaying the toolbar and side panels. The container
  // carries `.maplibregl-map { position: relative }`, so `absolute inset-0`
  // lines the overlay up exactly with the map.
  const container = mapControllerRef.current?.getMap()?.getContainer() ?? null;
  if (!container) return null;

  const theme = storymap?.theme ?? "dark";
  const themeClass = theme === "light" ? "glsm-light" : "glsm-dark";
  // Chapters sit after the optional start slide, so a chapter's nav entry maps
  // to its scroll-step index by this offset.
  const startOffset = storymap && storymap.startSlide !== "none" ? 1 : 0;
  // A start/closing slide is showing (no chapter highlighted). Slides are
  // documented as text-free, so the persistent story header/footer hide while
  // one is active (a blank/black cover already hides them; this also clears the
  // title/byline/footer for global/adjacent slides). visibility (not display)
  // keeps their layout so scroll positions and the step observer are unaffected.
  const slideActive = activeChapter === -1;

  return createPortal(
    // The scroll surface captures the wheel so scrolling navigates chapters.
    // The map controls are lifted above it (see StoryMapStyles) so they stay
    // clickable even though the story drives the camera.
    <div className="absolute inset-0 z-[70] overflow-hidden">
      <div className="absolute left-3 top-3 z-[72] flex items-center gap-2">
        <Button variant="secondary" size="sm" className="shadow-md" onClick={exitPresentation}>
          <X className="me-1 h-4 w-4" />
          {t("storymap.exitPresentation")}
        </Button>
        <Button
          variant="secondary"
          size="icon"
          className="h-8 w-8 shadow-md"
          title={t("storymap.toggleNav")}
          aria-pressed={navOpen}
          onClick={() => setNavOpen((open) => !open)}
        >
          <List className="h-4 w-4" />
        </Button>
      </div>

      {navOpen ? (
        <nav
          aria-label={t("storymap.chapterNav")}
          className="absolute left-3 top-14 z-[72] max-h-[calc(100%-4.5rem)] w-52 overflow-y-auto rounded-md border bg-background/85 p-1.5 shadow-lg backdrop-blur"
        >
          {chapters.map((chapter, index) => (
            <button
              key={chapter.id}
              type="button"
              onClick={() => goToStep(index + startOffset)}
              className={cn(
                "flex w-full items-center gap-2 rounded px-2 py-1.5 text-start text-xs transition-colors",
                index === activeChapter
                  ? "bg-primary/15 font-medium text-foreground"
                  : "text-muted-foreground hover:bg-muted",
              )}
            >
              <span
                className={cn(
                  "flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px]",
                  index === activeChapter
                    ? "bg-primary text-primary-foreground"
                    : "bg-muted text-muted-foreground",
                )}
              >
                {index + 1}
              </span>
              <span className="truncate">{chapter.title || t("storymap.untitledChapter")}</span>
            </button>
          ))}
        </nav>
      ) : null}

      {storymap?.inset ? (
        // The inner div is the MapLibre container; MapLibre stamps it with
        // `.maplibregl-map { position: relative }`, so keep the corner
        // positioning on the outer wrapper where it cannot be overridden.
        <div
          className={`pointer-events-none absolute z-[71] h-44 w-44 overflow-hidden rounded-md border-2 border-white/80 shadow-lg ${
            INSET_POSITION_CLASS[storymap.insetPosition] ?? INSET_POSITION_CLASS["bottom-left"]
          }`}
        >
          <div ref={insetRef} className="h-full w-full" />
        </div>
      ) : null}

      {/* Solid cover for a blank/black start or closing slide (#998). Painted
          over the map (and inset) but below the Exit/nav controls, and
          pointer-events:none so the wheel still scrolls the story underneath. */}
      {coverColor ? (
        <div
          className="pointer-events-none absolute inset-0 z-[71]"
          style={{ background: coverColor }}
        />
      ) : null}

      <StoryMapStyles />

      <div
        ref={scrollRef}
        className={cn("glsm-scroll absolute inset-0 overflow-y-auto", navOpen && "glsm-with-nav")}
      >
        {storymap && (storymap.title || storymap.subtitle || storymap.byline) ? (
          <div
            className={`glsm-header ${themeClass}`}
            style={slideActive ? { visibility: "hidden" } : undefined}
          >
            {storymap.title ? <h1>{storymap.title}</h1> : null}
            {storymap.subtitle ? <h2>{storymap.subtitle}</h2> : null}
            {storymap.byline ? <p>{storymap.byline}</p> : null}
          </div>
        ) : null}

        <div className="glsm-features">
          {steps.map((step, stepIndex) => {
            // Start/closing slides are empty scroll targets; their visual
            // treatment (cover or camera) is driven by the playback effect.
            if (step.kind === "slide") {
              return (
                <div
                  key={step.key}
                  data-step-index={stepIndex}
                  className="glsm-step glsm-slide-step"
                />
              );
            }
            const { chapter } = step;
            const layout = cardLayouts[chapter.id];
            const cardStyle = {
              transform: layout ? `translate(${layout.dx}px, ${layout.dy}px)` : undefined,
              width: layout?.w ? `${layout.w}px` : undefined,
              height: layout?.h ? `${layout.h}px` : undefined,
            };
            return (
              <div
                key={chapter.id}
                data-step-index={stepIndex}
                data-chapter-index={step.chapterIndex}
                className={`glsm-step ${ALIGNMENT_CLASS[chapter.alignment]} ${
                  chapter.hidden ? "glsm-hidden" : ""
                }`}
              >
                <div className={`glsm-card ${themeClass}`} style={cardStyle}>
                  <div
                    className="glsm-card-bar"
                    onPointerDown={(e) =>
                      startGesture(e, chapter.id, "drag", e.currentTarget.parentElement)
                    }
                    onDoubleClick={() => resetCard(chapter.id)}
                    title={t("storymap.dragHint")}
                  >
                    <GripVertical className="glsm-grip" />
                    <span className="glsm-card-title">
                      {chapter.title || t("storymap.untitledChapter")}
                    </span>
                  </div>
                  <div className="glsm-card-body">
                    {chapter.image ? <img src={chapter.image} alt={chapter.title} /> : null}
                    {chapter.description ? (
                      <div
                        // Descriptions support inline HTML, matching the template;
                        // sanitized because chapters can come from a shared project.
                        dangerouslySetInnerHTML={{
                          __html: sanitizeStoryHtml(chapter.description),
                        }}
                      />
                    ) : null}
                  </div>
                  <span
                    className="glsm-resize"
                    title={t("storymap.resizeHint")}
                    onPointerDown={(e) =>
                      startGesture(e, chapter.id, "resize", e.currentTarget.parentElement)
                    }
                  />
                </div>
              </div>
            );
          })}
        </div>

        {storymap?.footer ? (
          <div
            className={`glsm-footer ${themeClass}`}
            style={slideActive ? { visibility: "hidden" } : undefined}
          >
            <p dangerouslySetInnerHTML={{ __html: sanitizeStoryHtml(storymap.footer) }} />
          </div>
        ) : null}
      </div>
    </div>,
    container,
  );
}

/** Scoped styles mirroring the standalone storytelling template. */
function StoryMapStyles() {
  return (
    <style>{`
      /* Widths are percentages of the overlay (which is sized to the map
         canvas, not the viewport) so panels and images never spill past the
         map. The scroll surface captures the wheel so scrolling advances
         chapters; the scrollbar is hidden so it cannot cover the map controls,
         which are lifted above the overlay to stay clickable. */
      /* Lift the whole control layer (a positioned z-index:2 stacking context)
         above the overlay; it is pointer-events:none, so only its buttons take
         clicks while scroll/clicks elsewhere still reach the overlay. */
      .maplibregl-control-container { z-index: 73; }
      .glsm-scroll { scrollbar-width: none; }
      .glsm-scroll::-webkit-scrollbar { width: 0; height: 0; }
      /* Reserve room for the navigation pane so panels never slide under it. */
      .glsm-with-nav { padding-left: 14rem; }
      @media (max-width: 900px) { .glsm-with-nav { padding-left: 0; } }
      .glsm-scroll a, .glsm-scroll a:hover, .glsm-scroll a:visited { color: #0071bc; }
      /* Decorative text only; never intercept pointers meant for cards/map. */
      .glsm-header { margin: auto; width: 100%; position: relative; z-index: 5; pointer-events: none; }
      /* Explicit sizes: the app's CSS reset would otherwise shrink headings to inherit. */
      .glsm-header h1, .glsm-header h2, .glsm-header p { margin: 0; padding: 1vh 2%; text-align: center; }
      .glsm-header h1 { font-size: 2rem; font-weight: 700; line-height: 1.2; }
      .glsm-header h2 { font-size: 1.3rem; font-weight: 600; line-height: 1.3; }
      .glsm-header p { font-size: 1rem; }
      .glsm-footer { width: 100%; min-height: 5vh; padding: 2vh 0; text-align: center; line-height: 22px; font-size: 13px; position: relative; z-index: 5; }
      .glsm-footer p { margin: 0; padding: 0 5%; }
      .glsm-features { padding-top: 10vh; padding-bottom: 45vh; }
      .glsm-hidden { visibility: hidden; }
      /* Start/closing slides are empty full-height scroll targets (#998). */
      .glsm-slide-step { min-height: 85vh; padding-bottom: 0; }
      .glsm-centered { width: 50%; margin: 0 auto; }
      .glsm-lefty { width: 33%; margin-left: 5%; }
      .glsm-righty { width: 33%; margin-left: 62%; }
      .glsm-fully { width: 80%; margin: 0 auto; }
      .glsm-light { color: #444; background-color: #fafafa; }
      .glsm-dark { color: #fafafa; background-color: #444; }
      .glsm-step { padding-bottom: 45vh; opacity: 0.25; transition: opacity 0.3s; }
      .glsm-step.glsm-active { opacity: 0.95; }
      /* Each chapter renders as a movable, resizable card. */
      /* z-index keeps a dragged card above the (z-index:5) header it overlaps. */
      .glsm-card { position: relative; z-index: 6; display: flex; flex-direction: column; max-height: 60vh; line-height: 22px; font-size: 14px; border-radius: 6px; box-shadow: 0 6px 20px rgba(0,0,0,0.25); overflow: hidden; }
      .glsm-card-bar { display: flex; align-items: center; gap: 6px; padding: 7px 10px; cursor: move; touch-action: none; user-select: none; font-weight: 600; font-size: 13px; border-bottom: 1px solid rgba(127,127,127,0.25); }
      .glsm-grip { width: 14px; height: 14px; flex-shrink: 0; opacity: 0.55; }
      .glsm-card-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .glsm-card-body { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 14px 18px; }
      .glsm-card-body img { width: 100%; max-height: 38vh; object-fit: cover; border-radius: 2px; }
      .glsm-resize { position: absolute; right: 0; bottom: 0; width: 18px; height: 18px; cursor: nwse-resize; touch-action: none; }
      .glsm-resize::after { content: ''; position: absolute; right: 4px; bottom: 4px; width: 7px; height: 7px; border-right: 2px solid currentColor; border-bottom: 2px solid currentColor; opacity: 0.5; }
      .glsm-inset-marker { width: 12px; height: 12px; background-color: #ff6b6b; border: 2px solid white; border-radius: 50%; box-shadow: 0 2px 4px rgba(0,0,0,0.3); }
      @media (max-width: 750px) {
        .glsm-centered, .glsm-lefty, .glsm-righty, .glsm-fully { width: 90vw; margin: 0 auto; }
      }
    `}</style>
  );
}
