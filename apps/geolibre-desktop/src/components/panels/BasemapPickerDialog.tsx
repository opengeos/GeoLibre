import {
  BLANK_BASEMAP,
  PLANETARY_BASEMAP_GROUPS,
  PLANETARY_BASEMAPS,
  useAppStore,
  type PlanetaryBasemap,
} from "@geolibre/core";
import {
  Button,
  cn,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  Select,
} from "@geolibre/ui";
import type { FormEvent } from "react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  getOpenFreeMapPresets,
  LIBERTY_3D_ID,
  resolveProtomapsPresets,
  type PresetBasemap,
} from "../../lib/basemap-presets";
import { isOfflineBasemapSentinel, PROTOMAPS_FLAVORS, type ProtomapsFlavor } from "@geolibre/map";
import { planetaryBasemapLabel, planetaryBasemapSectionKey } from "../../lib/planetary-sections";
import { buildRemotePmtilesBasemap, isPmtilesStyleUrl } from "../../lib/pmtiles-basemap-url";
import { CollapsibleSection } from "../CollapsibleSection";

// Picking the "Liberty 3D" preset applies the Liberty style and tilts the
// current camera into a 3D perspective in place (matching the New Project
// dialog, which pairs that preset with a 3D map view).
const THREE_D_PITCH = 60;

const BLANK_CHOICE = "__blank__";
const CUSTOM_CHOICE = "__custom__";
const OFFLINE_CHOICE = "__offline__";

// The last custom URL (and PMTiles flavor) the user applied, so the field is
// repopulated next time the picker opens — a PMTiles basemap resolves to an
// opaque sentinel that can't be reversed back into its URL, so we remember it.
const CUSTOM_URL_STORAGE_KEY = "geolibre.basemapPicker.customUrl";
const CUSTOM_FLAVOR_STORAGE_KEY = "geolibre.basemapPicker.customFlavor";

