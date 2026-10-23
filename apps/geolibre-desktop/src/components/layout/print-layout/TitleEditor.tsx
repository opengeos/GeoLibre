import { useTranslation } from "react-i18next";
import { Input, Label, Select } from "@geolibre/ui";
import type { LayoutEditorProps } from "./state";

interface TitleEditorProps extends LayoutEditorProps {
  projectName: string | null | undefined;
}

/** Title and subtitle text, and where / how the title block sits. */
export function TitleEditor({ layout, dispatch, projectName }: TitleEditorProps) {
  const { t } = useTranslation();
  const { title, subtitle, titlePlacement, titleAlign } = layout;
  return (
    <>
      <div className="space-y-1.5">
        <Label htmlFor="layout-title">{t("printLayout.titleLabel")}</Label>
        <Input
          id="layout-title"
          value={title}
          onChange={(e) => dispatch({ type: "setLayout", patch: { title: e.target.value } })}
          placeholder={(projectName ?? "").trim() || t("printLayout.titlePlaceholder")}
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="layout-subtitle">{t("printLayout.subtitleLabel")}</Label>
        <Input
          id="layout-subtitle"
          value={subtitle}
          onChange={(e) => dispatch({ type: "setLayout", patch: { subtitle: e.target.value } })}
          placeholder={t("printLayout.subtitlePlaceholder")}
        />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="layout-title-placement">{t("printLayout.titlePlacement")}</Label>
          <Select
            id="layout-title-placement"
            value={titlePlacement}
            onChange={(e) =>
              dispatch({
                type: "setLayout",
                patch: { titlePlacement: e.target.value as "outside" | "inside" },
              })
            }
          >
            <option value="outside">{t("printLayout.placement.outside")}</option>
            <option value="inside">{t("printLayout.placement.inside")}</option>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="layout-title-align">{t("printLayout.alignment")}</Label>
          <Select
            id="layout-title-align"
            value={titleAlign}
            onChange={(e) =>
              dispatch({
                type: "setLayout",
                patch: { titleAlign: e.target.value as "left" | "center" | "right" },
              })
            }
          >
            <option value="left">{t("printLayout.align.left")}</option>
            <option value="center">{t("printLayout.align.center")}</option>
            <option value="right">{t("printLayout.align.right")}</option>
          </Select>
        </div>
      </div>
    </>
  );
}
