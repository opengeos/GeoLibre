import { useEffect, useRef } from "react";
import { useAppStore, type ProjectComment } from "@geolibre/core";
import type { MapController } from "@geolibre/map";
import maplibreGl from "maplibre-gl";

interface CommentMapOverlayProps {
  mapControllerRef: React.RefObject<MapController | null>;
  onSelectComment?: (commentId: string) => void;
  showResolved?: boolean;
}

function extractGeometryCoords(geometry: any): [number, number] | null {
  if (!geometry) return null;
  const { type, coordinates, geometries } = geometry;
  if (type === "Point" && Array.isArray(coordinates)) {
    return coordinates as [number, number];
  }
  if (type === "MultiPoint" && Array.isArray(coordinates?.[0])) {
    return coordinates[0] as [number, number];
  }
  if (type === "LineString" && Array.isArray(coordinates?.[0])) {
    return coordinates[0] as [number, number];
  }
  if (type === "MultiLineString" && Array.isArray(coordinates?.[0]?.[0])) {
    return coordinates[0][0] as [number, number];
  }
  if (type === "Polygon" && Array.isArray(coordinates?.[0]?.[0])) {
    return coordinates[0][0] as [number, number];
  }
  if (type === "MultiPolygon" && Array.isArray(coordinates?.[0]?.[0]?.[0])) {
    return coordinates[0][0][0] as [number, number];
  }
  if (type === "GeometryCollection" && Array.isArray(geometries)) {
    for (const g of geometries) {
      const coords = extractGeometryCoords(g);
      if (coords) return coords;
    }
  }
  return null;
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
    const storeLayer = useAppStore.getState().layers.find((l) => l.id === layerId);
    const sourceIds = new Set(
      storeLayer && Array.isArray(storeLayer.metadata?.sourceIds)
        ? (storeLayer.metadata.sourceIds as string[])
        : [layerId],
    );
    const styleLayers = map.getStyle()?.layers ?? [];
    const validLayers: string[] = [];
    for (const sl of styleLayers) {
      const slSource = "source" in sl && typeof sl.source === "string" ? sl.source : undefined;
      if (sl.id === layerId || (slSource && sourceIds.has(slSource))) {
        try {
          if (map.getLayer(sl.id)) {
            validLayers.push(sl.id);
          }
        } catch {
          // ignore layer lookup error
        }
      }
    }
    if (validLayers.length === 0 && map.getLayer(layerId)) {
      validLayers.push(layerId);
    }

    if (validLayers.length > 0) {
      try {
        const features = map.queryRenderedFeatures(undefined, {
          layers: validLayers,
          filter: ["==", ["id"], featureId],
        });
        if (features.length > 0 && features[0].geometry) {
          const coords = extractGeometryCoords(features[0].geometry);
          if (coords) return coords;
        }
      } catch {
        // Ignore query errors
      }
    }

    // 3. Fallback to GeoJSON features in store layers
    const layer = useAppStore.getState().layers.find((l) => l.id === layerId);
    if (layer?.geojson?.features) {
      const feat = layer.geojson.features.find((f) => String(f.id) === String(featureId));
      if (feat?.geometry) {
        const coords = extractGeometryCoords(feat.geometry);
        if (coords) return coords;
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
        container.className =
          "group relative cursor-pointer select-none transition-transform duration-150 ease-out hover:scale-[1.15]";
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
