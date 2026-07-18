import * as React from "react";
import { Pipette } from "lucide-react";
import { cn } from "../lib/utils";
import { Input } from "./input";

/**
 * The sentinel value a {@link ColorField} stores when its transparent toggle is
 * on. It is the CSS/MapLibre `transparent` keyword, so it flows straight through
 * to paint properties (an invisible fill/outline) and round-trips through the
 * project format as a plain string.
 */
export const TRANSPARENT_COLOR = "transparent";

/** Whether a color value is the {@link TRANSPARENT_COLOR} sentinel. */
export function isTransparentColor(value: string): boolean {
  return value.trim().toLowerCase() === TRANSPARENT_COLOR;
}

// The EyeDropper API is not yet part of TypeScript's DOM lib, so declare the
// minimal surface we use. Unlike the native color input's built-in eyedropper
// (whose magnifier can render *behind* the picker popup in some browsers), the
// EyeDropper API draws its magnifier as a top-level browser overlay above all
// page content, so any visible color can be sampled.
interface EyeDropperResult {
  sRGBHex: string;
}

interface EyeDropperInstance {
  open: (options?: { signal?: AbortSignal }) => Promise<EyeDropperResult>;
}

interface EyeDropperConstructor {
  new (): EyeDropperInstance;
}

declare global {
  interface Window {
    EyeDropper?: EyeDropperConstructor;
  }
}

export interface ColorFieldProps extends Omit<
  React.InputHTMLAttributes<HTMLInputElement>,
  "type" | "value" | "onChange"
> {
  /**
   * The current color as a `#rrggbb` hex string, or `TRANSPARENT_COLOR` when
   * the transparent toggle is on (only possible with `allowTransparent`).
   */
  value: string;
  /**
   * Called with the new `#rrggbb` hex string from the swatch or eyedropper, or
   * `TRANSPARENT_COLOR` when the transparent toggle is checked.
   */
  onChange: (hex: string) => void;
  /**
   * Called once after a screen-eyedropper pick commits a color. Callers using a
   * preview-while-dragging / commit-on-blur model (where `onChange` only
   * previews) should commit here, since the eyedropper never fires a blur.
   */
  onCommit?: () => void;
  /**
   * Accessible label for the screen eyedropper button. The English default is a
   * fallback for this i18n-free primitive package; app call-sites that support
   * react-i18next should pass a `t()`-translated value.
   */
  eyedropperLabel?: string;
  /**
   * When true (default), the swatch grows to fill the available width and the
   * field is a block-level flex row — suited to full-width form fields. Set
   * false for compact inline swatches that should keep their own width.
   */
  fill?: boolean;
  /**
   * Classes applied to the inner color swatch `<input>` (not the wrapper). Use
   * to size the swatch; pair with `buttonClassName` to match the eyedropper.
   */
  className?: string;
  /** Classes sizing the eyedropper button; match the swatch for compact rows. */
  buttonClassName?: string;
  /**
   * When true, a "Transparent" checkbox is shown after the swatch (QGIS-style
   * "no color"). Checking it calls `onChange(TRANSPARENT_COLOR)`; the swatch is
   * overlaid with a checkerboard + red slash that reads as "no color".
   * Unchecking (or picking a color from the still-clickable swatch/eyedropper)
   * restores an opaque value. Use for fill/outline colors where an invisible
   * value is meaningful.
   *
   * Note: the checkbox is the reliable way to clear transparency. Picking from
   * the native swatch also clears it, except in the edge case where the user
   * re-selects the exact remembered color — `<input type="color">` fires no
   * `change` event when the value is unchanged, so the transparent state would
   * persist. The checkbox covers that case.
   */
  allowTransparent?: boolean;
  /** Label for the transparent checkbox. Pass a `t()` value from app call-sites. */
  transparentLabel?: string;
  /** Tooltip shown on the swatch while transparent. Pass a `t()` value. */
  transparentSwatchLabel?: string;
  /**
   * Opaque color restored when the user clears transparency on a field that was
   * already `TRANSPARENT_COLOR` at mount (no prior opaque color to remember).
   * Defaults to black; call-sites should pass the domain default (e.g. the
   * layer style's default fill/stroke color) for a more meaningful restore.
   */
  fallbackColor?: string;
}

