import { type RefObject, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore } from "@geolibre/core";
import type { MapController } from "@geolibre/map";
import { Button } from "@geolibre/ui";
import { Check, Frame, X } from "lucide-react";

interface StoryMapComposeBarProps {
  mapControllerRef: RefObject<MapController | null>;
}

/**
 * Floating bar shown over the live map while a story chapter is being composed.
 *
 * The Story Map editor is a modal dialog whose full-screen overlay hides the
 * map, so users could not see the camera while capturing a view. Compose mode
 * (issue #775) closes the dialog and shows this bar instead: the user pans,
 * zooms, and tilts the real map, then saves the resulting camera straight into
 * the chapter and returns to the editor, or cancels to discard the changes.
 */
export function StoryMapComposeBar({
  mapControllerRef,
}: StoryMapComposeBarProps) {
  const { t } = useTranslation();
  const composingId = useAppStore((s) => s.ui.storymapComposingId);
  const storymap = useAppStore((s) => s.storymap);
  const setComposing = useAppStore((s) => s.setStorymapComposing);
  const setOpen = useAppStore((s) => s.setStorymapPanelOpen);
  const updateChapter = useAppStore((s) => s.updateStoryChapter);

  const chapter = composingId
    ? storymap?.chapters.find((c) => c.id === composingId)
    : undefined;

  const finish = useCallback(() => {
    setComposing(null);
    setOpen(true);
  }, [setComposing, setOpen]);

  const handleSave = useCallback(() => {
    if (!composingId) return;
    const view = mapControllerRef.current?.readView();
    if (view) {
      updateChapter(composingId, {
        location: {
          center: view.center,
          zoom: view.zoom,
          pitch: view.pitch,
          bearing: view.bearing,
        },
      });
    }
    finish();
  }, [composingId, finish, mapControllerRef, updateChapter]);

  // Bail out if compose mode is off, or if the chapter vanished (e.g. a project
  // load cleared the story) so the bar can't strand the user on the map.
  if (!composingId || !chapter) return null;

  const chapterTitle = chapter.title || t("storymap.untitledChapter");

  return (
    <div className="pointer-events-none absolute bottom-6 left-1/2 z-20 flex w-[min(92vw,34rem)] -translate-x-1/2 flex-col">
      <div
        className="pointer-events-auto flex flex-col gap-2 rounded-md border bg-background/95 px-3 py-2 text-sm shadow-lg backdrop-blur-sm"
        role="region"
        aria-label={t("storymap.composeMode.title")}
        data-testid="storymap-compose-bar"
      >
        <div className="flex items-start gap-2">
          <Frame
            className="mt-0.5 h-4 w-4 shrink-0 text-primary"
            aria-hidden="true"
          />
          <div className="min-w-0">
            <p className="truncate font-medium">
              {t("storymap.composeMode.title")}
              {": "}
              {chapterTitle}
            </p>
            <p className="text-xs text-muted-foreground">
              {t("storymap.composeMode.hint")}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button type="button" size="sm" variant="ghost" onClick={finish}>
            <X className="h-3.5 w-3.5" aria-hidden="true" />
            {t("storymap.composeMode.cancel")}
          </Button>
          <Button type="button" size="sm" onClick={handleSave}>
            <Check className="h-3.5 w-3.5" aria-hidden="true" />
            {t("storymap.composeMode.save")}
          </Button>
        </div>
      </div>
    </div>
  );
}
