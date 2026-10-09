import { OBIA_RULESET_MAX_STEPS, ObiaError, ObiaRulesetError } from "@geolibre/processing";
import type { TFunction } from "i18next";
import { ObiaContextError } from "./obia-context";
import { ObiaLevelError } from "./obia-levels";
import { ObiaRestoreError } from "./obia-persistence";

const CONTEXT_ERRORS = {
  "no-features": "obia.context.error.noFeatures",
  "no-links": "obia.context.error.noLinks",
  "no-sizes": "obia.context.error.noSizes",
  "no-above": "obia.context.error.noAbove",
} as const;

const LEVEL_ERRORS = {
  "no-features": "obia.levels.error.noFeatures",
  "too-large": "obia.levels.error.tooLarge",
  "not-top": "obia.levels.error.notTop",
  "too-deep": "obia.levels.error.tooDeep",
  "bad-scale": "obia.levels.error.badScale",
} as const;

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
      case "empty-area":
        return t("obia.error.emptyArea");
      case "missing-fields":
        return t("obia.error.missingFields", { count: err.params.count });
    }
  }
  if (err instanceof ObiaRulesetError) {
    return t("obia.ruleset.tooLong", { max: OBIA_RULESET_MAX_STEPS.toLocaleString() });
  }
  if (err instanceof ObiaLevelError) {
    return t(LEVEL_ERRORS[err.code]);
  }
  if (err instanceof ObiaContextError) {
    return t(CONTEXT_ERRORS[err.code]);
  }
  if (err instanceof ObiaRestoreError) {
    return t(
      err.code === "source-missing" ? "obia.error.sourceMissing" : "obia.error.sourceChanged",
    );
  }
  return err instanceof Error && err.message ? err.message : fallback;
}