/**
 * A color input pairing the native color swatch with a screen eyedropper.
 *
 * The eyedropper button is shown only when the browser exposes the
 * `EyeDropper` API; its magnifier overlays the whole screen, so colors shown
 * inside the picker UI itself can be sampled — unlike the native color input's
 * built-in eyedropper, which can render behind the picker popup.
 */
export const ColorField = React.forwardRef<HTMLInputElement, ColorFieldProps>(
  (
    {
      value,
      onChange,
      onCommit,
      className,
      disabled,
      eyedropperLabel = "Pick a color from the screen",
      fill = true,
      buttonClassName = "h-9 w-9",
      allowTransparent = false,
      transparentLabel = "Transparent",
      transparentSwatchLabel = "No color (transparent). Click to choose a color.",
      fallbackColor = "#000000",
      // `title`/`name`/`form` are pulled out so they can be applied
      // conditionally below: `title` must win over a forwarded value while
      // transparent, and a `name`d color input would otherwise submit the
      // remembered opaque hex instead of the transparent sentinel.
      title,
      name,
      form,
      ...props
    },
    ref,
  ) => {
    const transparent = allowTransparent && isTransparentColor(value);
    // Remember the last opaque color so unchecking "Transparent" can restore it
    // rather than snapping to an arbitrary default. Seed it from the prop at
    // mount so a layer that is opaque on first render is captured immediately;
    // a layer with no prior opaque color (mounted transparent, or empty) falls
    // back to `fallbackColor` until the user picks one. The guard keys off the
    // value itself (not the `transparent` flag, which also depends on
    // `allowTransparent`) so the ref can never hold the transparent sentinel.
    const lastOpaqueRef = React.useRef(isTransparentColor(value) || !value ? fallbackColor : value);
    // Keep the remembered color current via an effect rather than a render-time
    // ref write, so a discarded/replayed concurrent render can't double-apply.
    React.useEffect(() => {
      if (value && !isTransparentColor(value)) lastOpaqueRef.current = value;
    }, [value]);
    // Feature-detect after mount so the rendered output stays deterministic
    // across environments that prerender the build.
    const [supportsEyeDropper, setSupportsEyeDropper] = React.useState(false);
    // Abort any in-flight pick when the field unmounts so a late resolution
    // doesn't call onChange on a gone parent.
    const abortRef = React.useRef<AbortController | null>(null);
    React.useEffect(() => {
      setSupportsEyeDropper(
        typeof window !== "undefined" && typeof window.EyeDropper === "function",
      );
      return () => abortRef.current?.abort();
    }, []);

    const pickFromScreen = React.useCallback(async () => {
      if (typeof window === "undefined" || typeof window.EyeDropper !== "function") {
        return;
      }
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      try {
        const result = await new window.EyeDropper().open({
          signal: controller.signal,
        });
        if (result?.sRGBHex) {
          onChange(result.sRGBHex);
          onCommit?.();
        }
      } catch (err) {
        // AbortError = the user dismissed the picker (Escape / click-away) or
        // the field unmounted mid-pick; anything else is unexpected, so re-throw
        // to surface it in the browser console instead of swallowing silently.
        if (err instanceof DOMException && err.name === "AbortError") return;
        throw err;
      }
    }, [onChange, onCommit]);

    const setTransparent = React.useCallback(
      (next: boolean) => {
        onChange(next ? TRANSPARENT_COLOR : lastOpaqueRef.current);
        onCommit?.();
      },
      [onChange, onCommit],
    );

    return (
      <div className={cn("flex items-center gap-2", !fill && "inline-flex")}>
        {/* The native swatch stays mounted even while transparent so the
            forwarded ref, `id`, and the rest of `...props` (the StylePanel
            `Label htmlFor` target, ARIA wiring, etc.) always point at a usable
            control. When transparent it shows the remembered opaque color under
            a decorative checkerboard + red slash that reads as "no color";
            since the overlay is pointer-events-none, clicking the swatch (or
            the eyedropper) still opens the picker and commits a hex, which
            clears the transparent state. */}
        <div
          className={cn(
            "relative inline-flex",
            // Grow to fill the row whenever the field is full-width, so the
            // `w-full` swatch has a real width to fill. Gating this on
            // `supportsEyeDropper` collapsed the swatch to a thin vertical line
            // in browsers/webviews without the EyeDropper API (Firefox, Safari,
            // the desktop webview), where the eyedropper button is absent.
            fill && "flex-1",
          )}
        >
          {/* While transparent, the visible color input is left unnamed and a
              hidden input carries `name`/`form` so a form submits the
              transparent sentinel rather than the remembered opaque hex. */}
          {transparent && name ? (
            <input
              type="hidden"
              name={name}
              form={form}
              disabled={disabled}
              value={TRANSPARENT_COLOR}
            />
          ) : null}
          <Input
            ref={ref}
            type="color"
            name={transparent ? undefined : name}
            form={form}
            value={transparent ? lastOpaqueRef.current : value}
            disabled={disabled}
            title={transparent ? transparentSwatchLabel : title}
            // The swatch shows the remembered opaque color while transparent, so
            // give assistive tech an accessible name that conveys the "no color"
            // state instead of letting it announce that opaque value.
            aria-label={transparent ? transparentSwatchLabel : undefined}
            onChange={(event) => onChange(event.target.value)}
            // `peer` so the overlay (which covers the input's own
            // focus-visible border) can re-expose the focus ring below.
            className={cn("peer", fill && "w-full", className)}
            {...props}
          />
          {transparent ? (
            <span
              aria-hidden="true"
              className="pointer-events-none absolute inset-0 overflow-hidden rounded-md border border-input peer-focus-visible:border-2 peer-focus-visible:border-ring"
              style={{
                backgroundColor: "hsl(var(--background))",
                backgroundImage:
                  "linear-gradient(45deg, hsl(var(--muted-foreground) / 0.35) 25%, transparent 25%), linear-gradient(-45deg, hsl(var(--muted-foreground) / 0.35) 25%, transparent 25%), linear-gradient(45deg, transparent 75%, hsl(var(--muted-foreground) / 0.35) 75%), linear-gradient(-45deg, transparent 75%, hsl(var(--muted-foreground) / 0.35) 75%)",
                backgroundSize: "8px 8px",
                backgroundPosition: "0 0, 0 4px, 4px -4px, -4px 0",
              }}
            >
              <span
                className="absolute inset-0"
                style={{
                  background:
                    "linear-gradient(to top right, transparent calc(50% - 1px), #ef4444 calc(50% - 1px), #ef4444 calc(50% + 1px), transparent calc(50% + 1px))",
                }}
              />
            </span>
          ) : null}
        </div>
        {supportsEyeDropper ? (
          <button
            type="button"
            onClick={pickFromScreen}
            disabled={disabled}
            aria-label={eyedropperLabel}
            title={eyedropperLabel}
            className={cn(
              "flex shrink-0 items-center justify-center rounded-md border border-input bg-transparent text-muted-foreground shadow-xs transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:border-2 focus-visible:border-ring focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50",
              buttonClassName,
            )}
          >
            <Pipette className="h-4 w-4" aria-hidden="true" />
          </button>
        ) : null}
        {allowTransparent ? (
          <label className="flex shrink-0 cursor-pointer items-center gap-1.5 text-xs text-muted-foreground select-none">
            <input
              type="checkbox"
              checked={transparent}
              disabled={disabled}
              onChange={(event) => setTransparent(event.target.checked)}
              className="h-3.5 w-3.5 cursor-pointer accent-primary disabled:cursor-not-allowed"
            />
            {transparentLabel}
          </label>
        ) : null}
      </div>
    );
  },
);
ColorField.displayName = "ColorField";
