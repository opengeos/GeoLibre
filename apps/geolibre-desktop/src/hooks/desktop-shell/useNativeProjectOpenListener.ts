import { useEffect, type RefObject } from "react";
import { listenForNativeProjectOpen } from "../../lib/native-project-open";
import type { useProjectFileActions } from "../useProjectFileActions";

/**
 * Opens projects the OS hands the desktop app (file association, second launch).
 *
 * @param projectFilesRef - The shell's shared project-file actions.
 */
export function useNativeProjectOpenListener(
  projectFilesRef: RefObject<ReturnType<typeof useProjectFileActions>>,
): void {
  useEffect(() => {
    let disposed = false;
    let stopListening: (() => void) | null = null;
    void listenForNativeProjectOpen((path) => projectFilesRef.current.handleNativeProjectOpen(path))
      .then((unlisten) => {
        if (disposed) unlisten();
        else stopListening = unlisten;
      })
      .catch((error: unknown) => {
        console.error("[GeoLibre] Could not listen for opened project files", error);
      });
    return () => {
      disposed = true;
      stopListening?.();
    };
  }, [projectFilesRef]);
}
