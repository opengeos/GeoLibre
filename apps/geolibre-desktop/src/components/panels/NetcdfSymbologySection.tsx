import { useAppStore, type GeoLibreLayer } from "@geolibre/core";
import { Button, ColorRampSelect, Input, Label, Separator } from "@geolibre/ui";
import { Boxes } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useColormapRamps } from "../../hooks/useColormapRamps";
import { openNetcdfCubeSetup } from "../../lib/netcdf-cube-store";
import {
  bakeNetcdfImage,
  encodeImageOverlay,
  getNetcdfImageSource,
  getNetcdfLayerState,
  netcdfImageSymbology,
  warmNetcdfColormap,
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
    // From the layer's own record, not `applied`: a bake still in flight from the
    // previous layer is dropped just below, so seeding from it would put that
    // layer's limits in this one's fields.
    const own = netcdfImageSymbology(layer, source?.dataClim ?? [0, 1]);
    setMinText(String(own.clim[0]));
    setMaxText(String(own.clim[1]));
    // The section is not keyed per layer, so a pending bake would otherwise show
    // the previous layer's colormap in this layer's controls until it resolves.
    setPendingSymbology(null);
  }

  if (!source) return null;

  // Re-baking walks every cell and then PNG-encodes the result, which is
  // hundreds of milliseconds for a scene-sized grid. Run it after the control
  // has repainted with the new selection, so the dropdown and checkbox respond
  // immediately instead of freezing until the image is ready.
  const apply = (next: NetcdfImageSymbology): void => {
    setPendingSymbology(next);
    window.setTimeout(async () => {
      // A sprite ramp the catalogue has not sampled yet would bake as viridis,
      // and nothing re-bakes when the sample lands, so wait for it first.
      await warmNetcdfColormap(next.colormap);
      const image = bakeNetcdfImage(source, next);
      // Spread the layer as it stands *now*, not as it was at render: this runs a
      // tick later (longer, when a colormap had to be sampled first), and reusing
      // the captured record would silently revert any other edit to the same layer
      // landing in that window. Nothing to update if the layer is gone.
      const current = useAppStore.getState().layers.find((item) => item.id === layer.id);
      if (!current) {
        setPendingSymbology(null);
        return;
      }
      updateLayer(layer.id, {
        source: { ...current.source, url: encodeImageOverlay(image) },
        metadata: { ...current.metadata, netcdfSymbology: next },
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

        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" size="sm" onClick={resetClim}>
            {t("netcdfSymbology.resetRange")}
          </Button>
          {/* Only for a layer whose source file is still open on a band axis:
              the cube is read plane by plane from that file, so a plain 2-D
              grid (or a reloaded project) has nothing to build one from. */}
          {getNetcdfLayerState(layer.id)?.cube ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => openNetcdfCubeSetup(layer.id)}
            >
              <Boxes className="me-1.5 h-4 w-4" aria-hidden="true" />
              {t("netcdfSymbology.openCube")}
            </Button>
          ) : null}
        </div>
      </div>
    </>
  );
}
