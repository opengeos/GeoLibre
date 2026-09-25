import { useAppStore } from "@geolibre/core";
import type { MapEngine } from "@geolibre/map";
import { addVectorFileToMap, prepareRasterControl } from "@geolibre/plugins";
import type { TFunction } from "i18next";
import {
  type Dispatch,
  type DragEvent,
  type RefObject,
  type SetStateAction,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { importGeoPackageDrops } from "../../lib/geopackage-drop";
import type { GeotaggedPhotoResult } from "../../lib/geotagged-photos";
import { isPhotoDropFileName } from "../../lib/photo-file-names";
import {
  addOsmPbfLayers,
  isOsmPbfFileName,
  loadOsmPbf,
  osmPbfBaseName,
  OsmPbfTooLargeError,
  OSM_PBF_SIZE_WARN_BYTES,
} from "../../lib/osm-pbf-loader";
import {
  isGeoLibreProjectFileName,
  isTauri,
  loadDroppedPhotoFiles,
  loadDroppedPhotoPaths,
  loadDroppedRasterFiles,
  loadDroppedRasterPaths,
  loadDroppedVectorFiles,
  loadDroppedVectorPaths,
  readLocalFileBytes,
  readLocalFileText,
  type DroppedRaster,
} from "../../lib/tauri-io";
import type { LayoutOptions } from "../useLayoutOptions";
import { createAppAPI } from "../usePlugins";
import type { useProjectFileActions } from "../useProjectFileActions";
import { confirmLargeVectorDataset, type ImportedVectorLayer } from "./file-import";

function hasDroppedFiles(event: DragEvent<HTMLElement>): boolean {
  return Array.from(event.dataTransfer.types).includes("Files");
}

interface FileDropOptions {
  layoutOptions: LayoutOptions;
  mapControllerRef: RefObject<MapEngine | null>;
  projectFilesRef: RefObject<ReturnType<typeof useProjectFileActions>>;
  setDropError: Dispatch<SetStateAction<string | null>>;
  setDropMessage: Dispatch<SetStateAction<string | null>>;
  setCrsWarning: Dispatch<SetStateAction<string | null>>;
  clearDropMessageLater: () => void;
  finishDrop: (
    importedLayers: ImportedVectorLayer[],
    rasterCount: number,
    containerCount?: number,
  ) => void;
  addDroppedRasters: (rasters: DroppedRaster[]) => Promise<number>;
  addDroppedPhotos: (result: GeotaggedPhotoResult | null) => number;
  t: TFunction;
}

/**
 * Drag-and-drop file import onto the shell: the webview drag handlers, the
 * Tauri native drop listener, and the drop overlay state.
 *
 * @param options - The layout (viewer/capability gate), the map engine, the
 *   project-file actions, the status setters, the add helpers, and `t`.
 * @returns Whether files are being dragged over the shell, and the drag handlers.
 */
export function useFileDrop({
  layoutOptions,
  mapControllerRef,
  projectFilesRef,
  setDropError,
  setDropMessage,
  setCrsWarning,
  clearDropMessageLater,
  finishDrop,
  addDroppedRasters,
  addDroppedPhotos,
  t,
}: FileDropOptions) {
  const dragDepthRef = useRef(0);
  const [isDraggingFiles, setIsDraggingFiles] = useState(false);
  const addGeoJsonLayer = useAppStore((s) => s.addGeoJsonLayer);

  // Dropping a file adds a layer to the project, so it belongs with the menus,
  // shortcuts, and command palette the viewer preset switches off — otherwise
  // drag and drop is a way back into authoring that the read-only chrome never
  // advertises. A deployment that withheld `data:add` closes the same door for
  // the same reason: hiding the Add Data menu means nothing if a file dragged
  // onto the map still loads (issue #1673). Both drop paths are gated: the
  // Tauri native listener here and the webview handlers below.
  const deploymentCapabilities = useAppStore((s) => s.deploymentCapabilities);
  const dropDisabled = layoutOptions.viewer || !deploymentCapabilities.has("data:add");

  useEffect(() => {
    if (!isTauri() || dropDisabled) return;

    let unlisten: (() => void) | null = null;
    let disposed = false;

    void import("@tauri-apps/api/webview").then(({ getCurrentWebview }) => {
      if (disposed) return;
      void getCurrentWebview()
        .onDragDropEvent(async (event) => {
          if (event.payload.type === "enter" || event.payload.type === "over") {
            setIsDraggingFiles(true);
            // Match the perceived speed of Add Raster Layer: that flow warms
            // the lazy raster control while its native picker is open. A map
            // drop otherwise starts all initialization only after release.
            // Fire-and-forget here so drag feedback never waits on imports.
            if (event.payload.type === "enter") {
              void prepareRasterControl(createAppAPI(mapControllerRef)).catch((error) => {
                console.warn("[GeoLibre] Could not prepare the raster drop handler", error);
              });
            }
            return;
          }

          if (event.payload.type === "leave") {
            setIsDraggingFiles(false);
            return;
          }

          setIsDraggingFiles(false);
          setDropError(null);
          // Matches the browser drop handler: a warning about a previous file
          // must not linger over an unrelated drop.
          setCrsWarning(null);
          setDropMessage("Importing data...");

          try {
            const paths = event.payload.paths;
            const projectPaths = paths.filter(isGeoLibreProjectFileName);
            if (projectPaths.length > 0) {
              if (!deploymentCapabilities.has("project:edit")) {
                throw new Error(t("toolbar.error.projectDropNotAllowed"));
              }
              if (paths.length !== 1) {
                throw new Error(t("toolbar.error.multipleProjectDrop"));
              }
              const projectPath = projectPaths[0];
              if (!projectPath) return;
              await projectFilesRef.current.handleDroppedProject(
                await readLocalFileText(projectPath),
                projectPath,
              );
              setDropMessage(null);
              return;
            }
            // OSM PBF files split into three layers, so they bypass the normal
            // single-FeatureCollection pipeline (which would otherwise route a
            // .pbf to DuckDB ST_Read and merge it).
            const pbfPaths = paths.filter((path) => isOsmPbfFileName(path));
            const otherPaths = paths.filter((path) => !isOsmPbfFileName(path));

            if (pbfPaths.length > 0) {
              const { readFile, stat } = await import("@tauri-apps/plugin-fs");
              for (const path of pbfPaths) {
                const name = path.split(/[/\\]/).pop() || "osm";
                try {
                  // Check the size via metadata before reading the file into
                  // memory, so the guard runs before a huge extract is loaded.
                  const { size } = await stat(path);
                  if (size >= OSM_PBF_SIZE_WARN_BYTES) {
                    const sizeMb = Math.round(size / (1024 * 1024));
                    // window.confirm is blocking and adequate here; note that a
                    // few webview builds may suppress JS dialogs, in which case
                    // it returns false and the file is skipped.
                    if (
                      !window.confirm(
                        `${name} is about ${sizeMb} MB. Parsing it may use a lot of memory. Continue?`,
                      )
                    ) {
                      continue;
                    }
                  }
                  setDropMessage(`Parsing ${name}…`);
                  const bytes = await readFile(path);
                  // Guard against a subview Uint8Array: .buffer would include
                  // extra bytes and corrupt the parse, so slice to the exact view.
                  const buffer =
                    bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
                      ? (bytes.buffer as ArrayBuffer)
                      : (bytes.buffer.slice(
                          bytes.byteOffset,
                          bytes.byteOffset + bytes.byteLength,
                        ) as ArrayBuffer);
                  const layers = await loadOsmPbf(buffer);
                  const added = addOsmPbfLayers(
                    addGeoJsonLayer,
                    osmPbfBaseName(name),
                    path,
                    layers,
                  );
                  if (added > 0 && layers.bounds) {
                    mapControllerRef.current?.fitBounds(layers.bounds);
                  }
                  setDropMessage(
                    added > 0
                      ? `Added ${added} layer${added === 1 ? "" : "s"} from ${name}.`
                      : `No features found in ${name}.`,
                  );
                } catch (err) {
                  // Isolate per-file failures so one bad PBF doesn't abandon the
                  // rest of the drop.
                  setDropMessage(null);
                  setDropError(
                    err instanceof OsmPbfTooLargeError
                      ? t("toolbar.error.osmPbfTooLarge")
                      : `Could not parse ${name}: ${
                          err instanceof Error ? err.message : String(err)
                        }`,
                  );
                }
              }
            }

            // Geotagged photos become their own point layer; TIFF stays on the
            // raster path. Handle them before the vector/raster pipeline so a
            // dropped .jpg isn't routed to the DuckDB vector loader.
            const photoResult = await loadDroppedPhotoPaths(otherPaths);
            const photoCount = addDroppedPhotos(photoResult);
            // Surface a clear message when every dropped photo lacked GPS, so
            // the drop doesn't complete silently.
            if (photoResult && photoCount === 0 && photoResult.total > 0) {
              setDropError(t("addData.photos.errorNoGps", { count: photoResult.total }));
            }
            const restPaths = otherPaths.filter((path) => !isPhotoDropFileName(path));

            if (restPaths.length > 0) {
              const rasterCount = await addDroppedRasters(await loadDroppedRasterPaths(restPaths));
              const containers = await importGeoPackageDrops(restPaths, {
                readPath: readLocalFileBytes,
                addFile: (file, sourcePath) =>
                  addVectorFileToMap(createAppAPI(mapControllerRef), file, {
                    sourcePath,
                  }),
                onError: (name, error) =>
                  setDropError(
                    `${name}: ${error instanceof Error ? error.message : String(error)}`,
                  ),
              });
              const importedLayers = await loadDroppedVectorPaths(containers.remaining, {
                onLargeDataset: confirmLargeVectorDataset,
              });
              // See the browser handler: skip finishDrop's empty-input error
              // when PBF or photo files were present (even if rejected/failed).
              // See the browser handler: suppress the empty-input error when
              // photos were present so it can't clobber the GPS error above.
              if (
                importedLayers.length > 0 ||
                rasterCount > 0 ||
                containers.layerCount > 0 ||
                (pbfPaths.length === 0 && photoResult === null && containers.count === 0)
              ) {
                finishDrop(importedLayers, rasterCount, containers.layerCount);
              } else if (pbfPaths.length === 0 && photoResult === null) {
                setDropMessage(null);
              }
            }
          } catch (error) {
            setDropMessage(null);
            setDropError(error instanceof Error ? error.message : "Could not import files.");
          } finally {
            clearDropMessageLater();
          }
        })
        .then((nextUnlisten) => {
          if (disposed) {
            nextUnlisten();
          } else {
            unlisten = nextUnlisten;
          }
        })
        .catch((error) => {
          console.warn("Could not attach Tauri drag and drop handler", error);
        });
    });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [
    clearDropMessageLater,
    finishDrop,
    addDroppedRasters,
    addDroppedPhotos,
    addGeoJsonLayer,
    deploymentCapabilities,
    dropDisabled,
    t,
    mapControllerRef,
    projectFilesRef,
    setCrsWarning,
    setDropError,
    setDropMessage,
  ]);

  const handleDragEnter = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      if (dropDisabled || !hasDroppedFiles(event)) return;
      event.preventDefault();
      dragDepthRef.current += 1;
      setIsDraggingFiles(true);
    },
    [dropDisabled],
  );

  const handleDragOver = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      // Leaving the default action in place makes the browser refuse the drop,
      // so the overlay never appears and nothing is imported. A drop we will
      // *not* import still has to be cancelled here, though: the browser's own
      // default is to navigate the tab to the dropped file, which would take a
      // viewer or a locked-down kiosk out of the app entirely. Cancel either
      // way, and say so with the cursor.
      if (!hasDroppedFiles(event)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = dropDisabled ? "none" : "copy";
    },
    [dropDisabled],
  );

  const handleDragLeave = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      if (dropDisabled || !hasDroppedFiles(event)) return;
      event.preventDefault();
      dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
      if (dragDepthRef.current === 0) setIsDraggingFiles(false);
    },
    [dropDisabled],
  );

  const handleDrop = useCallback(
    async (event: DragEvent<HTMLDivElement>) => {
      if (!hasDroppedFiles(event)) return;
      // Cancel before the capability check, for the same reason as dragover:
      // an uncancelled drop navigates away from the app.
      event.preventDefault();
      if (dropDisabled) return;
      dragDepthRef.current = 0;
      setIsDraggingFiles(false);
      setDropError(null);
      // Not auto-dismissed on the status timeout (it has its own Close button),
      // so it is cleared here instead: a warning about a previous file must not
      // linger over an unrelated drop.
      setCrsWarning(null);
      setDropMessage("Importing data...");

      try {
        const allFiles = Array.from(event.dataTransfer.files);
        const projectFilesInDrop = allFiles.filter((file) => isGeoLibreProjectFileName(file.name));
        if (projectFilesInDrop.length > 0) {
          if (!deploymentCapabilities.has("project:edit")) {
            throw new Error(t("toolbar.error.projectDropNotAllowed"));
          }
          if (allFiles.length !== 1) {
            throw new Error(t("toolbar.error.multipleProjectDrop"));
          }
          const projectFile = projectFilesInDrop[0];
          if (!projectFile) return;
          await projectFilesRef.current.handleDroppedProject(await projectFile.text(), null);
          setDropMessage(null);
          return;
        }
        // OSM PBF files produce three separate layers (points/lines/polygons),
        // so they bypass the single-FeatureCollection vector drop pipeline.
        // Handle them first, then run the rest through the normal pipeline —
        // finishDrop throws on an empty list, so only call it when non-PBF
        // files were dropped.
        const pbfFiles = allFiles.filter((file) => isOsmPbfFileName(file.name));
        const otherFiles = allFiles.filter((file) => !isOsmPbfFileName(file.name));

        for (const file of pbfFiles) {
          // Mirror the file-picker path's large-file guard (parsing a huge
          // extract can exhaust memory even off the main thread).
          if (file.size >= OSM_PBF_SIZE_WARN_BYTES) {
            const sizeMb = Math.round(file.size / (1024 * 1024));
            if (
              !window.confirm(
                `${file.name} is about ${sizeMb} MB. Parsing it may use a lot of memory. Continue?`,
              )
            ) {
              continue;
            }
          }
          setDropMessage(`Parsing ${file.name}…`);
          let layers;
          try {
            layers = await loadOsmPbf(await file.arrayBuffer());
          } catch (err) {
            // Isolate per-file failures so one bad PBF doesn't abandon the rest
            // of the drop (including any co-dropped non-PBF files).
            setDropMessage(null);
            setDropError(
              err instanceof OsmPbfTooLargeError
                ? t("toolbar.error.osmPbfTooLarge")
                : `Could not parse ${file.name}: ${
                    err instanceof Error ? err.message : String(err)
                  }`,
            );
            continue;
          }
          const added = addOsmPbfLayers(
            addGeoJsonLayer,
            osmPbfBaseName(file.name),
            file.name,
            layers,
          );
          if (added > 0 && layers.bounds) {
            mapControllerRef.current?.fitBounds(layers.bounds);
          }
          setDropMessage(
            added > 0
              ? `Added ${added} layer${added === 1 ? "" : "s"} from ${file.name}.`
              : `No features found in ${file.name}.`,
          );
        }

        // Geotagged photos (JPEG/PNG/WebP/HEIC) become a single point layer of
        // their own; TIFF is left to the raster path. Handle them before the
        // vector/raster pipeline so a .jpg isn't sent to the DuckDB vector
        // loader (which would fail).
        const photoResult = await loadDroppedPhotoFiles(otherFiles);
        const photoCount = addDroppedPhotos(photoResult);
        // Surface a clear message when every dropped photo lacked GPS, so the
        // drop doesn't complete silently.
        if (photoResult && photoCount === 0 && photoResult.total > 0) {
          setDropError(t("addData.photos.errorNoGps", { count: photoResult.total }));
        }
        const restFiles = otherFiles.filter((file) => !isPhotoDropFileName(file.name));

        if (restFiles.length > 0) {
          const rasterCount = await addDroppedRasters(loadDroppedRasterFiles(restFiles));
          // Use the Add Data control so containers share its layer picker,
          // per-table source metadata, and grouped import behavior.
          const containers = await importGeoPackageDrops(restFiles, {
            readPath: readLocalFileBytes,
            addFile: (file, sourcePath) =>
              addVectorFileToMap(createAppAPI(mapControllerRef), file, {
                sourcePath,
              }),
            onError: (name, error) =>
              setDropError(`${name}: ${error instanceof Error ? error.message : String(error)}`),
          });
          const importedLayers = await loadDroppedVectorFiles(containers.remaining, {
            onLargeDataset: confirmLargeVectorDataset,
          });
          // Call finishDrop (which reports success or throws the empty-input
          // error) only when the other files produced something, or when the
          // drop contained no PBF/photo files at all. If those were present —
          // even if they were all rejected or failed — its empty-input error
          // would wrongly clobber their outcome.
          // Suppress finishDrop's empty-input error whenever photos were
          // present (photoResult !== null) — even if all lacked GPS — so its
          // generic message can't clobber the specific GPS error set above.
          if (
            importedLayers.length > 0 ||
            rasterCount > 0 ||
            containers.layerCount > 0 ||
            (pbfFiles.length === 0 && photoResult === null && containers.count === 0)
          ) {
            finishDrop(importedLayers, rasterCount, containers.layerCount);
          } else if (pbfFiles.length === 0 && photoResult === null) {
            setDropMessage(null);
          }
        }
      } catch (error) {
        setDropMessage(null);
        setDropError(error instanceof Error ? error.message : "Could not import files.");
      } finally {
        clearDropMessageLater();
      }
    },
    [
      clearDropMessageLater,
      finishDrop,
      addDroppedRasters,
      addDroppedPhotos,
      addGeoJsonLayer,
      deploymentCapabilities,
      dropDisabled,
      t,
      mapControllerRef,
      projectFilesRef,
      setCrsWarning,
      setDropError,
      setDropMessage,
    ],
  );

  // Escape hatch for a drop overlay that outlived its drag (issue #1664).
  //
  // The overlay is driven by one boolean fed from two places: the webview drag
  // handlers above (balanced by dragDepthRef) and, on desktop, Tauri's native
  // onDragDropEvent (no counter at all, since the OS reports enter/leave/drop
  // directly). Either feed can strand it. A native "leave" that never arrives
  // — which is what a modal native file dialog opening mid-drag produces on
  // WebKitGTK — leaves the flag set with nothing left to clear it, and an
  // unbalanced webview enter/leave pair leaves dragDepthRef above zero, which
  // has the same effect. The result is an overlay covering the map until the
  // user happens to drag another file across the window.
  //
  // Rather than guess at every way the OS can swallow an event, recover on a
  // pointer button, which cannot occur while a real drag is in progress: HTML
  // drag-and-drop suppresses mouse events and a native drag holds an OS pointer
  // grab. Escape is a separate, conventional request to cancel either the
  // stranded overlay or a genuine drag.
  useEffect(() => {
    if (!isDraggingFiles) return;

    const clear = () => {
      dragDepthRef.current = 0;
      setIsDraggingFiles(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      // Escape is the one the reporter reached for first; any key would do, but
      // limiting it keeps typing in a panel from silently cancelling feedback
      // for a drag that is genuinely still running.
      if (event.key === "Escape") clear();
    };

    // Capture phase, not bubble: several controls in the app stop propagation
    // on these events before they reach window (startLayerPanelResize below is
    // one, and a focused Radix dialog handles its own Escape), which would
    // silently defeat the recovery for exactly the interaction the user is most
    // likely to try first. Capturing on window runs before any of them.
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("pointerdown", clear, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("pointerdown", clear, true);
    };
  }, [isDraggingFiles]);

  return { handleDragEnter, handleDragLeave, handleDragOver, handleDrop, isDraggingFiles };
}
