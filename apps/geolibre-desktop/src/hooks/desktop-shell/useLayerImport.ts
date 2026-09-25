import { detectNonGeographicCoordinates, useAppStore } from "@geolibre/core";
import type { MapEngine } from "@geolibre/map";
import { getLayerBounds } from "@geolibre/map";
import { addRasterToMap, setKmlFileImportHandler, TIME_SLIDER_PLUGIN_ID } from "@geolibre/plugins";
import type { TFunction } from "i18next";
import { type Dispatch, type RefObject, type SetStateAction, useCallback, useEffect } from "react";
import type { GeotaggedPhotoResult } from "../../lib/geotagged-photos";
import { buildKmlModelLayer } from "../../lib/kml-model-layer";
import {
  isLoadedImageOverlay,
  isLoadedKmlSuperOverlay,
  isLoadedModel,
  isRasterFileName,
  loadDroppedRasterPaths,
  loadDroppedVectorFiles,
  loadDroppedVectorPaths,
  type DroppedRaster,
} from "../../lib/tauri-io";
import { createAppAPI, usePluginRegistry } from "../usePlugins";
import {
  confirmLargeVectorDataset,
  type ImportedVectorLayer,
  layerNameFromPath,
} from "./file-import";

interface LayerImportOptions {
  mapControllerRef: RefObject<MapEngine | null>;
  setDropError: Dispatch<SetStateAction<string | null>>;
  setDropMessage: Dispatch<SetStateAction<string | null>>;
  setCrsWarning: Dispatch<SetStateAction<string | null>>;
  t: TFunction;
}

/**
 * Adds loaded vector, raster and photo files to the project, shared by the
 * drag-and-drop paths, the KML import handler and the Browser panel's Files tree.
 *
 * @param options - The map engine, the status setters, and `t`.
 * @returns The add helpers the drop handlers and the Browser panel call.
 */
