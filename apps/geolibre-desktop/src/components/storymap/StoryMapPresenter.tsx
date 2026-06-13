import { type RefObject, useEffect, useMemo, useRef } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import maplibregl from "maplibre-gl";
import { useAppStore, type StoryChapter } from "@geolibre/core";
import type { MapController } from "@geolibre/map";
import { Button } from "@geolibre/ui";
import { X } from "lucide-react";
import { sanitizeStoryHtml } from "../../lib/sanitize-html";

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

const INSET_STYLE_URL =
  "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json";

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

  // Memoized so the effect below does not re-run on every render from a fresh
  // `?? []` array reference; it only changes when the story does.
  const chapters = useMemo(() => storymap?.chapters ?? [], [storymap]);
  const hasChapters = presenting && chapters.length > 0;

  // Set up scroll observation and the live map side-effects while presenting.
  useEffect(() => {
    if (!hasChapters) return;
    const controller = mapControllerRef.current;
    const map = controller?.getMap();
    const container = scrollRef.current;
    if (!controller || !map || !container || !storymap) return;

    const steps = Array.from(
      container.querySelectorAll<HTMLElement>("[data-chapter-index]"),
    );

    // Main-map marker, created once and moved per chapter.
    if (storymap.showMarkers) {
      markerRef.current = new maplibregl.Marker({
        color: storymap.markerColor,
      })
        .setLngLat(chapters[0].location.center)
        .addTo(map);
    }

    // Optional inset minimap.
    if (storymap.inset && insetRef.current) {
      const insetMap = new maplibregl.Map({
        container: insetRef.current,
        style: INSET_STYLE_URL,
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

      // Exit effects of the chapter we are leaving, then enter effects.
      if (previous >= 0 && chapters[previous]) {
        for (const change of chapters[previous].onChapterExit) {
          controller.setStoryLayerOpacity(
            change.layerId,
            change.opacity,
            change.duration,
          );
        }
      }
      for (const change of chapter.onChapterEnter) {
        controller.setStoryLayerOpacity(
          change.layerId,
          change.opacity,
          change.duration,
        );
      }
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
      // Undo any direct opacity changes made during playback.
      controller.restoreLayerStyles();
    };
  }, [hasChapters, chapters, storymap, mapControllerRef]);

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
    <div className="absolute inset-0 z-[70] overflow-hidden">
      <Button
        variant="secondary"
        size="sm"
        className="absolute right-3 top-3 z-[72] shadow-md"
        onClick={() => setPresenting(false)}
      >
        <X className="mr-1 h-4 w-4" />
        {t("storymap.exitPresentation")}
      </Button>

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
        className="glsm-scroll absolute inset-0 overflow-y-auto"
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
      .glsm-scroll a, .glsm-scroll a:hover, .glsm-scroll a:visited { color: #0071bc; }
      .glsm-header { margin: auto; width: 100%; position: relative; z-index: 5; }
      .glsm-header h1, .glsm-header h2, .glsm-header p { margin: 0; padding: 2vh 2vw; text-align: center; }
      .glsm-footer { width: 100%; min-height: 5vh; padding: 2vh 0; text-align: center; line-height: 25px; font-size: 13px; position: relative; z-index: 5; }
      .glsm-footer p { margin: 0; }
      .glsm-features { padding-top: 12vh; padding-bottom: 50vh; }
      .glsm-hidden { visibility: hidden; }
      .glsm-centered { width: 50vw; margin: 0 auto; }
      .glsm-lefty { width: 33vw; margin-left: 5vw; }
      .glsm-righty { width: 33vw; margin-left: 62vw; }
      .glsm-fully { width: 100%; margin: auto; }
      .glsm-light { color: #444; background-color: #fafafa; }
      .glsm-dark { color: #fafafa; background-color: #444; }
      .glsm-step { padding-bottom: 50vh; opacity: 0.25; transition: opacity 0.3s; }
      .glsm-step.glsm-active { opacity: 0.95; }
      .glsm-step > div { padding: 25px 50px; line-height: 25px; font-size: 14px; border-radius: 4px; }
      .glsm-step h3 { margin-top: 0; }
      .glsm-step img { width: 100%; border-radius: 2px; }
      .glsm-inset-marker { width: 12px; height: 12px; background-color: #ff6b6b; border: 2px solid white; border-radius: 50%; box-shadow: 0 2px 4px rgba(0,0,0,0.3); }
      @media (max-width: 750px) {
        .glsm-centered, .glsm-lefty, .glsm-righty, .glsm-fully { width: 90vw; margin: 0 auto; }
      }
    `}</style>
  );
}
