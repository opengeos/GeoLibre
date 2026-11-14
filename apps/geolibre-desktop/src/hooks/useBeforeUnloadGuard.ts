import { type AppPrivilege, type DeploymentCapability, useAppStore } from "@geolibre/core";
import { useEffect } from "react";
import { isEmbedded } from "./embedHost";
import { isTauri } from "../lib/is-tauri";
import { isToolbarHidden, isViewerLayoutParams } from "../lib/layout-params";

/** The store and URL state {@link shouldWarnBeforeUnload} decides from. */
export interface BeforeUnloadGuardState {
  /** Whether the project has unsaved changes. */
  isDirty: boolean;
  /** What this deployment may do (`project.save` needs `project:edit`). */
  deploymentCapabilities: ReadonlySet<DeploymentCapability>;
  /** What the session's role may do (`project.save` needs `project:save`). */
  privileges: readonly AppPrivilege[];
  /** The page's query string, for the viewer and hidden-toolbar chrome. */
  search: string;
}

/**
 * Whether leaving the page should raise the "Leave site?" prompt.
 *
 * The prompt protects work the user could have saved, so it only applies where
 * saving is reachable at all. The read-only `layout=viewer` chrome and a
 * hidden toolbar (`maponly`, `toolbar=hidden`, which unmounts the Project menu
 * and the Ctrl+S shortcut with it) offer no Save entry point, and a deployment
 * or role that withholds saving removes it too. There the prompt could only nag
 * a visitor about changes they have no way to keep, typically just the layers a
 * `?data=` link loaded, which the same link loads again.
 *
 * The rule keys on whether saving is reachable, not on how the changes were
 * made, on purpose: geometry drawn in a `layout=viewer&draw` embed or a file
 * dropped on a map-only page is not kept by the link either, but with no way to
 * save it the prompt can only announce the loss, and for an embed the host page
 * owns that work (it reads drawings through the embed API).
 *
 * Args:
 *   state: The dirty flag, the save gates and the page's query string.
 *
 * Returns:
 *   True when the project has unsaved changes and saving is available.
 */
export function shouldWarnBeforeUnload(state: BeforeUnloadGuardState): boolean {
  if (!state.isDirty) return false;
  const params = new URLSearchParams(state.search);
  if (isViewerLayoutParams(params) || isToolbarHidden(params)) return false;
  // The same two gates the command registry applies to `project.save`
  // (`deployment-gates.ts`): the deployment's `project:edit` and the role's
  // `project:save`.
  if (!state.deploymentCapabilities.has("project:edit")) return false;
  return state.privileges.includes("project:save");
}

/**
 * Warn before the browser tab is closed or reloaded while the project has
 * unsaved changes, so map work is not lost by accident. The native
 * `beforeunload` prompt only appears when {@link useAppStore} reports
 * `isDirty` and the user could have saved (see {@link shouldWarnBeforeUnload});
 * an unchanged project, or a read-only viewer, closes without interruption.
 *
 * Mount once at the app root. The guard is a no-op under Tauri (a desktop
 * window close raises no useful web prompt; `useWindowCloseGuard` asks there
 * instead) and in the Jupyter/embedded build (the host owns the page
 * lifecycle, and a confirm dialog inside an iframe is undesirable).
 */
export function useBeforeUnloadGuard(): void {
  useEffect(() => {
    if (isTauri() || isEmbedded()) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      // Read the latest state on each event rather than closing over a
      // render-time snapshot, so the listener never needs to be re-registered
      // (the session role's privileges can arrive after mount).
      const { isDirty, deploymentCapabilities, capabilities } = useAppStore.getState();
      if (
        !shouldWarnBeforeUnload({
          isDirty,
          deploymentCapabilities,
          privileges: capabilities.privileges,
          search: window.location.search,
        })
      )
        return;
      // preventDefault + a non-empty returnValue is what triggers the browser's
      // built-in "Leave site?" confirmation. Modern browsers honour
      // preventDefault alone and ignore the string, but Safari and older
      // Firefox still require a truthy returnValue, so set a non-empty sentinel
      // (its text is never shown).
      event.preventDefault();
      event.returnValue = "unsaved";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, []);
}
