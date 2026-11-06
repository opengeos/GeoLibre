import { useTranslation } from "react-i18next";
import { Button, Input, Label } from "@geolibre/ui";

interface BackgroundColorFieldProps {
  /** Id of the colour picker, which the label points at. */
  id: string;
  label: string;
  /** The committed colour. */
  value: string;
  /** The free-form hex field's text (may be a half-typed colour). */
  draft: string;
  /** The colour the reset button restores. */
  resetValue: string;
  /** Called with every pick or keystroke; the reducer commits complete hex colours. */
  onCommit: (value: string) => void;
}

/**
 * The value for the native colour picker, which accepts only `#rrggbb`: a
 * `#rgb` shorthand is expanded, and anything else shows `fallback` instead of
 * the picker's own black. The draft and the committed colour are unchanged.
 */
export function pickerColor(value: string, fallback: string): string {
  const hex = value.trim();
  if (/^#[0-9a-f]{6}$/i.test(hex)) return hex;
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(hex);
  return short ? `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}` : fallback;
}

/** A background colour: a picker, a free-form hex field and a reset button. */
export function BackgroundColorField({
  id,
  label,
  value,
  draft,
  resetValue,
  onCommit,
}: BackgroundColorFieldProps) {
  const { t } = useTranslation();
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <div className="flex items-center gap-2">
        <input
          id={id}
          type="color"
          className="h-9 w-12 shrink-0 cursor-pointer rounded-md border border-input bg-background"
          value={pickerColor(value, resetValue)}
          onChange={(e) => onCommit(e.target.value)}
        />
        <Input
          aria-label={label}
          className="flex-1"
          value={draft}
          onChange={(e) => onCommit(e.target.value)}
        />
        <Button variant="ghost" size="sm" onClick={() => onCommit(resetValue)}>
          {t("common.reset")}
        </Button>
      </div>
    </div>
  );
}
