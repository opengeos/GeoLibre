import { useTranslation } from "react-i18next";
import { Input, Label } from "@geolibre/ui";
import type { LayoutEditorProps } from "./state";

/** The cartographic title block ("stempel") fields (GH #522). */
export function InfoBlockEditor({ layout, dispatch }: LayoutEditorProps) {
  const { t } = useTranslation();
  const { author, projectNumber, crs, revision } = layout;
  const set = (patch: Partial<typeof layout>) => dispatch({ type: "setLayout", patch });
  return (
    <div className="grid grid-cols-2 gap-3">
      <div className="space-y-1.5">
        <Label htmlFor="layout-author">{t("printLayout.info.author")}</Label>
        <Input
          id="layout-author"
          value={author}
          placeholder={t("printLayout.info.authorPlaceholder")}
          onChange={(e) => set({ author: e.target.value })}
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="layout-project">{t("printLayout.info.project")}</Label>
        <Input
          id="layout-project"
          value={projectNumber}
          placeholder={t("printLayout.info.projectPlaceholder")}
          onChange={(e) => set({ projectNumber: e.target.value })}
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="layout-crs">{t("printLayout.info.crs")}</Label>
        <Input
          id="layout-crs"
          value={crs}
          placeholder={t("printLayout.info.crsPlaceholder")}
          onChange={(e) => set({ crs: e.target.value })}
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="layout-revision">{t("printLayout.info.revision")}</Label>
        <Input
          id="layout-revision"
          value={revision}
          placeholder={t("printLayout.info.revisionPlaceholder")}
          onChange={(e) => set({ revision: e.target.value })}
        />
      </div>
    </div>
  );
}
