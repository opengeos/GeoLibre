/**
 * Accent color schemes layered on top of the light/dark mode. A scheme only
 * re-tints the accent-bearing tokens (`--primary`, `--primary-foreground`,
 * `--ring`); the neutral base (background, border, muted) is shared.
 *
 * Preset schemes have their token values baked into `packages/ui/src/globals.css`
 * under `[data-theme="<id>"]` selectors and are selected via a `data-theme`
 * attribute on <html>. The "custom" scheme instead derives its tokens from a
 * user-picked hex color at runtime and injects them as inline styles on <html>
 * (which override the stylesheet in both light and dark mode). This module is the
 * single source of truth for the valid scheme ids and the picker UI.
 */
/**
 * Preset scheme ids, the single source of truth. Each one has a matching
 * `[data-theme="<id>"]` block in `globals.css` and an entry in `THEME_SCHEMES`.
 * Deriving the type from this array keeps the three in sync: adding an id here
 * without a `THEME_SCHEMES` entry is a compile error (the array is typed against
 * the derived id), so persisted values can't silently fall back to the default.
 */
const PRESET_SCHEME_IDS = ["blue", "violet", "emerald", "rose", "amber"] as const;

type PresetScheme = (typeof PRESET_SCHEME_IDS)[number];

/** A preset scheme, or "custom" (a user-picked hex color applied inline). */
export type ThemeScheme = PresetScheme | "custom";

/**
 * The default scheme matches the base `:root` / `.dark` tokens already shipped in
 * `globals.css`, so no `data-theme` attribute is set for it. Invariant: if this
 * ever changes to another preset, add a `[data-theme="<old default>"]` block in
 * `globals.css` for the now-non-default scheme (see `applyThemeScheme`).
 */
export const DEFAULT_THEME_SCHEME: PresetScheme = "blue";

/** Seed color for the custom picker before the user changes it (a teal-cyan). */
export const DEFAULT_CUSTOM_COLOR = "#0ea5e9";

export interface ThemeSchemeOption {
  id: PresetScheme;
  /** i18n key for the display label (typed so `t()` accepts it directly). */
  labelKey: `settings.appearance.scheme.${PresetScheme}`;
  /** Representative swatch color (`hsl()`) shown as the picker dot. */
  swatch: string;
}

/**
 * Selectable preset schemes, in picker order. The "custom" scheme is handled
 * separately (its swatch is the live picked color), so it is not listed here.
 */
export const THEME_SCHEMES: readonly ThemeSchemeOption[] = [
  {
    id: "blue",
    labelKey: "settings.appearance.scheme.blue",
    swatch: "hsl(221.2 83.2% 53.3%)",
  },
  {
    id: "violet",
    labelKey: "settings.appearance.scheme.violet",
    swatch: "hsl(262.1 83.3% 57.8%)",
  },
  {
    id: "emerald",
    labelKey: "settings.appearance.scheme.emerald",
    swatch: "hsl(142.1 76.2% 36.3%)",
  },
  {
    id: "rose",
    labelKey: "settings.appearance.scheme.rose",
    swatch: "hsl(346.8 77.2% 49.8%)",
  },
  {
    id: "amber",
    labelKey: "settings.appearance.scheme.amber",
    swatch: "hsl(24.6 95% 53.1%)",
  },
];

// Requires a leading `#`: the stored value is bound to `<input type="color">`,
// which only accepts exact `#rrggbb`/`#rgb` and resets to black otherwise.
const HEX_COLOR = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

/** Type guard for persisted/tampered scheme values. */
export function isThemeScheme(value: unknown): value is ThemeScheme {
  return value === "custom" || (PRESET_SCHEME_IDS as readonly string[]).includes(value as string);
}

/** Whether `value` is a 3- or 6-digit hex color with a leading `#`. */
export function isHexColor(value: unknown): value is string {
  return typeof value === "string" && HEX_COLOR.test(value.trim());
}

/** Expand a validated hex string to its six lowercase digits (no `#`). */
function expandHex(hex: string): string {
  const digits = HEX_COLOR.exec(hex.trim())?.[1]?.toLowerCase();
  if (!digits) return "";
  return digits.length === 3
    ? digits
        .split("")
        .map((channel) => channel + channel)
        .join("")
    : digits;
}

/**
 * Normalize free-form hex input to a canonical `#rrggbb` lowercase string, or
 * `null` when it is not a valid 3- or 6-digit hex. A leading `#` is optional, so
 * the Appearance pane can accept typed or pasted codes like `D58400` (#911).
 */
