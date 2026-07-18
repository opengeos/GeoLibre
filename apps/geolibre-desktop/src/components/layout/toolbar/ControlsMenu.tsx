import { useAppStore } from "@geolibre/core";
import {
  DEFAULT_EFFECTS_SETTINGS,
  type EffectsSettings,
  getCloudsAnimationState,
  getPrecipitationAnimationState,
  HALO_EXTENT_MAX,
  HALO_EXTENT_MIN,
  HALO_OPACITY_MAX,
  HALO_OPACITY_MIN,
  setCloudsFrame,
  setPrecipitationFrame,
  subscribeClouds,
  subscribePrecipitation,
  toggleCloudsPlaying,
  togglePrecipitationPlaying,
  type WeatherAnimationState,
  type WeatherLayerController,
} from "@geolibre/plugins";
import {
  Button,
  ColorField,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
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
import { Clapperboard, ClipboardList, LocateFixed, SlidersHorizontal, Video } from "lucide-react";
import { type MouseEvent as ReactMouseEvent, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ToolbarPanels } from "../../../hooks/useToolbarPanels";
import { useDesktopSettingsStore } from "../../../hooks/useDesktopSettings";
import { isMenuItemVisible } from "../../../lib/ui-profile";
import { MAP_CONTROL_ITEMS, type ToolbarChrome, type ToolbarMapControl } from "./constants";

interface ControlsMenuProps {
  chrome: ToolbarChrome;
  controlsVisible: Record<ToolbarMapControl, boolean>;
  panels: ToolbarPanels;
  effectsActive: boolean;
  directionsActive: boolean;
  reverseGeocodeActive: boolean;
  graticuleActive: boolean;
  cloudsActive: boolean;
  precipitationActive: boolean;
  onToggleMapControl: (control: ToolbarMapControl) => void;
  onToggleEffects: () => void;
  getEffectsSettings: () => EffectsSettings;
  onPreviewEffectsSettings: (next: Partial<EffectsSettings>) => void;
  onCommitEffectsSettings: () => void;
  onToggleDirections: () => void;
  onToggleReverseGeocode: () => void;
  onToggleGraticule: () => void;
  onToggleClouds: () => void;
  onTogglePrecipitation: () => void;
  onOpenFieldCollection: () => void;
  onOpenGpsTracking: () => void;
  onOpenRecordTour: () => void;
  onOpenRecordVideo: () => void;
}

/** The Controls menu: built-in map controls, atmosphere/routing toggles, and panels. */
export function ControlsMenu({
  chrome,
  controlsVisible,
  panels,
  effectsActive,
  directionsActive,
  reverseGeocodeActive,
  graticuleActive,
  cloudsActive,
  precipitationActive,
  onToggleMapControl,
  onToggleEffects,
  getEffectsSettings,
  onPreviewEffectsSettings,
  onCommitEffectsSettings,
  onToggleDirections,
  onToggleReverseGeocode,
  onToggleGraticule,
  onToggleClouds,
  onTogglePrecipitation,
  onOpenFieldCollection,
  onOpenGpsTracking,
  onOpenRecordTour,
  onOpenRecordVideo,
}: ControlsMenuProps) {
  const { t } = useTranslation();
  const uiProfile = useDesktopSettingsStore((s) => s.desktopSettings.uiProfile);
  const show = (id: string) => isMenuItemVisible(uiProfile, id);
  // Atmospheric effects only render on the globe (the engine idles in Mercator),
  // so the submenu is disabled while the map is in a flat projection (#783). The
  // GlobeControl toggle syncs this preference via the map "projectiontransition"
  // event, so the menu reacts the moment the user switches projections.
  const globeActive = useAppStore((s) => s.preferences.map.projection === "globe");
  const restrictBounds = useAppStore((s) => s.preferences.map.restrictBounds);
  const setPreferences = useAppStore((s) => s.setPreferences);
  // The globe cannot spin while the map bounds are locked, so enabling spin
  // while they are locked opens a dialog that unlocks the bounds first (#723).
  const [spinGlobeNoticeOpen, setSpinGlobeNoticeOpen] = useState(false);
  const handleSpinGlobe = () => {
    if (!panels.spinGlobe.visible && restrictBounds) {
      setSpinGlobeNoticeOpen(true);
      return;
    }
    panels.spinGlobe.toggle();
  };
  const confirmSpinGlobe = () => {
    setSpinGlobeNoticeOpen(false);
    // Unlock the bounds so the globe can actually spin, then start spinning.
    // Read live state at click time so a concurrent change isn't clobbered.
    const { preferences } = useAppStore.getState();
    if (preferences.map.restrictBounds) {
      setPreferences({
        ...preferences,
        map: { ...preferences.map, restrictBounds: false },
      });
    }
    if (!panels.spinGlobe.visible) panels.spinGlobe.toggle();
  };
  // Whether the first group (built-in controls + atmosphere/routing toggles) has
  // any visible item, so the separator below it isn't left orphaned.
  const anyTopControls =
    MAP_CONTROL_ITEMS.some((control) => show(`controls.mapControl.${control.id}`)) ||
    show("controls.atmosphereEffects") ||
    show("controls.clouds") ||
    show("controls.spinGlobe") ||
    show("controls.graticule") ||
    show("controls.sun") ||
    show("controls.routeAnimation") ||
    show("controls.directions") ||
    show("controls.reverseGeocode");
  // Whether the middle group (panels) has any visible item. The separator that
  // precedes the Field Collection / Record Tour group is gated on this so it
  // never renders as a leading or doubled separator when the group above it is
  // empty (e.g. a custom profile that hides every panel).
  const anyMiddleControls =
    show("controls.search") ||
    show("controls.colorbar") ||
    show("controls.legend") ||
    show("controls.html") ||
    show("controls.measure") ||
    show("controls.bookmark") ||
    show("controls.minimap") ||
    show("controls.viewState");

  return (
    <>
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
          {MAP_CONTROL_ITEMS.filter((control) => show(`controls.mapControl.${control.id}`)).map(
            (control) => (
              <DropdownMenuItem key={control.id} onClick={() => onToggleMapControl(control.id)}>
                {t(control.labelKey)}
                {controlsVisible[control.id] ? " ✓" : ""}
              </DropdownMenuItem>
            ),
          )}
          {show("controls.atmosphereEffects") && (
            <AtmosphereEffectsSubmenu
              active={effectsActive}
              disabled={!globeActive}
              onToggle={onToggleEffects}
              getSettings={getEffectsSettings}
              onPreview={onPreviewEffectsSettings}
              onCommit={onCommitEffectsSettings}
            />
          )}
          {show("controls.clouds") && (
            <WeatherSubmenu
              cloudsActive={cloudsActive}
              onToggleClouds={onToggleClouds}
              precipitationActive={precipitationActive}
              onTogglePrecipitation={onTogglePrecipitation}
            />
          )}
          {show("controls.sun") && (
            <DropdownMenuItem title={t("toolbar.item.sunTooltip")} onSelect={panels.sun.toggle}>
              {t("toolbar.item.sun")}
              {panels.sun.visible ? " ✓" : ""}
            </DropdownMenuItem>
          )}
          {show("controls.routeAnimation") && (
            <DropdownMenuItem
              title={t("toolbar.item.routeAnimationTooltip")}
              onSelect={panels.routeAnimation.toggle}
            >
              {t("toolbar.item.routeAnimation")}
              {panels.routeAnimation.visible ? " ✓" : ""}
            </DropdownMenuItem>
          )}
          {show("controls.spinGlobe") && (
            <DropdownMenuItem onSelect={handleSpinGlobe}>
              {t("toolbar.item.spinGlobe")}
              {panels.spinGlobe.visible ? " ✓" : ""}
            </DropdownMenuItem>
          )}
          {show("controls.graticule") && (
            <DropdownMenuItem onClick={onToggleGraticule}>
              {t("toolbar.item.graticule")}
              {graticuleActive ? " ✓" : ""}
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
          {anyMiddleControls &&
            (show("controls.fieldCollection") ||
              show("controls.gpsTracking") ||
              show("controls.recordTour") ||
              show("controls.recordVideo")) && <DropdownMenuSeparator />}
          {show("controls.fieldCollection") && (
            <DropdownMenuItem onSelect={onOpenFieldCollection}>
              <ClipboardList className="me-2 h-3.5 w-3.5" />
              {t("toolbar.item.fieldCollection")}
            </DropdownMenuItem>
          )}
          {show("controls.gpsTracking") && (
            <DropdownMenuItem onSelect={onOpenGpsTracking}>
              <LocateFixed className="me-2 h-3.5 w-3.5" />
              {t("toolbar.item.gpsTracking")}
            </DropdownMenuItem>
          )}
          {show("controls.recordTour") && (
            <DropdownMenuItem onSelect={onOpenRecordTour}>
              <Video className="me-2 h-3.5 w-3.5" />
              {t("toolbar.item.recordTour")}
            </DropdownMenuItem>
          )}
          {show("controls.recordVideo") && (
            <DropdownMenuItem onSelect={onOpenRecordVideo}>
              <Clapperboard className="me-2 h-3.5 w-3.5" />
              {t("toolbar.item.recordVideo")}
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <Dialog
        open={spinGlobeNoticeOpen}
        onOpenChange={(open: boolean) => {
          // Opened programmatically (no trigger), so onOpenChange only fires to
          // close it (Escape/overlay) — treat that as cancel.
          if (!open) setSpinGlobeNoticeOpen(false);
        }}
      >
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{t("toolbar.item.spinGlobeBoundsTitle")}</DialogTitle>
            <DialogDescription>{t("toolbar.item.spinGlobeBoundsDesc")}</DialogDescription>
          </DialogHeader>
          <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
            <p className="text-muted-foreground">{t("toolbar.item.spinGlobeBoundsHint")}</p>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setSpinGlobeNoticeOpen(false)}>
              {t("common.cancel")}
            </Button>
            <Button onClick={confirmSpinGlobe}>{t("toolbar.item.spinGlobeBoundsUnlock")}</Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

interface AtmosphereEffectsSubmenuProps {
  active: boolean;
  /** Greyed out and non-interactive while the map is not in globe projection. */
  disabled: boolean;
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
  disabled,
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
      <DropdownMenuSubTrigger
        // Off the globe the effects render nothing, so disable the submenu and
        // explain why on hover. The trigger keeps pointer-events active (see
        // dropdown-menu.tsx) so the native title tooltip still fires (#783).
        disabled={disabled}
        title={disabled ? t("toolbar.atmosphere.globeOnly") : undefined}
      >
        {t("toolbar.item.atmosphereEffects")}
        {/* Suppress the check on a disabled (Mercator) row: a ✓ on a greyed,
            non-interactive entry reads ambiguously. The active state is kept and
            the mark returns when globe view re-enables the row. */}
        {!disabled && active ? " ✓" : ""}
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
        <div className="space-y-3 px-2 py-1.5" onKeyDown={(e) => e.stopPropagation()}>
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

interface WeatherSubmenuProps {
  cloudsActive: boolean;
  onToggleClouds: () => void;
  precipitationActive: boolean;
  onTogglePrecipitation: () => void;
}

/**
 * The Weather submenu: groups the Clouds and Precipitation overlays. Each nested
 * item is a {@link WeatherLayerSubmenu} with its own on/off toggle and time-scrub
 * animation. The overlays themselves live in the Layers panel as normal tile
 * layers (with their own visibility/opacity); these submenus only drive the
 * animation.
 */
function WeatherSubmenu({
  cloudsActive,
  onToggleClouds,
  precipitationActive,
  onTogglePrecipitation,
}: WeatherSubmenuProps) {
  const { t } = useTranslation();
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger title={t("toolbar.item.weatherTooltip")}>
        {t("toolbar.item.weather")}
        {/* Aggregate indicator so an active overlay shows without opening the
            submenu (parity with the old top-level Clouds entry). */}
        {cloudsActive || precipitationActive ? " ✓" : ""}
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent>
        <WeatherLayerSubmenu
          label={t("toolbar.item.clouds")}
          showLabel={t("toolbar.item.cloudsShow")}
          tooltip={t("toolbar.item.cloudsTooltip")}
          sliderLabel={t("toolbar.item.cloudsDate")}
          active={cloudsActive}
          onToggle={onToggleClouds}
          controller={CLOUDS_CONTROLLER}
        />
        <WeatherLayerSubmenu
          label={t("toolbar.item.precipitation")}
          showLabel={t("toolbar.item.precipitationShow")}
          tooltip={t("toolbar.item.precipitationTooltip")}
          sliderLabel={t("toolbar.item.precipitationTime")}
          active={precipitationActive}
          onToggle={onTogglePrecipitation}
          controller={PRECIPITATION_CONTROLLER}
        />
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}

/** The plugin animation hooks a {@link WeatherLayerSubmenu} drives. */
// The subset of the plugin's WeatherLayerController this submenu drives (the
// activate/deactivate lifecycle is the plugin's, not the menu's). Derived via
// Pick so it can't drift from the exported type.
type WeatherControllerHandle = Pick<
  WeatherLayerController,
  "getState" | "setFrame" | "togglePlaying" | "subscribe"
>;

// Stable module-level controllers so each submenu's subscribe effect runs once.
const CLOUDS_CONTROLLER: WeatherControllerHandle = {
  getState: getCloudsAnimationState,
  setFrame: setCloudsFrame,
  togglePlaying: toggleCloudsPlaying,
  subscribe: subscribeClouds,
};
const PRECIPITATION_CONTROLLER: WeatherControllerHandle = {
  getState: getPrecipitationAnimationState,
  setFrame: setPrecipitationFrame,
  togglePlaying: togglePrecipitationPlaying,
  subscribe: subscribePrecipitation,
};

interface WeatherLayerSubmenuProps {
  label: string;
  showLabel: string;
  tooltip: string;
  sliderLabel: string;
  active: boolean;
  onToggle: () => void;
  controller: WeatherControllerHandle;
}

/**
 * A single Weather overlay submenu: an on/off toggle plus a time-scrub animation
 * (play/pause + a frame slider). Animation state lives in module state in the
 * plugin, so this mirrors it locally — seeded on mount/open and refreshed via
 * the controller's subscribe so the slider tracks playback frame by frame.
 */
function WeatherLayerSubmenu({
  label,
  showLabel,
  tooltip,
  sliderLabel,
  active,
  onToggle,
  controller,
}: WeatherLayerSubmenuProps) {
  const { t } = useTranslation();
  const [anim, setAnim] = useState<WeatherAnimationState>(controller.getState);

  useEffect(() => {
    setAnim(controller.getState());
    return controller.subscribe(() => setAnim(controller.getState()));
  }, [controller]);

  // Need at least two frames to animate/scrub; hide the Play + slider otherwise
  // (a single-frame source can't animate, and startPlaying() would no-op).
  const showAnimation = active && anim.labels.length > 1;

  return (
    <DropdownMenuSub
      onOpenChange={(open: boolean) => {
        if (open) setAnim(controller.getState());
      }}
    >
      <DropdownMenuSubTrigger title={tooltip}>
        {label}
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
          {showLabel}
          {active ? " ✓" : ""}
        </DropdownMenuItem>
        {showAnimation && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={(e: Event) => {
                e.preventDefault();
                controller.togglePlaying();
              }}
            >
              {anim.playing ? t("toolbar.item.weatherPause") : t("toolbar.item.weatherPlay")}
            </DropdownMenuItem>
            {/* Stop key events from reaching the menu's roving-focus/typeahead
                handlers so the slider responds to arrow keys. */}
            <div className="px-2 py-1.5" onKeyDown={(e) => e.stopPropagation()}>
              <SliderRow
                label={sliderLabel}
                min={0}
                max={anim.labels.length - 1}
                step={1}
                value={anim.index}
                format={(v) => anim.labels[Math.round(v)] ?? ""}
                onPreview={(v) => controller.setFrame(v)}
                onCommit={() => {}}
              />
            </div>
          </>
        )}
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
