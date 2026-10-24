import { shouldZoomToNewLayers, useAppStore } from "@geolibre/core";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { createLayerId } from "../components/layout/add-data/helpers";
import { type AppApi } from "../components/layout/toolbar/constants";
import { createTilePackageLayer, openTilePackage, releaseTilePackage } from "../lib/tilepackage";
import { isHttpUrl } from "../lib/tauri-io";

/**
 * Ask the user for a local file. The file is handed back as a `File` and read
 * lazily by `File.slice`, rather than through the data-file picker, which reads
 * the whole file into memory: tile packages run to gigabytes, and the reader
 * only ever needs the directory and the few tiles on screen.
 */
function pickLocalFile(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.onchange = () => resolve(input.files?.[0] ?? null);
    // `change` never fires when the dialog is dismissed.
    input.addEventListener("cancel", () => resolve(null));
    input.click();
  });
}

/**
 * Manages the ArcGIS tile package "Add Data" flow: the URL/file dialog, the
 * in-flight open (cancellable), and adding the resulting layer.
 *
 * @param appApi - The live app API used to fit the map to the new layer.
 * @param setActionError - Setter for the shared toolbar error dialog.
 * @returns Dialog state and handlers consumed by the toolbar.
 */
export function useTilePackageLoader(
  appApi: AppApi,
  setActionError: (message: string | null) => void,
) {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [url, setUrl] = useState("");
  // Bumped by every open and every cancel: a result whose number is stale was
  // dismissed (or superseded) and must not add a layer or surface an error.
  const attempt = useRef(0);

  const open = async (input: string | File) => {
    const mine = ++attempt.current;
    setLoading(true);
    try {
      const opened = await openTilePackage(input);
      if (mine !== attempt.current) {
        // Dismissed while opening: nothing will ever use it.
        releaseTilePackage(opened.key);
        return;
      }
      let layer;
      try {
        layer = createTilePackageLayer(opened, createLayerId());
      } catch (err) {
        releaseTilePackage(opened.key);
        throw err;
      }
      useAppStore.getState().addLayer(layer);
      const bounds = layer.source.bounds as [number, number, number, number] | undefined;
      if (bounds && shouldZoomToNewLayers()) appApi.fitBounds?.(bounds);
    } catch (err) {
      if (mine !== attempt.current) return;
      setActionError(
        err instanceof Error && err.message
          ? t("toolbar.error.vtpkLoadFailedWithMessage", { message: err.message })
          : t("toolbar.error.couldNotLoadVtpk"),
      );
    } finally {
      if (mine === attempt.current) setLoading(false);
    }
  };

  const cancel = () => {
    attempt.current += 1;
    setLoading(false);
  };

  const handleChooseFile = async () => {
    setDialogOpen(false);
    try {
      const file = await pickLocalFile(".vtpk,.tpkx");
      if (file) await open(file);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : t("toolbar.error.couldNotOpenVtpk"));
    }
  };

  const handleLoadUrl = async () => {
    const trimmedUrl = url.trim();
    if (!isHttpUrl(trimmedUrl)) {
      setActionError(t("toolbar.error.invalidVtpkUrl"));
      return;
    }
    setDialogOpen(false);
    await open(trimmedUrl);
  };

  return {
    loading,
    dialogOpen,
    setDialogOpen,
    url,
    setUrl,
    // True while a package is opening; used to disable the Add Data menu entry.
    busy: loading,
    handleChooseFile,
    handleLoadUrl,
    cancel,
  };
}
