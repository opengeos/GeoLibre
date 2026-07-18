import {
  BLANK_BASEMAP,
  createDefaultMapView,
  OPENFREEMAP_BASEMAPS,
  PLANETARY_BASEMAP_GROUPS,
  PLANETARY_BASEMAPS,
  PROTOMAPS_BASEMAPS,
  useAppStore,
  type MapViewState,
} from "@geolibre/core";
import { PROTOMAPS_FLAVORS, type ProtomapsFlavor } from "@geolibre/map";
import {
  LIBERTY_3D_ID,
  resolveProtomapsPresets,
  type PresetBasemap,
} from "../../lib/basemap-presets";
import { planetaryBasemapLabel, planetaryBasemapSectionKey } from "../../lib/planetary-sections";
import { buildRemotePmtilesBasemap, isPmtilesStyleUrl } from "../../lib/pmtiles-basemap-url";
import { CollapsibleSection } from "../CollapsibleSection";
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
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

const DEFAULT_BASEMAP_ID = "liberty";
const CUSTOM_BASEMAP_ID = "custom";
const BLANK_BASEMAP_ID = "blank";
const DEFAULT_PROJECT_NAME = "Untitled Project";

const THREE_D_MAP_VIEW: MapViewState = {
  center: [-0.114, 51.506],
  zoom: 14.2,
  bearing: 55.2,
  pitch: 60,
};

// Well-known basemap ids stay type-checked. Protomaps ids are still dynamic
// (only present when a key is configured), but they come from the const array,
// so the union catches typos and stale sentinel values.
type BasemapChoice =
  | (typeof OPENFREEMAP_BASEMAPS)[number]["id"]
  | (typeof PROTOMAPS_BASEMAPS)[number]["id"]
  | (typeof PLANETARY_BASEMAPS)[number]["id"]
  | typeof CUSTOM_BASEMAP_ID
  | typeof BLANK_BASEMAP_ID;

interface BasemapButtonProps {
  id: BasemapChoice;
  name: string;
  selected: boolean;
  onSelect: (id: BasemapChoice) => void;
}

function BasemapButton({ id, name, selected, onSelect }: BasemapButtonProps) {
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
      onClick={() => onSelect(id)}
    >
      {name}
    </button>
  );
}

interface NewProjectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaveCurrentProject: () => Promise<boolean>;
  onProjectCreated?: () => void;
}

