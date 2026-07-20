/** User-tunable appearance of the globe atmosphere. Persisted with a project. */
export interface EffectsSettings {
  haloColor: string;
  haloExtent: number;
  haloOpacity: number;
  spaceColor: string;
}

export const DEFAULT_EFFECTS_SETTINGS: EffectsSettings = {
  haloColor: "#4d9fe6",
  haloExtent: 2.8,
  haloOpacity: 1,
  spaceColor: "#0c1b33",
};

/** Slider bounds shared by the UI and the settings normalizer. */
export const HALO_EXTENT_MIN = 1.05;
export const HALO_EXTENT_MAX = 4;
export const HALO_OPACITY_MIN = 0;
export const HALO_OPACITY_MAX = 1;

/** Coerce arbitrary persisted/partial input into a complete EffectsSettings. */
export function normalizeEffectsSettings(
  value: unknown,
  base: EffectsSettings = DEFAULT_EFFECTS_SETTINGS,
): EffectsSettings {
  const candidate = (value ?? {}) as Partial<EffectsSettings>;
  const isHex = (input: unknown): input is string =>
    typeof input === "string" && /^#?[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/.test(input.trim());
  // Lowercase so casing never leaks into the equality check: uppercase hex from
  // a hand-edited project would otherwise read as non-default and serialize.
  const withHash = (input: string) => {
    const hex = input.trim().toLowerCase();
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
  };
}

/** Compare complete settings values without exposing renderer state. */
export function effectsSettingsEqual(a: EffectsSettings, b: EffectsSettings): boolean {
  return (
    a.haloColor === b.haloColor &&
    a.haloExtent === b.haloExtent &&
    a.haloOpacity === b.haloOpacity &&
    a.spaceColor === b.spaceColor
  );
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}
