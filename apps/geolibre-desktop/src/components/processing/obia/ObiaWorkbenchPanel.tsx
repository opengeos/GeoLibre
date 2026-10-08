import type { MapEngine } from "@geolibre/map";
import { addRasterToMap } from "@geolibre/plugins";
import { useCallback, useEffect, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { createAppAPI } from "../../../hooks/usePlugins";
import type { ObiaAddRaster } from "../../../lib/obia/obia-session";
import { clearObiaSourceCache } from "../../../lib/obia/obia-source";
import { ObiaAccuracyStep } from "./ObiaAccuracyStep";
import { ObiaClassifyStep } from "./ObiaClassifyStep";
import { ObiaMeasureStep } from "./ObiaMeasureStep";
import { ObiaSegmentStep } from "./ObiaSegmentStep";
import { ObiaTrainStep } from "./ObiaTrainStep";

interface ObiaWorkbenchPanelProps {
  mapControllerRef: React.RefObject<MapEngine | null>;
}

/**
 * Object-Based Analysis workbench (#3053), the content of a dockable right
 * panel (see `lib/obia/obia-panel.ts`). It runs the OBIA pipeline on the WASM
 * tool runner, one section per step: segment a raster layer into objects (one
 * polygon per object, `id` = `segment_id`), measure them, label training and
 * validation samples, classify them, and assess the accuracy. Each later step
 * appears once the one before it has run.
 */
export function ObiaWorkbenchPanel({ mapControllerRef }: ObiaWorkbenchPanelProps): ReactElement {
  const { t } = useTranslation();

  // The panel unmounts when closed or when another dock panel takes over;
  // release the cached image bytes then.
  useEffect(() => clearObiaSourceCache, []);

  const addRaster = useCallback<ObiaAddRaster>(
    async (bytes, name, fileName, state) => {
      const file = new File([bytes as BlobPart], fileName ?? `${name}.tif`, {
        type: "image/tiff",
      });
      await addRasterToMap(createAppAPI(mapControllerRef), file, { name, state });
    },
    [mapControllerRef],
  );

  return (
    <div
      className="flex h-full min-h-0 flex-col gap-3 overflow-auto p-3"
      data-testid="obia-workbench-panel"
    >
      <p className="text-xs text-muted-foreground">{t("obia.description")}</p>
      <ObiaSegmentStep mapControllerRef={mapControllerRef} onAddRaster={addRaster} />
      <ObiaMeasureStep />
      <ObiaTrainStep />
      <ObiaClassifyStep />
      <ObiaAccuracyStep />
    </div>
  );
}