export function NewProjectDialog({
  open,
  onOpenChange,
  onSaveCurrentProject,
  onProjectCreated,
}: NewProjectDialogProps) {
  const { t } = useTranslation();
  const newProject = useAppStore((s) => s.newProject);
  const [selectedBasemapId, setSelectedBasemapId] = useState<BasemapChoice>(DEFAULT_BASEMAP_ID);
  const [projectName, setProjectName] = useState(DEFAULT_PROJECT_NAME);
  const [customUrl, setCustomUrl] = useState("");
  const [customFlavor, setCustomFlavor] = useState<ProtomapsFlavor>("light");
  const [showSavePrompt, setShowSavePrompt] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const customUrlRef = useRef<HTMLInputElement>(null);

  const customStyleUrl = customUrl.trim();
  const customIsPmtiles = isPmtilesStyleUrl(customStyleUrl);
  const isCustomSelected = selectedBasemapId === CUSTOM_BASEMAP_ID;
  const isBlankSelected = selectedBasemapId === BLANK_BASEMAP_ID;
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
  // Move focus into the custom URL field the moment the user selects the
  // "Custom URL" basemap, so the now-unlocked input is ready to type into.
  useEffect(() => {
    if (isCustomSelected) customUrlRef.current?.focus();
  }, [isCustomSelected]);
  // Prioritize data preservation: when the dialog opens with unsaved changes,
  // ask to save the current project before showing the new-project form (#990),
  // matching standard desktop and web GIS conventions. With no unsaved changes,
  // go straight to the configuration form. Read the dirty flag once on open
  // (not as a reactive dep) so "Do not save" doesn't re-trigger the prompt while
  // the project is still dirty. useLayoutEffect (not useEffect) commits this
  // before paint, so a dirty open never flashes the config form first.
  useLayoutEffect(() => {
    if (open) setShowSavePrompt(useAppStore.getState().isDirty);
  }, [open]);
  const selectedPreset = useMemo<PresetBasemap | undefined>(
    () =>
      [...OPENFREEMAP_BASEMAPS, ...protomapsPresets].find(
        (basemap) => basemap.id === selectedBasemapId,
      ),
    [protomapsPresets, selectedBasemapId],
  );
  // Planetary basemaps are a separate list because selecting one also sets the
  // project's celestial body (so measurements use that body's radius).
  const selectedPlanetary = useMemo(
    () => PLANETARY_BASEMAPS.find((basemap) => basemap.id === selectedBasemapId),
    [selectedBasemapId],
  );
  const isCustomUrlValid = useMemo(() => {
    if (!customStyleUrl) return false;
    try {
      const url = new URL(customStyleUrl);
      return url.protocol === "http:" || url.protocol === "https:" || url.protocol === "pmtiles:";
    } catch {
      return false;
    }
  }, [customStyleUrl]);
  const canCreate = isCustomSelected
    ? isCustomUrlValid
    : isBlankSelected || Boolean(selectedPreset) || Boolean(selectedPlanetary);

  const resetForm = () => {
    setSelectedBasemapId(DEFAULT_BASEMAP_ID);
    setProjectName(DEFAULT_PROJECT_NAME);
    setCustomUrl("");
    setCustomFlavor("light");
    setShowSavePrompt(false);
    setIsSaving(false);
  };

  const handleOpenChange = (nextOpen: boolean) => {
    onOpenChange(nextOpen);
    if (!nextOpen) resetForm();
  };

  const createProject = () => {
    if (!canCreate) return;

    const basemapStyleUrl = isCustomSelected
      ? customIsPmtiles
        ? buildRemotePmtilesBasemap(customStyleUrl, customFlavor)
        : customStyleUrl
      : isBlankSelected
        ? BLANK_BASEMAP
        : (selectedPreset ?? selectedPlanetary)?.styleUrl;
    if (basemapStyleUrl == null) return;

    newProject({
      name: projectName.trim() || DEFAULT_PROJECT_NAME,
      basemapStyleUrl,
      // A planetary basemap seeds the matching celestial body; other basemaps
      // leave the project on the default Earth ellipsoid.
      ellipsoidId: selectedPlanetary?.ellipsoidId,
      mapView: selectedBasemapId === LIBERTY_3D_ID ? THREE_D_MAP_VIEW : createDefaultMapView(),
    });
    onProjectCreated?.();
    onOpenChange(false);
    resetForm();
  };

  const handleCreate = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    // Any unsaved changes were already resolved by the save prompt shown when
    // the dialog opened, so creating here is safe. createProject() still guards
    // on canCreate internally, so the removed call-site check is not a regression.
    createProject();
  };

  const handleSaveThenContinue = async () => {
    setIsSaving(true);
    try {
      const saved = await onSaveCurrentProject();
      // Advance to the configuration form only once the current project is
      // safely saved; a cancelled or failed save keeps the prompt up.
      if (saved) setShowSavePrompt(false);
    } catch (error) {
      console.error("Failed to save project", error);
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-xl">
        {showSavePrompt ? (
          <>
            <DialogHeader>
              <DialogTitle>{t("newProject.savePromptTitle")}</DialogTitle>
              <DialogDescription>{t("newProject.savePromptDescription")}</DialogDescription>
            </DialogHeader>
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                disabled={isSaving}
                onClick={() => handleOpenChange(false)}
              >
                {t("common.cancel")}
              </Button>
              <Button
                type="button"
                variant="secondary"
                disabled={isSaving}
                onClick={() => setShowSavePrompt(false)}
              >
                {t("newProject.doNotSave")}
              </Button>
              <Button type="button" disabled={isSaving} onClick={handleSaveThenContinue}>
                {isSaving ? t("newProject.saving") : t("common.save")}
              </Button>
            </div>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>New project</DialogTitle>
              <DialogDescription>
                {protomapsPresets.length > 0
                  ? t("newProject.basemapDescription")
                  : t("newProject.basemapDescriptionNoProtomaps")}
              </DialogDescription>
            </DialogHeader>
            <form className="space-y-5" onSubmit={handleCreate}>
              <div className="space-y-2">
                <Label htmlFor="new-project-name">Project name</Label>
                <Input
                  id="new-project-name"
                  autoFocus
                  value={projectName}
                  onChange={(event) => setProjectName(event.target.value)}
                />
              </div>

              <div className="space-y-4">
                <Label>Basemap</Label>

                <div className="space-y-2">
                  <p className="text-xs font-medium text-muted-foreground">
                    {t("newProject.sectionOpenFreeMap")}
                  </p>
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                    {OPENFREEMAP_BASEMAPS.map((basemap) => (
                      <BasemapButton
                        key={basemap.id}
                        id={basemap.id}
                        name={basemap.name}
                        selected={selectedBasemapId === basemap.id}
                        onSelect={setSelectedBasemapId}
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
                        <BasemapButton
                          key={basemap.id}
                          id={basemap.id}
                          name={basemap.name}
                          selected={selectedBasemapId === basemap.id}
                          onSelect={setSelectedBasemapId}
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
                        <BasemapButton
                          key={basemap.id}
                          id={basemap.id}
                          name={planetaryBasemapLabel(basemap, group.id)}
                          selected={selectedBasemapId === basemap.id}
                          onSelect={setSelectedBasemapId}
                        />
                      ))}
                    </div>
                  );
                  // Collapse the long "other bodies" section; keep Moon/Mars open.
                  return group.id === "other" ? (
                    <CollapsibleSection
                      key={group.id}
                      title={heading}
                      // Collapsed by default, but auto-expanded when the selected
                      // basemap is one of these, so the selection stays visible.
                      defaultOpen={group.basemaps.some((b) => b.id === selectedBasemapId)}
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
                    <BasemapButton
                      id={BLANK_BASEMAP_ID}
                      name="Blank"
                      selected={selectedBasemapId === BLANK_BASEMAP_ID}
                      onSelect={setSelectedBasemapId}
                    />
                    <BasemapButton
                      id={CUSTOM_BASEMAP_ID}
                      name={t("newProject.customUrlButton")}
                      selected={isCustomSelected}
                      onSelect={setSelectedBasemapId}
                    />
                  </div>
                </div>
              </div>

              {/* The custom URL is a mutually exclusive basemap choice: the
                  field unlocks only when "Custom URL" is selected above, so it
                  can never compete with a highlighted preset button. */}
              <div className="space-y-2">
                <Label htmlFor="custom-basemap-url">Custom URL</Label>
                <Input
                  id="custom-basemap-url"
                  ref={customUrlRef}
                  type="text"
                  inputMode="url"
                  placeholder="https://example.com/style.json or …/basemap.pmtiles"
                  value={customUrl}
                  disabled={!isCustomSelected}
                  onChange={(event) => setCustomUrl(event.target.value)}
                />
                {isCustomSelected && customIsPmtiles ? (
                  <div className="space-y-1">
                    <Label htmlFor="custom-basemap-flavor" className="text-xs">
                      {t("basemapExtract.style")}
                    </Label>
                    <Select
                      id="custom-basemap-flavor"
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
                {isCustomSelected && customStyleUrl && !isCustomUrlValid ? (
                  <p className="text-xs text-destructive">{t("newProject.invalidCustomUrl")}</p>
                ) : null}
              </div>

              <div className="flex justify-end gap-2">
                <Button type="button" variant="outline" onClick={() => handleOpenChange(false)}>
                  Cancel
                </Button>
                <Button type="submit" disabled={!canCreate}>
                  Create
                </Button>
              </div>
            </form>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
