import { ObiaError } from "@geolibre/processing";
import type { TFunction } from "i18next";
import { ObiaRestoreError } from "./obia-persistence";

/**
 * The message to show for a workbench failure: a translated message for the
 * input errors the OBIA engine raises as {@link ObiaError}, the error's own
 * message otherwise (tool output, which is not translatable), or `fallback`.
 *
 * @param err The caught value.
 * @param t The translator.
 * @param fallback Message when `err` carries none.
 */
export function obiaErrorMessage(err: unknown, t: TFunction, fallback: string): string {
  if (err instanceof ObiaError) {
    switch (err.code) {
      case "image-too-large":
        return t("obia.error.imageTooLarge", {
          width: err.params.width,
          height: err.params.height,
          max: err.params.max.toLocaleString(),
        });
      case "too-many-bands":
        return t("obia.error.tooManyBands", { count: err.params.bands });
      case "no-such-band":
        return t("obia.error.noSuchBand", { index: err.params.index });
      case "no-bands":
        return t("obia.error.noBands");
      case "missing-fields":
        return t("obia.error.missingFields", { count: err.params.count });
    }
  }
  if (err instanceof ObiaRestoreError) {
    return t(
      err.code === "source-missing" ? "obia.error.sourceMissing" : "obia.error.sourceChanged",
    );
  }
  return err instanceof Error && err.message ? err.message : fallback;
}
