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
import * as maplibregl from "maplibre-gl";
import {
  useAppStore,
  normalizeStoryChapterDurationSeconds,
  type StoryActiveSlideMode,
  type StoryChapter,
  type StoryMap,
} from "@geolibre/core";
import type { MapEngine } from "@geolibre/map";
import { Button, cn } from "@geolibre/ui";
import {
  ChevronLeft,
  ChevronRight,
  FileText,
  GripVertical,
  List,
  Pause,
  Play,
  RotateCcw,
  X,
} from "lucide-react";
import { sanitizeStoryHtml } from "../../lib/sanitize-html";
import {
  STORY_END_STEP_ID,
  STORY_GLOBAL_VIEW,
  STORY_INSET_STYLE_URL,
  STORY_START_STEP_ID,
  storySlideCoverColor,
} from "../../lib/storymap-constants";
import { createStoryMapMarker, type StoryMapMarker } from "./storymap-engine";
import {
  StoryMapPresentationTools,
  createPresentationToolsSession,
} from "./StoryMapPresentationTools";
import {
  StoryPresentationPlayback,
  type PresentationPlaybackState,
} from "./storymap-presentation-playback";

interface StoryMapPresenterProps {
  mapControllerRef: RefObject<MapEngine | null>;
  mapReadyGeneration: number;
}

/** One presentation step: a chapter card or an intro/outro slide. */
type PresenterStep =
  | { key: string; kind: "chapter"; chapter: StoryChapter; chapterIndex: number }
  | {
      key: string;
      kind: "slide";
      position: "start" | "end";
      mode: StoryActiveSlideMode;
    };

/**
 * Expand a story into its ordered steps, inserting the optional start and
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
 * Interactive presentation over the live map. Chapters advance explicitly or
 * on a timer; map gestures always pause playback and give control to the user.
 */
