import { useAppStore, type GeoLibreLayer } from "@geolibre/core";
import { Button, ColorRampSelect, Input, Label, Separator } from "@geolibre/ui";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useColormapRamps } from "../../hooks/useColormapRamps";
import {
  bakeNetcdfImage,
  encodeImageOverlay,
  getNetcdfImageSource,
  netcdfImageSymbology,
  type NetcdfImageSymbology,
} from "../../lib/netcdf-image-symbology";

/**
 * Symbology for a NetCDF grid baked into an `image` overlay: the same colormap
 * catalogue the raster panel offers, a reverse toggle, and the color limits.
 *
 * The pixels are drawn on the CPU rather than by a shader (see
 * `composeColormappedImage`), so every change re-bakes the image and writes a
 * new data URL; `syncImageLayer` hands that to `ImageSource.updateImage`, which
 * swaps the texture in place without rebuilding the layer.
 *
 * Renders nothing when the layer's decoded grid is not in memory. That is the
 * case after a project reload: the baked pixels are in the project file but the
 * values behind them are not, so there is nothing to re-colormap.
 *
 * @param props.layer - The image layer to style.
 * @returns The symbology controls, or null when the grid is unavailable.
 */
export function NetcdfSymbologySection({ layer }: { layer: GeoLibreLayer }) {
  const { t } = useTranslation();
  const updateLayer = useAppStore((state) => state.updateLayer);
  const rampOptions = useColormapRamps();
  const source = getNetcdfImageSource(layer.id);
  // The symbology awaiting its bake, so the controls show the new selection at
  // once rather than snapping back until the image lands.
  const [pendingSymbology, setPendingSymbology] = useState<NetcdfImageSymbology | null>(null);
  const applied = pendingSymbology ?? netcdfImageSymbology(layer, source?.dataClim ?? [0, 1]);
  // Free text while the user types, so a half-entered number ("-", "1.") does
  // not immediately re-bake with a nonsense limit.
  const [minText, setMinText] = useState(String(applied.clim[0]));
  const [maxText, setMaxText] = useState(String(applied.clim[1]));
  // The layer a draft belongs to; selecting a different layer must reload the
  // fields rather than keep the previous layer's numbers.
  const [draftLayerId, setDraftLayerId] = useState(layer.id);
  if (draftLayerId !== layer.id) {
    setDraftLayerId(layer.id);
    setMinText(String(applied.clim[0]));
    setMaxText(String(applied.clim[1]));
  }

  if (!source) return null;

  // Re-baking walks every cell and then PNG-encodes the result, which is
  // hundreds of milliseconds for a scene-sized grid. Run it after the control
  // has repainted with the new selection, so the dropdown and checkbox respond
  // immediately instead of freezing until the image is ready.
  const apply = (next: NetcdfImageSymbology): void => {
    setPendingSymbology(next);
    window.setTimeout(() => {
      const image = bakeNetcdfImage(source, next);
      updateLayer(layer.id, {
        source: { ...layer.source, url: encodeImageOverlay(image) },
        metadata: { ...layer.metadata, netcdfSymbology: next },
      });
      setPendingSymbology(null);
    }, 0);
  };

  const applyClim = (min: number, max: number): void => {
    // An inverted or zero-width range has no gradient to draw. Snap the fields
    // back to what is actually rendered rather than leaving the panel showing
    // limits the layer is not using.
    if (!Number.isFinite(min) || !Number.isFinite(max) || min >= max) {
      setMinText(String(applied.clim[0]));
      setMaxText(String(applied.clim[1]));
      return;
    }
    apply({ ...applied, clim: [min, max] });
  };

  const resetClim = (): void => {
    setMinText(String(source.dataClim[0]));
    setMaxText(String(source.dataClim[1]));
    apply({ ...applied, clim: source.dataClim });
  };

  return (
    <>
      <Separator />
      <div className="space-y-3">
        <p className="text-xs font-semibold">{t("netcdfSymbology.heading")}</p>

        <div className="space-y-2">
          <Label htmlFor="netcdfRamp">{t("netcdfSymbology.colorRampLabel")}</Label>
          <ColorRampSelect
            id="netcdfRamp"
            aria-label={t("netcdfSymbology.colorRampLabel")}
            value={applied.colormap}
            reversed={applied.reversed}
            ramps={rampOptions}
            onValueChange={(value) => apply({ ...applied, colormap: value })}
          />
        </div>

        <label className="flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            checked={applied.reversed}
            onChange={(event) => apply({ ...applied, reversed: event.target.checked })}
          />
          {t("netcdfSymbology.reverse")}
        </label>

        <div className="grid gap-2 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="netcdfClimMin">{t("netcdfSymbology.colorMin")}</Label>
            <Input
              id="netcdfClimMin"
              inputMode="decimal"
              value={minText}
              onChange={(event) => setMinText(event.target.value)}
              onBlur={() => applyClim(Number(minText), Number(maxText))}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="netcdfClimMax">{t("netcdfSymbology.colorMax")}</Label>
            <Input
              id="netcdfClimMax"
              inputMode="decimal"
              value={maxText}
              onChange={(event) => setMaxText(event.target.value)}
              onBlur={() => applyClim(Number(minText), Number(maxText))}
            />
          </div>
        </div>

        <Button type="button" variant="outline" size="sm" onClick={resetClim}>
          {t("netcdfSymbology.resetRange")}
        </Button>
      </div>
    </>
  );
}
