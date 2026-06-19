import {
  DEFAULT_EFFECTS_SETTINGS,
  type EffectsSettings,
  HALO_EXTENT_MAX,
  HALO_EXTENT_MIN,
  HALO_OPACITY_MAX,
  HALO_OPACITY_MIN,
} from "@geolibre/plugins";
import {
  Button,
  ColorField,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
  Slider,
} from "@geolibre/ui";
import { ClipboardList, SlidersHorizontal } from "lucide-react";
import { type MouseEvent as ReactMouseEvent, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ToolbarPanels } from "../../../hooks/useToolbarPanels";
import { useDesktopSettingsStore } from "../../../hooks/useDesktopSettings";
import { isMenuItemVisible } from "../../../lib/ui-profile";
import {
  MAP_CONTROL_ITEMS,
  type ToolbarChrome,
  type ToolbarMapControl,
} from "./constants";

interface ControlsMenuProps {
  chrome: ToolbarChrome;
  controlsVisible: Record<ToolbarMapControl, boolean>;
  panels: ToolbarPanels;
  effectsActive: boolean;
  directionsActive: boolean;
  reverseGeocodeActive: boolean;
  onToggleMapControl: (control: ToolbarMapControl) => void;
  onToggleEffects: () => void;
  getEffectsSettings: () => EffectsSettings;
  onPreviewEffectsSettings: (next: Partial<EffectsSettings>) => void;
  onCommitEffectsSettings: () => void;
  onToggleDirections: () => void;
  onToggleReverseGeocode: () => void;
  onOpenFieldCollection: () => void;
}

