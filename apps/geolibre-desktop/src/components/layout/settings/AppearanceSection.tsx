import { cn } from "@geolibre/ui";
import { Check, Moon, Sun } from "lucide-react";
import { useRef, useState, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { useDesktopSettingsStore } from "../../../hooks/useDesktopSettings";
import type { ThemeMode } from "../../../hooks/useThemeMode";
import { THEME_SCHEMES, normalizeHexColor, type ThemeScheme } from "../../../lib/theme-schemes";

/**
 * Apply an accent scheme live (instant preview) rather than waiting for Save,
 * mirroring the Interface profile toggles. Reads the latest state so a rapid
 * click after another live change does not clobber it with a stale
 * render-closure snapshot.
 *
 * Args:
 *   scheme: The accent scheme to apply.
 */
export function updateSavedThemeScheme(scheme: ThemeScheme): void {
  const { desktopSettings: current, setDesktopSettings } = useDesktopSettingsStore.getState();
  setDesktopSettings({ ...current, theme: { ...current.theme, scheme } });
}

/**
 * Store a custom accent color and activate the custom scheme, so editing the
 * swatch immediately previews it.
 *
 * Args:
 *   customColor: The `#rrggbb` color.
 */
function updateSavedThemeCustomColor(customColor: string): void {
  const { desktopSettings: current, setDesktopSettings } = useDesktopSettingsStore.getState();
  setDesktopSettings({
    ...current,
    theme: { ...current.theme, scheme: "custom", customColor },
  });
}

interface AppearanceSectionProps {
  /** Current light/dark mode, surfaced as toggles here (issue #716). */
  themeMode: ThemeMode;
  /** Flip the light/dark mode. */
  onToggleThemeMode: () => void;
  /**
   * The native color input. The accent-color dropdown's "Custom" entry
   * deep-links here so picking a custom color is reachable without a
   * third-level menu (#718); the dialog shell focuses it.
   */
  customColorInputRef: RefObject<HTMLInputElement | null>;
}

/**
 * The Appearance section: light/dark mode and the accent color. Changes apply
 * live rather than on Save.
 *
 * Args:
 *   props: The section props.
 *
 * Returns:
 *   The section content.
 */
export function AppearanceSection({
  themeMode,
  onToggleThemeMode,
  customColorInputRef,
}: AppearanceSectionProps) {
  const { t } = useTranslation();
  const desktopSettings = useDesktopSettingsStore((s) => s.desktopSettings);

  // In-progress text for the inline hex field next to the swatch. While the user
  // is typing or pasting a code it holds the raw string; `null` means the field
  // mirrors the saved color. On commit a valid 3- or 6-digit hex applies and an
  // invalid one is discarded, so the field reverts to the last valid color (#911).
  // Section-local: the section unmounts when the dialog closes, so a half-typed
  // value never resurfaces on the next open.
  const [customColorDraft, setCustomColorDraft] = useState<string | null>(null);
  // Set just before the Escape-triggered blur so the imminent blur discards the
  // draft instead of committing it: the dialog still closes (its own Escape
  // handler), but the typed value is cancelled rather than applied on the way out.
  const skipCustomColorCommitRef = useRef(false);

  const commitCustomColorDraft = () => {
    if (skipCustomColorCommitRef.current) {
      skipCustomColorCommitRef.current = false;
      setCustomColorDraft(null);
      return;
    }
    if (customColorDraft === null) return;
    const normalized = normalizeHexColor(customColorDraft);
    if (normalized) updateSavedThemeCustomColor(normalized);
    setCustomColorDraft(null);
  };

  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-sm font-semibold">{t("settings.appearance.title")}</h3>
        <p className="text-xs text-muted-foreground">{t("settings.appearance.description")}</p>
      </div>
      <div className="space-y-3">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {t("settings.appearance.themeMode")}
        </h4>
        {/* Light/dark cards so the mode lives beside the accent
            color instead of only on the toolbar (#716). The mode is
            a two-state toggle, so a non-active card just flips it. */}
        <div className="grid grid-cols-2 gap-3">
          {(["light", "dark"] as const).map((mode) => {
            const active = themeMode === mode;
            const ModeIcon = mode === "light" ? Sun : Moon;
            return (
              <button
                key={mode}
                type="button"
                aria-pressed={active}
                onClick={() => {
                  if (!active) onToggleThemeMode();
                }}
                className={cn(
                  "flex items-center gap-2.5 rounded-md border p-3 text-sm transition-colors",
                  active ? "border-primary ring-2 ring-ring" : "hover:bg-accent",
                )}
              >
                <ModeIcon className="h-5 w-5 shrink-0" />
                <span>{t(`settings.appearance.mode.${mode}`)}</span>
                {active ? <Check className="ms-auto h-4 w-4 text-primary" /> : null}
              </button>
            );
          })}
        </div>
      </div>
      <div className="space-y-3">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {t("settings.appearance.accentColor")}
        </h4>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {THEME_SCHEMES.map((scheme) => {
            const active = desktopSettings.theme.scheme === scheme.id;
            return (
              <button
                key={scheme.id}
                type="button"
                aria-pressed={active}
                onClick={() => updateSavedThemeScheme(scheme.id)}
                className={cn(
                  "flex items-center gap-2.5 rounded-md border p-3 text-sm transition-colors",
                  active ? "border-primary ring-2 ring-ring" : "hover:bg-accent",
                )}
              >
                <span
                  aria-hidden
                  className="h-5 w-5 shrink-0 rounded-full border"
                  style={{ backgroundColor: scheme.swatch }}
                />
                <span>{t(scheme.labelKey)}</span>
                {active ? <Check className="ms-auto h-4 w-4 text-primary" /> : null}
              </button>
            );
          })}
          <button
            type="button"
            aria-pressed={desktopSettings.theme.scheme === "custom"}
            onClick={() => updateSavedThemeScheme("custom")}
            className={cn(
              "flex items-center gap-2.5 rounded-md border p-3 text-sm transition-colors",
              desktopSettings.theme.scheme === "custom"
                ? "border-primary ring-2 ring-ring"
                : "hover:bg-accent",
            )}
          >
            <span
              aria-hidden
              className="h-5 w-5 shrink-0 rounded-full border"
              style={{
                backgroundColor: desktopSettings.theme.customColor,
              }}
            />
            <span>{t("settings.appearance.custom")}</span>
            {desktopSettings.theme.scheme === "custom" ? (
              <Check className="ms-auto h-4 w-4 text-primary" />
            ) : null}
          </button>
        </div>
        {desktopSettings.theme.scheme === "custom" ? (
          <label className="flex items-center gap-3 rounded-md border p-3 text-sm">
            <input
              ref={customColorInputRef}
              type="color"
              className="h-8 w-12 shrink-0 cursor-pointer rounded border bg-transparent p-0.5"
              value={desktopSettings.theme.customColor}
              onChange={(event) => updateSavedThemeCustomColor(event.target.value)}
              aria-label={t("settings.appearance.customColor")}
            />
            <span>{t("settings.appearance.customColor")}</span>
            {/* Inline hex entry so power users can type or paste an
                exact code instead of only dragging the native picker.
                The text input is interactive content, so a click lands
                here and focuses it rather than reopening the picker the
                wrapping label drives (#911). */}
            <input
              type="text"
              spellCheck={false}
              autoComplete="off"
              className="ms-auto w-24 rounded border bg-transparent px-2 py-1 text-end font-mono text-xs uppercase text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring aria-[invalid=true]:border-destructive aria-[invalid=true]:text-destructive"
              value={customColorDraft ?? desktopSettings.theme.customColor}
              // The field already holds a full `#rrggbb`, so select
              // all on focus to let the user type a replacement.
              onFocus={(event) => event.target.select()}
              // Drop whitespace and cap to the longest valid form
              // (`#rrggbb`) as the draft is stored, so a padded or
              // oversized paste is sanitized in place instead of
              // sitting clobbered; this also bounds a runaway paste
              // without a brittle maxLength that has to guess how
              // much surrounding whitespace to allow.
              onChange={(event) =>
                setCustomColorDraft(event.target.value.replace(/\s/g, "").slice(0, 7))
              }
              onBlur={commitCustomColorDraft}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  // Blur is the single commit path; the resulting
                  // onBlur applies/reverts the draft, so don't also
                  // commit here and double-write the same value.
                  event.preventDefault();
                  event.currentTarget.blur();
                } else if (event.key === "Escape") {
                  // Cancel the edit: flag the commit to skip, then
                  // blur so the value is dropped, not applied. The
                  // dialog's own Escape handling still closes it.
                  skipCustomColorCommitRef.current = true;
                  event.currentTarget.blur();
                }
              }}
              aria-label={t("settings.appearance.customColorHex")}
              // `|| undefined` omits the attribute entirely when
              // valid; a literal aria-invalid="false" makes some
              // screen readers announce "invalid: false" on focus.
              aria-invalid={
                (customColorDraft !== null &&
                  customColorDraft.trim() !== "" &&
                  normalizeHexColor(customColorDraft) === null) ||
                undefined
              }
            />
          </label>
        ) : null}
      </div>
    </div>
  );
}
