import {
  geocodeForward,
  resolveGeocoderConfig,
  useAppStore,
  type GeoLibreLayer,
} from "@geolibre/core";
import type { MapEngine } from "@geolibre/map";
import { Layers, MapPin, Table2 } from "lucide-react";
import { type RefObject, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import type { RankedCommand } from "../../lib/commands";
import { notify } from "../../lib/notify";
import {
  type PaletteSearchOptions,
  paletteFeatureResults,
  paletteLayerResults,
  palettePlaceResult,
} from "../../lib/palette-search";
import { flyToGeocodeMatch, selectAndFitLayer, selectFeatureMatch } from "../../lib/search-actions";

/**
 * The palette's search beyond commands, in two halves. `instant` (the matching
 * layers and the place search row) is cheap and runs on every keystroke, so the
 * place row always names the query as typed. `deferred` (the attribute scan)
 * is capped but not free, so the palette runs it after a short pause in typing,
 * like the Layers panel search box.
 */
export interface PaletteSearch {
  instant: (query: string) => RankedCommand[];
  deferred: (query: string) => RankedCommand[];
}

/** The project's layers and groups as of now: the palette reads them per query. */
function currentLayers(): { layers: GeoLibreLayer[]; groups: PaletteSearchOptions["groups"] } {
  const state = useAppStore.getState();
  return { layers: state.layers, groups: state.layerGroups };
}

/**
 * Build the command palette's layer, feature and place results, wired to the
 * same actions as the Layers panel: a layer is selected and framed like its
 * Zoom to layer button, a feature is selected and framed like a search row or
 * an attribute-table pick, and a place is geocoded through the configured
 * provider and framed. The store is read per query rather than subscribed to,
 * so layer edits never re-render the palette.
 *
 * @param mapControllerRef - The map engine the results move.
 * @returns The two search halves the palette merges with its commands.
 */
export function usePaletteSearch(mapControllerRef: RefObject<MapEngine | null>): PaletteSearch {
  const { t } = useTranslation();
  // Only the latest place pick may move the map: an earlier lookup that
  // resolves after a newer one is dropped.
  const latestPlaceRequest = useRef(0);

  return useMemo(() => {
    const searchPlace = (query: string) => {
      const engine = mapControllerRef.current;
      if (!engine) return;
      const request = ++latestPlaceRequest.current;
      const config = resolveGeocoderConfig(useAppStore.getState().preferences.geocoding);
      geocodeForward(query, { config, limit: 1 }).then(
        (matches) => {
          if (request !== latestPlaceRequest.current) return;
          const match = matches[0];
          if (!match) {
            notify.info(t("commandPalette.placeNotFound", { query }));
            return;
          }
          flyToGeocodeMatch(engine, match);
          notify.info(t("commandPalette.placeClosestMatch", { name: match.displayName }));
        },
        () => {
          if (request === latestPlaceRequest.current) notify.error(t("layers.searchPlacesError"));
        },
      );
    };

    const options: PaletteSearchOptions = {
      actions: {
        openLayer: (layerId) => {
          const failure = selectAndFitLayer(mapControllerRef.current, layerId);
          if (failure === "missing" || failure === null) return;
          const name = useAppStore.getState().layers.find((layer) => layer.id === layerId)?.name;
          notify.info(
            failure === "outsideMapCrs"
              ? t("layers.zoomToLayerOutsideMapCrs", { name })
              : t("layers.zoomToLayerUnknownExtent", { name }),
          );
        },
        openFeature: (match) => {
          selectFeatureMatch(mapControllerRef.current, match);
        },
        searchPlace,
      },
      labels: {
        layersGroup: t("commandPalette.layersGroup"),
        featuresGroup: (layer, partial) =>
          partial
            ? t("commandPalette.featuresGroupPartial", { layer })
            : t("commandPalette.featuresGroup", { layer }),
        placesGroup: t("commandPalette.placesGroup"),
        searchPlace: (query) => t("commandPalette.searchPlace", { query }),
      },
      icons: { layer: Layers, feature: Table2, place: MapPin },
    };

    return {
      instant: (query) => {
        const { layers } = currentLayers();
        return [
          ...paletteLayerResults(layers, query, options),
          ...palettePlaceResult(query, options),
        ];
      },
      deferred: (query) => {
        const { layers, groups } = currentLayers();
        return paletteFeatureResults(layers, query, { ...options, groups });
      },
    };
  }, [mapControllerRef, t]);
}
