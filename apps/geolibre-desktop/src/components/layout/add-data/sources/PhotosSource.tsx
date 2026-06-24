import { Button, Label } from "@geolibre/ui";
import { Images } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  type GeotaggedPhotoResult,
  loadGeotaggedPhotos,
} from "../../../../lib/geotagged-photos";
import { pickImageFilesWithFallback } from "../../../../lib/tauri-io";
import { createBaseLayer, errorMessage } from "../helpers";
import { AddDataSourceForm, useAddDataSource } from "../shared";

/**
 * Add Data source that imports a set of geotagged photos as a point layer.
 * Each image is placed from its EXIF GPS coordinates with a thumbnail and EXIF
 * metadata stored on the feature; photos without GPS are skipped and reported.
 */
export function PhotosSource() {
  const { t } = useTranslation();
  // Captured once on mount so the "did the user rename it?" comparisons stay
  // stable even if the UI language changes while the dialog is open.
  const [defaultName] = useState(() => t("addData.photos.defaultName"));
  const source = useAddDataSource(defaultName);
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [summary, setSummary] = useState<GeotaggedPhotoResult | null>(null);

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
      throw new Error(
        t("addData.photos.errorNoGps", { count: result.total }),
      );
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
            <Button
              type="button"
              variant="outline"
              onClick={handleChoosePhotos}
            >
              <Images className="mr-2 h-3.5 w-3.5" />
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
        <p className="text-xs text-muted-foreground">
          {t("addData.photos.hint")}
        </p>
      </div>
    </AddDataSourceForm>
  );
}
