import { useAppStore } from "@geolibre/core";
import { useMemo } from "react";
import { isAssistantOffered } from "../lib/assistant-availability";
import { isMobile } from "../lib/is-mobile";
import { useDesktopSettingsStore } from "./useDesktopSettings";

/**
 * Whether a shortcut into the AI assistant may be shown, following the
 * deployment capabilities, the session's privileges, and the interface profile
 * live (see `isAssistantOffered`).
 *
 * @returns True when the assistant is offered to this user.
 */
export function useAssistantOffered(): boolean {
  const deploymentCapabilities = useAppStore((s) => s.deploymentCapabilities);
  const privileges = useAppStore((s) => s.capabilities.privileges);
  const uiProfile = useDesktopSettingsStore((s) => s.desktopSettings.uiProfile);
  // The user agent is stable for the session, so evaluate once.
  const mobile = useMemo(() => isMobile(), []);
  return useMemo(
    () => isAssistantOffered({ deploymentCapabilities, privileges, uiProfile, mobile }),
    [deploymentCapabilities, privileges, uiProfile, mobile],
  );
}
