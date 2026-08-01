import { useState, useEffect, useCallback } from "react";
import type React from "react";
import { useAppStore, type CommentAnchor, type ProjectComment } from "@geolibre/core";
import type { MapController } from "@geolibre/map";
import { v4 as uuidv4 } from "uuid";
import type { CollaborationApi } from "../../hooks/useCollaboration";
import type maplibreGl from "maplibre-gl";

interface UseCommentToolOptions {
  mapControllerRef: React.RefObject<MapController | null>;
  collaboration?: CollaborationApi;
}

export interface PendingCommentState {
  anchor: CommentAnchor;
  point: { x: number; y: number };
}

export function useCommentTool({ mapControllerRef, collaboration }: UseCommentToolOptions) {
  const [isActive, setIsActive] = useState(false);
  const [pendingComment, setPendingComment] = useState<PendingCommentState | null>(null);

  const addComment = useAppStore((s) => s.addComment);
  const collab = useAppStore((s) => s.collaboration);

  const activateTool = useCallback(() => {
    setIsActive(true);
    setPendingComment(null);
  }, []);

  const deactivateTool = useCallback(() => {
    setIsActive(false);
    setPendingComment(null);
  }, []);

  const toggleTool = useCallback(() => {
    setIsActive((prev) => !prev);
    setPendingComment(null);
  }, []);

  const submitComment = useCallback(
    (body: string, authorName?: string) => {
      if (!pendingComment || !body.trim()) return;

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
        selfName = authorName?.trim() || storedName || "Author";
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
    const map = mapControllerRef.current?.getMap();
    if (!map || !isActive) return;

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
  }, [isActive, mapControllerRef]);

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
