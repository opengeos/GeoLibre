import * as React from "react";
import { Pipette } from "lucide-react";
import { cn } from "../lib/utils";
import { Input } from "./input";

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

export interface ColorFieldProps
  extends Omit<
    React.InputHTMLAttributes<HTMLInputElement>,
    "type" | "value" | "onChange"
  > {
  /** The current color as a `#rrggbb` hex string. */
  value: string;
  /** Called with the new `#rrggbb` hex string from the swatch or eyedropper. */
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
      ...props
    },
    ref,
  ) => {
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

    return (
      <div className={cn("flex items-center gap-2", !fill && "inline-flex")}>
        <Input
          ref={ref}
          type="color"
          value={value}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
          className={cn(supportsEyeDropper && fill && "flex-1", className)}
          {...props}
        />
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
      </div>
    );
  },
);
ColorField.displayName = "ColorField";