/** The Controls menu: built-in map controls, atmosphere/routing toggles, and panels. */
export function ControlsMenu({
  chrome,
  controlsVisible,
  panels,
  effectsActive,
  directionsActive,
  reverseGeocodeActive,
  onToggleMapControl,
  onToggleEffects,
  getEffectsSettings,
  onPreviewEffectsSettings,
  onCommitEffectsSettings,
  onToggleDirections,
  onToggleReverseGeocode,
  onOpenFieldCollection,
}: ControlsMenuProps) {
  const { t } = useTranslation();
  const uiProfile = useDesktopSettingsStore((s) => s.desktopSettings.uiProfile);
  const show = (id: string) => isMenuItemVisible(uiProfile, id);
  // Whether the first group (built-in controls + atmosphere/routing toggles) has
  // any visible item, so the separator below it isn't left orphaned.
  const anyTopControls =
    MAP_CONTROL_ITEMS.some((control) =>
      show(`controls.mapControl.${control.id}`),
    ) ||
    show("controls.atmosphereEffects") ||
    show("controls.spinGlobe") ||
    show("controls.directions") ||
    show("controls.reverseGeocode");

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          className={chrome.buttonClass}
          variant="ghost"
          size={chrome.buttonSize}
          aria-label={t("toolbar.menu.controls")}
        >
          <SlidersHorizontal className={chrome.iconClassName} />
          {chrome.renderLabel(t("toolbar.menu.controls"))}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuLabel>{t("toolbar.item.mapControls")}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {MAP_CONTROL_ITEMS.filter((control) =>
          show(`controls.mapControl.${control.id}`),
        ).map((control) => (
          <DropdownMenuItem
            key={control.id}
            onClick={() => onToggleMapControl(control.id)}
          >
            {t(control.labelKey)}
            {controlsVisible[control.id] ? " ✓" : ""}
          </DropdownMenuItem>
        ))}
        {show("controls.atmosphereEffects") && (
          <AtmosphereEffectsSubmenu
            active={effectsActive}
            onToggle={onToggleEffects}
            getSettings={getEffectsSettings}
            onPreview={onPreviewEffectsSettings}
            onCommit={onCommitEffectsSettings}
          />
        )}
        {show("controls.spinGlobe") && (
          <DropdownMenuItem onSelect={panels.spinGlobe.toggle}>
            {t("toolbar.item.spinGlobe")}
            {panels.spinGlobe.visible ? " ✓" : ""}
          </DropdownMenuItem>
        )}
        {show("controls.directions") && (
          <DropdownMenuItem
            title={t("toolbar.item.directionsTooltip")}
            onClick={onToggleDirections}
          >
            {t("toolbar.item.directions")}
            {directionsActive ? " ✓" : ""}
          </DropdownMenuItem>
        )}
        {show("controls.reverseGeocode") && (
          <DropdownMenuItem
            title={t("toolbar.item.reverseGeocodeTooltip")}
            onClick={onToggleReverseGeocode}
          >
            {t("toolbar.item.reverseGeocode")}
            {reverseGeocodeActive ? " ✓" : ""}
          </DropdownMenuItem>
        )}
        {anyTopControls && <DropdownMenuSeparator />}
        {show("controls.search") && (
          <DropdownMenuItem onSelect={panels.searchPlaces.toggle}>
            {t("toolbar.item.search")}
            {panels.searchPlaces.visible ? " ✓" : ""}
          </DropdownMenuItem>
        )}
        {show("controls.colorbar") && (
          <DropdownMenuItem onSelect={panels.colorbar.toggle}>
            {t("toolbar.item.colorbar")}
            {panels.colorbar.visible ? " ✓" : ""}
          </DropdownMenuItem>
        )}
        {show("controls.legend") && (
          <DropdownMenuItem onSelect={panels.legend.toggle}>
            {t("toolbar.item.legend")}
            {panels.legend.visible ? " ✓" : ""}
          </DropdownMenuItem>
        )}
        {show("controls.html") && (
          <DropdownMenuItem onSelect={panels.html.toggle}>
            {t("toolbar.item.html")}
            {panels.html.visible ? " ✓" : ""}
          </DropdownMenuItem>
        )}
        {show("controls.measure") && (
          <DropdownMenuItem onSelect={panels.measure.toggle}>
            {t("toolbar.item.measure")}
            {panels.measure.visible ? " ✓" : ""}
          </DropdownMenuItem>
        )}
        {show("controls.bookmark") && (
          <DropdownMenuItem onSelect={panels.bookmark.toggle}>
            {t("toolbar.item.bookmark")}
            {panels.bookmark.visible ? " ✓" : ""}
          </DropdownMenuItem>
        )}
        {show("controls.minimap") && (
          <DropdownMenuItem onSelect={panels.minimap.toggle}>
            {t("toolbar.item.minimap")}
            {panels.minimap.visible ? " ✓" : ""}
          </DropdownMenuItem>
        )}
        {show("controls.viewState") && (
          <DropdownMenuItem onSelect={panels.viewState.toggle}>
            {t("toolbar.item.viewState")}
            {panels.viewState.visible ? " ✓" : ""}
          </DropdownMenuItem>
        )}
        {show("controls.fieldCollection") && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={onOpenFieldCollection}>
              <ClipboardList className="mr-2 h-3.5 w-3.5" />
              {t("toolbar.item.fieldCollection")}
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

interface AtmosphereEffectsSubmenuProps {
  active: boolean;
  onToggle: () => void;
  getSettings: () => EffectsSettings;
  onPreview: (next: Partial<EffectsSettings>) => void;
  onCommit: () => void;
}

/**
 * Submenu for the globe atmosphere: an on/off toggle plus live controls for the
 * halo color, how far the halo reaches past the globe (the "floats above the
 * surface" vs "tight to the surface" look), the halo strength, and the deep
 * space backdrop color.
 *
 * Settings live in module state in the effects plugin, so this keeps a local
 * mirror seeded each time the submenu opens. Edits preview live (instant UI +
 * globe redraw) on every change, and persist only when a gesture ends — a
 * slider release, a color input blur, a reset, or the submenu closing — so a
 * color-picker drag doesn't churn the project-dirty flag on every frame.
 */
function AtmosphereEffectsSubmenu({
  active,
  onToggle,
  getSettings,
  onPreview,
  onCommit,
}: AtmosphereEffectsSubmenuProps) {
  const { t } = useTranslation();
  const [settings, setSettings] = useState<EffectsSettings>(getSettings);

  const preview = (next: Partial<EffectsSettings>) => {
    setSettings((prev) => ({ ...prev, ...next }));
    onPreview(next);
  };

  return (
    <DropdownMenuSub
      onOpenChange={(open: boolean) => {
        if (open) {
          // Re-seed from the source of truth on open so the controls reflect a
          // project that loaded new settings while the menu was closed.
          setSettings(getSettings());
        } else {
          // Backstop: persist any previewed change whose gesture-end commit
          // didn't fire (e.g. a color picked then the menu dismissed).
          onCommit();
        }
      }}
    >
      <DropdownMenuSubTrigger>
        {t("toolbar.item.atmosphereEffects")}
        {active ? " ✓" : ""}
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="w-64">
        <DropdownMenuItem
          // onSelect (not onClick) fires for both mouse and keyboard
          // (Enter/Space); preventDefault keeps the submenu open after toggling.
          onSelect={(e: Event) => {
            e.preventDefault();
            onToggle();
          }}
        >
          {t("toolbar.item.atmosphereEnabled")}
          {active ? " ✓" : ""}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {/* Stop key events from reaching the menu's roving-focus/typeahead
            handlers so sliders respond to arrow keys and the color inputs work. */}
        <div
          className="space-y-3 px-2 py-1.5"
          onKeyDown={(e) => e.stopPropagation()}
        >
          <ColorRow
            label={t("toolbar.atmosphere.haloColor")}
            value={settings.haloColor}
            onPreview={(haloColor) => preview({ haloColor })}
            onCommit={onCommit}
          />
          <SliderRow
            label={t("toolbar.atmosphere.haloExtent")}
            hint={t("toolbar.atmosphere.haloExtentHint")}
            min={HALO_EXTENT_MIN}
            max={HALO_EXTENT_MAX}
            step={0.05}
            value={settings.haloExtent}
            format={(v) => `${v.toFixed(2)}×`}
            onPreview={(haloExtent) => preview({ haloExtent })}
            onCommit={onCommit}
          />
          <SliderRow
            label={t("toolbar.atmosphere.haloOpacity")}
            min={HALO_OPACITY_MIN}
            max={HALO_OPACITY_MAX}
            step={0.05}
            value={settings.haloOpacity}
            format={(v) => `${Math.round(v * 100)}%`}
            onPreview={(haloOpacity) => preview({ haloOpacity })}
            onCommit={onCommit}
          />
          <ColorRow
            label={t("toolbar.atmosphere.spaceColor")}
            value={settings.spaceColor}
            onPreview={(spaceColor) => preview({ spaceColor })}
            onCommit={onCommit}
          />
        </div>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          // onSelect fires for mouse and keyboard alike. A discrete action:
          // preview the defaults, then commit immediately. preventDefault keeps
          // the submenu open so the reset is visible in the controls.
          onSelect={(e: Event) => {
            e.preventDefault();
            preview({ ...DEFAULT_EFFECTS_SETTINGS });
            onCommit();
          }}
        >
          {t("toolbar.atmosphere.reset")}
        </DropdownMenuItem>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}

interface ColorRowProps {
  label: string;
  value: string;
  onPreview: (value: string) => void;
  onCommit: () => void;
}

function ColorRow({ label, value, onPreview, onCommit }: ColorRowProps) {
  return (
    <label className="flex items-center justify-between gap-2 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <ColorField
        fill={false}
        aria-label={label}
        eyedropperLabel={label}
        value={value}
        // onChange fires continuously while dragging in the picker (preview);
        // onBlur fires once when the picker closes / focus leaves (commit). The
        // eyedropper has no blur, so ColorField commits via onCommit instead.
        onChange={onPreview}
        onCommit={onCommit}
        onBlur={onCommit}
        className="h-6 w-10 cursor-pointer p-0.5"
        buttonClassName="h-6 w-6"
      />
    </label>
  );
}

interface SliderRowProps {
  label: string;
  hint?: string;
  min: number;
  max: number;
  step: number;
  value: number;
  format: (value: number) => string;
  onPreview: (value: number) => void;
  onCommit: () => void;
}

function SliderRow({
  label,
  hint,
  min,
  max,
  step,
  value,
  format,
  onPreview,
  onCommit,
}: SliderRowProps) {
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-xs">
        <span className="text-muted-foreground" title={hint}>
          {label}
        </span>
        <span className="tabular-nums text-foreground">{format(value)}</span>
      </div>
      <Slider
        aria-label={label}
        min={min}
        max={max}
        step={step}
        value={[value]}
        // onValueChange streams every scrub frame (preview); onValueCommit
        // fires once on pointer-up / keyboard commit (persist).
        onValueChange={([v]: number[]) => onPreview(v ?? value)}
        onValueCommit={onCommit}
        onClick={(e: ReactMouseEvent) => e.stopPropagation()}
      />
    </div>
  );
}
