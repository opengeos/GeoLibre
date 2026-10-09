import { lazy, Suspense, useState, type ReactNode } from "react";

// The toolbar's on-demand dialogs, split out of the app chunk. Each is fetched
// the first time it opens (see MountWhenOpened). Dialogs that must run while
// closed stay static imports in TopToolbar: Settings renders its own toolbar
// button, Print Layout syncs the project's print layout on mount, and Field
// Collection restores its session pill from a device preference on mount.

export const AboutDialog = lazy(() =>
  import("../AboutDialog").then((m) => ({ default: m.AboutDialog })),
);
export const AddDataDialog = lazy(() =>
  import("../AddDataDialog").then((m) => ({ default: m.AddDataDialog })),
);
export const AddNetcdfDialog = lazy(() =>
  import("../AddNetcdfDialog").then((m) => ({ default: m.AddNetcdfDialog })),
);
export const AddSpaceborneLidarDialog = lazy(() =>
  import("../AddSpaceborneLidarDialog").then((m) => ({ default: m.AddSpaceborneLidarDialog })),
);
export const CommandPalette = lazy(() =>
  import("../../command/CommandPalette").then((m) => ({ default: m.CommandPalette })),
);
export const GeoreferencerDialog = lazy(() =>
  import("../GeoreferencerDialog").then((m) => ({ default: m.GeoreferencerDialog })),
);
export const GpsTrackingDialog = lazy(() =>
  import("../GpsTrackingDialog").then((m) => ({ default: m.GpsTrackingDialog })),
);
export const KeyboardShortcutsDialog = lazy(() =>
  import("../../command/KeyboardShortcutsDialog").then((m) => ({
    default: m.KeyboardShortcutsDialog,
  })),
);
export const LoadFeaturesIntoEditorDialog = lazy(() =>
  import("../LoadFeaturesIntoEditorDialog").then((m) => ({
    default: m.LoadFeaturesIntoEditorDialog,
  })),
);
export const ManagePluginsDialog = lazy(() =>
  import("../ManagePluginsDialog").then((m) => ({ default: m.ManagePluginsDialog })),
);
export const NewProjectDialog = lazy(() =>
  import("../NewProjectDialog").then((m) => ({ default: m.NewProjectDialog })),
);
export const ProjectGalleryDialog = lazy(() =>
  import("../ProjectGalleryDialog").then((m) => ({ default: m.ProjectGalleryDialog })),
);
export const RecordTourDialog = lazy(() =>
  import("../RecordTourDialog").then((m) => ({ default: m.RecordTourDialog })),
);
export const RecordVideoDialog = lazy(() =>
  import("../RecordVideoDialog").then((m) => ({ default: m.RecordVideoDialog })),
);
export const SetViewDialog = lazy(() =>
  import("../SetViewDialog").then((m) => ({ default: m.SetViewDialog })),
);
export const ShareProjectDialog = lazy(() =>
  import("../ShareProjectDialog").then((m) => ({ default: m.ShareProjectDialog })),
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
