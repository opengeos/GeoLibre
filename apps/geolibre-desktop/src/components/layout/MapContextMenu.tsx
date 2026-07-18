import type { MapController } from "@geolibre/map";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@geolibre/ui";
import type maplibregl from "maplibre-gl";
import { BookOpen, Braces, Crosshair, Earth, MapIcon, MapPin, ZoomIn } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { googleEarthUrl, googleMapsUrl } from "../../lib/external-map-links";
import { openExternalLink } from "../../lib/open-external";

interface ContextMenuState {
  /** Monotonic id so each right-click remounts the menu at the new anchor. */
  id: number;
  /** Clicked longitude/latitude in degrees. */
  lng: number;
  lat: number;
  /** Cursor position in viewport pixels, used to anchor the popup. */
  x: number;
  y: number;
}

/** Decimal places used when formatting and copying coordinates. */
const COORD_PRECISION = 6;

/** Format a clicked point as "lat, lng" to mirror the Google Maps convention. */
function formatCoords(lat: number, lng: number): string {
  return `${lat.toFixed(COORD_PRECISION)}, ${lng.toFixed(COORD_PRECISION)}`;
}

async function copyText(value: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(value);
  } catch {
    // Clipboard access can be denied (insecure context, permissions). Fall back
    // to a transient textarea + execCommand so the copy still works offline.
    const textarea = document.createElement("textarea");
    textarea.value = value;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    try {
      document.execCommand("copy");
    } finally {
      document.body.removeChild(textarea);
    }
  }
}

/**
 * Renders the map's right-click context menu (issue #829).
 *
 * Listening to MapLibre's own `contextmenu` event (rather than a raw DOM
 * handler) yields the clicked geographic coordinate directly. The top item
 * shows that coordinate and copies it to the clipboard on click, Google-Maps
 * style; below it sits a curated set of quick actions that operate on the
 * clicked point (copy GeoJSON, recenter, zoom in, open in Google Maps/Earth).
 *
 * The menu is positioned with an invisible zero-size trigger pinned at the
 * cursor: Radix anchors its content to that trigger. The whole menu is keyed by
 * a monotonic id so each new right-click remounts it at the fresh anchor instead
 * of leaving the popup stuck at the previous location.
 *
 * @param mapControllerRef - Ref to the live primary map controller.
 * @param mapReadyGeneration - Bumped when the controller (re)initialises, so the
 *   `contextmenu` listener re-attaches once the map is ready.
 */