export function StoryMapPresenter({
  mapControllerRef,
  mapReadyGeneration,
}: StoryMapPresenterProps) {
  const { t } = useTranslation();
  const presenting = useAppStore((s) => s.ui.storymapPresenting);
  const setPresenting = useAppStore((s) => s.setStorymapPresenting);
  const setPanelOpen = useAppStore((s) => s.setStorymapPanelOpen);
  const storymap = useAppStore((s) => s.storymap);
  const playbackRef = useRef<StoryPresentationPlayback | null>(null);
  const toolsSessionRef = useRef(createPresentationToolsSession());
  const [playback, setPlayback] = useState<PresentationPlaybackState>({
    index: 0,
    phase: "paused",
    remainingSeconds: 15,
    started: false,
  });
  const [hasDraft, setHasDraft] = useState(false);
  const draftRef = useRef(false);
  const onDraftChange = useCallback((draft: boolean) => {
    draftRef.current = draft;
    setHasDraft(draft);
  }, []);
  const pause = useCallback(() => playbackRef.current?.pause(), []);
  // style.load also bumps the generation. Rebind only when the engine itself
  // changes, otherwise changing basemaps would restart a talk at chapter one.
  const presentationEngine = useMemo(
    () => mapControllerRef.current,
    [mapControllerRef, mapReadyGeneration],
  );
  const resumeStepRef = useRef<number | null>(null);

  // Exit the presentation, reopening the editor when it was launched from there
  // so the user lands back in the editor instead of the bare map (#918). Reads
  // the flag before clearing it via setPresenting(false).
  const exitPresentation = useCallback(() => {
    if (draftRef.current) return;
    playbackRef.current?.dispose();
    const reopenEditor = useAppStore.getState().ui.storymapReturnToEditor;
    setPresenting(false);
    if (reopenEditor) setPanelOpen(true);
  }, [setPanelOpen, setPresenting]);

  const stageRef = useRef<HTMLDivElement>(null);
  const insetRef = useRef<HTMLDivElement>(null);
  const insetMapRef = useRef<maplibregl.Map | null>(null);
  const insetMarkerRef = useRef<maplibregl.Marker | null>(null);
  const markerRef = useRef<StoryMapMarker | null>(null);
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
  const [cardOpen, setCardOpen] = useState(true);

  // Memoized so the render path and `hasChapters` get a stable reference.
  const chapters = useMemo(() => storymap?.chapters ?? [], [storymap]);
  // The ordered presentation steps, recomputed when the story changes (it is frozen
  // during a presentation, so this is stable while presenting).
  const steps = useMemo(() => (storymap ? buildPresenterSteps(storymap) : []), [storymap]);
  const hasChapters = presenting && chapters.length > 0;

  const goToStep = useCallback((stepIndex: number) => {
    if (!draftRef.current) playbackRef.current?.select(stepIndex);
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
      const viewport = stageRef.current?.getBoundingClientRect() ?? null;
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
    setCardOpen(true);
    const first = buildPresenterSteps(story)[0];
    if (first?.kind === "slide") {
      setActiveChapter(-1);
      setCoverColor(storySlideCoverColor(first.mode, story.theme));
    } else {
      setActiveChapter(0);
      setCoverColor(null);
    }
  }, [hasChapters]);

  // The presentation owns timing and story side-effects, never normal map input.
  useEffect(() => {
    if (!hasChapters) return;
    const controller = presentationEngine;
    const container = stageRef.current;
    const story = storymapRef.current;
    if (!controller?.getRenderSurface() || !container || !story) return;
    // Frozen snapshot for this presentation run (edits are blocked while
    // presenting), shadowing the outer memoized `chapters`/`steps` deliberately.
    const chapters = story.chapters;
    const steps = buildPresenterSteps(story);

    // Main-map marker, created once and moved per chapter.
    if (story.showMarkers) {
      markerRef.current = createStoryMapMarker(controller, story.markerColor);
      markerRef.current?.setLngLat(chapters[0].location.center);
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

    // Apply a chapter's layer fades to the map and collect them into `pending`,
    // which enterChapter commits to the store in one write once the replay is
    // done (see `ui.storymapLayerOpacity`): deck.gl diagrams and the on-map
    // Legend follow the fades from there, while MapLibre layers take them
    // directly from the controller.
    const applyEffects = (
      changes: StoryChapter["onChapterEnter"],
      pending: Record<string, number>,
    ) => {
      for (const change of changes) {
        controller.setStoryLayerOpacity(change.layerId, change.opacity, change.duration);
        pending[change.layerId] = change.opacity;
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

    const enterChapter = (
      chapter: StoryChapter,
      index: number,
      automatic: boolean,
      arrived: () => void,
    ) => {
      const previous = activeChapterRef.current;
      activeChapterRef.current = index;
      setActiveChapter(index);
      setCoverColor(null);

      // Drive the camera through the controller (which handles the optional
      // rotation) rather than mutating the MapLibre instance directly.
      controller.applyStoryChapterCamera(
        chapter.location,
        chapter.mapAnimation || "flyTo",
        automatic && chapter.rotateAnimation,
        arrived,
      );
      // Re-show the marker in case it was hidden by a preceding global slide.
      setMarkersVisible(true);
      moveCameraTo(chapter.location);

      // Replay the chapters between the old and new position as if scrolled
      // through (exit the one we leave, then enter+exit each skipped chapter in
      // order) so a nav jump reaches the same layer state as
      // stepping one chapter at a time, without firing exits for chapters whose
      // enter never ran. `previous` is -1 before the first chapter (e.g. jumping
      // straight from the start slide to chapter N), which replays 0..N-1 so the
      // skipped chapters' fades still run.
      const pending: Record<string, number> = {};
      if (previous !== index) {
        // Chapter indices are always >= 0: a `previous` of -1 means "before
        // chapter 0", so the loop starts at i = 0 and only moves toward `index`.
        const dir = previous < index ? 1 : -1;
        if (previous >= 0) applyEffects(chapters[previous]?.onChapterExit ?? [], pending);
        for (let i = previous + dir; i !== index; i += dir) {
          applyEffects(chapters[i]?.onChapterEnter ?? [], pending);
          applyEffects(chapters[i]?.onChapterExit ?? [], pending);
        }
      }
      if (previous !== index) {
        applyEffects(chapter.onChapterEnter, pending);
        useAppStore.getState().setStorymapLayerOpacity(pending);
      }
    };

    const enterSlide = (step: Extract<PresenterStep, { kind: "slide" }>, arrived: () => void) => {
      // A slide is not a chapter, so clear the nav highlight. Keep
      // `activeChapterRef` pointing at the last real chapter (it is the replay
      // anchor): a closing "hold" slide keeps that state, and jumping from a
      // slide back to a chapter still replays the intermediate chapters' fades.
      setActiveChapter(-1);
      setCoverColor(storySlideCoverColor(step.mode, story.theme));
      if (step.mode === "blank" || step.mode === "black") {
        controller.stopStoryCamera();
        arrived();
        return;
      }
      // Global zooms out to the whole map; "adjacent" previews/holds the
      // neighboring chapter's camera with all text hidden.
      const location =
        step.mode === "global"
          ? STORY_GLOBAL_VIEW
          : step.position === "start"
            ? (chapters[0]?.location ?? STORY_GLOBAL_VIEW)
            : (chapters[chapters.length - 1]?.location ?? STORY_GLOBAL_VIEW);
      controller.applyStoryChapterCamera(location, "flyTo", false, arrived);
      // The global overview shows no marker; the adjacent preview keeps the
      // chapter's marker and moves it to that chapter.
      if (step.mode === "global") {
        setMarkersVisible(false);
      } else {
        setMarkersVisible(true);
        moveCameraTo(location);
      }
    };

    const enterStep = (index: number, automatic: boolean, arrived: () => void) => {
      const step = steps[index];
      if (!step) return;

      if (step.kind === "chapter") {
        enterChapter(step.chapter, step.chapterIndex, automatic, arrived);
      } else {
        enterSlide(step, arrived);
      }
    };
    const player = new StoryPresentationPlayback(
      steps.map((step) =>
        normalizeStoryChapterDurationSeconds(
          step.kind === "chapter" ? step.chapter.durationSeconds : undefined,
        ),
      ),
      enterStep,
      () => controller.stopStoryCamera(),
      setPlayback,
    );
    playbackRef.current = player;
    player.initialize(resumeStepRef.current ?? 0, resumeStepRef.current !== null);
    resumeStepRef.current = null;

    // Capture gestures before the renderer handles them, cancelling pending
    // flight/rotation callbacks before a user's view can be overwritten.
    const onMapInput = (event: Event) => {
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest("[data-story-ui], .glsm-card")) return;
      player.pause();
    };
    // Include the shell's search box and menus, which live outside the map.
    // Otherwise their flyTo/fitBounds could be overwritten by the next timer.
    document.addEventListener("pointerdown", onMapInput, true);
    document.addEventListener("wheel", onMapInput, { capture: true, passive: true });
    const onFocus = (event: FocusEvent) => {
      if (
        event.target instanceof Element &&
        event.target.closest("input, textarea, select, [contenteditable=true]")
      )
        onMapInput(event);
    };
    document.addEventListener("focusin", onFocus);
    const onVisibility = () => {
      if (document.hidden) player.pause();
    };
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      document.removeEventListener("pointerdown", onMapInput, true);
      gestureCleanupRef.current?.();
      document.removeEventListener("wheel", onMapInput, true);
      document.removeEventListener("focusin", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
      const continuing = useAppStore.getState().ui.storymapPresenting;
      resumeStepRef.current = continuing ? player.snapshot.index : null;
      player.dispose();
      if (playbackRef.current === player) playbackRef.current = null;
      markerRef.current?.remove();
      markerRef.current = null;
      insetMarkerRef.current?.remove();
      insetMarkerRef.current = null;
      insetMapRef.current?.remove();
      insetMapRef.current = null;
      activeChapterRef.current = -1;
      // Reset nav highlight (mirroring activeChapterRef = -1), slide cover, and
      // any card drag/resize so the next presentation starts clean.
      setActiveChapter(-1);
      setCoverColor(null);
      if (!continuing) setCardLayouts({});
      if (!continuing) {
        toolsSessionRef.current = createPresentationToolsSession();
        draftRef.current = false;
        setHasDraft(false);
      }
      // Undo any direct opacity changes made during playback.
      controller.restoreLayerStyles();
    };
  }, [hasChapters, presentationEngine]);

  // Allow Escape to exit the presentation. The presenter owns the key while it
  // is up: it listens in the capture phase and stops propagation, so on-map
  // panels that also close on Escape (the Legend panel, for one) do not close
  // themselves as a side effect of leaving the story (discussion #2326). An
  // Escape aimed at an open dialog, menu, or an editable control (the Legend
  // panel's inline rename and dictionary textarea handle Escape locally) is
  // left alone so it still dismisses or reverts that surface first.
  useEffect(() => {
    if (!presenting) return;
    const onKey = (event: KeyboardEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (
        (event.key === "Enter" || event.code === "Space") &&
        target?.closest("button") &&
        !target.closest("[data-story-ui], .glsm-card")
      )
        playbackRef.current?.pause();
      if (
        target?.closest(
          '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], [role="combobox"], input, textarea, select, [contenteditable="true"]',
        )
      ) {
        return;
      }
      if (event.key === "Escape") {
        if (draftRef.current) return;
        event.preventDefault();
        event.stopPropagation();
        exitPresentation();
      } else if (event.key === "PageDown" || event.key === "PageUp") {
        event.preventDefault();
        event.stopPropagation();
        if (!draftRef.current) {
          const player = playbackRef.current;
          if (player) player.select(player.snapshot.index + (event.key === "PageDown" ? 1 : -1));
        }
      } else if (event.code === "Space" && !target?.closest("button, a")) {
        event.preventDefault();
        event.stopPropagation();
        if (draftRef.current) return;
        const player = playbackRef.current;
        if (player?.snapshot.phase === "playing" || player?.snapshot.phase === "moving")
          player.pause();
        else player?.play();
      } else if (
        ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "+", "-", "="].includes(event.key)
      ) {
        // Keep the renderer's native navigation keys, but stop automatic moves.
        if (!target?.closest("[data-story-ui]")) playbackRef.current?.pause();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [presenting, exitPresentation]);

  // A presentation with no chapters has nothing to show; close it (routing
  // through exitPresentation so it still honors the return-to-editor intent).
  useEffect(() => {
    if (presenting && chapters.length === 0) exitPresentation();
  }, [presenting, chapters.length, exitPresentation]);

  if (!presenting || chapters.length === 0) return null;

  // Render into the active engine's container so the presentation is clipped to the
  // map canvas instead of overlaying the toolbar and side panels. Each engine
  // positions its container relatively, so `absolute inset-0` lines the overlay
  // up exactly with the map.
  const container = mapControllerRef.current?.getRenderSurface()?.getContainer() ?? null;
  if (!container) return null;

  const theme = storymap?.theme ?? "dark";
  const themeClass = theme === "light" ? "glsm-light" : "glsm-dark";
  // Chapters sit after the optional start slide, so a chapter's nav entry maps
  // to its step index by this offset.
  const startOffset = storymap && storymap.startSlide !== "none" ? 1 : 0;
  // A start/closing slide is showing (no chapter highlighted). Slides carry no
  // chapter text, and the closing slide hides the story header/footer too. The
  // start view is the story's opening screen, so it keeps the title block
  // (title/subtitle/byline), raised above a blank/black cover; only the footer
  // hides there. visibility (not display) keeps the title area stable as the
  // presenter switches between steps.
  const slideActive = activeChapter === -1;
  const currentStep = steps[playback.index];
  const startSlideActive =
    slideActive && currentStep?.kind === "slide" && currentStep.position === "start";
  const automatic = playback.phase === "playing" || playback.phase === "moving";
  const playLabel = automatic
    ? t("storymap.playback.pause")
    : playback.phase === "ended"
      ? t("storymap.playback.restart")
      : !playback.started
        ? t("storymap.playback.play")
        : playback.index === steps.length - 1
          ? t("storymap.playback.finish")
          : t("storymap.playback.playNext");
  const statusLabel =
    playback.phase === "playing"
      ? t("storymap.playback.countdown", { seconds: playback.remainingSeconds })
      : playback.phase === "moving"
        ? t("storymap.playback.moving")
        : playback.phase === "ended"
          ? t("storymap.playback.ended")
          : t("storymap.playback.paused");

  return createPortal(
    <div
      className="pointer-events-none absolute inset-0 z-[70] overflow-hidden"
      data-testid="story-presentation"
    >
      <div
        data-story-ui
        className="pointer-events-auto absolute start-3 top-3 z-[72] flex items-center gap-2"
      >
        <Button
          variant="secondary"
          size="sm"
          className="shadow-md"
          disabled={hasDraft}
          onClick={exitPresentation}
        >
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
        <Button
          variant="secondary"
          size="icon"
          className="h-8 w-8 shadow-md"
          title={t("storymap.playback.toggleCard")}
          aria-label={t("storymap.playback.toggleCard")}
          aria-pressed={cardOpen}
          onClick={() => setCardOpen((open) => !open)}
        >
          <FileText className="h-4 w-4" />
        </Button>
      </div>

      {navOpen ? (
        <nav
          data-story-ui
          aria-label={t("storymap.chapterNav")}
          className="pointer-events-auto absolute start-3 top-14 z-[72] max-h-[calc(100%-10rem)] w-52 overflow-y-auto rounded-md border map-glass p-1.5 shadow-lg"
        >
          {chapters.map((chapter, index) => (
            <button
              key={chapter.id}
              type="button"
              disabled={hasDraft}
              aria-current={index === activeChapter ? "step" : undefined}
              onClick={() => goToStep(index + startOffset)}
              className={cn(
                "flex w-full items-center gap-2 rounded px-2 py-1.5 text-start text-xs transition-colors disabled:opacity-50",
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

      {presentationEngine && (
        <div data-story-ui>
          <StoryMapPresentationTools
            engine={presentationEngine}
            session={toolsSessionRef.current}
            chapterId={steps[playback.index]?.key ?? ""}
            chapterTitle={chapters[activeChapter]?.title}
            disabled={slideActive}
            onInteract={pause}
            onDraftChange={onDraftChange}
          />
        </div>
      )}

      <div
        data-story-ui
        role="toolbar"
        aria-label={t("storymap.playback.controls")}
        className="pointer-events-auto absolute bottom-4 start-1/2 z-[74] flex w-max max-w-[calc(100%-1.5rem)] -translate-x-1/2 flex-wrap items-center justify-center gap-1 rounded-lg border map-glass px-3 py-2 shadow-lg rtl:translate-x-1/2"
      >
        <Button
          variant="ghost"
          size="icon"
          disabled={hasDraft || playback.index <= 0}
          aria-label={t("storymap.playback.previous")}
          title={t("storymap.playback.previous")}
          onClick={() => goToStep(playback.index - 1)}
        >
          <ChevronLeft className="h-4 w-4 rtl:rotate-180" />
        </Button>
        <Button
          size="sm"
          disabled={hasDraft}
          onClick={() => (automatic ? pause() : playbackRef.current?.play())}
        >
          {automatic ? <Pause className="me-1 h-4 w-4" /> : <Play className="me-1 h-4 w-4" />}
          {playLabel}
        </Button>
        <Button
          variant="ghost"
          size="icon"
          disabled={hasDraft || playback.index >= steps.length - 1}
          aria-label={t("storymap.playback.next")}
          title={t("storymap.playback.next")}
          onClick={() => goToStep(playback.index + 1)}
        >
          <ChevronRight className="h-4 w-4 rtl:rotate-180" />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={hasDraft}
          onClick={() => playbackRef.current?.resetView()}
          title={t("storymap.playback.resetView")}
        >
          <RotateCcw className="me-1 h-4 w-4" />
          {t("storymap.playback.resetView")}
        </Button>
        <span
          className="px-2 text-xs tabular-nums text-muted-foreground"
          data-testid="story-playback-status"
          role="status"
        >
          {activeChapter >= 0
            ? t("storymap.playback.position", {
                current: activeChapter + 1,
                total: chapters.length,
              })
            : t("storymap.playback.slide")}
          {" · "}
          {statusLabel}
        </span>
        {hasDraft ? (
          <span className="w-full text-center text-xs text-amber-600" role="status">
            {t("storymap.playback.finishDrawing")}
          </span>
        ) : null}
      </div>

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
          pointer-events:none so the renderer remains available underneath. */}
      {coverColor ? (
        <div
          className="pointer-events-none absolute inset-0 z-[71]"
          style={{ background: coverColor }}
        />
      ) : null}

      <StoryMapStyles />

      <div
        ref={stageRef}
        className={cn(
          "glsm-stage pointer-events-none absolute inset-0",
          navOpen && "glsm-with-nav",
        )}
      >
        {storymap && (storymap.title || storymap.subtitle || storymap.byline) ? (
          <div
            className={`glsm-header ${themeClass}`}
            data-testid="story-title-block"
            style={
              !cardOpen || (slideActive && !startSlideActive)
                ? { visibility: "hidden" }
                : startSlideActive
                  ? // Above the start slide's blank/black cover (z-71).
                    { zIndex: 71 }
                  : undefined
            }
          >
            {storymap.title ? <h1>{storymap.title}</h1> : null}
            {storymap.subtitle ? <h2>{storymap.subtitle}</h2> : null}
            {storymap.byline ? <p>{storymap.byline}</p> : null}
          </div>
        ) : null}

        <div className="glsm-features">
          {steps.map((step, stepIndex) => {
            // Start/closing slides are text-free presentation steps; their visual
            // treatment (cover or camera) is driven by the playback effect.
            if (step.kind === "slide") {
              return (
                <div
                  key={step.key}
                  data-step-index={stepIndex}
                  className={cn(
                    "glsm-step glsm-slide-step",
                    stepIndex === playback.index && "glsm-active",
                  )}
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
                className={`glsm-step ${stepIndex === playback.index ? "glsm-active" : ""} ${ALIGNMENT_CLASS[chapter.alignment]} ${
                  chapter.hidden ? "glsm-hidden" : ""
                }`}
                style={!cardOpen ? { visibility: "hidden" } : undefined}
              >
                <div className={`glsm-card ${themeClass}`} style={cardStyle}>
                  <button
                    type="button"
                    className="glsm-card-bar"
                    onPointerDown={(e) =>
                      startGesture(e, chapter.id, "drag", e.currentTarget.parentElement)
                    }
                    onDoubleClick={() => resetCard(chapter.id)}
                    onClick={(event) => {
                      if (event.detail === 0) resetCard(chapter.id);
                    }}
                    title={t("storymap.dragHint")}
                  >
                    <GripVertical className="glsm-grip" />
                    <span className="glsm-card-title">
                      {chapter.title || t("storymap.untitledChapter")}
                    </span>
                  </button>
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
            style={slideActive || !cardOpen ? { visibility: "hidden" } : undefined}
          >
            <p dangerouslySetInnerHTML={{ __html: sanitizeStoryHtml(storymap.footer) }} />
          </div>
        ) : null}
      </div>
    </div>,
    container,
  );
}

/** Presentation chrome never blocks gestures outside a card or control. */
function StoryMapStyles() {
  return (
    <style>{`
      /* Only controls and the current chapter card intercept input. */
      .maplibregl-control-container { z-index: 73; }
      /* Reserve room for the navigation pane so panels never slide under it. */
      .glsm-stage { padding-top: 4rem; }
      .glsm-with-nav { padding-inline-start: 14rem; }
      @media (max-width: 900px) { .glsm-with-nav { padding-inline-start: 0; } }
      .glsm-stage a, .glsm-stage a:hover, .glsm-stage a:visited { color: #0071bc; }
      /* Decorative text only; never intercept pointers meant for cards/map. */
      .glsm-header { margin: 0 auto; width: fit-content; max-width: 65%; position: relative; z-index: 5; pointer-events: none; border-radius: 6px; }
      /* Explicit sizes: the app's CSS reset would otherwise shrink headings to inherit. */
      .glsm-header h1, .glsm-header h2, .glsm-header p { margin: 0; padding: 1vh 2%; text-align: center; }
      .glsm-header h1 { font-size: 1.1rem; font-weight: 700; line-height: 1.2; }
      .glsm-header h2 { font-size: .85rem; font-weight: 500; line-height: 1.3; }
      .glsm-header p { font-size: .75rem; }
      .glsm-footer { max-width: 60%; padding: 3px 12px; text-align: center; line-height: 18px; font-size: 11px; position: absolute; bottom: 5rem; inset-inline-end: 1rem; z-index: 5; border-radius: 4px; }
      .glsm-footer p { margin: 0; padding: 0 5%; }
      .glsm-features { padding-top: 2vh; }
      .glsm-hidden { visibility: hidden; }
      .glsm-slide-step { pointer-events: none; }
      .glsm-centered { width: 50%; margin: 0 auto; }
      .glsm-lefty { width: 33%; margin-inline-start: 3%; }
      .glsm-righty { width: 33%; margin-inline-start: 62%; }
      .glsm-fully { width: 80%; margin: 0 auto; }
      .glsm-light { color: #444; background-color: #fafafa; }
      .glsm-dark { color: #fafafa; background-color: #444; }
      .glsm-step { display: none; }
      .glsm-step.glsm-active { display: block; }
      /* Each chapter renders as a movable, resizable card. */
      /* z-index keeps a dragged card above the (z-index:5) header it overlaps. */
      .glsm-card { pointer-events: auto; position: relative; z-index: 64; display: flex; flex-direction: column; max-height: min(50vh, 480px); line-height: 22px; font-size: 14px; border-radius: 6px; box-shadow: 0 6px 20px rgba(0,0,0,0.25); overflow: hidden; }
      .glsm-card-bar { display: flex; width: 100%; text-align: start; align-items: center; gap: 6px; padding: 7px 10px; cursor: move; touch-action: none; user-select: none; font-weight: 600; font-size: 13px; border-bottom: 1px solid rgba(127,127,127,0.25); }
      .glsm-grip { width: 14px; height: 14px; flex-shrink: 0; opacity: 0.55; }
      .glsm-card-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .glsm-card-body { flex: 1 1 auto; min-height: 0; overflow-y: auto; overscroll-behavior: contain; padding: 14px 18px; }
      .glsm-card-body img { width: 100%; max-height: 38vh; object-fit: cover; border-radius: 2px; }
      .glsm-resize { position: absolute; right: 0; bottom: 0; width: 18px; height: 18px; cursor: nwse-resize; touch-action: none; }
      .glsm-resize::after { content: ''; position: absolute; right: 4px; bottom: 4px; width: 7px; height: 7px; border-right: 2px solid currentColor; border-bottom: 2px solid currentColor; opacity: 0.5; }
      .glsm-inset-marker { width: 12px; height: 12px; background-color: #ff6b6b; border: 2px solid white; border-radius: 50%; box-shadow: 0 2px 4px rgba(0,0,0,0.3); }
      @media (max-width: 750px) {
        .glsm-centered, .glsm-lefty, .glsm-righty, .glsm-fully { width: 65%; margin-inline-start: 32%; }
      }
    `}</style>
  );
}
