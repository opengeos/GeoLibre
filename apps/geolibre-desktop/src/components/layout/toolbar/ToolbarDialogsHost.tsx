import {
  excludeHiddenFieldsFromProject,
  redactProjectCredentials,
  serializeProject,
} from "@geolibre/core";
import type { MapEngine } from "@geolibre/map";
import type { ComponentProps, RefObject } from "react";
import type { useConsentGatedActions } from "../../../hooks/useConsentGatedActions";
import type { useOsmPbfLoader } from "../../../hooks/useOsmPbfLoader";
import type { ProjectFileActions } from "../../../hooks/useProjectFileActions";
import type { useTilePackageLoader } from "../../../hooks/useTilePackageLoader";
import type { useAddDataDialogState } from "../../../hooks/toolbar/useAddDataDialogState";
import type { usePaletteCommands } from "../../../hooks/toolbar/usePaletteCommands";
import { usePaletteSearch } from "../../../hooks/toolbar/usePaletteSearch";
import type { ToolbarDialogs } from "../../../hooks/toolbar/useToolbarDialogs";
import { IS_MAS_BUILD } from "../../../lib/build-flags";
import { FieldCollectionDialog } from "../FieldCollectionDialog";
import { PrintLayoutDialog } from "../PrintLayoutDialog";
import type { AppApi } from "./constants";
import { ConsentNoticeDialogs } from "./ConsentNoticeDialogs";
import {
  AboutDialog,
  AddDataDialog,
  AddNetcdfDialog,
  AddSpaceborneLidarDialog,
  CommandPalette,
  GeoreferencerDialog,
  GpsTrackingDialog,
  KeyboardShortcutsDialog,
  LoadFeaturesIntoEditorDialog,
  ManagePluginsDialog,
  MountWhenOpened,
  NewProjectDialog,
  ProjectGalleryDialog,
  RecordTourDialog,
  RecordVideoDialog,
  SetViewDialog,
  ShareProjectDialog,
} from "./LazyDialogs";
import { OsmPbfDialogs } from "./OsmPbfDialogs";
import { ProjectFileDialogs } from "./ProjectFileDialogs";
import { TilePackageDialogs } from "./TilePackageDialogs";

export interface ToolbarDialogsHostProps {
  viewer: boolean;
  appApi: AppApi;
  mapControllerRef: RefObject<MapEngine | null>;
  mapReadyGeneration: number;
  projectName: string;
  projectGeneration: number;
  dialogs: ToolbarDialogs;
  addData: ReturnType<typeof useAddDataDialogState>;
  projectFiles: ProjectFileActions;
  consent: ReturnType<typeof useConsentGatedActions>;
  osmPbf: ReturnType<typeof useOsmPbfLoader>;
  tilePackage: ReturnType<typeof useTilePackageLoader>;
  loadEditorFeaturesOpen: boolean;
  loadEditorFeaturesLayerId: string | null;
  setLoadEditorFeaturesOpen: (open: boolean) => void;
  allowedCommands: ComponentProps<typeof KeyboardShortcutsDialog>["commands"];
  paletteCommands: ReturnType<typeof usePaletteCommands>;
  onProjectCreated: () => void;
}

/**
 * Shared dialog portals owned by TopToolbar so both desktop menubar mode and
 * phone mobileShell mode keep the exact same dialogs mounted and wired.
 */
