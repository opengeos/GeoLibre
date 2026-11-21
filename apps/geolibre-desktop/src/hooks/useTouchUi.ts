import { useEffect, useMemo, useState } from "react";
import { isMobile } from "../lib/is-mobile";
import { resolveMobileShell, resolveTouchUi, type TouchUiMode } from "../lib/touch-ui";
import { useDesktopSettingsStore } from "./useDesktopSettings";
import { useIsMobileViewport } from "./useIsMobileViewport";

const COARSE_POINTER_QUERY = "(pointer: coarse)";

export function getIsCoarsePointer(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia(COARSE_POINTER_QUERY).matches
  );
}

/** Reactively track whether the primary input pointer is coarse (touch). */
export function useIsCoarsePointer(): boolean {
  const [coarse, setCoarse] = useState(getIsCoarsePointer);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return;
    }
    const query = window.matchMedia(COARSE_POINTER_QUERY);
    const onChange = () => setCoarse(query.matches);
    onChange();
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  return coarse;
}

export interface TouchUiState {
  /** True when coarse-pointer / touch ergonomics (`data-touch-ui="true"`) are active. */
  touchUi: boolean;
  /** True when the phone mobile shell (compact top bar, bottom nav, bottom sheets) is active. */
  mobileShell: boolean;
  /** True when the viewport is phone-width (`<= 767px`). */
  mobileViewport: boolean;
  /** Persisted touch UI preference (`"auto" | "touch" | "desktop"`). */
  touchUiMode: TouchUiMode;
}

/**
 * Resolve the active Touch UI and Mobile Phone Shell flags from the persisted
 * preference, pointer coarseness, mobile OS detection, viewport width, and
 * embed layout flags.
 */
export function useTouchUi(options?: { compact?: boolean; panelsHidden?: boolean }): TouchUiState {
  const touchUiMode = useDesktopSettingsStore((s) => s.desktopSettings.layout.touchUiMode);
  const coarsePointer = useIsCoarsePointer();
  const mobileViewport = useIsMobileViewport();
  const mobilePlatform = useMemo(() => isMobile(), []);

  const touchUi = resolveTouchUi({
    mode: touchUiMode,
    coarsePointer,
    mobilePlatform,
  });
  const mobileShell = resolveMobileShell({
    mode: touchUiMode,
    touchUi,
    mobileViewport,
    compact: options?.compact ?? false,
    panelsHidden: options?.panelsHidden ?? false,
  });

  return { touchUi, mobileShell, mobileViewport, touchUiMode };
}

/**
 * Mirror `touchUi` onto `document.documentElement[data-touch-ui]` so both the
 * shell and body-portaled Radix dialogs/menus/sheets inherit touch styling.
 */
export function useApplyTouchUiAttribute(touchUi: boolean): void {
  useEffect(() => {
    if (typeof document === "undefined") return;
    const root = document.documentElement;
    if (touchUi) {
      root.dataset.touchUi = "true";
    } else {
      delete root.dataset.touchUi;
    }
    return () => {
      delete root.dataset.touchUi;
    };
  }, [touchUi]);
}
