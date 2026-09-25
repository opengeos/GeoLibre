import { type MouseEvent as ReactMouseEvent, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Input, Slider } from "@geolibre/ui";
import { clamp } from "../../../lib/clamp";

interface LayerOpacitySliderProps {
  label: string;
  ariaLabel: string;
  value: number;
  onChange: (value: number) => void;
}

// Opacity control for the layer panel cards: a compact slider paired with a
// value readout that, on double-click, swaps to an inline numeric input so the
// user can type an exact value instead of dragging to it. This mirrors the
// Style panel's RasterStyleSlider (#832) to keep interaction parity between the
// two panels (#838). Enter/blur commits the clamped value, Escape cancels.
export function LayerOpacitySlider({ label, ariaLabel, value, onChange }: LayerOpacitySliderProps) {
  const { t } = useTranslation();
  const min = 0;
  const max = 1;
  const step = 0.05;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  // Guard so each edit session commits (or cancels) at most once: Enter and
  // Escape both tear down the input, and React still fires onBlur on the
  // unmounting element. Without this, blur would re-commit after Enter or
  // commit a cancelled draft after Escape.
  const handledRef = useRef(false);

  const commit = (raw: string) => {
    if (handledRef.current) return;
    handledRef.current = true;
    const parsed = Number(raw);
    // Treat an empty/whitespace entry like Escape: cancel rather than commit 0
    // (Number("") === 0 would otherwise silently reset the slider to its min).
    if (raw.trim() !== "" && Number.isFinite(parsed)) {
      onChange(Number(clamp(parsed, min, max).toFixed(2)));
    }
    setEditing(false);
  };

  const cancel = () => {
    handledRef.current = true;
    setEditing(false);
  };

  const startEditing = () => {
    // The slider stays mounted while editing, so a second double-click on its
    // track must not re-enter and clobber the in-progress draft (the value
    // button is unmounted while editing, so it cannot re-trigger this).
    if (editing) return;
    handledRef.current = false;
    setDraft(value.toFixed(2));
    setEditing(true);
  };

  return (
    <div className="mt-2 flex items-center gap-1">
      <span className="text-[10px] text-muted-foreground">{label}</span>
      <Slider
        aria-label={ariaLabel}
        className="flex-1"
        min={min}
        max={max}
        step={step}
        value={[value]}
        onValueChange={([v]: number[]) => onChange(v ?? value)}
        onClick={(e: ReactMouseEvent) => e.stopPropagation()}
        onDoubleClick={(e: ReactMouseEvent) => {
          e.stopPropagation();
          startEditing();
        }}
      />
      {editing ? (
        <Input
          type="number"
          min={min}
          max={max}
          step={step}
          autoFocus
          aria-label={t("layers.opacityValueInputAria", { label: ariaLabel })}
          className="h-6 w-12 px-1 py-0 text-end font-mono text-[10px] [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onClick={(e: ReactMouseEvent) => e.stopPropagation()}
          onBlur={(e) => commit(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") {
              e.preventDefault();
              commit((e.target as HTMLInputElement).value);
            } else if (e.key === "Escape") {
              e.preventDefault();
              cancel();
            }
          }}
        />
      ) : (
        <button
          type="button"
          className="w-9 shrink-0 cursor-text text-end font-mono text-[10px] tabular-nums text-muted-foreground hover:text-foreground"
          title={t("layers.opacityExactHint")}
          aria-label={t("layers.opacityValueEditAria", { label: ariaLabel })}
          onClick={(e: ReactMouseEvent) => e.stopPropagation()}
          onDoubleClick={(e: ReactMouseEvent) => {
            e.stopPropagation();
            startEditing();
          }}
        >
          {value.toFixed(2)}
        </button>
      )}
    </div>
  );
}
