import type { MapCanvasRasterIdentify } from "@geolibre/map";
import { isPlanetaryComputerLayer } from "@geolibre/core";
import { identifyPlanetaryComputerLayer, readRasterPixel } from "@geolibre/plugins";
import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import {
  getNetcdfLayerState,
  gridPixelAt,
  NETCDF_IMAGE_SOURCE_KIND,
} from "../lib/netcdf-image-symbology";
import {
  planetaryComputerIdentifyProperties,
  wrapLongitude,
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
 * Planetary Computer layers are drawn from rendered tiles, so their source
 * values are read from the Planetary Computer Data API.
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

      if (isPlanetaryComputerLayer(layer)) {
        // A click on a repeated world copy reports a longitude beyond ±180;
        // the layer's bounds and the Data API both use the wrapped value.
        const wrapped: [number, number] = [wrapLongitude(lngLat[0]), lngLat[1]];
        const reading = await identifyPlanetaryComputerLayer(layer, wrapped, { signal });
        if (!reading || signal.aborted) return null;
        return {
          title: t("map.identifyAll.pixel"),
          properties: planetaryComputerIdentifyProperties(reading, {
            item: t("map.identifyAll.stacItem"),
            nodata: t("map.identifyAll.nodata"),
            coordinates: t("map.identifyAll.coordinates"),
            lngLat: wrapped,
          }),
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
