import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Input, Label, Select } from "@geolibre/ui";
import {
  PAPER_SIZES,
  type Orientation,
  type PaperSizeId,
  type SizeUnit,
} from "../../../lib/print-layout";
import type { LayoutEditorProps } from "./state";

/** The page: paper / screen size, orientation, custom dimensions and margin. */
export function PageEditor({ layout, dispatch }: LayoutEditorProps) {
  const { t } = useTranslation();
  const { paperSize, orientation, customWidth, customHeight, customUnit, pageMargin } = layout;
  const isCustom = paperSize === "custom";
  const paperOptions = useMemo(() => PAPER_SIZES.filter((p) => p.group === "paper"), []);
  const screenOptions = useMemo(
    () => PAPER_SIZES.filter((p) => p.group === "screen" && p.id !== "custom"),
    [],
  );
  return (
    <>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="layout-paper">{t("printLayout.size")}</Label>
          <Select
            id="layout-paper"
            value={paperSize}
            onChange={(e) =>
              dispatch({ type: "setLayout", patch: { paperSize: e.target.value as PaperSizeId } })
            }
          >
            <optgroup label={t("printLayout.sizeGroup.paper")}>
              {paperOptions.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </optgroup>
            <optgroup label={t("printLayout.sizeGroup.screen")}>
              {screenOptions.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </optgroup>
            <option value="custom">{t("printLayout.sizeCustom")}</option>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="layout-orientation">{t("printLayout.orientation")}</Label>
          <Select
            id="layout-orientation"
            value={orientation}
            disabled={isCustom}
            onChange={(e) =>
              dispatch({
                type: "setLayout",
                patch: { orientation: e.target.value as Orientation },
              })
            }
          >
            <option value="portrait">{t("printLayout.portrait")}</option>
            <option value="landscape">{t("printLayout.landscape")}</option>
          </Select>
        </div>
      </div>

      {isCustom && (
        <div className="grid grid-cols-3 gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="layout-custom-w">{t("printLayout.width")}</Label>
            <Input
              id="layout-custom-w"
              type="number"
              min={1}
              value={customWidth}
              onChange={(e) =>
                dispatch({ type: "setCustomSize", width: Number(e.target.value) || 0 })
              }
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="layout-custom-h">{t("printLayout.height")}</Label>
            <Input
              id="layout-custom-h"
              type="number"
              min={1}
              value={customHeight}
              onChange={(e) =>
                dispatch({ type: "setCustomSize", height: Number(e.target.value) || 0 })
              }
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="layout-custom-unit" className="sr-only">
              {t("printLayout.unit")}
            </Label>
            <span aria-hidden="true" className="block h-5">
              &nbsp;
            </span>
            <Select
              id="layout-custom-unit"
              aria-label={t("printLayout.unit")}
              value={customUnit}
              onChange={(e) =>
                dispatch({ type: "setLayout", patch: { customUnit: e.target.value as SizeUnit } })
              }
            >
              <option value="px">px</option>
              <option value="mm">mm</option>
            </Select>
          </div>
        </div>
      )}

      <div className="space-y-1.5">
        <Label htmlFor="layout-margin">{t("printLayout.margin")}</Label>
        <Select
          id="layout-margin"
          value={pageMargin}
          onChange={(e) =>
            dispatch({
              type: "setLayout",
              patch: { pageMargin: e.target.value as "normal" | "narrow" | "none" },
            })
          }
        >
          <option value="normal">{t("printLayout.marginOption.normal")}</option>
          <option value="narrow">{t("printLayout.marginOption.narrow")}</option>
          <option value="none">{t("printLayout.marginOption.none")}</option>
        </Select>
      </div>
    </>
  );
}
