import { useAppStore } from "@geolibre/core";
import type { MapController } from "@geolibre/map";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@geolibre/ui";
import { Database } from "lucide-react";
import { useState, type RefObject } from "react";
import { AddDataShellProvider } from "./add-data/context";
import { KIND_DESCRIPTIONS, KIND_LABELS } from "./add-data/constants";
import { ArcGISSource } from "./add-data/sources/ArcGISSource";
import { DeckVizSource } from "./add-data/sources/DeckVizSource";
import { DelimitedTextSource } from "./add-data/sources/DelimitedTextSource";
import { GpxSource } from "./add-data/sources/GpxSource";
import { MbtilesSource } from "./add-data/sources/MbtilesSource";
import { PostgresSource } from "./add-data/sources/PostgresSource";
import { VideoSource } from "./add-data/sources/VideoSource";
import { WfsSource } from "./add-data/sources/WfsSource";
import { WmsSource } from "./add-data/sources/WmsSource";
import { WmtsSource } from "./add-data/sources/WmtsSource";
import { XyzSource } from "./add-data/sources/XyzSource";
import type { AddDataKind } from "./add-data/types";
import { useMartinConnection } from "./add-data/useMartinConnection";

export type { AddDataKind } from "./add-data/types";

interface AddDataDialogProps {
  kind: AddDataKind | null;
  mapControllerRef: RefObject<MapController | null>;
  onOpenChange: (open: boolean) => void;
  /**
   * Deck.gl Layer kind to pre-select when the dialog opens as `deckgl-viz`
   * (e.g. a "3D model" menu entry opens it on the scenegraph layer type).
   */
  initialDeckVizKind?: string;
}

/**
 * Renders the active data-source subcomponent for the given kind. Each source
 * is self-contained: it owns its own form state and submit logic and reads the
 * shared services from the dialog shell via context.
 */
function renderSource(
  kind: AddDataKind,
  initialDeckVizKind: string | undefined,
) {
  switch (kind) {
    case "xyz":
      return <XyzSource />;
    case "wms":
      return <WmsSource />;
    case "wfs":
      return <WfsSource />;
    case "wmts":
      return <WmtsSource />;
    case "gpx":
      return <GpxSource />;
    case "delimited-text":
      return <DelimitedTextSource />;
    case "mbtiles":
      return <MbtilesSource />;
    case "arcgis":
      return <ArcGISSource />;
    case "postgres":
      return <PostgresSource />;
    case "video":
      return <VideoSource />;
    case "deckgl-viz":
      return <DeckVizSource initialDeckVizKind={initialDeckVizKind} />;
    default:
      return null;
  }
}

/**
 * Shell for the Add Data dialog. Owns the cross-cutting state (submit-in-progress,
 * the Martin connection that must survive source remounts) and exposes shared
 * services to the per-source subcomponents through context.
 */
export function AddDataDialog({
  kind,
  mapControllerRef,
  onOpenChange,
  initialDeckVizKind,
}: AddDataDialogProps) {
  const open = kind !== null;
  const addLayer = useAppStore((s) => s.addLayer);
  const existingLayers = useAppStore((s) => s.layers);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const martin = useMartinConnection();

  const title = kind ? KIND_LABELS[kind] : "Add Data";
  const description = kind ? KIND_DESCRIPTIONS[kind] : "";

  const closeDialog = () => {
    martin.stopTransient();
    onOpenChange(false);
  };

  const handleOpenChange = (next: boolean) => {
    if (!next && isSubmitting) return;
    if (!next) martin.stopTransient();
    onOpenChange(next);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Database className="h-4 w-4" />
            {title}
          </DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        {kind ? (
          <AddDataShellProvider
            value={{
              mapControllerRef,
              addLayer,
              existingLayers,
              isSubmitting,
              setIsSubmitting,
              closeDialog,
              martin,
            }}
          >
            {renderSource(kind, initialDeckVizKind)}
          </AddDataShellProvider>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
