import {
  classifiedRaster,
  convertGeoTiffToCog,
  legendCsv,
  type ObiaClassifiedRaster,
} from "@geolibre/processing";
import { Button } from "@geolibre/ui";
import { Download, ImagePlus, Loader2 } from "lucide-react";
import { useEffect, useRef, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import {
  saveBinaryFileWithFallback,
  saveTextFileWithFallback,
} from "../../../lib/file-io/file-dialogs";
import { useObiaSession, type ObiaAddRaster } from "../../../lib/obia/obia-session";
import { ObiaStatus, ObiaStepHeading } from "./ObiaFields";

interface ObiaExportStepProps {
  onAddRaster: ObiaAddRaster;
}

/**
 * Step 6: burn the classification onto the segmentation grid and add it to
 * the map in the class colors, or save the class-code GeoTIFF and its legend.
 * The objects layer itself is the vector result (`obia_predicted`).
 */
export function ObiaExportStep({ onAddRaster }: ObiaExportStepProps): ReactElement | null {
  const { t } = useTranslation();
  const segmentation = useObiaSession((s) => s.segmentation);
  const classes = useObiaSession((s) => s.classes);
  const classification = useObiaSession((s) => s.classification);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  // The raster for the current classification, built once for every action.
  const cache = useRef<{ key: string; raster: ObiaClassifiedRaster } | null>(null);

  // Release the rasters built for an older segmentation or classification.
  useEffect(() => {
    cache.current = null;
  }, [segmentation, classification]);

  if (!segmentation || !classification) return null;

  const baseName = segmentation.sourceName.replace(/\.[^.]+$/, "");
  const build = async () => {
    // One raster per segmentation, classification and class styling; JSON so
    // no class name can collide with a separator.
    const key = JSON.stringify([
      segmentation.finishedAt,
      classification.finishedAt,
      classes.map((cls) => [cls.name, cls.color]),
    ]);
    if (cache.current?.key !== key) {
      const raster = await classifiedRaster(
        segmentation.labels,
        classification.predictions,
        classes,
      );
      // Cloud-optimize both: the map renders COGs directly (a striped TIFF
      // would prompt for conversion), and a COG is the better file to hand out.
      // No overviews: the encoder averages them, which would blend class codes
      // and colors. The workbench's pixel cap keeps both well inside the
      // converter's sample limit (3 bands x 16.7M pixels < 100M samples).
      cache.current = {
        key,
        raster: {
          ...raster,
          codes: await convertGeoTiffToCog(raster.codes, { overviews: false }),
          rgb: await convertGeoTiffToCog(raster.rgb, { overviews: false }),
        },
      };
    }
    return cache.current.raster;
  };

  const run = async (action: () => Promise<string | null>) => {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      setMessage(await action());
    } catch (err) {
      setError(err instanceof Error ? err.message : t("obia.export.error.failed"));
    } finally {
      setBusy(false);
    }
  };

  const addToMap = () =>
    run(async () => {
      const raster = await build();
      await onAddRaster(
        raster.rgb,
        t("obia.export.layerName", { name: segmentation.sourceName }),
        `${baseName}_classified.tif`,
        // Show the class colors as written, not stretched to the data range.
        {
          mode: "rgb",
          bands: [1, 2, 3],
          rescale: [
            [0, 255],
            [0, 255],
            [0, 255],
          ],
        },
      );
      return t("obia.export.added");
    });

  const saveCodes = () =>
    run(async () => {
      const raster = await build();
      const path = await saveBinaryFileWithFallback(raster.codes, {
        defaultName: `${baseName}_classes.tif`,
        filters: [{ name: "GeoTIFF", extensions: ["tif", "tiff"] }],
        browserTypes: [{ description: "GeoTIFF", accept: { "image/tiff": [".tif", ".tiff"] } }],
        mimeType: "image/tiff",
      });
      return path === null ? null : t("obia.export.saved");
    });

  const saveLegend = () =>
    run(async () => {
      const raster = await build();
      const path = await saveTextFileWithFallback(legendCsv(raster.legend), {
        defaultName: `${baseName}_classes.csv`,
        filters: [{ name: "CSV", extensions: ["csv"] }],
        browserTypes: [{ description: "CSV", accept: { "text/csv": [".csv"] } }],
        mimeType: "text/csv",
      });
      return path === null ? null : t("obia.export.saved");
    });

  return (
    <section className="flex flex-col gap-3 border-t pt-3">
      <ObiaStepHeading index={6} title={t("obia.steps.export")} />
      <p className="text-xs text-muted-foreground">{t("obia.export.hint")}</p>
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          className="gap-1"
          disabled={busy}
          onClick={() => void addToMap()}
          data-testid="obia-export-map"
        >
          {busy ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <ImagePlus className="h-3.5 w-3.5" />
          )}
          {t("obia.export.addToMap")}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="gap-1"
          disabled={busy}
          onClick={() => void saveCodes()}
        >
          <Download className="h-3.5 w-3.5" />
          {t("obia.export.saveCodes")}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="gap-1"
          disabled={busy}
          onClick={() => void saveLegend()}
        >
          <Download className="h-3.5 w-3.5" />
          {t("obia.export.saveLegend")}
        </Button>
      </div>
      <ObiaStatus error={error} success={message} testId="obia-export-result" />
    </section>
  );
}
