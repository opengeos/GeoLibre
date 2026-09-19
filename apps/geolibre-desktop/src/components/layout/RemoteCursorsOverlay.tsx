import { useAppStore, type CollaborationPresence } from "@geolibre/core";
import { useEffect, useRef } from "react";
import type { RefObject } from "react";
import type { MapEngine } from "@geolibre/map";
import {
  mountProjectedElement,
  mountProjectedExtent,
  type ProjectedElementHandle,
  type ProjectedExtentHandle,
} from "../../lib/projected-map-overlay";

interface ParticipantOverlays {
  cursor?: ProjectedElementHandle;
  extent?: ProjectedExtentHandle;
}

/**
 * Renders remote participants' presence on the map during a live session:
 * cursors and viewport outlines as renderer-neutral projected DOM overlays.
 *
 * Non-visual component (returns null) — it imperatively attaches to the live map
 * via the engine render surface. It owns and tears down only its own elements,
 * so it is independent of the map style and deck.gl overlay lifecycles.
 *
 * @param mapControllerRef - Ref to the live map controller.
 */
export function RemoteCursorsOverlay({
  mapControllerRef,
  mapReadyGeneration,
}: {
  mapControllerRef: RefObject<MapEngine | null>;
  mapReadyGeneration: number;
}): null {
  const presence = useAppStore((s) => s.collaboration.presence);
  const isActive = useAppStore((s) => s.collaboration.isActive);
  const primaryRenderer = useAppStore((s) => s.primaryRenderer);
  const overlaysRef = useRef<Map<string, ParticipantOverlays>>(new Map());
  const engineRef = useRef<MapEngine | null>(null);

  useEffect(() => {
    const engine = mapControllerRef.current;
    if (engineRef.current !== engine || !isActive) {
      clearOverlays(overlaysRef.current);
      engineRef.current = engine;
    }
    if (!engine || !isActive) return;

    const participantIds = new Set(Object.keys(presence));
    for (const [id, overlays] of overlaysRef.current) {
      if (!participantIds.has(id)) {
        overlays.cursor?.remove();
        overlays.extent?.remove();
        overlaysRef.current.delete(id);
      }
    }

    for (const [id, participant] of Object.entries(presence)) {
      const overlays = overlaysRef.current.get(id) ?? {};
      if (participant.cursor) {
        if (overlays.cursor) {
          overlays.cursor.setCoordinate([participant.cursor.lng, participant.cursor.lat]);
        } else {
          overlays.cursor = mountProjectedElement(
            engine,
            createCursorElement(participant),
            [participant.cursor.lng, participant.cursor.lat],
            "top-left",
          );
        }
      } else {
        overlays.cursor?.remove();
        delete overlays.cursor;
      }
      if (participant.view?.bbox) {
        if (overlays.extent) {
          overlays.extent.setExtent(participant.view.bbox);
          overlays.extent.setColor(participant.color);
        } else {
          overlays.extent = mountProjectedExtent(engine, participant.view.bbox, participant.color);
        }
      } else {
        overlays.extent?.remove();
        delete overlays.extent;
      }
      overlaysRef.current.set(id, overlays);
    }
  }, [presence, isActive, primaryRenderer, mapReadyGeneration, mapControllerRef]);

  useEffect(
    () => () => {
      clearOverlays(overlaysRef.current);
      engineRef.current = null;
    },
    [],
  );

  return null;
}

function clearOverlays(overlays: Map<string, ParticipantOverlays>): void {
  for (const entry of overlays.values()) {
    entry.cursor?.remove();
    entry.extent?.remove();
  }
  overlays.clear();
}

const SVG_NS = "http://www.w3.org/2000/svg";

// `color` and `displayName` come from a remote participant and are stored and
// re-broadcast by the relay without trust. Build the cursor with DOM/SVG APIs
// and set the color as an attribute/style property (never interpolated into
// markup) so a hostile value can't become executable markup — the server also
// validates `color`, but this is the defense-in-depth client half.
function createCursorElement(p: CollaborationPresence): HTMLDivElement {
  const el = document.createElement("div");
  el.className = "geolibre-collab-cursor";
  el.style.cssText =
    "pointer-events:none;display:flex;align-items:flex-start;gap:2px;transform:translate(-2px,-2px);will-change:transform;";
  el.appendChild(createCursorSvg(p.color));
  const label = document.createElement("span");
  label.className = "geolibre-collab-cursor-label";
  label.style.cssText =
    "color:#fff;font-size:11px;line-height:1;padding:2px 5px;border-radius:6px;white-space:nowrap;margin-top:10px;box-shadow:0 1px 2px rgba(0,0,0,.3);";
  label.style.background = p.color;
  label.textContent = p.displayName;
  el.appendChild(label);
  return el;
}

// Inline SVG arrow cursor tinted with the participant's color, built with DOM
// APIs so the color is set as an attribute rather than injected into markup.
function createCursorSvg(color: string): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("width", "18");
  svg.setAttribute("height", "18");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("d", "M3 2l7.5 18 2.2-7.3L20 10.5 3 2z");
  path.setAttribute("fill", color);
  path.setAttribute("stroke", "#fff");
  path.setAttribute("stroke-width", "1.2");
  path.setAttribute("stroke-linejoin", "round");
  svg.appendChild(path);
  return svg;
}
