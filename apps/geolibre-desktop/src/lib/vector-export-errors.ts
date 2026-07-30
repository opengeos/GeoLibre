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
