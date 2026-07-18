import { type NetworkToolKind, useAppStore } from "@geolibre/core";
import { DIRECTIONS_PLUGIN_ID, REVERSE_GEOCODE_PLUGIN_ID } from "@geolibre/plugins";
import { useState } from "react";
import {
  hasReverseGeocodeConsent,
  recordReverseGeocodeConsent,
} from "../lib/reverse-geocode-consent";
import { hasRoutingConsent, recordRoutingConsent } from "../lib/routing-consent";
import type { AppApi } from "../components/layout/toolbar/constants";

interface UseConsentGatedActionsOptions {
  appApi: AppApi;
  isActive: (id: string) => boolean;
  toggle: (id: string, appApi: AppApi) => void;
}

/**
 * Wraps the actions that send user data to public third-party servers
 * (Directions/OSRM, reverse geocoding, and Valhalla network tools) behind a
 * one-time consent notice, since a hover-only tooltip is invisible on touch.
 *
 * @returns Notice dialog state plus the gated toggle/open handlers.
 */
export function useConsentGatedActions({
  appApi,
  isActive,
  toggle,
}: UseConsentGatedActionsOptions) {
  const setNetworkToolOpen = useAppStore((s) => s.setNetworkToolOpen);
  const [directionsNoticeOpen, setDirectionsNoticeOpen] = useState(false);
  const [reverseGeocodeNoticeOpen, setReverseGeocodeNoticeOpen] = useState(false);
  const [routingNoticeOpen, setRoutingNoticeOpen] = useState(false);
  const [pendingNetworkTool, setPendingNetworkTool] = useState<NetworkToolKind | null>(null);

  // Show a one-time consent notice the first time routing is enabled, since it
  // sends the user's waypoints to a public third-party server.
  const handleToggleDirections = () => {
    if (isActive(DIRECTIONS_PLUGIN_ID)) {
      toggle(DIRECTIONS_PLUGIN_ID, appApi);
      return;
    }
    let acknowledged = false;
    try {
      acknowledged = localStorage.getItem("geolibre:directions-osrm-notice") === "1";
    } catch {
      // localStorage unavailable (private mode): fall back to showing the notice.
    }
    if (acknowledged) toggle(DIRECTIONS_PLUGIN_ID, appApi);
    else setDirectionsNoticeOpen(true);
  };
  const confirmEnableDirections = () => {
    try {
      localStorage.setItem("geolibre:directions-osrm-notice", "1");
    } catch {
      // Ignore: the notice will simply show again next time.
    }
    setDirectionsNoticeOpen(false);
    toggle(DIRECTIONS_PLUGIN_ID, appApi);
  };

  // Reverse geocode sends the clicked coordinates to a public geocoder, so it
  // shows the same one-time consent notice as Directions before first enabling.
  // The consent flag is shared with the project-restore path (DesktopShell), so
  // every activation path is gated on it.
  const handleToggleReverseGeocode = () => {
    if (isActive(REVERSE_GEOCODE_PLUGIN_ID)) {
      toggle(REVERSE_GEOCODE_PLUGIN_ID, appApi);
      return;
    }
    if (hasReverseGeocodeConsent()) toggle(REVERSE_GEOCODE_PLUGIN_ID, appApi);
    else setReverseGeocodeNoticeOpen(true);
  };
  const confirmEnableReverseGeocode = () => {
    recordReverseGeocodeConsent();
    setReverseGeocodeNoticeOpen(false);
    toggle(REVERSE_GEOCODE_PLUGIN_ID, appApi);
  };

  // Network analysis tools send the coordinates of the input points to a public
  // Valhalla routing server, so they show the same one-time consent notice as
  // Directions before opening, gated on every activation path (each menu item).
  const openNetworkTool = (kind: NetworkToolKind) => {
    if (hasRoutingConsent()) {
      setNetworkToolOpen(kind);
      return;
    }
    setPendingNetworkTool(kind);
    setRoutingNoticeOpen(true);
  };
  const confirmOpenNetworkTool = () => {
    recordRoutingConsent();
    setRoutingNoticeOpen(false);
    if (pendingNetworkTool) setNetworkToolOpen(pendingNetworkTool);
    setPendingNetworkTool(null);
  };
  // Cancel/dismiss the routing notice, clearing the paired pending-tool state so
  // callers don't need to know that state exists.
  const dismissRoutingNotice = () => {
    setRoutingNoticeOpen(false);
    setPendingNetworkTool(null);
  };

  return {
    directionsNoticeOpen,
    setDirectionsNoticeOpen,
    reverseGeocodeNoticeOpen,
    setReverseGeocodeNoticeOpen,
    routingNoticeOpen,
    dismissRoutingNotice,
    handleToggleDirections,
    confirmEnableDirections,
    handleToggleReverseGeocode,
    confirmEnableReverseGeocode,
    openNetworkTool,
    confirmOpenNetworkTool,
  };
}