export function MapContextMenu({
  mapControllerRef,
  mapReadyGeneration,
  onExplorePlace,
}: {
  mapControllerRef: RefObject<MapController | null>;
  mapReadyGeneration: number;
  /** Open a Wikipedia knowledge card for the clicked coordinate. */
  onExplorePlace?: (lat: number, lng: number) => void;
}) {
  const { t } = useTranslation();
  // `menu` keeps the last anchor/coordinate even while closing, so the exit
  // animation plays from the right spot; `open` drives visibility separately.
  const [menu, setMenu] = useState<ContextMenuState | null>(null);
  const [open, setOpen] = useState(false);
  const seqRef = useRef(0);

  useEffect(() => {
    const map = mapControllerRef.current?.getMap();
    if (!map) return;

    const handleContextMenu = (event: maplibregl.MapMouseEvent) => {
      seqRef.current += 1;
      setMenu({
        id: seqRef.current,
        lng: event.lngLat.lng,
        lat: event.lngLat.lat,
        x: event.originalEvent.clientX,
        y: event.originalEvent.clientY,
      });
      setOpen(true);
    };

    map.on("contextmenu", handleContextMenu);
    return () => {
      map.off("contextmenu", handleContextMenu);
    };
  }, [mapControllerRef, mapReadyGeneration]);

  const copyCoords = useCallback(() => {
    if (!menu) return;
    void copyText(formatCoords(menu.lat, menu.lng));
  }, [menu]);

  const copyGeoJson = useCallback(() => {
    if (!menu) return;
    const feature = {
      type: "Feature",
      geometry: { type: "Point", coordinates: [menu.lng, menu.lat] },
      properties: {},
    };
    void copyText(JSON.stringify(feature, null, 2));
  }, [menu]);

  const centerHere = useCallback(() => {
    if (!menu) return;
    mapControllerRef.current?.flyTo({ center: [menu.lng, menu.lat] });
  }, [menu, mapControllerRef]);

  const zoomInHere = useCallback(() => {
    if (!menu) return;
    // Read the live zoom; if the map was torn down between right-click and
    // selection, omit zoom so the move still recenters instead of snapping to
    // zoom 1. MapLibre clamps the +1 to the configured maxZoom on its own.
    const currentZoom = mapControllerRef.current?.getMap()?.getZoom();
    mapControllerRef.current?.flyTo({
      center: [menu.lng, menu.lat],
      ...(currentZoom !== undefined ? { zoom: currentZoom + 1 } : {}),
    });
  }, [menu, mapControllerRef]);

  // Open a Wikipedia knowledge card for the clicked point (Google Earth-style
  // "what's here"). The consent gate lives in the shell handler.
  const explorePlace = useCallback(() => {
    if (!menu) return;
    onExplorePlace?.(menu.lat, menu.lng);
  }, [menu, onExplorePlace]);

  // Read the live zoom so the external site opens at the on-screen scale; if
  // the map was torn down between right-click and selection, fall back to a
  // city-level view rather than dropping the action.
  const viewInGoogleMaps = useCallback(() => {
    if (!menu) return;
    const zoom = mapControllerRef.current?.getMap()?.getZoom() ?? 12;
    void openExternalLink(googleMapsUrl(menu.lat, menu.lng, zoom, { marker: true }));
  }, [menu, mapControllerRef]);

  const viewInGoogleEarth = useCallback(() => {
    if (!menu) return;
    const zoom = mapControllerRef.current?.getMap()?.getZoom() ?? 12;
    void openExternalLink(googleEarthUrl(menu.lat, menu.lng, zoom));
  }, [menu, mapControllerRef]);

  return (
    // Keyed by the right-click id so each new right-click remounts the menu with
    // a fresh anchor at the cursor. The key is tied to `menu` (not `open`), so a
    // normal close leaves the key stable and Radix can play its exit animation;
    // only the next right-click forces the remount that repositions the popup.
    <DropdownMenu key={menu?.id ?? "init"} open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <span
          aria-hidden
          style={{
            position: "fixed",
            left: menu?.x ?? 0,
            top: menu?.y ?? 0,
            width: 0,
            height: 0,
          }}
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="bottom" className="w-64">
        <DropdownMenuItem
          onSelect={copyCoords}
          className="gap-2 font-mono text-xs"
          title={t("mapContextMenu.copyCoordinatesHint")}
        >
          <MapPin className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate">{menu ? formatCoords(menu.lat, menu.lng) : ""}</span>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-xs text-muted-foreground">
          {t("mapContextMenu.quickActions")}
        </DropdownMenuLabel>
        {onExplorePlace ? (
          <DropdownMenuItem onSelect={explorePlace} className="gap-2">
            <BookOpen className="h-4 w-4 shrink-0 text-muted-foreground" />
            {t("mapContextMenu.whatsHere")}
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuItem onSelect={copyGeoJson} className="gap-2">
          <Braces className="h-4 w-4 shrink-0 text-muted-foreground" />
          {t("mapContextMenu.copyGeoJson")}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={centerHere} className="gap-2">
          <Crosshair className="h-4 w-4 shrink-0 text-muted-foreground" />
          {t("mapContextMenu.centerHere")}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={zoomInHere} className="gap-2">
          <ZoomIn className="h-4 w-4 shrink-0 text-muted-foreground" />
          {t("mapContextMenu.zoomInHere")}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={viewInGoogleMaps} className="gap-2">
          <MapIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
          {t("mapContextMenu.viewInGoogleMaps")}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={viewInGoogleEarth} className="gap-2">
          <Earth className="h-4 w-4 shrink-0 text-muted-foreground" />
          {t("mapContextMenu.viewInGoogleEarth")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
