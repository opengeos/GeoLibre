import { styleValue, useAppStore, type GeoLibreLayer } from "@geolibre/core";
import { useTranslation } from "react-i18next";
import { clamp } from "../../../lib/clamp";
import { MAX_LAYER_ZOOM, MIN_LAYER_ZOOM } from "./constants";
import { NumericStyleInput } from "./style-inputs";

/**
 * The layer's min/max zoom inputs, kept ordered so min never exceeds max.
 *
 * @param props - The layer being styled.
 * @returns The two-column zoom range inputs.
 */
export function ZoomRangeControls({ layer }: { layer: GeoLibreLayer }) {
  const { t } = useTranslation();
  const setLayerStyle = useAppStore((s) => s.setLayerStyle);
  const { style } = layer;
  const minZoom = styleValue(style, "minZoom");
  const maxZoom = styleValue(style, "maxZoom");
  const setMinZoom = (value: number) => {
    const next = clamp(value, MIN_LAYER_ZOOM, MAX_LAYER_ZOOM);
    setLayerStyle(layer.id, {
      minZoom: next,
      maxZoom: Math.max(next, maxZoom),
    });
  };
  const setMaxZoom = (value: number) => {
    const next = clamp(value, MIN_LAYER_ZOOM, MAX_LAYER_ZOOM);
    setLayerStyle(layer.id, {
      minZoom: Math.min(next, minZoom),
      maxZoom: next,
    });
  };
  return (
    <div className="grid grid-cols-2 gap-3">
      <NumericStyleInput
        id={`${layer.id}-minZoom`}
        label={t("style.visibility.minZoom")}
        tooltip={t("style.visibility.minZoomTooltip")}
        min={MIN_LAYER_ZOOM}
        max={maxZoom}
        step={1}
        value={minZoom}
        onChange={setMinZoom}
      />
      <NumericStyleInput
        id={`${layer.id}-maxZoom`}
        label={t("style.visibility.maxZoom")}
        tooltip={t("style.visibility.maxZoomTooltip")}
        min={minZoom}
        max={MAX_LAYER_ZOOM}
        step={1}
        value={maxZoom}
        onChange={setMaxZoom}
      />
    </div>
  );
}
