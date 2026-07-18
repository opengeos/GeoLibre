import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  addOsmPbfLayers,
  loadOsmPbf,
  osmPbfBaseName,
  OsmPbfTooLargeError,
  OSM_PBF_SIZE_WARN_BYTES,
  type OsmPbfProgress,
} from "../lib/osm-pbf-loader";
import { isHttpUrl, openLocalDataFileWithFallback } from "../lib/tauri-io";
import { type AppApi } from "../components/layout/toolbar/constants";

/** A pending large-file confirmation before parsing an OSM PBF extract. */
export interface OsmPbfConfirm {
  data: ArrayBuffer;
  baseName: string;
  sourcePath: string;
  sizeMb: number;
}

/**
 * Manages the OSM PBF "Add Data" flow: the URL/file dialog, the large-file
 * confirmation, the in-flight parse (abortable), and adding the parsed layers.
 *
 * @param appApi - The live app API used to add layers and fetch buffers.
 * @param setActionError - Setter for the shared toolbar error dialog.
 * @returns Dialog state and handlers consumed by the toolbar.
 */
export function useOsmPbfLoader(appApi: AppApi, setActionError: (message: string | null) => void) {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState<OsmPbfProgress | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [confirm, setConfirm] = useState<OsmPbfConfirm | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const runOsmPbf = async (data: ArrayBuffer, baseName: string, sourcePath: string) => {
    // Reuse a controller already started for the URL fetch, else make one, so
    // the loading dialog's Cancel/dismiss can abort the in-flight parse.
    const controller = abortRef.current ?? new AbortController();
    abortRef.current = controller;
    if (controller.signal.aborted) {
      abortRef.current = null;
      setLoading(false);
      return;
    }
    setLoading(true);
    setProgress(null);
    try {
      const layers = await loadOsmPbf(data, controller.signal, setProgress);
      const added = addOsmPbfLayers(appApi.addGeoJsonLayer, baseName, sourcePath, layers);
      if (added === 0) {
        setActionError(t("toolbar.error.osmPbfNoFeatures"));
      } else if (layers.bounds) {
        appApi.fitBounds?.(layers.bounds);
      }
    } catch (err) {
      // A user cancel (abort) is not an error.
      if (err instanceof DOMException && err.name === "AbortError") return;
      // A timeout or worker OOM means the extract is too big for the browser;
      // point the user at pre-filtering instead of the generic parse hint.
      if (err instanceof OsmPbfTooLargeError) {
        setActionError(t("toolbar.error.osmPbfTooLarge"));
        return;
      }
      const base = err instanceof Error ? err.message : t("toolbar.error.couldNotLoadOsmPbf");
      // Bare .pbf is also the Mapbox Vector Tile extension; hint at it on
      // failure. The message + hint live in one catalog key so each locale
      // controls how the two sentences join (e.g. no space in CJK).
      setActionError(t("toolbar.error.osmPbfLoadFailedWithHint", { message: base }));
    } finally {
      setLoading(false);
      setProgress(null);
      if (abortRef.current === controller) abortRef.current = null;
    }
  };

  const cancel = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    setLoading(false);
    setProgress(null);
  };

  // Large extracts can exhaust browser memory; confirm before parsing.
  const startOsmPbf = (data: ArrayBuffer, baseName: string, sourcePath: string) => {
    if (data.byteLength >= OSM_PBF_SIZE_WARN_BYTES) {
      setConfirm({
        data,
        baseName,
        sourcePath,
        sizeMb: Math.round(data.byteLength / (1024 * 1024)),
      });
      return;
    }
    void runOsmPbf(data, baseName, sourcePath);
  };

  const handleChooseFile = async () => {
    setDialogOpen(false);
    try {
      const result = await openLocalDataFileWithFallback({
        filters: [{ name: "OSM PBF", extensions: ["pbf", "osm.pbf"] }],
        accept: ".pbf,.osm.pbf",
        readBinary: true,
      });
      if (!result?.data) return;
      const fileName = result.path.split(/[/\\]/).pop() || "osm";
      startOsmPbf(result.data, osmPbfBaseName(fileName), result.path);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : t("toolbar.error.couldNotOpenOsmPbf"));
    }
  };

  const handleLoadUrl = async () => {
    const trimmedUrl = url.trim();
    if (!isHttpUrl(trimmedUrl)) {
      setActionError(t("toolbar.error.invalidOsmPbfUrl"));
      return;
    }
    setDialogOpen(false);
    // Start the controller before the fetch so a dismiss during download is
    // honored (the download itself isn't abortable through the shared fetcher,
    // but we drop the result instead of parsing/adding it).
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    try {
      const data = await appApi.fetchArrayBuffer?.(trimmedUrl);
      if (controller.signal.aborted) return;
      // Surface the user-facing message directly rather than throwing a
      // translated Error — Error.message also feeds error boundaries and logs,
      // which should stay locale-independent. The catch below still covers a
      // genuine fetch failure.
      if (!data) {
        setLoading(false);
        if (abortRef.current === controller) abortRef.current = null;
        setActionError(t("toolbar.error.couldNotDownloadOsmPbf"));
        return;
      }
      const fileName = trimmedUrl.split("/").pop()?.split("?")[0].split("#")[0] || "osm";
      // Keep the loading indicator up through the parse for small files
      // (runOsmPbf re-sets it and clears it in finally); only stop it here when
      // a large file will instead show the confirm dialog, to avoid a flicker.
      if (data.byteLength >= OSM_PBF_SIZE_WARN_BYTES) setLoading(false);
      startOsmPbf(data, osmPbfBaseName(fileName), trimmedUrl);
    } catch (err) {
      setLoading(false);
      if (abortRef.current === controller) abortRef.current = null;
      setActionError(
        err instanceof Error ? err.message : t("toolbar.error.couldNotDownloadOsmPbf"),
      );
    }
  };

  // Run a confirmed large-file parse and clear the confirmation.
  const runConfirmed = () => {
    const pending = confirm;
    setConfirm(null);
    if (pending) {
      void runOsmPbf(pending.data, pending.baseName, pending.sourcePath);
    }
  };

  return {
    loading,
    progress,
    dialogOpen,
    setDialogOpen,
    url,
    setUrl,
    confirm,
    setConfirm,
    // True while a load is in flight or a large-file confirm is pending; used to
    // disable the Add Data menu entry.
    busy: loading || confirm !== null,
    handleChooseFile,
    handleLoadUrl,
    cancel,
    runConfirmed,
  };
}
