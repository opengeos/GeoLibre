import { useState } from "react";

/**
 * Open state for the dialogs the top toolbar owns and opens from its menus,
 * the command palette, and the global shortcuts.
 *
 * Dialogs whose open state lives in the store (Collaborate, Load Features
 * into Editor) and the Add Data dialog (see `useAddDataDialogState`) are not
 * here.
 *
 * @returns Each dialog's open flag and setter, plus the About dialog's
 *   "check for updates" request counter.
 */
export function useToolbarDialogs() {
  const [netcdfDialogOpen, setNetcdfDialogOpen] = useState(false);
  const [newProjectDialogOpen, setNewProjectDialogOpen] = useState(false);
  const [managePluginsOpen, setManagePluginsOpen] = useState(false);
  const [shareDialogOpen, setShareDialogOpen] = useState(false);
  const [galleryDialogOpen, setGalleryDialogOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [printLayoutOpen, setPrintLayoutOpen] = useState(false);
  const [fieldCollectionOpen, setFieldCollectionOpen] = useState(false);
  const [gpsTrackingOpen, setGpsTrackingOpen] = useState(false);
  const [recordTourOpen, setRecordTourOpen] = useState(false);
  const [recordVideoOpen, setRecordVideoOpen] = useState(false);
  const [georeferencerOpen, setGeoreferencerOpen] = useState(false);
  const [setViewOpen, setSetViewOpen] = useState(false);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  // AboutDialog runs one update check per increment, and only while open, so
  // every increment must come with opening it.
  const [checkForUpdatesRequest, setCheckForUpdatesRequest] = useState(0);

  return {
    netcdfDialogOpen,
    setNetcdfDialogOpen,
    newProjectDialogOpen,
    setNewProjectDialogOpen,
    managePluginsOpen,
    setManagePluginsOpen,
    shareDialogOpen,
    setShareDialogOpen,
    galleryDialogOpen,
    setGalleryDialogOpen,
    aboutOpen,
    setAboutOpen,
    printLayoutOpen,
    setPrintLayoutOpen,
    fieldCollectionOpen,
    setFieldCollectionOpen,
    gpsTrackingOpen,
    setGpsTrackingOpen,
    recordTourOpen,
    setRecordTourOpen,
    recordVideoOpen,
    setRecordVideoOpen,
    georeferencerOpen,
    setGeoreferencerOpen,
    setViewOpen,
    setSetViewOpen,
    commandPaletteOpen,
    setCommandPaletteOpen,
    shortcutsOpen,
    setShortcutsOpen,
    checkForUpdatesRequest,
    setCheckForUpdatesRequest,
  };
}

export type ToolbarDialogs = ReturnType<typeof useToolbarDialogs>;
