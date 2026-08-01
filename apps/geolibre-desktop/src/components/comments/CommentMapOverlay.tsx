import { useEffect, useRef } from "react";
import { useAppStore, type ProjectComment } from "@geolibre/core";
import type { MapController } from "@geolibre/map";
import maplibreGl from "maplibre-gl";

interface CommentMapOverlayProps {
  mapControllerRef: React.RefObject<MapController | null>;
  onSelectComment?: (commentId: string) => void;
  showResolved?: boolean;
}

export function resolveCommentCoordinates(
  comment: ProjectComment,
  map: maplibreGl.Map | null,
): [number, number] | null {
  // 1. Direct lngLat on point or feature anchor
  if (comment.anchor.lngLat) {
    return comment.anchor.lngLat;
  }

  if (!map) return null;

  // 2. Query rendered features on active layer
  if (comment.anchor.type === "feature") {
    const { layerId, featureId } = comment.anchor;
    try {
      const features = map.queryRenderedFeatures(undefined, {
        layers: [layerId],
        filter: ["==", ["id"], featureId],
      });
      if (features.length > 0 && features[0].geometry) {
        const g = features[0].geometry;
        if (g.type === "Point") return g.coordinates as [number, number];
        if (g.type === "Polygon" && g.coordinates[0]?.[0]) {
          return g.coordinates[0][0] as [number, number];
        }
        if (g.type === "LineString" && g.coordinates[0]) {
          return g.coordinates[0] as [number, number];
        }
      }
    } catch {
      // Ignore query errors
    }

    // 3. Fallback to GeoJSON features in store layers
    const layer = useAppStore.getState().layers.find((l) => l.id === layerId);
    if (layer?.geojson?.features) {
      const feat = layer.geojson.features.find((f) => String(f.id) === String(featureId));
      if (feat?.geometry) {
        const g = feat.geometry;
        if (g.type === "Point") return g.coordinates as [number, number];
        if (g.type === "Polygon" && g.coordinates[0]?.[0]) {
          return g.coordinates[0][0] as [number, number];
        }
        if (g.type === "LineString" && g.coordinates[0]) {
          return g.coordinates[0] as [number, number];
        }
      }
    }
  }

  return null;
}

export function CommentMapOverlay({
  mapControllerRef,
  onSelectComment,
  showResolved = false,
}: CommentMapOverlayProps): null {
  const comments = useAppStore((s) => s.comments);
  const markersRef = useRef<maplibreGl.Marker[]>([]);

  useEffect(() => {
    const map = mapControllerRef.current?.getMap() ?? null;
    if (!map) return;

    const renderMarkers = () => {
      // Clear existing markers
      markersRef.current.forEach((m) => m.remove());
      markersRef.current = [];

      comments.forEach((comment, idx) => {
        if (comment.resolved && !showResolved) return;

        const coords = resolveCommentCoordinates(comment, map);
        if (!coords) return;

        const pinColor = comment.author?.color || "#3b82f6";

        const container = document.createElement("div");
        container.className = "group relative cursor-pointer select-none transition-transform duration-150 ease-out hover:scale-115";
        container.style.zIndex = comment.resolved ? "9" : "10";

        // Build the pin with DOM APIs so the author color is set as a style
        // property, never interpolated into markup — defense-in-depth against
        // a hand-edited project file with a hostile color value.
        const pin = document.createElement("div");
        pin.style.cssText = [
          "display:flex",
          "align-items:center",
          "justify-content:center",
          "width:28px",
          "height:28px",
          "border-radius:50% 50% 50% 0",
          "transform:rotate(-45deg)",
          `border:2px solid ${comment.resolved ? "#10b981" : "#ffffff"}`,
          "box-shadow:0 4px 10px rgba(0,0,0,0.35)",
          `opacity:${comment.resolved ? 0.65 : 1}`,
        ].join(";");
        pin.style.backgroundColor = pinColor;

        const label = document.createElement("span");
        label.style.cssText =
          "transform:rotate(45deg);color:#ffffff;font-size:11px;font-weight:700;font-family:system-ui,sans-serif;line-height:1";
        label.textContent = `#${idx + 1}`;
        pin.appendChild(label);
        container.appendChild(pin);

        container.addEventListener("click", (e) => {
          e.stopPropagation();
          onSelectComment?.(comment.id);
        });

        const marker = new maplibreGl.Marker({
          element: container,
          anchor: "bottom",
        })
          .setLngLat(coords)
          .addTo(map);

        markersRef.current.push(marker);
      });
    };

    renderMarkers();

    // Re-render when the style reloads (basemap switch wipes all markers).
    // No moveend listener needed: MapLibre Marker objects are positioned in
    // geographic space and track the map viewport automatically.
    map.on("styledata", renderMarkers);

    return () => {
      map.off("styledata", renderMarkers);
      markersRef.current.forEach((m) => m.remove());
      markersRef.current = [];
    };
  }, [comments, showResolved, mapControllerRef, onSelectComment]);

  return null;
}
