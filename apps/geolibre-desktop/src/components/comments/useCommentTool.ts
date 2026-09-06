import { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import type React from "react";
import { useAppStore, type CommentAnchor, type ProjectComment } from "@geolibre/core";
import type { MapEngine } from "@geolibre/map";
import { v4 as uuidv4 } from "uuid";
import type { CollaborationApi } from "../../hooks/useCollaboration";
import type * as maplibreGl from "maplibre-gl";

interface UseCommentToolOptions {
  mapControllerRef: React.RefObject<MapEngine | null>;
  collaboration?: CollaborationApi;
  /**
   * Bumped whenever a canvas publishes an engine, and on an engine hand-off.
   * The ref has stable identity, so this is what re-runs the click-listener
   * effect when the map underneath changes (#2268 review).
   */
  mapReadyGeneration: number;
}

export interface PendingCommentState {
  anchor: CommentAnchor;
  point: { x: number; y: number };
}

export function useCommentTool({
  mapControllerRef,
  collaboration,
  mapReadyGeneration,
}: UseCommentToolOptions) {
  const { t } = useTranslation();
  const [isActive, setIsActive] = useState(false);
  const [pendingComment, setPendingComment] = useState<PendingCommentState | null>(null);

  const addComment = useAppStore((s) => s.addComment);
  const collab = useAppStore((s) => s.collaboration);

  /**
   * Whether the current engine can host the tool at all. Placing a comment needs
   * a map click and feature picking, both MapLibre-only today, so an engine
   * without a native map must not let the tool arm (#2268 review).
   */
  const canPlaceComments = useCallback(
    // `=== true`, not `!== false`: a null ref (no engine published yet) must not
    // arm the tool either. The effect below only attaches its click listener
    // when `isActive` flips, and mutating the ref does not re-run it — so a tool
    // armed before the map was ready would stay armed and dead until the user
    // toggled it off and on again (#2268 review).
    () => mapControllerRef.current?.capabilities.nativeMapInstance === true,
    [mapControllerRef],
  );

  const activateTool = useCallback(() => {
    if (!canPlaceComments()) return;
    setIsActive(true);
    setPendingComment(null);
  }, [canPlaceComments]);

  const deactivateTool = useCallback(() => {
    setIsActive(false);
    setPendingComment(null);
  }, []);

  const toggleTool = useCallback(() => {
    setIsActive((prev) => (prev ? false : canPlaceComments()));
    setPendingComment(null);
  }, [canPlaceComments]);

  const submitComment = useCallback(
    (body: string, authorName?: string) => {
      if (!pendingComment || !body.trim()) return;
      if (collab.isActive && collaboration && !collaboration.canEdit()) return;

      // Priority: collab identity > caller-supplied name > localStorage > fallback
      let selfName: string;
      let selfColor: string;
      if (collab.isActive && collab.selfName) {
        selfName = collab.selfName;
        selfColor = collab.selfColor || "#3b82f6";
      } else {
        let storedName = "";
        try {
          storedName =
            typeof localStorage !== "undefined"
              ? (localStorage.getItem("geolibre_author_name") ?? "")
              : "";
        } catch {
          storedName = "";
        }
        selfName = authorName?.trim() || storedName || t("comments.defaultAuthorName");
        selfColor = "#3b82f6";
      }

      const newComment: ProjectComment = {
        id: uuidv4(),
        anchor: pendingComment.anchor,
        author: {
          name: selfName,
          color: selfColor,
        },
        body: body.trim(),
        createdAt: new Date().toISOString(),
        resolved: false,
        replies: [],
      };

      addComment(newComment);

      if (collab.isActive) {
        collaboration?.sendCommentMutation({
          type: "add",
          comment: newComment,
        });
      }

      setPendingComment(null);
      setIsActive(false);
    },
    [pendingComment, collab, addComment, collaboration],
  );

  const cancelPendingComment = useCallback(() => {
    setPendingComment(null);
  }, []);

  useEffect(() => {
    // Placing a comment needs a map click plus feature picking, so it is
    // MapLibre-only for now. The guard used to be implicit — the ref was null on
    // the globe — but it now holds a `CesiumEngine` whose `getMap()` is null, so
    // without saying so the tool could read as armed while no click ever lands
    // (#2268 review). `activateTool`/`toggleTool` refuse to arm without it.
    const map = mapControllerRef.current?.getMap();
    if (!isActive) return;
    if (!map) {
      // Armed with no map to click: disarm rather than leave the tool looking
      // active. Unconditional, including when the ref is momentarily null — the
      // hand-off bumps the generation before the incoming engine publishes, and
      // waiting for a non-null ref left the tool stuck armed if that engine
      // never arrived (a Cesium or WebGL failure means no second bump) (#2268
      // review). There is no initial-mount case to protect: `canPlaceComments`
      // requires `nativeMapInstance === true`, so `isActive` cannot be true
      // before an engine has published.
      setIsActive(false);
      return;
    }

    map.getCanvas().style.cursor = "crosshair";

    const handleMapClick = (e: maplibreGl.MapMouseEvent) => {
      e.originalEvent.stopPropagation();

      // Map source and style layer IDs to canonical store layer IDs.
      const storeLayers = useAppStore.getState().layers;
      const sourceMap = new Map<string, string>();
      for (const l of storeLayers) {
        sourceMap.set(l.id, l.id);
        if (Array.isArray(l.metadata?.sourceIds)) {
          for (const sid of l.metadata.sourceIds) {
            if (typeof sid === "string") sourceMap.set(sid, l.id);
          }
        }
      }

      const bbox: [maplibreGl.PointLike, maplibreGl.PointLike] = [
        [e.point.x - 5, e.point.y - 5],
        [e.point.x + 5, e.point.y + 5],
      ];
      const features = map.queryRenderedFeatures(bbox);

      let anchor: CommentAnchor = {
        type: "point",
        lngLat: [e.lngLat.lng, e.lngLat.lat],
      };

      // Search for feature with a valid ID on a user data layer
      for (const feat of features) {
        const featSource = feat.source || (feat as { layer?: { source?: string } }).layer?.source;
        const storeLayerId =
          (featSource ? sourceMap.get(featSource) : undefined) ??
          (feat.layer?.id ? sourceMap.get(feat.layer.id) : undefined);
        if (storeLayerId && feat.id !== undefined && feat.id !== null) {
          anchor = {
            type: "feature",
            layerId: storeLayerId,
            featureId: feat.id as string | number,
            lngLat: [e.lngLat.lng, e.lngLat.lat],
          };
          break;
        }
      }

      setPendingComment({
        anchor,
        point: { x: e.point.x, y: e.point.y },
      });
    };

    map.on("click", handleMapClick);

    return () => {
      map.getCanvas().style.cursor = "";
      map.off("click", handleMapClick);
    };
    // `mapReadyGeneration` is what makes this re-run on an engine hand-off: the
    // ref has stable identity, so without it a tool armed on the 2D map would
    // stay armed across a switch and never attach to the replacement map
    // (#2268 review).
  }, [isActive, mapControllerRef, mapReadyGeneration]);

  return {
    isActive,
    activateTool,
    deactivateTool,
    toggleTool,
    pendingComment,
    submitComment,
    cancelPendingComment,
  };
}
