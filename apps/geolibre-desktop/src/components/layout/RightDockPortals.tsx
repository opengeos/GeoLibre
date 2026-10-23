import type { MapEngine } from "@geolibre/map";
import { Suspense, type ComponentProps, type ReactElement } from "react";
import { createPortal } from "react-dom";
import { BROWSER_PANEL_ID } from "../../hooks/useRegisterBrowserPanel";
import { COMMENTS_PANEL_ID } from "../../hooks/useRegisterCommentsPanel";
import type { LayoutOptions } from "../../hooks/useLayoutOptions";
import { OBIA_PANEL_ID } from "../../lib/obia/obia-panel";
import { CommentsPanel } from "../comments/CommentsPanel";
import { BrowserPanel } from "../panels/BrowserPanel";
import { ObiaWorkbenchPanel } from "./desktopShellLazyPanels";

type BrowserPanelProps = ComponentProps<typeof BrowserPanel>;
type CommentsPanelProps = ComponentProps<typeof CommentsPanel>;

interface RightDockPortalsProps {
  activePanelId: string | null;
  layoutOptions: Pick<LayoutOptions, "panelsHidden" | "viewer">;
  mapControllerRef: React.RefObject<MapEngine | null>;
  /** The dedicated content hosts from `useRightPanelHost`. */
  hosts: { browser: HTMLElement; comments: HTMLElement; obia: HTMLElement };
  browser: Omit<BrowserPanelProps, "mapControllerRef">;
  comments: Omit<CommentsPanelProps, "mapControllerRef">;
}

/**
 * The React-rendered right-dock panels (Browser, Comments, Object-Based
 * Analysis). Each body is portalled into its own dedicated content host, which
 * the dock slots relocate between positions, so the panel shares the app's
 * React context while the shell owns its dock chrome. Only the active panel is
 * rendered.
 */
export function RightDockPortals({
  activePanelId,
  layoutOptions,
  mapControllerRef,
  hosts,
  browser,
  comments,
}: RightDockPortalsProps): ReactElement | null {
  if (layoutOptions.panelsHidden) return null;
  if (activePanelId === BROWSER_PANEL_ID && !layoutOptions.viewer) {
    return createPortal(
      <BrowserPanel mapControllerRef={mapControllerRef} {...browser} />,
      hosts.browser,
    );
  }
  if (activePanelId === COMMENTS_PANEL_ID) {
    return createPortal(
      <CommentsPanel mapControllerRef={mapControllerRef} {...comments} />,
      hosts.comments,
    );
  }
  if (activePanelId === OBIA_PANEL_ID) {
    return createPortal(
      <Suspense fallback={null}>
        <ObiaWorkbenchPanel mapControllerRef={mapControllerRef} />
      </Suspense>,
      hosts.obia,
    );
  }
  return null;
}
