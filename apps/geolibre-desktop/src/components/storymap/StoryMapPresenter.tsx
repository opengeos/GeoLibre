import {
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import maplibregl from "maplibre-gl";
import { useAppStore, type StoryChapter } from "@geolibre/core";
import type { MapController } from "@geolibre/map";
import { Button, cn } from "@geolibre/ui";
import { List, X } from "lucide-react";
import { sanitizeStoryHtml } from "../../lib/sanitize-html";
import { STORY_INSET_STYLE_URL } from "../../lib/storymap-constants";

interface StoryMapPresenterProps {
  mapControllerRef: RefObject<MapController | null>;
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
  "bottom-left": "bottom-3 left-3",
  "bottom-right": "bottom-3 right-3",
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
  const storymap = useAppStore((s) => s.storymap);

  const scrollRef = useRef<HTMLDivElement>(null);
  const insetRef = useRef<HTMLDivElement>(null);
  const insetMapRef = useRef<maplibregl.Map | null>(null);
  const insetMarkerRef = useRef<maplibregl.Marker | null>(null);
  const markerRef = useRef<maplibregl.Marker | null>(null);
  const activeIndexRef = useRef<number>(-1);
  // Mirror of activeIndexRef as state so the navigation pane can highlight the
  // current chapter.
  const [activeIndex, setActiveIndex] = useState(0);
  const [navOpen, setNavOpen] = useState(true);

  // Memoized so the render path and `hasChapters` get a stable reference.
  const chapters = useMemo(() => storymap?.chapters ?? [], [storymap]);
  const hasChapters = presenting && chapters.length > 0;

  // Scroll a chapter into view; the IntersectionObserver then activates it and
  // flies the camera, so clicking the nav reuses the same scroll-driven path.
  const goToChapter = useCallback((index: number) => {
    const step = scrollRef.current?.querySelector<HTMLElement>(
      `[data-chapter-index="${index}"]`,
    );
    step?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, []);

  // The playback effect reads the story through a ref so it only sets up on
  // present/exit (hasChapters) and not on every edit. Edits cannot happen mid-
  // presentation anyway (the builder is closed first), so the story is frozen.
  const storymapRef = useRef(storymap);
  storymapRef.current = storymap;

  // Set up scroll observation and the live map side-effects while presenting.
  useEffect(() => {
    if (!hasChapters) return;
    const controller = mapControllerRef.current;
    const map = controller?.getMap();
    const container = scrollRef.current;
    const story = storymapRef.current;
    if (!controller || !map || !container || !story) return;
    const chapters = story.chapters;

    const steps = Array.from(
      container.querySelectorAll<HTMLElement>("[data-chapter-index]"),
    );

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

    const enterChapter = (index: number) => {
      if (index === activeIndexRef.current) return;
      const previous = activeIndexRef.current;
      activeIndexRef.current = index;
      const chapter = chapters[index];
      if (!chapter) return;
      setActiveIndex(index);

      steps.forEach((step, i) =>
        step.classList.toggle("glsm-active", i === index),
      );

      // Drive the camera through the controller (which cancels any in-progress
      // movement and handles the optional rotation) rather than mutating the
      // MapLibre instance directly from UI code.
      controller.applyStoryChapterCamera(
        chapter.location,
        chapter.mapAnimation || "flyTo",
        chapter.rotateAnimation,
      );

      markerRef.current?.setLngLat(chapter.location.center);
      if (insetMapRef.current) {
        insetMapRef.current.setCenter(chapter.location.center);
        insetMarkerRef.current?.setLngLat(chapter.location.center);
      }

      const applyEffects = (changes: typeof chapter.onChapterEnter) => {
        for (const change of changes) {
          controller.setStoryLayerOpacity(
            change.layerId,
            change.opacity,
            change.duration,
          );
        }
      };

      // Replay the chapters between the old and new position as if scrolled
      // through (exit the one we leave, then enter+exit each skipped chapter in
      // order) so a fast scroll or nav jump reaches the same layer state as
      // stepping one chapter at a time, without firing exits for chapters whose
      // enter never ran.
      if (previous >= 0 && previous !== index) {
        const step = previous < index ? 1 : -1;
        applyEffects(chapters[previous]?.onChapterExit ?? []);
        for (let i = previous + step; i !== index; i += step) {
          applyEffects(chapters[i]?.onChapterEnter ?? []);
          applyEffects(chapters[i]?.onChapterExit ?? []);
        }
      }
      applyEffects(chapter.onChapterEnter);
    };

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const index = Number(
            (entry.target as HTMLElement).dataset.chapterIndex,
          );
          if (Number.isFinite(index)) enterChapter(index);
        }
      },
      {
        root: container,
        // Treat a step as active once it crosses the vertical center.
        rootMargin: "-45% 0px -45% 0px",
        threshold: 0,
      },
    );
    for (const step of steps) observer.observe(step);

    // Kick off the first chapter immediately.
    enterChapter(0);

    return () => {
      observer.disconnect();
      markerRef.current?.remove();
      markerRef.current = null;
      insetMarkerRef.current?.remove();
      insetMarkerRef.current = null;
      insetMapRef.current?.remove();
      insetMapRef.current = null;
      activeIndexRef.current = -1;
      // Reset the nav highlight so the next presentation starts at chapter 1.
      setActiveIndex(0);
      // Undo any direct opacity changes made during playback.
      controller.restoreLayerStyles();
    };
  }, [hasChapters, mapControllerRef]);

  // Allow Escape to exit the presentation.
  useEffect(() => {
    if (!presenting) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPresenting(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [presenting, setPresenting]);

  // A presentation with no chapters has nothing to show; close it.
  useEffect(() => {
    if (presenting && chapters.length === 0) setPresenting(false);
  }, [presenting, chapters.length, setPresenting]);

  if (!presenting || chapters.length === 0) return null;

  // Render into the MapLibre container so the presentation is clipped to the
  // map canvas instead of overlaying the toolbar and side panels. The container
  // carries `.maplibregl-map { position: relative }`, so `absolute inset-0`
  // lines the overlay up exactly with the map.
  const container = mapControllerRef.current?.getMap()?.getContainer() ?? null;
  if (!container) return null;

  const theme = storymap?.theme ?? "dark";
  const themeClass = theme === "light" ? "glsm-light" : "glsm-dark";

  return createPortal(
    // The scroll surface captures the wheel so scrolling navigates chapters.
    // The map controls are lifted above it (see StoryMapStyles) so they stay
    // clickable even though the story drives the camera.
    <div className="absolute inset-0 z-[70] overflow-hidden">
      <div className="absolute left-3 top-3 z-[72] flex items-center gap-2">
        <Button
          variant="secondary"
          size="sm"
          className="shadow-md"
          onClick={() => setPresenting(false)}
        >
          <X className="mr-1 h-4 w-4" />
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
              onClick={() => goToChapter(index)}
              className={cn(
                "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs transition-colors",
                index === activeIndex
                  ? "bg-primary/15 font-medium text-foreground"
                  : "text-muted-foreground hover:bg-muted",
              )}
            >
              <span
                className={cn(
                  "flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px]",
                  index === activeIndex
                    ? "bg-primary text-primary-foreground"
                    : "bg-muted text-muted-foreground",
                )}
              >
                {index + 1}
              </span>
              <span className="truncate">
                {chapter.title || t("storymap.untitledChapter")}
              </span>
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
            INSET_POSITION_CLASS[storymap.insetPosition] ??
            INSET_POSITION_CLASS["bottom-right"]
          }`}
        >
          <div ref={insetRef} className="h-full w-full" />
        </div>
      ) : null}

      <StoryMapStyles />

      <div
        ref={scrollRef}
        className={cn(
          "glsm-scroll absolute inset-0 overflow-y-auto",
          navOpen && "glsm-with-nav",
        )}
      >
        {storymap &&
        (storymap.title || storymap.subtitle || storymap.byline) ? (
          <div className={`glsm-header ${themeClass}`}>
            {storymap.title ? <h1>{storymap.title}</h1> : null}
            {storymap.subtitle ? <h2>{storymap.subtitle}</h2> : null}
            {storymap.byline ? <p>{storymap.byline}</p> : null}
          </div>
        ) : null}

        <div className="glsm-features">
          {chapters.map((chapter, index) => (
            <div
              key={chapter.id}
              data-chapter-index={index}
              className={`glsm-step ${ALIGNMENT_CLASS[chapter.alignment]} ${
                chapter.hidden ? "glsm-hidden" : ""
              }`}
            >
              <div className={themeClass}>
                {chapter.title ? <h3>{chapter.title}</h3> : null}
                {chapter.image ? (
                  <img src={chapter.image} alt={chapter.title} />
                ) : null}
                {chapter.description ? (
                  <p
                    // Descriptions support inline HTML, matching the template;
                    // sanitized because chapters can come from a shared project.
                    dangerouslySetInnerHTML={{
                      __html: sanitizeStoryHtml(chapter.description),
                    }}
                  />
                ) : null}
              </div>
            </div>
          ))}
        </div>

        {storymap?.footer ? (
          <div className={`glsm-footer ${themeClass}`}>
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
      .glsm-header { margin: auto; width: 100%; position: relative; z-index: 5; }
      .glsm-header h1, .glsm-header h2, .glsm-header p { margin: 0; padding: 1.5vh 2%; text-align: center; }
      .glsm-footer { width: 100%; min-height: 5vh; padding: 2vh 0; text-align: center; line-height: 22px; font-size: 13px; position: relative; z-index: 5; }
      .glsm-footer p { margin: 0; padding: 0 5%; }
      .glsm-features { padding-top: 10vh; padding-bottom: 45vh; }
      .glsm-hidden { visibility: hidden; }
      .glsm-centered { width: 50%; margin: 0 auto; }
      .glsm-lefty { width: 33%; margin-left: 5%; }
      .glsm-righty { width: 33%; margin-left: 62%; }
      .glsm-fully { width: 80%; margin: 0 auto; }
      .glsm-light { color: #444; background-color: #fafafa; }
      .glsm-dark { color: #fafafa; background-color: #444; }
      .glsm-step { padding-bottom: 45vh; opacity: 0.25; transition: opacity 0.3s; }
      .glsm-step.glsm-active { opacity: 0.95; }
      .glsm-step > div { padding: 20px 28px; line-height: 22px; font-size: 14px; border-radius: 4px; }
      .glsm-step h3 { margin-top: 0; }
      .glsm-step img { width: 100%; max-height: 38vh; object-fit: cover; border-radius: 2px; }
      .glsm-inset-marker { width: 12px; height: 12px; background-color: #ff6b6b; border: 2px solid white; border-radius: 50%; box-shadow: 0 2px 4px rgba(0,0,0,0.3); }
      @media (max-width: 750px) {
        .glsm-centered, .glsm-lefty, .glsm-righty, .glsm-fully { width: 90vw; margin: 0 auto; }
      }
    `}</style>
  );
}
