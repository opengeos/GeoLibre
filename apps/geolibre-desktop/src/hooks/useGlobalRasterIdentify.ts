import type { MapCanvasRasterIdentify } from "@geolibre/map";
import { readRasterPixel } from "@geolibre/plugins";
import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import {
  getNetcdfLayerState,
  gridPixelAt,
  NETCDF_IMAGE_SOURCE_KIND,
} from "../lib/netcdf-image-symbology";
import {
  rasterIdentifyProperties,
  rasterPixelIdentifyProperties,
} from "../lib/global-raster-identify";
import { netcdfIdentifyRows } from "./useNetcdfIdentify";

/**
 * Build the application-owned raster bridge used by all-layer Identify.
 *
 * COGs read through the raster control's public pixel API. NetCDF image layers
 * read their retained in-memory grids, matching the dedicated per-layer
 * inspector without adding a profile marker for a broad all-layer query.
 *
 * @returns Stable raster identify callback for `MapCanvas`.
 */
export function useGlobalRasterIdentify(): MapCanvasRasterIdentify {
  const { t } = useTranslation();

  return useCallback<MapCanvasRasterIdentify>(
    async (layer, lngLat, { signal }) => {
      if (layer.metadata.sourceKind === NETCDF_IMAGE_SOURCE_KIND) {
        const state = getNetcdfLayerState(layer.id);
        if (!state) return null;
        const pixel = gridPixelAt(state.grid, lngLat[0], lngLat[1]);
        if (!pixel) return null;
        return {
          title: t("map.identifyAll.pixel"),
          properties: rasterIdentifyProperties(netcdfIdentifyRows(state, pixel, t)),
        };
      }

      if (layer.type !== "cog") return null;
      const reading = await readRasterPixel(layer.id, lngLat, { signal });
      if (!reading || signal.aborted) return null;
      return {
        title: t("map.identifyAll.pixel"),
        properties: rasterPixelIdentifyProperties(reading, {
          band: (index) => t("map.identifyAll.band", { index }),
          nodata: t("map.identifyAll.nodata"),
          coordinates: t("map.identifyAll.coordinates"),
          row: t("map.identifyAll.row"),
          column: t("map.identifyAll.column"),
        }),
      };
    },
    [t],
  );
}
