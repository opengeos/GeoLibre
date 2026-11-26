import {
  BookOpen,
  Braces,
  Circle,
  Crosshair,
  Earth,
  Eye,
  Globe2,
  MapIcon,
  MapPin,
  Navigation2,
  Route,
  Signpost,
  Sparkles,
  Spline,
  ZoomIn,
} from "lucide-react";
import { useEffect, useMemo } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { registerMobileBackHandler } from "../../../lib/mobile-back-stack";
import { useTerrainVisibility } from "../../../lib/terrain-visibility-settings";
import { QUICK_TRAVEL_CONTOURS_LABEL, type QuickBufferPreset } from "../../../lib/quick-analysis";
import type { TouchMenuItem } from "../../../lib/touch-menu-nav";
import { TouchMenuSheet } from "./TouchMenuSheet";

export interface MapContextTouchSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  coordLabel: string;
  hasExplorePlace: boolean;
  lineOfSightAvailable: boolean;
  viewshedBusy: boolean;
  bufferPresets: readonly QuickBufferPreset[];
  viewshedRadiiMeters: readonly number[];
  formatDistance: (preset: QuickBufferPreset) => string;
  formatViewshedRadius: (meters: number) => string;
  onCopyCoords: () => void;
  onExplorePlace: () => void;
  onCopyGeoJson: () => void;
  onCenterHere: () => void;
  onZoomInHere: () => void;
  onDirections: (role: "origin" | "destination") => void;
  onBufferHere: (preset: QuickBufferPreset) => void;
  onTravelTimeHere: (mode: "auto" | "pedestrian") => void;
  onViewshedHere: (radiusMeters: number) => void;
  onLineOfSightHere: () => void;
  onOpenBufferProcessing: () => void;
  onViewInGoogleMaps: () => void;
  onViewInGoogleEarth: () => void;
}

/**
 * Touch drill-down bottom sheet for map long-press quick actions
 * (GeoLibre#3537 Phase 3), replacing the floating Radix context dropdown.
 */
