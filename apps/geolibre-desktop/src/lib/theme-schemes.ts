/**
 * Accent color schemes layered on top of the light/dark mode. A scheme only
 * re-tints the accent-bearing tokens (`--primary`, `--primary-foreground`,
 * `--ring`); the neutral base (background, border, muted) is shared. The actual
 * token values live in `packages/ui/src/globals.css` under `[data-theme="<id>"]`
 * selectors. This module is the single source of truth for the valid scheme ids
 * and the picker UI (label key + representative swatch color).
 */
export type ThemeScheme = "blue" | "violet" | "emerald" | "rose" | "amber";

/**
 * The default scheme matches the base `:root` / `.dark` tokens already shipped in
 * `globals.css`, so no `data-theme` attribute is set for it.
 */
export const DEFAULT_THEME_SCHEME: ThemeScheme = "blue";

export interface ThemeSchemeOption {
  id: ThemeScheme;
  /** i18n key for the display label (typed so `t()` accepts it directly). */
  labelKey:
    | "settings.appearance.scheme.blue"
    | "settings.appearance.scheme.violet"
    | "settings.appearance.scheme.emerald"
    | "settings.appearance.scheme.rose"
    | "settings.appearance.scheme.amber";
  /** Representative swatch color (`hsl()`) shown as the picker dot. */
  swatch: string;
}

/** Selectable accent schemes, in picker order. Single source of truth. */
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

/** Type guard for persisted/tampered values. */
export function isThemeScheme(value: unknown): value is ThemeScheme {
  return (
    typeof value === "string" &&
    THEME_SCHEMES.some((scheme) => scheme.id === value)
  );
}

/**
 * Apply (or clear) the active accent scheme on the document root. The default
 * scheme removes the attribute so the base `:root` / `.dark` tokens apply.
 *
 * @param scheme - The accent scheme to activate.
 */
export function applyThemeScheme(scheme: ThemeScheme): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  if (scheme === DEFAULT_THEME_SCHEME) {
    root.removeAttribute("data-theme");
  } else {
    root.setAttribute("data-theme", scheme);
  }
}
