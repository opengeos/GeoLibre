import { DEFAULT_LAYER_STYLE, styleValue, type LayerStyle } from "@geolibre/core";

// Floor for the contrast handed to Cesium. MapLibre can ask for a black point
// at or above mid-grey, which Cesium's brightness/contrast pair cannot express
// (see imageryColorAdjustments); flooring the contrast keeps the stretch exact
// and degrades only the lift, instead of letting the brightness factor run away.
const MIN_IMAGERY_CONTRAST = 0.1;

/**
 * Cesium's `ImageryLayer` colour controls for a layer's raster symbology. The
 * ArcGIS engine applies the same brightness/contrast/saturation/hue as CSS
 * filter effects, which compose the same way (see `arcgisRasterEffect`).
 *
 * MapLibre and Cesium run the same four operations, but with different curves,
 * different neutral points, and a different order, so this is not a
 * property-by-property rename. Writing MapLibre's raster shader in order (hue
 * spin, saturation, contrast, brightness) and Cesium's `sampleAndBlend` in
 * order (brightness, contrast, hue, saturation):
 *
 * | step       | MapLibre                       | Cesium                     |
 * | ---------- | ------------------------------ | -------------------------- |
 * | saturation | `rgb += (avg - rgb) * f`       | `luma + (rgb - luma) * a`  |
 * | contrast   | `(rgb - 0.5) * k + 0.5`        | `0.5 + (rgb - 0.5) * k'`   |
 * | brightness | `mix(min, max, rgb)`           | `rgb * b`                  |
 *
 * where MapLibre derives `f` and `k` through
 * `f = s > 0 ? 1 - 1 / (1.001 - s) : -s` and `k = c > 0 ? 1 / (1 - c) : 1 + c`.
 *
 * Two things follow. Both curves bend above 0, so `1 + value` tracks MapLibre
 * only on the negative half and would leave the globe visibly flatter than the
 * 2D map for any positive contrast or saturation; both are mirrored exactly
 * here. (MapLibre pivots saturation on the channel average and Cesium on
 * luminance. That pivot is not something `ImageryLayer` exposes; the multiplier
 * is the part that translates.)
 *
 * And MapLibre's brightness is a *window*, not a gain: it scales by the
 * window's width and lifts the black point to `min`. Mapping the window onto
 * `brightness` alone would drop the width, so the globe would miss the
 * flattening that a narrowed window produces on the 2D map. Cesium has no
 * window, but its brightness and contrast compose into the same shape of
 * affine map, so the two are solved for together. With MapLibre's composed
 * contrast and brightness written as `out = S * in + I`:
 *
 *     S = k * (max - min)          I = (min + max) / 2 - S / 2
 *
 * and Cesium's composed brightness and contrast as
 * `out = (b * k') * in + 0.5 * (1 - k')`, matching slope and intercept gives
 * `k' = 1 - 2I` and `b = S / k'`. The one shape Cesium cannot reach is
 * `I >= 0.5`, hence {@link MIN_IMAGERY_CONTRAST}.
 */
export function imageryColorAdjustments(style: LayerStyle | undefined): {
  brightness: number;
  contrast: number;
  saturation: number;
  hue: number;
} {
  const s = style ?? DEFAULT_LAYER_STYLE;
  const num = (value: unknown, fallback: number) =>
    typeof value === "number" && Number.isFinite(value) ? value : fallback;
  const unit = (value: unknown, fallback: number) =>
    Math.min(1, Math.max(-1, num(value, fallback)));
  const min = num(styleValue(s, "rasterBrightnessMin"), 0);
  const max = num(styleValue(s, "rasterBrightnessMax"), 1);
  // The raster paint spec bounds both to [-1, 1] and MapLibre clamps on parse,
  // so a store value outside it would already be rendering differently in 2D.
  const contrast = unit(styleValue(s, "rasterContrast"), 0);
  const saturation = unit(styleValue(s, "rasterSaturation"), 0);

  // MapLibre's own curve, `1 / (1 - contrast)`, is +Infinity at contrast 1,
  // which is reachable: the Style panel's slider stops there. MapLibre hands that
  // Infinity to the shader and the framebuffer clamps it into a hard threshold
  // at mid-grey; here it would poison the slope/intercept solve below and set
  // brightness to NaN. Flooring the denominator keeps the curve exact
  // everywhere it is finite and turns the endpoint into the same very hard
  // threshold, rather than bending the whole positive half to dodge one point.
  const mapLibreContrast = contrast > 0 ? 1 / Math.max(1e-4, 1 - contrast) : 1 + contrast;
  const slope = mapLibreContrast * (max - min);
  const intercept = (min + max) / 2 - slope / 2;
  // A flat result (contrast -1, or a zero-width window) wants a contrast of 0,
  // which Cesium reaches exactly, so only floor the contrast when there is a
  // slope to divide by. Flooring unconditionally would leave the fully
  // flattened case a few percent off a target it can hit.
  const exactContrast = 1 - 2 * intercept;
  const cesiumContrast =
    slope > 0 ? Math.max(MIN_IMAGERY_CONTRAST, exactContrast) : Math.max(0, exactContrast);

  return {
    brightness: slope > 0 ? slope / cesiumContrast : 0,
    contrast: cesiumContrast,
    // 1.001 is MapLibre's own constant in saturationFactor, not a guard added
    // here; it is why this curve has no endpoint problem of its own.
    saturation: saturation > 0 ? 1 / (1.001 - saturation) : Math.max(0, 1 + saturation),
    hue: (num(styleValue(s, "rasterHueRotate"), 0) * Math.PI) / 180,
  };
}
