import { useTranslation } from "react-i18next";
import { Input, Label } from "@geolibre/ui";
import type { LayoutEditorProps } from "./state";

/** The footer's text. */
export function FooterEditor({ layout, dispatch }: LayoutEditorProps) {
  const { t } = useTranslation();
  return (
    <div className="space-y-1.5">
      <Label htmlFor="layout-footer">{t("printLayout.footerTextLabel")}</Label>
      <Input
        id="layout-footer"
        value={layout.footerText}
        placeholder={t("printLayout.footerPlaceholder")}
        onChange={(e) => dispatch({ type: "setLayout", patch: { footerText: e.target.value } })}
      />
    </div>
  );
}
