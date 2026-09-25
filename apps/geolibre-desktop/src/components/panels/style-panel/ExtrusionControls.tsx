import { styleValue, useAppStore, type GeoLibreLayer } from "@geolibre/core";
import { Button, ColorField, Label, Select } from "@geolibre/ui";
import { useTranslation } from "react-i18next";
import { validateExpressionJson } from "./classification-helpers";
import { NumericStyleInput } from "./style-inputs";
import type { StylePanelDrafts } from "./useStylePanelDrafts";

interface ExtrusionControlsProps {
  layer: GeoLibreLayer;
  drafts: StylePanelDrafts;
  extrusionHeightPropertyOptions: string[];
}

/**
 * The 3D extrusion controls: drafted color, opacity, height source and base,
 * applied together with the Apply button.
 *
 * @param props - The layer, its draft state and the height attribute options.
 * @returns The extrusion controls.
 */
export function ExtrusionControls({
  layer,
  drafts,
  extrusionHeightPropertyOptions,
}: ExtrusionControlsProps) {
  const { t } = useTranslation();
  const setLayerStyle = useAppStore((s) => s.setLayerStyle);
  const { style } = layer;
  const {
    draftVectorStyleMode,
    draftColorExpression,
    draftHeightExpression,
    setDraftHeightExpression,
    draftExtrusionColor,
    setDraftExtrusionColor,
    draftExtrusionOpacity,
    setDraftExtrusionOpacity,
    draftExtrusionHeightProperty,
    setDraftExtrusionHeightProperty,
    draftExtrusionHeightScale,
    setDraftExtrusionHeightScale,
    draftExtrusionBase,
    setDraftExtrusionBase,
    draftAdvancedExtrusionEnabled,
    setDraftAdvancedExtrusionEnabled,
    extrusionError,
    setExtrusionError,
  } = drafts;
  const extrusionHeightProperties = extrusionHeightPropertyOptions.includes(
    draftExtrusionHeightProperty,
  )
    ? extrusionHeightPropertyOptions
    : extrusionHeightPropertyOptions;
  const extrusionSettingsChanged =
    draftExtrusionColor !== styleValue(style, "extrusionColor") ||
    draftExtrusionOpacity !== styleValue(style, "extrusionOpacity") ||
    draftExtrusionHeightProperty !== styleValue(style, "extrusionHeightProperty") ||
    draftExtrusionHeightScale !== styleValue(style, "extrusionHeightScale") ||
    draftExtrusionBase !== styleValue(style, "extrusionBase") ||
    draftAdvancedExtrusionEnabled !== styleValue(style, "extrusionAdvancedStyleEnabled") ||
    draftColorExpression !== styleValue(style, "extrusionColorExpression") ||
    draftHeightExpression !== styleValue(style, "extrusionHeightExpression");
  const applyExtrusionSettings = () => {
    if (draftAdvancedExtrusionEnabled) {
      const colorError = validateExpressionJson(
        draftColorExpression,
        t("style.expressionLabels.color"),
        t,
      );
      if (colorError) {
        setExtrusionError(colorError);
        return;
      }

      const heightError = validateExpressionJson(
        draftHeightExpression,
        t("style.expressionLabels.height"),
        t,
      );
      if (heightError) {
        setExtrusionError(heightError);
        return;
      }
    }

    setExtrusionError(null);
    setLayerStyle(layer.id, {
      extrusionColor: draftExtrusionColor,
      extrusionOpacity: draftExtrusionOpacity,
      extrusionHeightProperty: draftExtrusionHeightProperty,
      extrusionHeightScale: draftExtrusionHeightScale,
      extrusionBase: draftExtrusionBase,
      extrusionAdvancedStyleEnabled: draftAdvancedExtrusionEnabled,
      extrusionColorExpression: draftColorExpression.trim(),
      extrusionHeightExpression: draftHeightExpression.trim(),
    });
  };
  return (
    <>
      {draftVectorStyleMode === "single" ? (
        <div className="space-y-2">
          <Label htmlFor="extrusionColor">{t("style.extrusion.color")}</Label>
          <ColorField
            id="extrusionColor"
            value={draftExtrusionColor}
            onChange={(color) => setDraftExtrusionColor(color)}
          />
        </div>
      ) : null}
      <NumericStyleInput
        id="extrusionOpacity"
        label={t("style.extrusion.opacity")}
        min={0}
        max={1}
        step={0.05}
        value={draftExtrusionOpacity}
        onChange={setDraftExtrusionOpacity}
      />
      <label
        htmlFor="extrusionAdvancedStyleEnabled"
        className="flex items-center gap-2 text-sm font-medium"
      >
        <input
          id="extrusionAdvancedStyleEnabled"
          type="checkbox"
          checked={draftAdvancedExtrusionEnabled}
          onChange={(event) => {
            setDraftAdvancedExtrusionEnabled(event.target.checked);
            setExtrusionError(null);
          }}
        />
        {t("style.extrusion.advanced")}
      </label>
      {draftAdvancedExtrusionEnabled ? (
        <div className="space-y-2">
          <Label htmlFor="extrusionHeightExpression">{t("style.extrusion.heightExpression")}</Label>
          <textarea
            id="extrusionHeightExpression"
            className="min-h-20 w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-xs placeholder:text-muted-foreground focus-visible:border-2 focus-visible:border-ring focus-visible:outline-none focus-visible:ring-0"
            value={draftHeightExpression}
            onChange={(event) => {
              setDraftHeightExpression(event.target.value);
              setExtrusionError(null);
            }}
          />
        </div>
      ) : (
        <>
          <div className="space-y-2">
            <Label htmlFor="extrusionHeightProperty">{t("style.extrusion.heightProperty")}</Label>
            <Select
              id="extrusionHeightProperty"
              value={draftExtrusionHeightProperty}
              onChange={(event) => setDraftExtrusionHeightProperty(event.target.value)}
              disabled={extrusionHeightProperties.length === 0}
            >
              {extrusionHeightProperties.length === 0 ? (
                <option value="">{t("style.labels.noAttributes")}</option>
              ) : (
                extrusionHeightProperties.map((property) => (
                  <option key={property} value={property}>
                    {property}
                  </option>
                ))
              )}
            </Select>
          </div>
          <NumericStyleInput
            id="extrusionHeightScale"
            label={t("style.extrusion.heightScale")}
            min={0}
            max={10000}
            step={0.00001}
            value={draftExtrusionHeightScale}
            onChange={setDraftExtrusionHeightScale}
          />
          <NumericStyleInput
            id="extrusionBase"
            label={t("style.extrusion.base")}
            min={0}
            max={100000}
            step={1}
            value={draftExtrusionBase}
            onChange={setDraftExtrusionBase}
          />
        </>
      )}
      <Button
        type="button"
        size="sm"
        className="w-full"
        disabled={!extrusionSettingsChanged}
        onClick={applyExtrusionSettings}
      >
        {t("style.extrusion.apply")}
      </Button>
      {extrusionError && <p className="text-xs text-destructive">{extrusionError}</p>}
    </>
  );
}
