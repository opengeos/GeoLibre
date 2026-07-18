import type { AttributeFormFieldError } from "@geolibre/core";
import type { TFunction } from "i18next";

/**
 * Localize an Attribute Form validation error (`@geolibre/core`'s
 * `validateAttributeFormValues`) into the message both editing surfaces show —
 * the attribute table's cell tooltip and the Field Collection form's inline
 * error. A constraint failure prefers the author's own description over the
 * generic message.
 */
export function attributeFormErrorMessage(t: TFunction, error: AttributeFormFieldError): string {
  if (error.code === "required") return t("attributeForm.error.required");
  if (error.code === "number") return t("attributeForm.error.number");
  if (error.code === "range") {
    if (error.min != null && error.max != null)
      return t("attributeForm.error.range", {
        min: error.min,
        max: error.max,
      });
    if (error.min != null) return t("attributeForm.error.rangeMin", { min: error.min });
    return t("attributeForm.error.rangeMax", { max: error.max });
  }
  if (error.code === "valueMap") return t("attributeForm.error.valueMap");
  return error.message ?? t("attributeForm.error.constraint");
}
