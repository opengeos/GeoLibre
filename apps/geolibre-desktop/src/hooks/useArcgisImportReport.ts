import { useAppStore } from "@geolibre/core";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ArcgisProjectImportWarning } from "../lib/arcgis-project-import";
import {
  arcgisRepairGroups,
  commitLocatedArcgisLayers,
  readLocatedArcgisLayers,
  withoutLocatedWarnings,
  type ArcgisRepairGroup,
  type ArcgisWorkspaceRepairSession,
} from "../lib/arcgis-workspace-repair";
import { readLocalVectorFeatures } from "../lib/restore-local-layers";
import { isAbsoluteLocalPath, listDirectory, pickLocalDirectory } from "../lib/tauri-io";

/** What the last Locate folder of an ArcGIS Pro import did. */
export interface ArcgisRepairResult {
  /** The folder the user picked. */
  folder: string;
  /** Layers added from it. */
  restored: number;
  /** Layers of the same workspace still not loaded. */
  remaining: number;
  /** The folder is not on a local or mapped drive, which a saved project cannot reopen from. */
  networkFolder?: boolean;
}

/** The ArcGIS Pro import report and its Locate folder step. */
export interface ArcgisImportReport {
  /** Warnings to show, or null while the report is closed. */
  warnings: ArcgisProjectImportWarning[] | null;
  /** Saved folders whose layers a Locate folder can still add. */
  repairGroups: ArcgisRepairGroup[];
  /** A Locate folder is in progress. */
  repairBusy: boolean;
  repairResult: ArcgisRepairResult | null;
  /**
   * Open the report for the project an import just loaded, unless it has
   * nothing to say.
   *
   * @param warnings - The import's warnings.
   * @param repair - Layers a Locate folder can still add, if any.
   */
  show: (
    warnings: ArcgisProjectImportWarning[],
    repair: ArcgisWorkspaceRepairSession | null,
  ) => void;
  /** Close the report, ending any Locate folder it offered. */
  close: () => void;
  /**
   * Ask for the folder that now holds one saved workspace, and add the layers
   * of that workspace found there.
   *
   * @param key - The workspace's {@link ArcgisRepairGroup.key}.
   */
  locate: (key: string) => Promise<void>;
}

/**
 * State of the ArcGIS Pro import report. The report belongs to the project
 * the import loaded: once another project replaces it (`projectLoadCount`
 * changes) the report closes, and a Locate that was running adds nothing. A
 * collaboration snapshot refreshing the same project leaves it open.
 *
 * @param onError - Shows an unexpected Locate failure.
 */
export function useArcgisImportReport(onError: (message: string) => void): ArcgisImportReport {
  const [warnings, setWarnings] = useState<ArcgisProjectImportWarning[] | null>(null);
  const [repairGroups, setRepairGroups] = useState<ArcgisRepairGroup[]>([]);
  const [repairBusy, setRepairBusy] = useState(false);
  const [repairResult, setRepairResult] = useState<ArcgisRepairResult | null>(null);
  const repairRef = useRef<ArcgisWorkspaceRepairSession | null>(null);
  // `projectLoadCount` of the project the open report describes.
  const reportLoadCountRef = useRef<number | null>(null);
  // Set synchronously, so a second click before the busy state renders does
  // not open a second picker.
  const busyRef = useRef(false);
  const projectLoadCount = useAppStore((s) => s.projectLoadCount);

  const close = useCallback(() => {
    repairRef.current = null;
    reportLoadCountRef.current = null;
    setWarnings(null);
    setRepairGroups([]);
    setRepairResult(null);
  }, []);

  useEffect(() => {
    const shown = reportLoadCountRef.current;
    if (shown !== null && shown !== projectLoadCount) close();
  }, [projectLoadCount, close]);

  const show = useCallback<ArcgisImportReport["show"]>((nextWarnings, repair) => {
    const ownRepair = repair && repair.pending.size > 0 ? repair : null;
    repairRef.current = ownRepair;
    reportLoadCountRef.current = useAppStore.getState().projectLoadCount;
    setRepairGroups(ownRepair ? arcgisRepairGroups(ownRepair) : []);
    setRepairResult(null);
    setWarnings(nextWarnings.length > 0 || ownRepair ? nextWarnings : null);
  }, []);

  const locate = useCallback(
    async (key: string) => {
      const session = repairRef.current;
      if (!session || busyRef.current) return;
      const group = arcgisRepairGroups(session).find((entry) => entry.key === key);
      if (!group) return;
      const current = () =>
        repairRef.current === session &&
        useAppStore.getState().projectLoadCount === session.projectLoadCount;
      busyRef.current = true;
      setRepairBusy(true);
      setRepairResult(null);
      try {
        const folder = await pickLocalDirectory();
        if (!folder || !current()) return;
        // A network share can be read now, but a saved project never reopens
        // from one (`isAbsoluteLocalPath` rejects UNC paths), so its layers
        // would be lost on the next open.
        if (!isAbsoluteLocalPath(folder)) {
          setRepairResult({
            folder,
            restored: 0,
            remaining: group.layerIds.length,
            networkFolder: true,
          });
          return;
        }
        const listing = await listDirectory(folder)
          .then((entries) =>
            entries.filter((entry) => !entry.isDirectory).map((entry) => entry.name),
          )
          .catch(() => null);
        if (!current()) return;
        const restored = await readLocatedArcgisLayers(
          session,
          key,
          folder,
          listing,
          readLocalVectorFeatures,
        );
        // The layers belong to the project the import loaded; once another
        // replaced it (which also closed this report) they go nowhere.
        if (!current()) return;
        const added = new Set(commitLocatedArcgisLayers(session, restored, useAppStore.getState));
        const remaining = group.layerIds.filter((id) => session.pending.has(id)).length;
        setWarnings((previous) => withoutLocatedWarnings(previous ?? [], added));
        setRepairGroups(arcgisRepairGroups(session));
        setRepairResult({ folder, restored: added.size, remaining });
      } catch (error) {
        // A failure that belongs to a replaced project is not this one's to show.
        if (!current()) return;
        console.error("Failed to locate ArcGIS project data", error);
        onError(error instanceof Error ? error.message : String(error));
      } finally {
        busyRef.current = false;
        setRepairBusy(false);
      }
    },
    [onError],
  );

  return { warnings, repairGroups, repairBusy, repairResult, show, close, locate };
}
