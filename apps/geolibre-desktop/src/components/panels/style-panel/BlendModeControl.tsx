import {
  BLEND_MODES,
  DEFAULT_BLEND_MODE,
  controlRendersLayer,
  styleValue,
  useAppStore,
  type BlendMode,
  type GeoLibreLayer,
} from "@geolibre/core";
import { Label, Select } from "@geolibre/ui";
import { layerBlendModesSupported, subscribeLayerBlendModeSupport } from "@geolibre/map";
import type { ParseKeys } from "i18next";
import { useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";

interface BlendModeControlProps {
  layer: GeoLibreLayer;
  isPluginPaintedLayer: boolean;
}

/**
 * The layer blend-mode select, or nothing where no blend mode can apply.
 *
 * @param props - The layer and whether a plugin paints it.
 * @returns The labelled select, or null.
 */
export function BlendModeControl({ layer, isPluginPaintedLayer }: BlendModeControlProps) {
  const { t } = useTranslation();
  const setLayerStyle = useAppStore((s) => s.setLayerStyle);
  const { style } = layer;
  const blendModeSelectId = `blend-mode-${layer.id}`;
  // Blend-mode support is decided when the map installs its render wrappers,
  // which can happen after this panel first renders, so subscribe rather than
  // read the module state once. Kept above the early returns below so the hook
  // order stays stable.
  const blendModesSupported = useSyncExternalStore(
    subscribeLayerBlendModeSupport,
    layerBlendModesSupported,
    layerBlendModesSupported,
  );
  // How the layer composites onto the map beneath it (opengeos/GeoLibre#1981).
  // Blending is applied while MapLibre draws the layer, so a layer painted by a
  // plugin (`paintMode`) or rendered by a control (`customLayerType`: 3D Tiles,
  // Gaussian splats, LiDAR, the COG raster engine, Add Vector Layer) can never
  // honour it -- offering the menu there would only persist a mode nothing
  // applies. `blendModesSupported` additionally drops it on a `maplibre-gl`
  // build whose render seams moved; see `@geolibre/map`'s `layer-blend-modes`.
  return !isPluginPaintedLayer && !controlRendersLayer(layer) && blendModesSupported ? (
    <div className="space-y-2">
      <Label htmlFor={blendModeSelectId}>{t("style.blendMode")}</Label>
      <Select
        id={blendModeSelectId}
        aria-label={t("style.blendModeFor", { name: layer.name })}
        value={styleValue(style, "blendMode") ?? DEFAULT_BLEND_MODE}
        onChange={(event) =>
          setLayerStyle(layer.id, { blendMode: event.target.value as BlendMode })
        }
      >
        {BLEND_MODES.map((mode) => (
          <option key={mode} value={mode}>
            {t(`style.blendModes.${mode}` as ParseKeys)}
          </option>
        ))}
      </Select>
    </div>
  ) : null;
}
