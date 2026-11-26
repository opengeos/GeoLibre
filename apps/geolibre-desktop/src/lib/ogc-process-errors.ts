import i18next from "i18next";
import type en from "../i18n/locales/en.json";

type ErrorCode = keyof typeof en.processing.ogcProcesses.errors;
type ErrorParameters = Record<string, string | number>;

/** Keep client-owned errors translatable while preserving service details. */
export class OgcProcessError extends Error {
  constructor(
    readonly code: ErrorCode,
    readonly parameters: ErrorParameters = {},
  ) {
    super(i18next.t(`processing.ogcProcesses.errors.${code}`, parameters));
    this.name = "OgcProcessError";
  }
}

/** Resolve stored errors again so an open dialog follows language changes. */
export function ogcProcessErrorText(error: unknown): string {
  return error instanceof OgcProcessError
    ? i18next.t(`processing.ogcProcesses.errors.${error.code}`, error.parameters)
    : error instanceof Error
      ? error.message
      : String(error);
}