export function useLayerImport({
  mapControllerRef,
  setDropError,
  setDropMessage,
  setCrsWarning,
  t,
}: LayerImportOptions) {
  const addImageOverlayLayer = useAppStore((s) => s.addImageOverlayLayer);
  const addTileLayer = useAppStore((s) => s.addTileLayer);
  const addLayerGroup = useAppStore((s) => s.addLayerGroup);
  const moveLayerGroupToGroup = useAppStore((s) => s.moveLayerGroupToGroup);
  const moveLayerToGroup = useAppStore((s) => s.moveLayerToGroup);
  const { isActive: isPluginActive, toggle: togglePlugin } = usePluginRegistry();
  const addLayer = useAppStore((s) => s.addLayer);
  const addGeoJsonLayer = useAppStore((s) => s.addGeoJsonLayer);

  const addImportedVectorLayers = useCallback(
    (importedLayers: ImportedVectorLayer[]) => {
      let lastLayerId: string | null = null;
      // Layers whose coordinates cannot be WGS84; surfaced together after the
      // loop so a multi-file drop reports once rather than per file.
      const nonGeographic: string[] = [];
      // Frame ids for each time-animated overlay sequence (keyed by the loader's
      // group marker), so they can be gathered into one layer group afterward.
      const frameGroups = new Map<string, string[]>();
      // The same for time-tagged KML placemark layers outside any Folder.
      const placemarkFrameGroups = new Map<string, { name: string; ids: string[] }>();
      // KML Folder ancestry becomes nested GeoLibre groups. Prefix keys with
      // the source path so identically named folders from separate files do not
      // get combined when several files are imported in one batch.
      const kmlGroups = new Map<string, string>();
      // GeoJSON layer ids contributed by each source file. A folder-aware KML
      // splits into one layer per placemark, so the final fit needs every id
      // from that file to frame the whole import rather than one placemark.
      const layerIdsBySource = new Map<string, string[]>();
      // Tracked across every record kind (not just the GeoJSON ones) so a file
      // whose placemarks are followed by an overlay or model is still
      // recognized as the last source imported.
      let lastSourcePath: string | null = null;
      // Whether any time-tagged KML placemark layer was added, so the Time
      // Slider opens even when every frame already sits in a KML Folder group.
      let hasVectorTimeFrames = false;
      for (const layer of importedLayers) {
        if (layer.path) lastSourcePath = layer.path;
        if (isLoadedKmlSuperOverlay(layer)) {
          lastLayerId = addTileLayer(layer.name || layerNameFromPath(layer.path), {
            tiles: [layer.url],
            type: "xyz",
            tileSize: layer.tileSize,
            bounds: layer.bounds,
            minzoom: layer.minzoom,
            maxzoom: layer.maxzoom,
            metadata: {
              sourceKind: "kml-super-overlay",
              bounds: layer.bounds,
            },
          });
          continue;
        }
        // A KML/KMZ ground overlay becomes an image layer, not a vector one.
        if (isLoadedImageOverlay(layer)) {
          lastLayerId = addImageOverlayLayer(
            // `||` (not `??`) so an empty name falls back to the path, matching
            // the vector branch and the drop toast.
            layer.name || layerNameFromPath(layer.path),
            { url: layer.url, coordinates: layer.coordinates },
            {
              opacity: layer.opacity,
              bounds: layer.bounds,
              sourcePath: layer.path,
              ...(layer.timeSpan ? { timeSpan: layer.timeSpan } : {}),
              ...(layer.visible === false ? { visible: false } : {}),
            },
          );
          if (layer.groupId) {
            const ids = frameGroups.get(layer.groupId) ?? [];
            ids.push(lastLayerId);
            frameGroups.set(layer.groupId, ids);
          }
          continue;
        }
        // A KML/KMZ <Model> becomes a deck.gl scenegraph layer.
        if (isLoadedModel(layer)) {
          const modelLayer = buildKmlModelLayer(layer);
          addLayer(modelLayer);
          lastLayerId = modelLayer.id;
          continue;
        }
        // `||` (not `??`) so an empty-string name falls back to the path, and
        // matches the name shown in the drop confirmation toast.
        const layerName = layer.name || layerNameFromPath(layer.path);
        // A file that declares WGS84 but holds projected coordinates loads
        // cleanly, lists in the Layers panel, and renders nowhere — the map
        // simply never moves. Warn rather than fail: the data is readable and
        // only the user knows its true CRS.
        const offRange = detectNonGeographicCoordinates(layer.data);
        if (offRange) {
          nonGeographic.push(layerName);
          console.warn(
            `[GeoLibre] "${layerName}" declares geographic coordinates but its values are out of range ` +
              `(max |x| ${Math.round(offRange.maxAbsX).toLocaleString()}, max |y| ${Math.round(
                offRange.maxAbsY,
              ).toLocaleString()} ` +
              `over ${offRange.sampled.toLocaleString()} sampled coordinates). The file's CRS is almost certainly ` +
              `mislabelled — reproject it, or correct its .prj/crs, and load it again.`,
          );
        }
        lastLayerId = addGeoJsonLayer(layerName, layer.data, layer.path);
        // Time-tagged KML placemarks are Time Slider frames, animated through
        // the same `metadata.timeSpan` visibility toggling as ground overlays.
        if (layer.timeSpan) {
          const frameId = lastLayerId;
          // `addGeoJsonLayer` starts every layer with empty metadata.
          useAppStore.getState().updateLayer(frameId, {
            metadata: { timeSpan: layer.timeSpan },
            ...(layer.visible === false ? { visible: false } : {}),
          });
          hasVectorTimeFrames = true;
          // Frames outside any KML Folder are gathered into one group named
          // after their file below; foldered frames already sit in their
          // Folder groups.
          if (layer.groupId && !layer.groupPath?.length) {
            const group = placemarkFrameGroups.get(layer.groupId) ?? {
              name: layerNameFromPath(layer.path),
              ids: [],
            };
            group.ids.push(frameId);
            placemarkFrameGroups.set(layer.groupId, group);
          }
        }
        if (layer.path) {
          const sourceIds = layerIdsBySource.get(layer.path) ?? [];
          sourceIds.push(lastLayerId);
          layerIdsBySource.set(layer.path, sourceIds);
        }
        if (layer.groupPath?.length) {
          let parentId: string | null = null;
          const pathParts: string[] = [];
          for (const folderName of layer.groupPath) {
            pathParts.push(folderName);
            const key = `${layer.path}\0${pathParts.join("\0")}`;
            let groupId = kmlGroups.get(key);
            if (!groupId) {
              groupId = addLayerGroup(folderName);
              if (parentId) moveLayerGroupToGroup(groupId, parentId);
              kmlGroups.set(key, groupId);
            }
            parentId = groupId;
          }
          if (parentId) moveLayerToGroup(lastLayerId, parentId);
        }
      }

      setCrsWarning(
        nonGeographic.length > 0
          ? t("addData.nonGeographicCoordinates", {
              names: nonGeographic.join(", "),
            })
          : null,
      );

      // Gather each time-animated overlay's frames into one collapsible group so
      // the sequence reads as a single timeline entry, not N stacked layers.
      const sequences = [...frameGroups.values()].filter((ids) => ids.length > 1);
      sequences.forEach((ids, index) => {
        // Suffix when a single drop yields more than one sequence so the groups
        // are distinguishable in the panel (e.g. two independent radar loops).
        const name =
          sequences.length > 1
            ? `${t("kml.timeOverlayGroup")} ${index + 1}`
            : t("kml.timeOverlayGroup");
        addLayerGroup(name, ids);
      });
      for (const { name, ids } of placemarkFrameGroups.values()) {
        if (ids.length > 1) addLayerGroup(name, ids);
      }
      const hasTimeAnimation = sequences.length > 0 || hasVectorTimeFrames;
      // Auto-open the Time Slider so a time-animated overlay sequence can be
      // stepped through immediately, without the user hunting for the plugin.
      if (hasTimeAnimation && !isPluginActive(TIME_SLIDER_PLUGIN_ID)) {
        togglePlugin(TIME_SLIDER_PLUGIN_ID, createAppAPI(mapControllerRef));
      }

      // A folder-aware KML becomes one layer per placemark, so framing the last
      // layer alone would open on a single point. Combine the extents of every
      // layer the last source contributed and fit that instead.
      const sourceLayerIds = lastSourcePath ? (layerIdsBySource.get(lastSourcePath) ?? []) : [];
      if (sourceLayerIds.length > 1) {
        const sourceLayerIdSet = new Set(sourceLayerIds);
        const bounds = useAppStore
          .getState()
          .layers.filter((layer) => sourceLayerIdSet.has(layer.id))
          .map(getLayerBounds)
          .filter((value): value is [number, number, number, number] => value !== null);
        if (bounds.length) {
          mapControllerRef.current?.fitBounds([
            Math.min(...bounds.map((value) => value[0])),
            Math.min(...bounds.map((value) => value[1])),
            Math.max(...bounds.map((value) => value[2])),
            Math.max(...bounds.map((value) => value[3])),
          ]);
          return;
        }
      }

      const importedLayer = useAppStore.getState().layers.find((layer) => layer.id === lastLayerId);
      if (importedLayer) {
        // A deck.gl-backed layer (e.g. a KML <Model> scenegraph) mounts its
        // overlay on the next render; fitting synchronously here races that
        // mount and the camera move is lost. Defer the fit past the mount so
        // it frames the model. MapLibre-native layers fit synchronously.
        if (importedLayer.type === "deckgl-viz") {
          const layerId = importedLayer.id;
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              window.setTimeout(() => {
                const current = useAppStore.getState().layers.find((layer) => layer.id === layerId);
                if (current) mapControllerRef.current?.fitLayer(current);
              }, 50);
            });
          });
        } else {
          mapControllerRef.current?.fitLayer(importedLayer);
        }
      }
    },
    [
      addGeoJsonLayer,
      addImageOverlayLayer,
      addTileLayer,
      addLayer,
      addLayerGroup,
      moveLayerGroupToGroup,
      moveLayerToGroup,
      isPluginActive,
      togglePlugin,
      t,
      mapControllerRef,
      setCrsWarning,
    ],
  );

  useEffect(() => {
    setKmlFileImportHandler(async (imports) => {
      setDropError(null);
      // Matches the drop handlers: the catch below sets `dropError` without
      // reaching `addImportedVectorLayers`, so without this a previous file's
      // banner would sit beside the new error.
      setCrsWarning(null);
      try {
        const paths = imports
          .map(({ sourcePath }) => sourcePath)
          .filter((sourcePath): sourcePath is string => typeof sourcePath === "string");
        // Prefer the filesystem paths the desktop picker reports: a Super-Overlay
        // records its source in the tile URL so a saved project can re-read the
        // pyramid, which a path-less browser File cannot support.
        const layers =
          paths.length === imports.length
            ? await loadDroppedVectorPaths(paths, {
                onLargeDataset: confirmLargeVectorDataset,
              })
            : await loadDroppedVectorFiles(
                imports.map(({ file }) => file),
                {
                  onLargeDataset: confirmLargeVectorDataset,
                },
              );
        addImportedVectorLayers(layers);
      } catch (error) {
        setDropError(error instanceof Error ? error.message : t("kml.importFailed"));
      }
    });
    return () => setKmlFileImportHandler(null);
  }, [addImportedVectorLayers, t, setDropError, setCrsWarning]);

  const addDroppedPhotos = useCallback(
    (result: GeotaggedPhotoResult | null): number => {
      if (!result || result.located === 0) return 0;
      const layerId = addGeoJsonLayer(t("addData.photos.defaultName"), result.featureCollection);
      const layer = useAppStore.getState().layers.find((existing) => existing.id === layerId);
      if (layer) mapControllerRef.current?.fitLayer(layer);
      // Report skipped (no-GPS) photos too, mirroring the Add Data dialog's
      // summary, so a partially-skipped drop isn't silent.
      const summary = t("addData.photos.addedSummary", {
        count: result.located,
      });
      const skippedNote =
        result.skipped > 0 ? ` ${t("addData.photos.skippedNote", { count: result.skipped })}` : "";
      setDropMessage(summary + skippedNote);
      return result.located;
    },
    [addGeoJsonLayer, t, mapControllerRef, setDropMessage],
  );

  const addDroppedRasters = useCallback(
    async (rasters: DroppedRaster[]): Promise<number> => {
      if (!rasters.length) return 0;
      const appAPI = createAppAPI(mapControllerRef);
      for (const raster of rasters) {
        // `path` is present only for a desktop pick/drop; it is what lets a saved
        // project reload the raster instead of dropping it (issue #1463).
        await addRasterToMap(appAPI, raster.source, {
          name: raster.name,
          ...(raster.path ? { localPath: raster.path } : {}),
        });
      }
      return rasters.length;
    },
    [mapControllerRef],
  );

  // Add a single local file (clicked in the Browser panel's Files tree) as a
  // layer, reusing the same loaders + store dispatch as the drag-and-drop path.
  // Resolves to an inline error message, or null on success. Vector/raster only
  // (the Files tree filters to those); MBTiles go through the Add Data dialog.
  const addFilePath = useCallback(
    async (path: string): Promise<string | null> => {
      try {
        if (isRasterFileName(path)) {
          const count = await addDroppedRasters(await loadDroppedRasterPaths([path]));
          return count > 0 ? null : t("browser.addFileFailed");
        }
        let cancelled = false;
        const importedLayers = await loadDroppedVectorPaths([path], {
          // Same large-dataset confirmation the drag-and-drop / Open Vector File
          // paths use, so clicking a big file in the tree can't silently hang.
          onLargeDataset: (dataset) => {
            const accepted = confirmLargeVectorDataset(dataset);
            cancelled = !accepted;
            return accepted;
          },
        });
        // A declined large-file prompt is a cancellation, not a failure — but
        // loadDroppedVectorPaths can still return valid layers (e.g. KML ground
        // overlays / models) alongside a declined placemark-vector load, so only
        // treat an *empty* result as a cancel/no-op; otherwise add what loaded.
        if (!importedLayers.length) {
          return cancelled ? null : t("browser.addFileFailed");
        }
        addImportedVectorLayers(importedLayers);
        return null;
      } catch (error) {
        return error instanceof Error ? error.message : t("browser.addFileFailed");
      }
    },
    [addDroppedRasters, addImportedVectorLayers, t],
  );

  const finishDrop = useCallback(
    (importedLayers: ImportedVectorLayer[], rasterCount: number, containerCount = 0) => {
      if (!importedLayers.length && !rasterCount && !containerCount) {
        throw new Error("Drop a supported vector or raster file.");
      }
      if (importedLayers.length) addImportedVectorLayers(importedLayers);
      // Name the layer when a single vector file was dropped (the common case)
      // so the confirmation echoes what the user just added, instead of a bare
      // count that can read like "nothing happened" while the source panel
      // stays open (opengeos/GeoLibre#666).
      if (importedLayers.length === 1 && !rasterCount && !containerCount) {
        const only = importedLayers[0];
        // `||` (not `??`) so an empty-string name also falls back to the path.
        setDropMessage(
          t("toolbar.fileDrop.addedLayer", {
            name: only.name || layerNameFromPath(only.path),
          }),
        );
        return;
      }
      // Full-sentence keys (rather than a JS-assembled summary) keep word
      // order and the connector inside the translation catalog. The mixed
      // case composes two independently pluralized noun phrases into its
      // sentence, since one i18next key can pluralize only a single count.
      const vectorCount = importedLayers.length + containerCount;
      setDropMessage(
        vectorCount && rasterCount
          ? t("toolbar.fileDrop.addedBoth", {
              vector: t("toolbar.fileDrop.bothVectorLayers", {
                count: vectorCount,
              }),
              raster: t("toolbar.fileDrop.bothRasterLayers", {
                count: rasterCount,
              }),
            })
          : vectorCount
            ? t("toolbar.fileDrop.addedVectorLayers", {
                count: vectorCount,
              })
            : t("toolbar.fileDrop.addedRasterLayers", { count: rasterCount }),
      );
    },
    [addImportedVectorLayers, t, setDropMessage],
  );

  return { addDroppedPhotos, addDroppedRasters, addFilePath, finishDrop };
}
