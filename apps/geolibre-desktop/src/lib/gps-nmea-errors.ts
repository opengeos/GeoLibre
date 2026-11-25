import type { TFunction } from "i18next";
import type { NmeaError } from "./nmea-source";

/**
 * Localized text for an {@link NmeaError}. Only the cases the UI can describe
 * better than the browser are translated; a `failed` error carries a message
 * relayed from the platform (a `DOMException` string, or a driver error), and
 * showing that is more useful than a generic localized sentence.
 */
export function nmeaErrorText(err: NmeaError, t: TFunction): string {
  switch (err.code) {
    case "unavailable":
      return t("gps.nmeaUnsupported");
    case "unsupported-device":
      return t("gps.nmeaUnsupportedDevice");
    case "disconnected":
      return t("gps.nmeaDisconnected");
    case "bluetooth-off":
      return t("gps.nmeaBluetoothOff");
    case "permission-denied":
      return t("gps.nmeaBluetoothPermissionDenied");
    case "connect-failed":
      return t("gps.nmeaBluetoothConnectFailed");
    case "busy":
      return t("gps.nmeaBluetoothBusy");
    case "not-paired":
      return t("gps.nmeaBluetoothNotPaired");
    default:
      return err.message;
  }
}