export function MapContextTouchSheet({
  open,
  onOpenChange,
  coordLabel,
  hasExplorePlace,
  lineOfSightAvailable,
  viewshedBusy,
  bufferPresets,
  viewshedRadiiMeters,
  formatDistance,
  formatViewshedRadius,
  onCopyCoords,
  onExplorePlace,
  onCopyGeoJson,
  onCenterHere,
  onZoomInHere,
  onDirections,
  onBufferHere,
  onTravelTimeHere,
  onViewshedHere,
  onLineOfSightHere,
  onOpenBufferProcessing,
  onViewInGoogleMaps,
  onViewInGoogleEarth,
}: MapContextTouchSheetProps) {
  const { t } = useTranslation();
  // The same Earth-model switch as the desktop menu's checkbox and the Line of
  // Sight panel, so a long-press viewshed honours (and can change) it.
  const viewshedCurvature = useTerrainVisibility((s) => s.curvature);
  const updateTerrainVisibility = useTerrainVisibility((s) => s.update);

  useEffect(() => {
    if (!open) return;
    return registerMobileBackHandler(() => {
      onOpenChange(false);
      return true;
    });
  }, [open, onOpenChange]);

  const items = useMemo<TouchMenuItem[]>(() => {
    const quickItems: TouchMenuItem[] = [
      {
        kind: "action",
        id: "copy-coords",
        label: coordLabel,
        description: t("mapContextMenu.copyCoordinatesHint"),
        icon: <MapPin className="h-4 w-4" />,
        onSelect: onCopyCoords,
      },
      ...(hasExplorePlace
        ? [
            {
              kind: "action" as const,
              id: "whats-here",
              label: t("mapContextMenu.whatsHere"),
              icon: <BookOpen className="h-4 w-4" />,
              onSelect: onExplorePlace,
            },
          ]
        : []),
      {
        kind: "action",
        id: "copy-geojson",
        label: t("mapContextMenu.copyGeoJson"),
        icon: <Braces className="h-4 w-4" />,
        onSelect: onCopyGeoJson,
      },
      {
        kind: "action",
        id: "center-here",
        label: t("mapContextMenu.centerHere"),
        icon: <Crosshair className="h-4 w-4" />,
        onSelect: onCenterHere,
      },
      {
        kind: "action",
        id: "zoom-in-here",
        label: t("mapContextMenu.zoomInHere"),
        icon: <ZoomIn className="h-4 w-4" />,
        onSelect: onZoomInHere,
      },
      ...(lineOfSightAvailable
        ? [
            {
              kind: "action" as const,
              id: "directions-to",
              label: t("mapContextMenu.directionsToHere"),
              icon: <Signpost className="h-4 w-4" />,
              onSelect: () => onDirections("destination"),
            },
            {
              kind: "action" as const,
              id: "directions-from",
              label: t("mapContextMenu.directionsFromHere"),
              icon: <Navigation2 className="h-4 w-4" />,
              onSelect: () => onDirections("origin"),
            },
          ]
        : []),
    ];

    const analysisItems: TouchMenuItem[] = [
      ...bufferPresets.map((preset) => ({
        kind: "action" as const,
        id: `buffer-${preset.distance}-${preset.units}`,
        label: t("quickAnalysis.bufferHere", { distance: formatDistance(preset) }),
        icon: <Circle className="h-4 w-4" />,
        onSelect: () => onBufferHere(preset),
      })),
      {
        kind: "action",
        id: "drive-time",
        label: t("quickAnalysis.driveTimeHere", { contours: QUICK_TRAVEL_CONTOURS_LABEL }),
        icon: <Route className="h-4 w-4" />,
        onSelect: () => onTravelTimeHere("auto"),
      },
      {
        kind: "action",
        id: "walk-time",
        label: t("quickAnalysis.walkTimeHere", { contours: QUICK_TRAVEL_CONTOURS_LABEL }),
        icon: <Route className="h-4 w-4" />,
        onSelect: () => onTravelTimeHere("pedestrian"),
      },
      ...viewshedRadiiMeters.map((radiusMeters) => ({
        kind: "action" as const,
        id: `viewshed-${radiusMeters}`,
        label: t("quickAnalysis.viewshedHere", { radius: formatViewshedRadius(radiusMeters) }),
        disabled: viewshedBusy,
        icon: <Eye className="h-4 w-4" />,
        onSelect: () => onViewshedHere(radiusMeters),
      })),
      {
        kind: "action",
        id: "viewshed-curvature",
        label: t("quickAnalysis.viewshedCurvature"),
        description: t(
          viewshedCurvature
            ? "quickAnalysis.viewshedCurvatureOn"
            : "quickAnalysis.viewshedCurvatureOff",
        ),
        active: viewshedCurvature,
        icon: <Globe2 className="h-4 w-4" />,
        onSelect: () => updateTerrainVisibility({ curvature: !viewshedCurvature }),
      },
      ...(lineOfSightAvailable
        ? [
            {
              kind: "action" as const,
              id: "line-of-sight",
              label: t("quickAnalysis.lineOfSightHere"),
              icon: <Spline className="h-4 w-4" />,
              onSelect: onLineOfSightHere,
            },
          ]
        : []),
      {
        kind: "action",
        id: "open-processing",
        label: t("quickAnalysis.openInProcessing"),
        icon: <Sparkles className="h-4 w-4" />,
        onSelect: onOpenBufferProcessing,
      },
    ];

    return [
      {
        kind: "section",
        id: "quick-actions",
        label: t("mapContextMenu.quickActions"),
        items: [
          ...quickItems,
          {
            kind: "submenu",
            id: "quick-analysis",
            label: t("quickAnalysis.menu"),
            icon: <Sparkles className="h-4 w-4" />,
            items: analysisItems,
          },
        ],
      },
      {
        kind: "section",
        id: "external",
        label: t("mobileShell.more.app"),
        items: [
          {
            kind: "action",
            id: "google-maps",
            label: t("mapContextMenu.viewInGoogleMaps"),
            icon: <MapIcon className="h-4 w-4" />,
            onSelect: onViewInGoogleMaps,
          },
          {
            kind: "action",
            id: "google-earth",
            label: t("mapContextMenu.viewInGoogleEarth"),
            icon: <Earth className="h-4 w-4" />,
            onSelect: onViewInGoogleEarth,
          },
        ],
      },
    ];
  }, [
    coordLabel,
    t,
    onCopyCoords,
    hasExplorePlace,
    onExplorePlace,
    onCopyGeoJson,
    onCenterHere,
    onZoomInHere,
    lineOfSightAvailable,
    onDirections,
    bufferPresets,
    formatDistance,
    onBufferHere,
    onTravelTimeHere,
    viewshedRadiiMeters,
    formatViewshedRadius,
    viewshedBusy,
    onViewshedHere,
    viewshedCurvature,
    updateTerrainVisibility,
    onLineOfSightHere,
    onOpenBufferProcessing,
    onViewInGoogleMaps,
    onViewInGoogleEarth,
  ]);

  if (!open || typeof document === "undefined") return null;

  return createPortal(
    <div
      role="presentation"
      className="fixed inset-0 z-50"
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <TouchMenuSheet
        open={open}
        onOpenChange={onOpenChange}
        title={coordLabel}
        items={items}
        defaultDetent="half"
        searchable={false}
        data-testid="mobile-map-context-sheet"
      />
    </div>,
    document.body,
  );
}