export function ToolbarDialogsHost({
  viewer,
  appApi,
  mapControllerRef,
  mapReadyGeneration,
  projectName,
  projectGeneration,
  dialogs,
  addData,
  projectFiles,
  consent,
  osmPbf,
  tilePackage,
  loadEditorFeaturesOpen,
  loadEditorFeaturesLayerId,
  setLoadEditorFeaturesOpen,
  allowedCommands,
  paletteCommands,
  onProjectCreated,
}: ToolbarDialogsHostProps) {
  const paletteSearch = usePaletteSearch(mapControllerRef);
  return (
    <>
      <MountWhenOpened open={dialogs.newProjectDialogOpen}>
        <NewProjectDialog
          open={dialogs.newProjectDialogOpen}
          onOpenChange={dialogs.handleNewProjectDialogOpenChange}
          showExamples={dialogs.newProjectShowExamples}
          onSaveCurrentProject={projectFiles.handleSave}
          onProjectCreated={onProjectCreated}
          onOpenExample={(url, signal) =>
            projectFiles.openProjectFromShareUrl(url, { asCopy: true, signal })
          }
        />
      </MountWhenOpened>
      {/* No plugin marketplace in the Mac App Store build (all its entry
          points are hidden too; this keeps the install surface out of the
          bundle). */}
      {!IS_MAS_BUILD && (
        <MountWhenOpened open={dialogs.managePluginsOpen}>
          <ManagePluginsDialog
            open={dialogs.managePluginsOpen}
            onOpenChange={dialogs.setManagePluginsOpen}
            mapControllerRef={mapControllerRef}
          />
        </MountWhenOpened>
      )}
      {/* Remount on every project load so the composer starts from the opened
          project's saved layout instead of keeping the previous project's
          settings and captured map (GeoLibre discussion #1992). */}
      <PrintLayoutDialog
        key={`print-layout-${projectGeneration}`}
        open={dialogs.printLayoutOpen}
        onOpenChange={dialogs.setPrintLayoutOpen}
        mapControllerRef={mapControllerRef}
      />
      {/* Field Collection and GPS Tracking add features and layers to the
          project, so they follow the Controls menu entries that open them out
          of the read-only viewer preset. Record Tour and Record Video below
          only read the map, so they stay. */}
      {!viewer && (
        <FieldCollectionDialog
          open={dialogs.fieldCollectionOpen}
          onOpenChange={dialogs.setFieldCollectionOpen}
          mapControllerRef={mapControllerRef}
          mapReadyGeneration={mapReadyGeneration}
        />
      )}
      {!viewer && (
        <MountWhenOpened open={dialogs.gpsTrackingOpen}>
          <GpsTrackingDialog
            open={dialogs.gpsTrackingOpen}
            onOpenChange={dialogs.setGpsTrackingOpen}
            mapControllerRef={mapControllerRef}
            mapReadyGeneration={mapReadyGeneration}
          />
        </MountWhenOpened>
      )}
      <MountWhenOpened open={dialogs.recordTourOpen}>
        <RecordTourDialog
          open={dialogs.recordTourOpen}
          onOpenChange={dialogs.setRecordTourOpen}
          mapControllerRef={mapControllerRef}
        />
      </MountWhenOpened>
      <MountWhenOpened open={dialogs.recordVideoOpen}>
        <RecordVideoDialog
          open={dialogs.recordVideoOpen}
          onOpenChange={dialogs.setRecordVideoOpen}
          mapControllerRef={mapControllerRef}
        />
      </MountWhenOpened>
      <MountWhenOpened open={dialogs.georeferencerOpen}>
        <GeoreferencerDialog
          open={dialogs.georeferencerOpen}
          onOpenChange={dialogs.setGeoreferencerOpen}
          mapControllerRef={mapControllerRef}
          mapReadyGeneration={mapReadyGeneration}
        />
      </MountWhenOpened>
      <MountWhenOpened open={dialogs.setViewOpen}>
        <SetViewDialog
          open={dialogs.setViewOpen}
          onOpenChange={dialogs.setSetViewOpen}
          mapControllerRef={mapControllerRef}
        />
      </MountWhenOpened>
      <MountWhenOpened open={loadEditorFeaturesOpen}>
        <LoadFeaturesIntoEditorDialog
          open={loadEditorFeaturesOpen}
          onOpenChange={setLoadEditorFeaturesOpen}
          mapControllerRef={mapControllerRef}
          initialLayerId={loadEditorFeaturesLayerId}
        />
      </MountWhenOpened>
      <MountWhenOpened open={dialogs.shareDialogOpen}>
        <ShareProjectDialog
          open={dialogs.shareDialogOpen}
          onOpenChange={dialogs.setShareDialogOpen}
          currentTitle={projectName}
          getProject={async (title) => {
            // Shared projects are opened on another machine where the local files
            // don't exist, so always embed the vector data (never file references).
            const { project, defaultProjectName } = await projectFiles.buildEmbeddedProject(title);
            const redacted = redactProjectCredentials(excludeHiddenFieldsFromProject(project));
            // Strip path separators, control chars, and other characters that are
            // illegal in filenames so the server gets a predictable name.
            const safeName = defaultProjectName.replace(
              // Includes U+007F (DEL) alongside the C0 control range; both are
              // non-printing and rejected by some filesystems and HTTP servers.
              /[\u0000-\u001f\u007f/\\:*?"<>|]/g,
              "_",
            );
            return {
              content: serializeProject(redacted.project),
              filename: `${safeName}.geolibre.json`,
              redactedCount: redacted.redactedCount,
            };
          }}
        />
      </MountWhenOpened>
      <MountWhenOpened open={dialogs.galleryDialogOpen}>
        <ProjectGalleryDialog
          open={dialogs.galleryDialogOpen}
          onOpenChange={dialogs.handleGalleryDialogOpenChange}
          defaultScope={dialogs.galleryDefaultScope}
          onOpenProject={(url, authToken, options) =>
            projectFiles.openProjectFromShareUrl(url, { authToken, ...options })
          }
        />
      </MountWhenOpened>
      <MountWhenOpened open={addData.dialogProps.kind !== null}>
        <AddDataDialog {...addData.dialogProps} mapControllerRef={mapControllerRef} />
      </MountWhenOpened>
      <MountWhenOpened open={dialogs.netcdfDialogOpen}>
        <AddNetcdfDialog
          open={dialogs.netcdfDialogOpen}
          appApi={appApi}
          onOpenChange={dialogs.setNetcdfDialogOpen}
        />
      </MountWhenOpened>
      <MountWhenOpened open={dialogs.spaceborneLidarDialogOpen}>
        <AddSpaceborneLidarDialog
          open={dialogs.spaceborneLidarDialogOpen}
          appApi={appApi}
          onOpenChange={dialogs.setSpaceborneLidarDialogOpen}
        />
      </MountWhenOpened>
      <ProjectFileDialogs projectFiles={projectFiles} />
      <ConsentNoticeDialogs consent={consent} />
      <OsmPbfDialogs osmPbf={osmPbf} />
      <TilePackageDialogs tilePackage={tilePackage} />
      <MountWhenOpened open={dialogs.aboutOpen}>
        <AboutDialog
          checkForUpdatesRequest={dialogs.checkForUpdatesRequest}
          open={dialogs.aboutOpen}
          renderTrigger={false}
          onOpenChange={dialogs.setAboutOpen}
        />
      </MountWhenOpened>
      {!viewer && (
        <MountWhenOpened open={dialogs.commandPaletteOpen}>
          <CommandPalette
            open={dialogs.commandPaletteOpen}
            commands={paletteCommands.commands}
            searchOnlyCommands={paletteCommands.toolCommands}
            search={paletteSearch}
            onOpenChange={dialogs.setCommandPaletteOpen}
          />
        </MountWhenOpened>
      )}
      {!viewer && (
        <MountWhenOpened open={dialogs.shortcutsOpen}>
          <KeyboardShortcutsDialog
            open={dialogs.shortcutsOpen}
            commands={allowedCommands}
            onOpenChange={dialogs.setShortcutsOpen}
          />
        </MountWhenOpened>
      )}
    </>
  );
}