function readStoredCustomUrl(): string {
  try {
    return localStorage.getItem(CUSTOM_URL_STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

function readStoredCustomFlavor(): ProtomapsFlavor {
  try {
    const stored = localStorage.getItem(CUSTOM_FLAVOR_STORAGE_KEY);
    if (stored && (PROTOMAPS_FLAVORS as readonly string[]).includes(stored)) {
      return stored as ProtomapsFlavor;
    }
  } catch {
    // Ignore unavailable storage.
  }
  return "light";
}

interface PresetButtonProps {
  name: string;
  selected: boolean;
  onSelect: () => void;
}

function PresetButton({ name, selected, onSelect }: PresetButtonProps) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      className={cn(
        "flex min-h-10 items-center justify-center rounded-md border px-3 py-1.5 text-center text-sm font-medium leading-tight transition-colors",
        "hover:bg-accent hover:text-accent-foreground",
        selected
          ? "border-primary bg-primary text-primary-foreground hover:bg-primary hover:text-primary-foreground"
          : "border-input bg-background",
      )}
      onClick={onSelect}
    >
      {name}
    </button>
  );
}

interface BasemapPickerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Quick picker for swapping the active core basemap from the layer panel's
 * Background row. Offers the same predefined basemaps as the New Project dialog
 * (OpenFreeMap, Protomaps when an API key is configured, a blank background, or
 * a custom style URL) and applies the selection instantly via the store. The
 * current camera is preserved, so only the underlying map style changes.
 */
export function BasemapPickerDialog({ open, onOpenChange }: BasemapPickerDialogProps) {
  const { t } = useTranslation();
  const basemapStyleUrl = useAppStore((s) => s.basemapStyleUrl);
  const setBasemapStyleUrl = useAppStore((s) => s.setBasemapStyleUrl);
  const setMapView = useAppStore((s) => s.setMapView);
  const applyPlanetaryBasemap = useAppStore((s) => s.applyPlanetaryBasemap);

  const openFreeMapPresets = useMemo(() => getOpenFreeMapPresets(), []);
  // Protomaps styles need an API key (VITE_PROTOMAPS_API_KEY). It can come from
  // the build or from Settings → Environment variables, so re-resolve when the
  // dialog opens and whenever the runtime env changes; an absent key hides the
  // section.
  const [protomapsPresets, setProtomapsPresets] =
    useState<PresetBasemap[]>(resolveProtomapsPresets);
  useEffect(() => {
    if (!open) return;
    const refresh = () => setProtomapsPresets(resolveProtomapsPresets());
    refresh();
    window.addEventListener("geolibre:runtime-env-change", refresh);
    return () => window.removeEventListener("geolibre:runtime-env-change", refresh);
  }, [open]);

  const allPresets = useMemo(
    () => [
      ...openFreeMapPresets,
      ...protomapsPresets,
      ...PLANETARY_BASEMAPS.map((b) => ({
        id: b.id,
        name: b.name,
        styleUrl: b.styleUrl,
      })),
    ],
    [openFreeMapPresets, protomapsPresets],
  );

  // The currently active choice, used to highlight a single button. Match on the
  // style URL; "Liberty 3D" shares Liberty's URL, so the first match (Liberty)
  // wins and only one button highlights.
  const activeChoice = useMemo(() => {
    if (basemapStyleUrl === BLANK_BASEMAP) return BLANK_CHOICE;
    // An offline/PMTiles basemap is a runtime sentinel, not a real style URL —
    // don't treat it as a custom URL (its sentinel would fail URL validation).
    if (isOfflineBasemapSentinel(basemapStyleUrl)) return OFFLINE_CHOICE;
    const preset = allPresets.find((p) => p.styleUrl === basemapStyleUrl);
    return preset ? preset.id : CUSTOM_CHOICE;
  }, [allPresets, basemapStyleUrl]);

  // Seed the custom URL field when the dialog opens: prefer the active custom
  // style URL, else fall back to the last custom URL the user applied (a PMTiles
  // basemap resolves to a sentinel that can't be reversed to its URL).
  const [customUrl, setCustomUrl] = useState("");
  const [customFlavor, setCustomFlavor] = useState<ProtomapsFlavor>("light");
  useEffect(() => {
    if (!open) return;
    setCustomUrl(activeChoice === CUSTOM_CHOICE ? basemapStyleUrl : readStoredCustomUrl());
    setCustomFlavor(readStoredCustomFlavor());
    // Re-seed only when the dialog opens, not on every store change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const customStyleUrl = customUrl.trim();
  const customIsPmtiles = isPmtilesStyleUrl(customStyleUrl);
  const isCustomUrlValid = useMemo(() => {
    if (!customStyleUrl) return false;
    try {
      const url = new URL(customStyleUrl);
      return url.protocol === "http:" || url.protocol === "https:" || url.protocol === "pmtiles:";
    } catch {
      return false;
    }
  }, [customStyleUrl]);

  const applyPreset = (preset: PresetBasemap) => {
    setBasemapStyleUrl(preset.styleUrl);
    if (preset.id === LIBERTY_3D_ID) {
      // Tilt the current view into 3D in place, preserving center and zoom.
      setMapView({ pitch: THREE_D_PITCH }, true);
    }
    onOpenChange(false);
  };

  // Selecting a planetary basemap also switches the project's celestial body so
  // measurements (distance/area/scale) use that body's radius, and the globe
  // control renders it as the correct sphere.
  const applyPlanetary = (basemap: PlanetaryBasemap) => {
    applyPlanetaryBasemap(basemap);
    onOpenChange(false);
  };

  const applyBlank = () => {
    setBasemapStyleUrl(BLANK_BASEMAP);
    onOpenChange(false);
  };

  const applyCustom = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!isCustomUrlValid) return;
    try {
      localStorage.setItem(CUSTOM_URL_STORAGE_KEY, customStyleUrl);
      if (customIsPmtiles) {
        localStorage.setItem(CUSTOM_FLAVOR_STORAGE_KEY, customFlavor);
      }
    } catch {
      // Ignore unavailable storage; persistence is best-effort.
    }
    setBasemapStyleUrl(
      customIsPmtiles ? buildRemotePmtilesBasemap(customStyleUrl, customFlavor) : customStyleUrl,
    );
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{t("basemapPicker.title")}</DialogTitle>
          <DialogDescription>
            {protomapsPresets.length > 0
              ? t("newProject.basemapDescription")
              : t("newProject.basemapDescriptionNoProtomaps")}
          </DialogDescription>
        </DialogHeader>

        <form className="space-y-5" onSubmit={applyCustom}>
          <div className="space-y-2">
            <p className="text-xs font-medium text-muted-foreground">
              {t("newProject.sectionOpenFreeMap")}
            </p>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {openFreeMapPresets.map((basemap) => (
                <PresetButton
                  key={basemap.id}
                  name={basemap.name}
                  selected={activeChoice === basemap.id}
                  onSelect={() => applyPreset(basemap)}
                />
              ))}
            </div>
          </div>

          {protomapsPresets.length > 0 ? (
            <div className="space-y-2">
              <p className="text-xs font-medium text-muted-foreground">
                {t("newProject.sectionProtomaps")}
              </p>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {protomapsPresets.map((basemap) => (
                  <PresetButton
                    key={basemap.id}
                    name={basemap.name}
                    selected={activeChoice === basemap.id}
                    onSelect={() => applyPreset(basemap)}
                  />
                ))}
              </div>
            </div>
          ) : null}

          {PLANETARY_BASEMAP_GROUPS.map((group) => {
            const heading = t(planetaryBasemapSectionKey(group.id));
            const grid = (
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {group.basemaps.map((basemap) => (
                  <PresetButton
                    key={basemap.id}
                    name={planetaryBasemapLabel(basemap, group.id)}
                    selected={activeChoice === basemap.id}
                    onSelect={() => applyPlanetary(basemap)}
                  />
                ))}
              </div>
            );
            // The "other bodies" section holds many entries, so collapse it to
            // keep the panel short; the Moon/Mars sections stay always-visible.
            return group.id === "other" ? (
              <CollapsibleSection
                key={group.id}
                title={heading}
                // Collapsed by default, but auto-expanded when the active basemap
                // is one of these, so the current selection isn't hidden.
                defaultOpen={group.basemaps.some((b) => b.id === activeChoice)}
              >
                {grid}
              </CollapsibleSection>
            ) : (
              <div key={group.id} className="space-y-2">
                <p className="text-xs font-medium text-muted-foreground">{heading}</p>
                {grid}
              </div>
            );
          })}

          <div className="space-y-2">
            <p className="text-xs font-medium text-muted-foreground">
              {t("newProject.sectionOther")}
            </p>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              <PresetButton
                name="Blank"
                selected={activeChoice === BLANK_CHOICE}
                onSelect={applyBlank}
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="basemap-picker-custom-url">{t("newProject.customUrlButton")}</Label>
            <div className="flex gap-2">
              <Input
                id="basemap-picker-custom-url"
                type="text"
                inputMode="url"
                placeholder="https://example.com/style.json or …/basemap.pmtiles"
                value={customUrl}
                onChange={(event) => setCustomUrl(event.target.value)}
              />
              <Button type="submit" disabled={!isCustomUrlValid}>
                {t("basemapPicker.applyCustom")}
              </Button>
            </div>
            {customIsPmtiles ? (
              <div className="space-y-1">
                <Label htmlFor="basemap-picker-custom-flavor" className="text-xs">
                  {t("basemapExtract.style")}
                </Label>
                <Select
                  id="basemap-picker-custom-flavor"
                  value={customFlavor}
                  onChange={(event) => setCustomFlavor(event.target.value as ProtomapsFlavor)}
                >
                  {PROTOMAPS_FLAVORS.map((f) => (
                    <option key={f} value={f}>
                      {t(`basemapExtract.flavor.${f}`)}
                    </option>
                  ))}
                </Select>
              </div>
            ) : null}
            {customStyleUrl && !isCustomUrlValid ? (
              <p className="text-xs text-destructive">{t("basemapPicker.invalidUrl")}</p>
            ) : null}
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
