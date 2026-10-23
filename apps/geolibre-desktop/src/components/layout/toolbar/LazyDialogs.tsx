import i18next from "i18next";
import { lazy, Suspense, useState, type ComponentType, type ReactNode } from "react";
import { notify } from "../../../lib/notify";

// The toolbar's on-demand dialogs, split out of the app chunk. Each is fetched
// the first time it opens (see MountWhenOpened). Dialogs that must run while
// closed stay static imports in TopToolbar: Settings renders its own toolbar
// button, Print Layout syncs the project's print layout on mount, and Field
// Collection restores its session pill from a device preference on mount.

/**
 * Resolves a dialog chunk to the module shape `React.lazy` expects, falling
 * back to a component that renders nothing when the chunk cannot be loaded.
 *
 * Two failure shapes reach this: a rejected import (offline, or a stale chunk
 * deleted by a redeploy), and an import that resolves to `undefined`. The
 * second comes from Vite's preload wrapper, which turns the rejection into
 * `undefined` once a `vite:preloadError` listener calls `preventDefault()`, as
 * the stale-chunk recovery does while it reloads the page. Without the
 * fallback, `React.lazy` reads `.default` off `undefined` during render and
 * the toolbar's error boundary takes the whole toolbar down. A warning toast
 * tells the user the dialog did not open and how to recover, since `React.lazy`
 * caches the empty fallback until the page reloads.
 *
 * @param name - The dialog's name, for the console error.
 * @param load - Imports the chunk and picks the dialog component from it.
 * @returns The `{ default }` module for `React.lazy`.
 */
export async function loadLazyDialog<T extends ComponentType<never>>(
  name: string,
  load: () => Promise<T | undefined>,
): Promise<{ default: T }> {
  try {
    const component = await load();
    if (component) return { default: component };
    console.error(`Failed to load ${name}: its chunk is unavailable.`);
  } catch (error) {
    console.error(`Failed to load ${name}`, error);
  }
  notify.warning(i18next.t("notifications.dialogLoadFailed"));
  // The fallback renders nothing, so it ignores the dialog's props; the cast
  // only satisfies the dialog's prop type.
  return { default: (() => null) as unknown as T };
}

export const AboutDialog = lazy(() =>
  loadLazyDialog("AboutDialog", () => import("../AboutDialog").then((m) => m.AboutDialog)),
);
export const AddDataDialog = lazy(() =>
  loadLazyDialog("AddDataDialog", () => import("../AddDataDialog").then((m) => m.AddDataDialog)),
);
export const AddNetcdfDialog = lazy(() =>
  loadLazyDialog("AddNetcdfDialog", () =>
    import("../AddNetcdfDialog").then((m) => m.AddNetcdfDialog),
  ),
);
export const AddSpaceborneLidarDialog = lazy(() =>
  loadLazyDialog("AddSpaceborneLidarDialog", () =>
    import("../AddSpaceborneLidarDialog").then((m) => m.AddSpaceborneLidarDialog),
  ),
);
export const CommandPalette = lazy(() =>
  loadLazyDialog("CommandPalette", () =>
    import("../../command/CommandPalette").then((m) => m.CommandPalette),
  ),
);
export const GeoreferencerDialog = lazy(() =>
  loadLazyDialog("GeoreferencerDialog", () =>
    import("../GeoreferencerDialog").then((m) => m.GeoreferencerDialog),
  ),
);
export const GpsTrackingDialog = lazy(() =>
  loadLazyDialog("GpsTrackingDialog", () =>
    import("../GpsTrackingDialog").then((m) => m.GpsTrackingDialog),
  ),
);
export const KeyboardShortcutsDialog = lazy(() =>
  loadLazyDialog("KeyboardShortcutsDialog", () =>
    import("../../command/KeyboardShortcutsDialog").then((m) => m.KeyboardShortcutsDialog),
  ),
);
export const LoadFeaturesIntoEditorDialog = lazy(() =>
  loadLazyDialog("LoadFeaturesIntoEditorDialog", () =>
    import("../LoadFeaturesIntoEditorDialog").then((m) => m.LoadFeaturesIntoEditorDialog),
  ),
);
export const ManagePluginsDialog = lazy(() =>
  loadLazyDialog("ManagePluginsDialog", () =>
    import("../ManagePluginsDialog").then((m) => m.ManagePluginsDialog),
  ),
);
export const NewProjectDialog = lazy(() =>
  loadLazyDialog("NewProjectDialog", () =>
    import("../NewProjectDialog").then((m) => m.NewProjectDialog),
  ),
);
export const ProjectGalleryDialog = lazy(() =>
  loadLazyDialog("ProjectGalleryDialog", () =>
    import("../ProjectGalleryDialog").then((m) => m.ProjectGalleryDialog),
  ),
);
export const RecordTourDialog = lazy(() =>
  loadLazyDialog("RecordTourDialog", () =>
    import("../RecordTourDialog").then((m) => m.RecordTourDialog),
  ),
);
export const RecordVideoDialog = lazy(() =>
  loadLazyDialog("RecordVideoDialog", () =>
    import("../RecordVideoDialog").then((m) => m.RecordVideoDialog),
  ),
);
export const SetViewDialog = lazy(() =>
  loadLazyDialog("SetViewDialog", () => import("../SetViewDialog").then((m) => m.SetViewDialog)),
);
export const ShareProjectDialog = lazy(() =>
  loadLazyDialog("ShareProjectDialog", () =>
    import("../ShareProjectDialog").then((m) => m.ShareProjectDialog),
  ),
);

/**
 * Mounts a lazily loaded dialog the first time it opens and keeps it mounted
 * afterwards, so closing it keeps its state exactly as a dialog mounted at
 * startup would (a running GPS track, a recording, a half-filled form).
 *
 * @param props.open - Whether the dialog is open now.
 * @param props.children - The lazy dialog element.
 * @returns The dialog inside a null-fallback Suspense once it has opened.
 */
export function MountWhenOpened({ open, children }: { open: boolean; children: ReactNode }) {
  const [opened, setOpened] = useState(open);
  // Adjusting state while rendering (not in an effect) mounts the dialog in
  // the same render that opens it.
  if (open && !opened) setOpened(true);
  if (!opened && !open) return null;
  return <Suspense fallback={null}>{children}</Suspense>;
}
