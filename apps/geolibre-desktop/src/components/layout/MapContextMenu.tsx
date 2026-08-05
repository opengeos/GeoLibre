import { useAppStore } from "@geolibre/core";
import type { MapController } from "@geolibre/map";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@geolibre/ui";
import type * as maplibregl from "maplibre-gl";
import {
  BookOpen,
  Braces,
  Circle,
  Crosshair,
  Earth,
  MapIcon,
  MapPin,
  Route,
  Sparkles,
  ZoomIn,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { googleEarthUrl, googleMapsUrl } from "../../lib/external-map-links";
import { openExternalLink } from "../../lib/open-external";
import {
  bufferPresetsFor,
  clickedPointLayer,
  formatBufferDistance,
  QUICK_TRAVEL_CONTOURS,
  QUICK_TRAVEL_CONTOURS_LABEL,
  runQuickAnalysis,
  type QuickBufferPreset,
} from "../../lib/quick-analysis";
import { hasRoutingConsent, recordRoutingConsent } from "../../lib/routing-consent";
import { RoutingConsentDialog } from "./RoutingConsentDialog";

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
  const { i18n, t } = useTranslation();
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

  // Quick analysis (#1523): run an existing Processing tool against the clicked
  // point with defaults filled in. The buffer ladder follows the scale bar's
  // unit system so the menu speaks in the units the map is already labelled in.
  const scaleUnit = useAppStore((s) => s.preferences.map.scaleUnit);
  const bufferPresets = useMemo(() => bufferPresetsFor(scaleUnit), [scaleUnit]);
  const setVectorToolOpen = useAppStore((s) => s.setVectorToolOpen);

  const formatDistance = useCallback(
    (preset: QuickBufferPreset) => formatBufferDistance(preset, i18n.language, t),
    [i18n.language, t],
  );

  const bufferHere = useCallback(
    (preset: QuickBufferPreset) => {
      if (!menu) return;
      const point = clickedPointLayer(menu.lng, menu.lat);
      void runQuickAnalysis({
        toolId: "buffer",
        parameters: { layer: point.id, distance: preset.distance, units: preset.units },
        extraLayers: [point],
        resultName: t("quickAnalysis.bufferLayerName", { distance: formatDistance(preset) }),
        mapControllerRef,
      });
    },
    [menu, t, formatDistance, mapControllerRef],
  );

  // Travel time sends the clicked coordinate to a public Valhalla server, so it
  // is gated on the same one-time privacy notice as the Network tools — that
  // consent flag is documented as covering every activation path, and a menu
  // item that skipped it would send coordinates without the notice.
  const [pendingTravelMode, setPendingTravelMode] = useState<"auto" | "pedestrian" | null>(null);
  // The coordinate is captured when the notice opens: `menu` is cleared by the
  // next right-click, and the run must use the point the user actually chose.
  const pendingTravelPoint = useRef<{ lng: number; lat: number } | null>(null);

  const runTravelTime = useCallback(
    (mode: "auto" | "pedestrian", lng: number, lat: number) => {
      const point = clickedPointLayer(lng, lat);
      void runQuickAnalysis({
        toolId: "isochrone",
        parameters: {
          layer: point.id,
          mode,
          metric: "time",
          contours: QUICK_TRAVEL_CONTOURS,
          // Left empty so the tool resolves the configured routing server
          // rather than baking one in here.
          endpoint: "",
        },
        extraLayers: [point],
        resultName:
          mode === "auto"
            ? t("quickAnalysis.driveTimeLayerName")
            : t("quickAnalysis.walkTimeLayerName"),
        mapControllerRef,
      });
    },
    [t, mapControllerRef],
  );

  const travelTimeHere = useCallback(
    (mode: "auto" | "pedestrian") => {
      if (!menu) return;
      if (hasRoutingConsent()) {
        runTravelTime(mode, menu.lng, menu.lat);
        return;
      }
      pendingTravelPoint.current = { lng: menu.lng, lat: menu.lat };
      setPendingTravelMode(mode);
    },
    [menu, runTravelTime],
  );

  const confirmTravelTime = useCallback(() => {
    const point = pendingTravelPoint.current;
    const mode = pendingTravelMode;
    recordRoutingConsent();
    setPendingTravelMode(null);
    pendingTravelPoint.current = null;
    if (mode && point) runTravelTime(mode, point.lng, point.lat);
  }, [pendingTravelMode, runTravelTime]);

  const cancelTravelTime = useCallback(() => {
    setPendingTravelMode(null);
    pendingTravelPoint.current = null;
  }, []);

  return (
    <>
      <RoutingConsentDialog
        open={pendingTravelMode !== null}
        onCancel={cancelTravelTime}
        onConfirm={confirmTravelTime}
      />
      {/* Keyed by the right-click id so each new right-click remounts the menu
          with a fresh anchor at the cursor. The key is tied to `menu` (not
          `open`), so a normal close leaves the key stable and Radix can play
          its exit animation; only the next right-click forces the remount that
          repositions the popup. */}
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
          <DropdownMenuSub>
            <DropdownMenuSubTrigger className="gap-2">
              <Sparkles className="h-4 w-4 shrink-0 text-muted-foreground" />
              {t("quickAnalysis.menu")}
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="w-60">
              {bufferPresets.map((preset) => (
                <DropdownMenuItem
                  key={`${preset.distance}-${preset.units}`}
                  onSelect={() => bufferHere(preset)}
                  className="gap-2"
                >
                  <Circle className="h-4 w-4 shrink-0 text-muted-foreground" />
                  {t("quickAnalysis.bufferHere", { distance: formatDistance(preset) })}
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => travelTimeHere("auto")} className="gap-2">
                <Route className="h-4 w-4 shrink-0 text-muted-foreground" />
                {t("quickAnalysis.driveTimeHere", { contours: QUICK_TRAVEL_CONTOURS_LABEL })}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => travelTimeHere("pedestrian")} className="gap-2">
                <Route className="h-4 w-4 shrink-0 text-muted-foreground" />
                {t("quickAnalysis.walkTimeHere", { contours: QUICK_TRAVEL_CONTOURS_LABEL })}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              {/* Escape hatch when the presets aren't what was wanted: the full
                dialog, preselected on the same tool. */}
              <DropdownMenuItem onSelect={() => setVectorToolOpen("buffer")} className="gap-2">
                <Sparkles className="h-4 w-4 shrink-0 text-muted-foreground" />
                {t("quickAnalysis.openInProcessing")}
              </DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
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
    </>
  );
}
