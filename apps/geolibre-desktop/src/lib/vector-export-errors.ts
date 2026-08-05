import type { TFunction } from "i18next";

/** Error raised when a GeoJSON feature contains coordinates KML cannot serialize. */
export class KmlCoordinateError extends Error {
  readonly featureId: string | number | undefined;
  readonly featureIndex: number;

  constructor(featureIndex: number, featureId: string | number | undefined) {
    super("KML_INVALID_COORDINATE");
    this.name = "KmlCoordinateError";
    this.featureId = featureId;
    this.featureIndex = featureIndex;
  }
}

/** Return a localized KML coordinate error, or null for an unrelated error. */
export function kmlExportErrorMessage(error: unknown, t: TFunction): string | null {
  if (!(error instanceof KmlCoordinateError)) return null;
  return error.featureId == null
    ? t("vectorExport.invalidKmlCoordinatesByPosition", {
        position: error.featureIndex + 1,
      })
    : t("vectorExport.invalidKmlCoordinatesById", {
        id: error.featureId,
      });
}
