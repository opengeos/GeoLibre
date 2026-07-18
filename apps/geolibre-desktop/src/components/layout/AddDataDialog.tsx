import { useAppStore } from "@geolibre/core";
import type { MapController } from "@geolibre/map";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@geolibre/ui";
import { Database } from "lucide-react";
import { useCallback, useMemo, useState, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { AddDataShellProvider } from "./add-data/context";
import { KIND_I18N_KEY } from "./add-data/constants";
import { ArcGISSource } from "./add-data/sources/ArcGISSource";
import { CadSource } from "./add-data/sources/CadSource";
import { DeckVizSource } from "./add-data/sources/DeckVizSource";
import { DelimitedTextSource } from "./add-data/sources/DelimitedTextSource";
import { GdbSource } from "./add-data/sources/GdbSource";
import { GeoRssSource } from "./add-data/sources/GeoRssSource";
import { GpxSource } from "./add-data/sources/GpxSource";
import { MbtilesSource } from "./add-data/sources/MbtilesSource";
import { OgcVectorTilesSource } from "./add-data/sources/OgcVectorTilesSource";
import { PhotosSource } from "./add-data/sources/PhotosSource";
import { PostgresSource } from "./add-data/sources/PostgresSource";
import { VideoSource } from "./add-data/sources/VideoSource";
import { WfsSource } from "./add-data/sources/WfsSource";
import { WmsSource } from "./add-data/sources/WmsSource";
import { WmtsSource } from "./add-data/sources/WmtsSource";
import { XyzSource } from "./add-data/sources/XyzSource";
import type { AddDataKind } from "./add-data/types";
import type { OpenAddDataPostgres } from "./add-data/open-add-data";
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
  /**
   * Connection (and optional table) to pre-select when the dialog opens as
   * `postgres` — set when the Browser panel opens a saved connection or a
   * clicked PostGIS table.
   */
  initialPostgres?: OpenAddDataPostgres;
}

/**
 * Renders the active data-source subcomponent for the given kind. Each source
 * is self-contained: it owns its own form state and submit logic and reads the
 * shared services from the dialog shell via context.
 */
function renderSource(
  kind: AddDataKind,
  initialDeckVizKind: string | undefined,
  initialPostgres: OpenAddDataPostgres | undefined,
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
    case "ogc-vector-tiles":
      return <OgcVectorTilesSource />;
    case "gpx":
      return <GpxSource />;
    case "georss":
      return <GeoRssSource />;
    case "delimited-text":
      return <DelimitedTextSource />;
    case "cad":
      return <CadSource />;
    case "gdb":
      return <GdbSource />;
    case "photos":
      return <PhotosSource />;
    case "mbtiles":
      return <MbtilesSource />;
    case "arcgis":
      return <ArcGISSource />;
    case "postgres":
      return <PostgresSource initialPostgres={initialPostgres} />;
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
  initialPostgres,
}: AddDataDialogProps) {
  const { t } = useTranslation();
  const open = kind !== null;
  const addLayer = useAppStore((s) => s.addLayer);
  const existingLayers = useAppStore((s) => s.layers);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const martin = useMartinConnection();

  const title = kind ? t(`addData.kind.${KIND_I18N_KEY[kind]}.label`) : t("addData.title");
  const description = kind ? t(`addData.kind.${KIND_I18N_KEY[kind]}.description`) : "";

  const closeDialog = useCallback(() => {
    martin.stopTransient();
    onOpenChange(false);
  }, [martin, onOpenChange]);

  const handleOpenChange = (next: boolean) => {
    if (!next && isSubmitting) return;
    if (!next) martin.stopTransient();
    onOpenChange(next);
  };

  // Memoized so context consumers (the source forms) only re-render when shell
  // state actually changes, not on every shell render. Effective because
  // `martin` and `closeDialog` are stable across renders (see their hooks).
  const contextValue = useMemo(
    () => ({
      mapControllerRef,
      addLayer,
      existingLayers,
      isSubmitting,
      setIsSubmitting,
      closeDialog,
      martin,
    }),
    [mapControllerRef, addLayer, existingLayers, isSubmitting, closeDialog, martin],
  );

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
          <AddDataShellProvider value={contextValue}>
            {renderSource(kind, initialDeckVizKind, initialPostgres)}
          </AddDataShellProvider>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
