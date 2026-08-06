import { Button } from "@geolibre/ui";
import { ExternalLink } from "lucide-react";
import { useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import {
  clearNetcdfProfileSamples,
  getNetcdfProfileSamples,
  isNetcdfProfilePoppedOut,
  setNetcdfProfilePoppedOut,
  subscribeNetcdfProfile,
} from "../../lib/netcdf-profile-store";
import { NetcdfProfileChart } from "./NetcdfProfileChart";

/**
 * The Style panel's section for the pixels sampled with Identify on a NetCDF
 * layer: their spectral signatures, and the Clear that removes them from the map.
 *
 * Renders nothing until a pixel has been sampled, so it costs nothing for a
 * layer nobody has clicked. When the chart is popped out into the floating
 * window the section keeps its header — Clear and the dock control have to stay
 * reachable — but hands the chart itself to the window rather than drawing two.
 *
 * @param props.layerId - The layer whose samples to show; samples taken from any
 *   other layer are ignored, so selecting a second NetCDF layer does not show
 *   the first one's spectra under the second one's heading.
 * @returns The section, or null when this layer has no sampled pixel.
 */
export function NetcdfProfilePanel({ layerId }: { layerId: string }) {
  const { t } = useTranslation();
  const allSamples = useSyncExternalStore(
    subscribeNetcdfProfile,
    getNetcdfProfileSamples,
    getNetcdfProfileSamples,
  );
  const poppedOut = useSyncExternalStore(
    subscribeNetcdfProfile,
    isNetcdfProfilePoppedOut,
    isNetcdfProfilePoppedOut,
  );
  const samples = allSamples.filter((sample) => sample.layerId === layerId);

  if (samples.length === 0) return null;

  return (
    <div className="space-y-2 border-t p-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-semibold">{t("netcdfProfile.heading")}</p>
        <div className="flex items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="gap-1.5"
            aria-pressed={poppedOut}
            title={poppedOut ? t("netcdfProfile.dock") : t("netcdfProfile.popOut")}
            onClick={() => setNetcdfProfilePoppedOut(!poppedOut)}
          >
            <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
            {poppedOut ? t("netcdfProfile.dock") : t("netcdfProfile.popOut")}
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={clearNetcdfProfileSamples}>
            {t("netcdfProfile.clear")}
          </Button>
        </div>
      </div>

      {poppedOut ? (
        <p className="text-[10px] text-muted-foreground">{t("netcdfProfile.poppedOutHint")}</p>
      ) : (
        <NetcdfProfileChart samples={samples} />
      )}
    </div>
  );
}