export function normalizeHexColor(value: string): string | null {
  const trimmed = value.trim();
  const candidate = trimmed.startsWith("#") ? trimmed : `#${trimmed}`;
  if (!isHexColor(candidate)) return null;
  return `#${expandHex(candidate)}`;
}

/**
 * Convert a hex color to the bare HSL channels (`"H S% L%"`) the design tokens
 * expect. Returns null for invalid input.
 *
 * @param hex - A 3- or 6-digit hex color with a leading `#`.
 */
export function hexToHslChannels(hex: string): string | null {
  const digits = expandHex(hex);
  if (!digits) return null;

  const r = parseInt(digits.slice(0, 2), 16) / 255;
  const g = parseInt(digits.slice(2, 4), 16) / 255;
  const b = parseInt(digits.slice(4, 6), 16) / 255;

  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const lightness = (max + min) / 2;
  const delta = max - min;

  let hue = 0;
  let saturation = 0;
  if (delta !== 0) {
    saturation = delta / (1 - Math.abs(2 * lightness - 1));
    if (max === r) {
      hue = ((g - b) / delta) % 6;
    } else if (max === g) {
      hue = (b - r) / delta + 2;
    } else {
      hue = (r - g) / delta + 4;
    }
    hue *= 60;
    if (hue < 0) hue += 360;
  }

  const round = (value: number) => Math.round(value * 10) / 10;
  return `${round(hue)} ${round(saturation * 100)}% ${round(lightness * 100)}%`;
}

/**
 * Pick a readable foreground (white or near-black, as HSL channels) for text
 * placed on `hex`, choosing whichever has the higher WCAG contrast ratio.
 *
 * @param hex - The background color the foreground sits on.
 */
export function foregroundForHex(hex: string): string {
  const digits = expandHex(hex);
  // Fall back to white for invalid input (matches the default light-on-accent).
  if (!digits) return "0 0% 100%";

  const linearize = (value: number) => {
    const channel = value / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  };
  const luminance =
    0.2126 * linearize(parseInt(digits.slice(0, 2), 16)) +
    0.7152 * linearize(parseInt(digits.slice(2, 4), 16)) +
    0.0722 * linearize(parseInt(digits.slice(4, 6), 16));

  const contrastWithWhite = 1.05 / (luminance + 0.05);
  const contrastWithBlack = (luminance + 0.05) / 0.05;
  // White text, or the palette's near-black foreground.
  return contrastWithWhite >= contrastWithBlack ? "0 0% 100%" : "222.2 47.4% 11.2%";
}

/** Accent tokens the custom scheme overrides inline (cleared on other schemes). */
const CUSTOM_TOKEN_PROPERTIES = ["--primary", "--primary-foreground", "--ring"] as const;

/**
 * Apply (or clear) the active accent scheme on the document root.
 *
 * - Presets set a `data-theme` attribute (the default scheme sets none, matching
 *   the base `:root` / `.dark` tokens).
 * - The custom scheme injects accent tokens derived from `customColor` as inline
 *   styles, which override the stylesheet in both light and dark mode.
 *
 * @param scheme - The accent scheme to activate.
 * @param customColor - The hex color backing the "custom" scheme.
 */
export function applyThemeScheme(scheme: ThemeScheme, customColor?: string): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;

  // Always clear any inline tokens from a previous custom selection first, so
  // switching back to a preset/default does not leave the custom color stuck.
  for (const property of CUSTOM_TOKEN_PROPERTIES) {
    root.style.removeProperty(property);
  }

  if (scheme === "custom") {
    root.removeAttribute("data-theme");
    // Guard on `customColor` (not just the parsed channels) so TypeScript knows
    // it is a string when computing the foreground, no cast needed.
    const channels = customColor ? hexToHslChannels(customColor) : null;
    if (customColor && channels) {
      root.style.setProperty("--primary", channels);
      root.style.setProperty("--primary-foreground", foregroundForHex(customColor));
      root.style.setProperty("--ring", channels);
    }
    // An invalid/empty custom color leaves the base tokens in place.
    return;
  }

  // The default scheme has no `[data-theme]` block — its tokens equal the base
  // `:root` / `.dark` rules, so clearing the attribute applies them (see the
  // invariant on DEFAULT_THEME_SCHEME). Every other preset has a matching block.
  if (scheme === DEFAULT_THEME_SCHEME) {
    root.removeAttribute("data-theme");
  } else {
    root.setAttribute("data-theme", scheme);
  }
}
