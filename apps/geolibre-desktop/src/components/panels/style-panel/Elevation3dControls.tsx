import { DEFAULT_LAYER_STYLE, styleValue, useAppStore, type GeoLibreLayer } from "@geolibre/core";
import { ColorField, Label, Separator } from "@geolibre/ui";
import { useTranslation } from "react-i18next";
import type { GeometryFlags } from "./layer-capabilities";
import { NumericStyleInput } from "./style-inputs";

interface Elevation3dControlsProps {
  layer: GeoLibreLayer;
  strokeWidthInMeters: boolean;
  geometryFlags: GeometryFlags;
  isSketchLayer: boolean;
}

// Controls for the "3D (Z values)" mode: only the knobs the deck.gl render
// honors (flat colors, widths, and the elevation transform). Data-driven
// symbology, point renderers, patterns, markers, and labels are 2D-only.
export function Elevation3dControls({
  layer,
  strokeWidthInMeters,
  geometryFlags,
  isSketchLayer,
}: Elevation3dControlsProps) {
  const { t } = useTranslation();
  const setLayerStyle = useAppStore((s) => s.setLayerStyle);
  const { style } = layer;
  return (
    <>
      <div className="space-y-2">
        <Label htmlFor="fillColor">{t("style.elevation3d.fillColor")}</Label>
        <ColorField
          id="fillColor"
          value={style.fillColor}
          onChange={(fillColor) => setLayerStyle(layer.id, { fillColor })}
          allowTransparent
          fallbackColor={DEFAULT_LAYER_STYLE.fillColor}
          transparentLabel={t("style.symbology.transparent")}
          transparentSwatchLabel={t("style.symbology.transparentSwatch")}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="strokeColor">{t("style.elevation3d.outlineColor")}</Label>
        <ColorField
          id="strokeColor"
          value={style.strokeColor}
          onChange={(strokeColor) => setLayerStyle(layer.id, { strokeColor })}
          allowTransparent
          fallbackColor={DEFAULT_LAYER_STYLE.strokeColor}
          transparentLabel={t("style.symbology.transparent")}
          transparentSwatchLabel={t("style.symbology.transparentSwatch")}
        />
      </div>
      {/* The 3D render honors meter-based widths (lineWidthUnits), so mirror
          the 2D control's range/label switch or the tighter pixel clamp would
          silently destroy a meters width on the next edit. */}
      <NumericStyleInput
        id="strokeWidth"
        label={
          strokeWidthInMeters
            ? t("style.elevation3d.strokeWidthMeters")
            : t("style.elevation3d.strokeWidth")
        }
        min={0}
        max={strokeWidthInMeters ? 100000 : 20}
        step={strokeWidthInMeters ? 1 : 0.5}
        value={style.strokeWidth}
        onChange={(strokeWidth) => setLayerStyle(layer.id, { strokeWidth })}
      />
      <NumericStyleInput
        id="fillOpacity"
        label={t("style.elevation3d.fillOpacity")}
        min={0}
        max={1}
        step={0.05}
        value={style.fillOpacity}
        onChange={(fillOpacity) => setLayerStyle(layer.id, { fillOpacity })}
      />
      {/* Sketches mix geometry types under one style, so "Circle radius" is
          suppressed there for the same reason as in the 2D controls (#483). */}
      {geometryFlags.hasPoint && !isSketchLayer ? (
        <NumericStyleInput
          id="circleRadius"
          label={t("style.elevation3d.circleRadius")}
          min={1}
          max={50}
          step={1}
          value={style.circleRadius}
          onChange={(circleRadius) => setLayerStyle(layer.id, { circleRadius })}
        />
      ) : null}
      <Separator />
      <NumericStyleInput
        id="elevation3dVerticalScale"
        label={t("style.elevation3d.verticalScale")}
        min={0}
        max={100}
        step={0.1}
        value={styleValue(style, "elevation3dVerticalScale")}
        onChange={(elevation3dVerticalScale) =>
          setLayerStyle(layer.id, { elevation3dVerticalScale })
        }
        tooltip={t("style.elevation3d.verticalScaleTooltip")}
      />
      <NumericStyleInput
        id="elevation3dOffset"
        label={t("style.elevation3d.offset")}
        min={-10000}
        max={10000}
        step={10}
        value={styleValue(style, "elevation3dOffset")}
        onChange={(elevation3dOffset) => setLayerStyle(layer.id, { elevation3dOffset })}
        tooltip={t("style.elevation3d.offsetTooltip")}
      />
    </>
  );
}
