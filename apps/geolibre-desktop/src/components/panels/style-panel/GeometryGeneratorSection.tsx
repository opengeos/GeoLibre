import {
  DEFAULT_LAYER_STYLE,
  styleValue,
  useAppStore,
  type GeoLibreLayer,
  type GeometryGeneratorType,
} from "@geolibre/core";
import { ColorField, Label, Select } from "@geolibre/ui";
import { useTranslation } from "react-i18next";
import { proportionalSizeBounds } from "../../../lib/vector-style-classification";
import { NumericFieldSelect, NumericStyleInput } from "./style-inputs";

interface GeometryGeneratorSectionProps {
  layer: GeoLibreLayer;
  numericPropertyOptions: string[];
}

/**
 * Geometry generator controls (per-feature derived geometry symbology:
 * centroid, bounding box, convex hull, buffer).
 *
 * @param props - The layer and its numeric attribute candidates.
 * @returns The geometry generator section.
 */
export function GeometryGeneratorSection({
  layer,
  numericPropertyOptions,
}: GeometryGeneratorSectionProps) {
  const { t } = useTranslation();
  const setLayerStyle = useAppStore((s) => s.setLayerStyle);
  const { style } = layer;
  // --- Geometry generator (per-feature derived geometry symbology) ---
  const generatorType = styleValue(style, "geometryGenerator");
  const generatorSizeProperty = styleValue(style, "geometryGeneratorSizeProperty");
  /**
   * Picking a size field seeds the value range from the data, since an
   * unseeded 0..100 default would map a population column onto a single
   * radius. Unlike the proportional-size picker, this one offers numeric
   * columns only, so there is no bad pick to reject after the fact — but
   * `numericPropertyOptions` admits a column with a single numeric value,
   * which has no spread to derive a range from. That case falls back to the
   * defaults rather than keeping the previous field's range, which would
   * scale the new field against numbers that never came from it.
   */
  const chooseGeneratorSizeProperty = (property: string) => {
    if (!property) {
      setLayerStyle(layer.id, { geometryGeneratorSizeProperty: "" });
      return;
    }
    const bounds = proportionalSizeBounds(layer, property);
    setLayerStyle(layer.id, {
      geometryGeneratorSizeProperty: property,
      geometryGeneratorSizeMinValue:
        bounds?.min ?? DEFAULT_LAYER_STYLE.geometryGeneratorSizeMinValue,
      geometryGeneratorSizeMaxValue:
        bounds?.max ?? DEFAULT_LAYER_STYLE.geometryGeneratorSizeMaxValue,
    });
  };
  return (
    <div className="space-y-3">
      <div className="space-y-2">
        <Label htmlFor="geometryGenerator">{t("style.generator.type")}</Label>
        <Select
          id="geometryGenerator"
          value={generatorType}
          onChange={(event) =>
            setLayerStyle(layer.id, {
              geometryGenerator: event.target.value as GeometryGeneratorType,
            })
          }
        >
          <option value="none">{t("style.generator.typeNone")}</option>
          <option value="centroid">{t("style.generator.typeCentroid")}</option>
          <option value="bounding-box">{t("style.generator.typeBoundingBox")}</option>
          <option value="convex-hull">{t("style.generator.typeConvexHull")}</option>
          <option value="buffer">{t("style.generator.typeBuffer")}</option>
        </Select>
      </div>
      {generatorType !== "none" && (
        <>
          {generatorType === "buffer" && (
            <>
              <NumericStyleInput
                id="geometryGeneratorBufferDistance"
                label={t("style.generator.bufferDistance")}
                min={-100000}
                max={1000000}
                step={10}
                value={styleValue(style, "geometryGeneratorBufferDistance")}
                onChange={(geometryGeneratorBufferDistance) =>
                  setLayerStyle(layer.id, { geometryGeneratorBufferDistance })
                }
              />
              <NumericFieldSelect
                id="geometryGeneratorBufferProperty"
                label={t("style.generator.bufferField")}
                value={styleValue(style, "geometryGeneratorBufferProperty")}
                onSelect={(geometryGeneratorBufferProperty) =>
                  setLayerStyle(layer.id, { geometryGeneratorBufferProperty })
                }
                numericPropertyOptions={numericPropertyOptions}
              />
              {styleValue(style, "geometryGeneratorBufferProperty") !== "" && (
                <p className="text-xs text-muted-foreground">
                  {t("style.generator.bufferFieldHint")}
                </p>
              )}
            </>
          )}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label htmlFor="geometryGeneratorFillColor">{t("style.generator.fillColor")}</Label>
              <ColorField
                id="geometryGeneratorFillColor"
                value={styleValue(style, "geometryGeneratorFillColor")}
                onChange={(geometryGeneratorFillColor) =>
                  setLayerStyle(layer.id, { geometryGeneratorFillColor })
                }
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="geometryGeneratorStrokeColor">
                {t("style.generator.strokeColor")}
              </Label>
              <ColorField
                id="geometryGeneratorStrokeColor"
                value={styleValue(style, "geometryGeneratorStrokeColor")}
                onChange={(geometryGeneratorStrokeColor) =>
                  setLayerStyle(layer.id, { geometryGeneratorStrokeColor })
                }
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <NumericStyleInput
              id="geometryGeneratorStrokeWidth"
              label={t("style.generator.strokeWidth")}
              min={0}
              max={20}
              step={0.5}
              value={styleValue(style, "geometryGeneratorStrokeWidth")}
              onChange={(geometryGeneratorStrokeWidth) =>
                setLayerStyle(layer.id, { geometryGeneratorStrokeWidth })
              }
            />
            <NumericStyleInput
              id="geometryGeneratorOpacity"
              label={t("style.generator.opacity")}
              min={0}
              max={1}
              step={0.05}
              value={styleValue(style, "geometryGeneratorOpacity")}
              onChange={(geometryGeneratorOpacity) =>
                setLayerStyle(layer.id, { geometryGeneratorOpacity })
              }
            />
          </div>
          {generatorType === "centroid" && (
            <>
              {/* Stays visible with a size field chosen: it is the radius
                  `generatorCircleRadiusValue` falls back to whenever the
                  field's range turns out degenerate, so hiding it would leave
                  the radius actually in use unreachable. */}
              <NumericStyleInput
                id="geometryGeneratorCircleRadius"
                label={t("style.generator.circleRadius")}
                min={1}
                max={40}
                step={1}
                value={styleValue(style, "geometryGeneratorCircleRadius")}
                onChange={(geometryGeneratorCircleRadius) =>
                  setLayerStyle(layer.id, { geometryGeneratorCircleRadius })
                }
              />
              <NumericFieldSelect
                id="geometryGeneratorSizeProperty"
                label={t("style.generator.sizeField")}
                value={generatorSizeProperty}
                onSelect={chooseGeneratorSizeProperty}
                numericPropertyOptions={numericPropertyOptions}
              />
              {generatorSizeProperty !== "" && (
                <>
                  <div className="grid grid-cols-2 gap-3">
                    <NumericStyleInput
                      id="geometryGeneratorSizeMinValue"
                      label={t("style.symbology.minValue")}
                      min={-1_000_000_000}
                      max={1_000_000_000}
                      step={1}
                      value={styleValue(style, "geometryGeneratorSizeMinValue")}
                      onChange={(geometryGeneratorSizeMinValue) =>
                        setLayerStyle(layer.id, { geometryGeneratorSizeMinValue })
                      }
                    />
                    <NumericStyleInput
                      id="geometryGeneratorSizeMaxValue"
                      label={t("style.symbology.maxValue")}
                      min={-1_000_000_000}
                      max={1_000_000_000}
                      step={1}
                      value={styleValue(style, "geometryGeneratorSizeMaxValue")}
                      onChange={(geometryGeneratorSizeMaxValue) =>
                        setLayerStyle(layer.id, { geometryGeneratorSizeMaxValue })
                      }
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <NumericStyleInput
                      id="geometryGeneratorSizeMinRadius"
                      label={t("style.symbology.minSize")}
                      min={0}
                      max={100}
                      step={1}
                      value={styleValue(style, "geometryGeneratorSizeMinRadius")}
                      onChange={(geometryGeneratorSizeMinRadius) =>
                        setLayerStyle(layer.id, { geometryGeneratorSizeMinRadius })
                      }
                    />
                    <NumericStyleInput
                      id="geometryGeneratorSizeMaxRadius"
                      label={t("style.symbology.maxSize")}
                      min={0}
                      max={100}
                      step={1}
                      value={styleValue(style, "geometryGeneratorSizeMaxRadius")}
                      onChange={(geometryGeneratorSizeMaxRadius) =>
                        setLayerStyle(layer.id, { geometryGeneratorSizeMaxRadius })
                      }
                    />
                  </div>
                </>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}
