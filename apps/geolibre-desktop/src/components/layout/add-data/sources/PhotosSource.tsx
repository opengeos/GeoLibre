import { useAppStore } from "@geolibre/core";
import { Button, Label } from "@geolibre/ui";
import { Images, MapPin } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  type GeotaggedPhotoResult,
  loadGeotaggedPhotos,
  loadPhotosAtLocation,
  relocatePhotoFeatures,
} from "../../../../lib/geotagged-photos";
import { pickImageFilesWithFallback } from "../../../../lib/tauri-io";
import { createBaseLayer, errorMessage } from "../helpers";
import { AddDataSourceForm, useAddDataSource } from "../shared";

/** Round a lng/lat for the placement prompt so it reads cleanly. */
function formatCoordinate(value: number): string {
  return value.toFixed(4);
}

/**
 * Add Data source that imports a set of geotagged photos as a point layer.
 * Each image is placed from its EXIF GPS coordinates with a thumbnail and EXIF
 * metadata stored on the feature; photos without GPS are skipped and reported.
 *
 * When a single photo carries no usable GPS, the dialog offers a manual
 * placement workflow instead of a hard error: the photo is dropped at the
 * current map center and a draggable pin lets the user fine-tune its position
 * on the map.
 */
export function PhotosSource() {
  const { t } = useTranslation();
  // Captured once on mount so the "did the user rename it?" comparisons stay
  // stable even if the UI language changes while the dialog is open.
  const [defaultName] = useState(() => t("addData.photos.defaultName"));
  const source = useAddDataSource(defaultName);
  const updateLayer = useAppStore((s) => s.updateLayer);
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [summary, setSummary] = useState<GeotaggedPhotoResult | null>(null);
  // Set when a single photo had no GPS: holds the map center the photo would be
  // placed at, switching the dialog to the manual-placement prompt.
  const [manualCenter, setManualCenter] = useState<[number, number] | null>(null);

  const handleChoosePhotos = async () => {
    source.setError(null);
    try {
      const files = await pickImageFilesWithFallback();
      if (files.length === 0) return;
      setSelectedFiles(files);
    } catch (err) {
      source.setError(errorMessage(err, t("addData.photos.readError")));
    }
  };

  const handleSubmit = source.runSubmit(async () => {
    const name = source.layerName.trim() || defaultName;
    if (selectedFiles.length === 0) {
      throw new Error(t("addData.photos.errorChooseFiles"));
    }

    const result = await loadGeotaggedPhotos(selectedFiles);
    if (result.located === 0) {
      // A single photo with no GPS pivots to manual placement instead of a hard
      // stop; multiple no-GPS photos still report the original error.
      if (selectedFiles.length === 1) {
        const center = source.shell.mapControllerRef.current?.readView().center ?? null;
        if (center) {
          setManualCenter([center[0], center[1]]);
          return;
        }
      }
      throw new Error(t("addData.photos.errorNoGps", { count: result.total }));
    }

    const layer = {
      ...createBaseLayer(
        name,
        "geojson",
        { type: "geojson" },
        {
          sourceKind: "geotagged-photos",
          featureCount: result.located,
          skipped: result.skipped,
          withoutThumbnail: result.withoutThumbnail,
          total: result.total,
        },
      ),
      geojson: result.featureCollection,
    };
    source.shell.addLayer(layer, source.beforeLayer);
    source.shell.mapControllerRef.current?.fitLayer(layer);
    // Keep the dialog open on a summary panel so the skipped/no-thumbnail
    // counts are reported clearly before the user dismisses it.
    setSummary(result);
  });

  const handleManualPlace = source.runSubmit(async () => {
    if (!manualCenter) return;
    const name = source.layerName.trim() || defaultName;
    const result = await loadPhotosAtLocation(selectedFiles, manualCenter);
    const layer = {
      ...createBaseLayer(
        name,
        "geojson",
        { type: "geojson" },
        {
          sourceKind: "geotagged-photos",
          featureCount: result.located,
          skipped: result.skipped,
          withoutThumbnail: result.withoutThumbnail,
          total: result.total,
          manualPlacement: true,
        },
      ),
      geojson: result.featureCollection,
    };
    source.shell.addLayer(layer, source.beforeLayer);
    // Hand the user a draggable pin on the map to fine-tune the position. It
    // lives outside React, so closing the dialog (below) does not cancel it.
    // Each drag rewrites the layer's whole geojson, always derived from the
    // original placement collection (not the current store value) so repeated
    // moves can't accumulate floating-point drift.
    let unsubscribe = () => {};
    const dispose = source.shell.mapControllerRef.current?.startManualPlacement(manualCenter, {
      hint: t("addData.photos.manualHint"),
      doneLabel: t("common.done"),
      onMove: (lngLat) =>
        updateLayer(layer.id, {
          geojson: relocatePhotoFeatures(result.featureCollection, lngLat),
        }),
      onDone: () => unsubscribe(),
    });
    // If the user deletes the layer before finishing placement, the pin and its
    // popup would otherwise linger on the map. Watch the store and dispose them
    // when the layer disappears. (This dialog closes right after, so the
    // subscription, not a React effect, owns the cleanup.)
    if (dispose) {
      unsubscribe = useAppStore.subscribe((state) => {
        if (!state.layers.some((l) => l.id === layer.id)) {
          dispose();
          unsubscribe();
        }
      });
    }
    // Close the dialog so the map (and the drag pin) become interactive; the
    // modal overlay would otherwise block dragging.
    source.shell.closeDialog();
  });

  if (summary) {
    return (
      <div className="space-y-4">
        <div className="space-y-2 rounded-md border border-border p-3 text-sm">
          <p className="font-medium text-foreground">
            {t("addData.photos.addedSummary", { count: summary.located })}
          </p>
          {summary.skipped > 0 ? (
            <p className="text-muted-foreground">
              {t("addData.photos.skippedNote", { count: summary.skipped })}
            </p>
          ) : null}
          {summary.withoutThumbnail > 0 ? (
            <p className="text-muted-foreground">
              {t("addData.photos.noThumbnailNote", {
                count: summary.withoutThumbnail,
              })}
            </p>
          ) : null}
        </div>
        <div className="flex justify-end">
          <Button type="button" onClick={source.shell.closeDialog}>
            {t("common.done")}
          </Button>
        </div>
      </div>
    );
  }

  if (manualCenter) {
    return (
      <form className="space-y-4" onSubmit={handleManualPlace}>
        <div className="space-y-2 rounded-md border border-border p-3 text-sm">
          <p className="font-medium text-foreground">{t("addData.photos.manualPromptTitle")}</p>
          <p className="text-muted-foreground">{t("addData.photos.manualPromptBody")}</p>
          <p className="text-xs text-muted-foreground">
            {t("addData.photos.manualPromptCenter", {
              lng: formatCoordinate(manualCenter[0]),
              lat: formatCoordinate(manualCenter[1]),
            })}
          </p>
        </div>
        {source.error ? <p className="text-sm text-destructive">{source.error}</p> : null}
        <div className="flex justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              setManualCenter(null);
              source.setError(null);
            }}
            disabled={source.isSubmitting}
          >
            {t("common.cancel")}
          </Button>
          <Button type="submit" disabled={source.isSubmitting}>
            <MapPin className="me-2 h-3.5 w-3.5" />
            {t("addData.photos.manualPlace")}
          </Button>
        </div>
      </form>
    );
  }

  return (
    <AddDataSourceForm
      layerName={source.layerName}
      onLayerNameChange={source.setLayerName}
      beforeLayerId={source.beforeLayerId}
      onBeforeLayerIdChange={source.setBeforeLayerId}
      onSubmit={handleSubmit}
      error={source.error}
      submitDisabled={source.isSubmitting || selectedFiles.length === 0}
    >
      <div className="space-y-3">
        <div className="space-y-1.5">
          <Label>{t("addData.photos.chooseLabel")}</Label>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" variant="outline" onClick={handleChoosePhotos}>
              <Images className="me-2 h-3.5 w-3.5" />
              {t("addData.photos.choosePhotos")}
            </Button>
            <span className="min-w-0 truncate text-xs text-muted-foreground">
              {selectedFiles.length > 0
                ? t("addData.photos.selectedCount", {
                    count: selectedFiles.length,
                  })
                : t("addData.common.noFileSelected")}
            </span>
          </div>
        </div>
        <p className="text-xs text-muted-foreground">{t("addData.photos.hint")}</p>
      </div>
    </AddDataSourceForm>
  );
}
