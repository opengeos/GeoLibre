/**
 * User-tunable appearance of the globe atmosphere. Persisted with the project
 * (see the plugin's getProjectState/applyProjectState) so a styled globe — for
 * example one prepared for image export — reopens the way it was saved.
 *
 * - `haloColor` is the base color of the atmospheric halo; the gradient stops
 *   are derived from it (lightened toward white near the globe edge, darkened
 *   in the faint outer falloff).
 * - `haloExtent` is how far the halo reaches past the globe, as a multiple of
 *   the globe radius. Lower values pull the glow tight to the surface so data
 *   reads as painted onto the sphere; higher values give the stylized "air"
 *   look where the limb floats in a wide blue haze.
 * - `haloOpacity` scales the whole halo's strength (0 hides it).
 * - `spaceColor` is the center color of the deep-space radial backdrop; the
 *   outer edge is a darkened shade of it.
 * - `showStars`, `showMilkyWay` and `showConstellations` toggle the layers of
 *   the real night sky painted on the MapLibre/Mapbox backdrop (the Cesium
 *   globe has its own sky box).
 */
export interface EffectsSettings {
  haloColor: string;
  haloExtent: number;
  haloOpacity: number;
  spaceColor: string;
  showStars: boolean;
  showMilkyWay: boolean;
  showConstellations: boolean;
}

export const DEFAULT_EFFECTS_SETTINGS: EffectsSettings = {
  haloColor: "#4d9fe6",
  haloExtent: 2.8,
  haloOpacity: 1,
  spaceColor: "#0c1b33",
  showStars: true,
  showMilkyWay: true,
  showConstellations: false,
};

// Slider bounds shared by the UI and the settings normalizer.
export const HALO_EXTENT_MIN = 1.05;
export const HALO_EXTENT_MAX = 4;
export const HALO_OPACITY_MIN = 0;
export const HALO_OPACITY_MAX = 1;

/** Clamp `value` into `[min, max]`, falling back to `fallback` if non-finite. */
function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

/** Coerce arbitrary persisted/partial input into a complete EffectsSettings. */
export function normalizeEffectsSettings(
  value: unknown,
  base: EffectsSettings = DEFAULT_EFFECTS_SETTINGS,
): EffectsSettings {
  const candidate = (value ?? {}) as Partial<EffectsSettings>;
  const isHex = (v: unknown): v is string =>
    typeof v === "string" && /^#?[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/.test(v.trim());
  // Lowercase so casing never leaks into the equality check: uppercase hex from
  // a hand-edited project would otherwise read as "non-default" and get
  // serialized even when the rendered color matches a default exactly.
  const withHash = (v: string) => {
    const hex = v.trim().toLowerCase();
    return hex.startsWith("#") ? hex : `#${hex}`;
  };
  return {
    haloColor: isHex(candidate.haloColor) ? withHash(candidate.haloColor) : base.haloColor,
    haloExtent: clampNumber(
      candidate.haloExtent,
      HALO_EXTENT_MIN,
      HALO_EXTENT_MAX,
      base.haloExtent,
    ),
    haloOpacity: clampNumber(
      candidate.haloOpacity,
      HALO_OPACITY_MIN,
      HALO_OPACITY_MAX,
      base.haloOpacity,
    ),
    spaceColor: isHex(candidate.spaceColor) ? withHash(candidate.spaceColor) : base.spaceColor,
    showStars: typeof candidate.showStars === "boolean" ? candidate.showStars : base.showStars,
    showMilkyWay:
      typeof candidate.showMilkyWay === "boolean" ? candidate.showMilkyWay : base.showMilkyWay,
    showConstellations:
      typeof candidate.showConstellations === "boolean"
        ? candidate.showConstellations
        : base.showConstellations,
  };
}

export function effectsSettingsEqual(a: EffectsSettings, b: EffectsSettings): boolean {
  return (
    a.haloColor === b.haloColor &&
    a.haloExtent === b.haloExtent &&
    a.haloOpacity === b.haloOpacity &&
    a.spaceColor === b.spaceColor &&
    a.showStars === b.showStars &&
    a.showMilkyWay === b.showMilkyWay &&
    a.showConstellations === b.showConstellations
  );
}
