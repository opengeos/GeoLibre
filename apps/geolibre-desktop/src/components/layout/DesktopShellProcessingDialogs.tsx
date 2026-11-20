import { shouldZoomToNewLayers } from "@geolibre/core";
import type { MapEngine } from "@geolibre/map";
import { addLidarLayerFromBytes, addRasterToMap } from "@geolibre/plugins";
import { Suspense, type RefObject } from "react";
import { createAppAPI } from "../../hooks/usePlugins";
import { lidarOutputForMap } from "../../lib/lidar-export";
import {
  BatchToolsDialog,
  ConversionDialog,
  GeocodeDialog,
  NetworkToolsDialog,
  ProcessingDialog,
  ProcessingHistoryDialog,
  RasterToolsDialog,
  SegmentationDialog,
  StatisticsToolsDialog,
  VectorToolsDialog,
} from "./desktopShellLazyPanels";
import { MountWhenOpened } from "./MountWhenOpened";

interface DesktopShellProcessingDialogsProps {
  mapControllerRef: RefObject<MapEngine | null>;
}

/** Lazily-mounted processing and analysis dialogs owned by the workspace shell. */
export function DesktopShellProcessingDialogs({
  mapControllerRef,
}: DesktopShellProcessingDialogsProps) {
  return (
    <>
      <MountWhenOpened isOpen={(ui) => ui.processingOpen}>
        <Suspense fallback={null}>
          <ProcessingDialog
            mapControllerRef={mapControllerRef}
            onAddRaster={async (bytes, name, fileName) => {
              // Cast required: TS types Uint8Array as Uint8Array<ArrayBufferLike>,
              // which is not directly assignable to BlobPart under this lib.
              // `fileName` (when given) becomes the layer's sourcePath while `name`
              // stays the human-readable display name; the control keeps them
              // separate (info.source.fileName vs info.name).
              const file = new File([bytes as BlobPart], fileName ?? `${name}.tif`, {
                type: "image/tiff",
              });
              await addRasterToMap(createAppAPI(mapControllerRef), file, {
                name,
              });
            }}
            onAddLidar={async (bytes, name, fileName) => {
              try {
                const cloud = await lidarOutputForMap(bytes, fileName);
                const id = await addLidarLayerFromBytes(
                  createAppAPI(mapControllerRef),
                  cloud.bytes,
                  {
                    name,
                    fileName: cloud.fileName,
                    fit: shouldZoomToNewLayers(),
                  },
                );
                return id !== null;
              } catch (error) {
                // Too large to convert, or unreadable by the viewer: the dialog
                // downloads the output instead.
                console.warn("[lidar] could not add tool output to the map", error);
                return false;
              }
            }}
          />
        </Suspense>
      </MountWhenOpened>
      <MountWhenOpened isOpen={(ui) => ui.conversionOpen}>
        <Suspense fallback={null}>
          <ConversionDialog />
        </Suspense>
      </MountWhenOpened>
      <MountWhenOpened isOpen={(ui) => ui.vectorToolOpen}>
        <Suspense fallback={null}>
          <VectorToolsDialog mapControllerRef={mapControllerRef} />
        </Suspense>
      </MountWhenOpened>
      <MountWhenOpened isOpen={(ui) => ui.networkToolOpen}>
        <Suspense fallback={null}>
          <NetworkToolsDialog mapControllerRef={mapControllerRef} />
        </Suspense>
      </MountWhenOpened>
      <MountWhenOpened isOpen={(ui) => ui.batchToolsOpen}>
        <Suspense fallback={null}>
          <BatchToolsDialog mapControllerRef={mapControllerRef} />
        </Suspense>
      </MountWhenOpened>
      <MountWhenOpened isOpen={(ui) => ui.statisticsToolOpen}>
        <Suspense fallback={null}>
          <StatisticsToolsDialog mapControllerRef={mapControllerRef} />
        </Suspense>
      </MountWhenOpened>
      <MountWhenOpened isOpen={(ui) => ui.geocodeOpen}>
        <Suspense fallback={null}>
          <GeocodeDialog mapControllerRef={mapControllerRef} />
        </Suspense>
      </MountWhenOpened>
      <MountWhenOpened isOpen={(ui) => ui.processingHistoryOpen}>
        <Suspense fallback={null}>
          <ProcessingHistoryDialog />
        </Suspense>
      </MountWhenOpened>
      <MountWhenOpened isOpen={(ui) => ui.rasterToolOpen}>
        <Suspense fallback={null}>
          <RasterToolsDialog mapControllerRef={mapControllerRef} />
        </Suspense>
      </MountWhenOpened>
      <MountWhenOpened isOpen={(ui) => ui.segmentationOpen}>
        <Suspense fallback={null}>
          <SegmentationDialog mapControllerRef={mapControllerRef} />
        </Suspense>
      </MountWhenOpened>
    </>
  );
}
