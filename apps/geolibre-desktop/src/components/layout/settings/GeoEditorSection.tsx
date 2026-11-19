import {
  DEFAULT_GEO_EDITOR_SETTINGS,
  type GeoEditorAttributeField,
  type GeoEditorSettings,
} from "@geolibre/core";
import { Button, Input, Label, Select } from "@geolibre/ui";
import { useTranslation } from "react-i18next";
import { useSettingsDraft } from "./SettingsDraftContext";

/** Configure the project's drawn-feature form without changing existing attributes. */
export function GeoEditorSection() {
  const { t } = useTranslation();
  const { draftPreferences, setDraftPreferences } = useSettingsDraft();
  const settings = draftPreferences.map.geoEditor ?? DEFAULT_GEO_EDITOR_SETTINGS;
  const update = (
    patch:
      | Partial<GeoEditorSettings>
      | ((current: GeoEditorSettings) => Partial<GeoEditorSettings>),
  ) =>
    setDraftPreferences((current) => ({
      ...current,
      map: {
        ...current.map,
        geoEditor: {
          ...(current.map.geoEditor ?? DEFAULT_GEO_EDITOR_SETTINGS),
          ...(typeof patch === "function"
            ? patch(current.map.geoEditor ?? DEFAULT_GEO_EDITOR_SETTINGS)
            : patch),
        },
      },
    }));
  const updateField = (index: number, patch: Partial<GeoEditorAttributeField>) =>
    update((current) => ({
      fields: current.fields.map((field, i) => (i === index ? { ...field, ...patch } : field)),
    }));
  return (
    <section className="grid gap-4">
      <h3 className="text-base font-semibold">{t("settings.geoEditor.title")}</h3>
      <p className="text-sm text-muted-foreground">{t("settings.geoEditor.description")}</p>
      <Label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={settings.showAfterDraw}
          onChange={(event) => update({ showAfterDraw: event.target.checked })}
        />
        {t("settings.geoEditor.showAfterDraw")}
      </Label>
      <div className="grid gap-3">
        {settings.fields.map((field, index) => (
          <fieldset key={index} className="grid gap-2 rounded-md border p-3">
            <legend className="px-1 text-sm">
              {t("settings.geoEditor.field", { number: index + 1 })}
            </legend>
            <Label>
              {t("settings.geoEditor.name")}
              <Input
                value={field.name}
                onChange={(event) => updateField(index, { name: event.target.value })}
              />
            </Label>
            <Label>
              {t("settings.geoEditor.label")}
              <Input
                value={field.label ?? ""}
                onChange={(event) => updateField(index, { label: event.target.value })}
              />
            </Label>
            <div className="grid grid-cols-2 gap-2">
              <Label>
                {t("settings.geoEditor.type")}
                <Select
                  value={field.type}
                  onChange={(event) =>
                    updateField(index, {
                      type: event.target.value as GeoEditorAttributeField["type"],
                    })
                  }
                >
                  {(["string", "number", "boolean", "color", "date", "textarea"] as const).map(
                    (type) => (
                      <option key={type} value={type}>
                        {t(`settings.geoEditor.types.${type}`)}
                      </option>
                    ),
                  )}
                </Select>
              </Label>
              <Label>
                {t("settings.geoEditor.geometry")}
                <Select
                  value={field.geometry}
                  onChange={(event) =>
                    updateField(index, {
                      geometry: event.target.value as GeoEditorAttributeField["geometry"],
                    })
                  }
                >
                  {(["all", "polygon", "line", "point"] as const).map((geometry) => (
                    <option key={geometry} value={geometry}>
                      {t(`settings.geoEditor.geometries.${geometry}`)}
                    </option>
                  ))}
                </Select>
              </Label>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                update((current) => ({ fields: current.fields.filter((_, i) => i !== index) }))
              }
            >
              {t("settings.geoEditor.remove")}
            </Button>
          </fieldset>
        ))}
      </div>
      <Button
        variant="outline"
        onClick={() =>
          update((current) => {
            let name = "attribute";
            let number = 1;
            while (current.fields.some((field) => field.name.trim() === name))
              name = `attribute_${number++}`;
            return { fields: [...current.fields, { name, type: "string", geometry: "all" }] };
          })
        }
      >
        {t("settings.geoEditor.add")}
      </Button>
      <p className="text-xs text-muted-foreground">{t("settings.geoEditor.namesHelp")}</p>
    </section>
  );
}
