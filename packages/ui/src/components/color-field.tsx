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
  /** Accessible label for the screen eyedropper button. */
  eyedropperLabel?: string;
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
      className,
      disabled,
      eyedropperLabel = "Pick a color from the screen",
      ...props
    },
    ref,
  ) => {
    // Feature-detect after mount so the rendered output stays deterministic
    // across environments that prerender the build.
    const [supportsEyeDropper, setSupportsEyeDropper] = React.useState(false);
    React.useEffect(() => {
      setSupportsEyeDropper(
        typeof window !== "undefined" && typeof window.EyeDropper === "function",
      );
    }, []);

    const pickFromScreen = React.useCallback(async () => {
      if (typeof window === "undefined" || typeof window.EyeDropper !== "function") {
        return;
      }
      try {
        const result = await new window.EyeDropper().open();
        if (result?.sRGBHex) onChange(result.sRGBHex);
      } catch {
        // The user dismissed the eyedropper (Escape or click-away); ignore.
      }
    }, [onChange]);

    return (
      <div className="flex items-center gap-2">
        <Input
          ref={ref}
          type="color"
          value={value}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
          className={cn(supportsEyeDropper && "flex-1", className)}
          {...props}
        />
        {supportsEyeDropper ? (
          <button
            type="button"
            onClick={pickFromScreen}
            disabled={disabled}
            aria-label={eyedropperLabel}
            title={eyedropperLabel}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-input bg-transparent text-muted-foreground shadow-xs transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:border-2 focus-visible:border-ring focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Pipette className="h-4 w-4" aria-hidden="true" />
          </button>
        ) : null}
      </div>
    );
  },
);
ColorField.displayName = "ColorField";
