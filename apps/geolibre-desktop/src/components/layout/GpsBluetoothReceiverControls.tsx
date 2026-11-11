/**
 * The Android app's receiver picker for GPS Tracking (issue #3397), split out
 * of GpsTrackingDialog.tsx, plus the localized NMEA error text both share.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { Button, Label, Select } from "@geolibre/ui";
import { Bluetooth, RefreshCw } from "lucide-react";
import { appendDiagnostic, formatUnknown } from "../../lib/diagnostics";
import {
  listPairedBluetoothDevices,
  NmeaError,
  type PairedBluetoothDevice,
} from "../../lib/nmea-source";

/** Remembered paired receiver in the Android app, preselected on the next visit. */
const NMEA_BLUETOOTH_DEVICE_STORAGE_KEY = "geolibre.gpsTracking.bluetoothDevice";

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
    default:
      return err.message;
  }
}

function loadStoredBluetoothAddress(): string | null {
  try {
    return window.localStorage.getItem(NMEA_BLUETOOTH_DEVICE_STORAGE_KEY);
  } catch {
    return null;
  }
}

interface AndroidBluetoothControlsProps {
  connecting: boolean;
  disabled: boolean;
  onConnect: (device: PairedBluetoothDevice) => void;
}

/**
 * Receiver picker for the Android app (issue #3397): lists the devices paired
 * in Android's Bluetooth settings and connects to the chosen one over its
 * Serial Port Profile through the native plugin. The list loads on mount,
 * which is when Android asks for the Bluetooth permission the first time; the
 * last receiver used is preselected so reconnecting is one tap.
 */
export function AndroidBluetoothControls({
  connecting,
  disabled,
  onConnect,
}: AndroidBluetoothControlsProps) {
  const { t } = useTranslation();
  const [devices, setDevices] = useState<PairedBluetoothDevice[] | null>(null);
  const [address, setAddress] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const mountedRef = useRef(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    setListError(null);
    try {
      const paired = await listPairedBluetoothDevices();
      if (!mountedRef.current) return;
      setDevices(paired);
      const stored = loadStoredBluetoothAddress();
      setAddress((current) => {
        const keep = [current, stored].find((a) => a && paired.some((d) => d.address === a));
        return keep ?? paired[0]?.address ?? "";
      });
    } catch (err) {
      if (!mountedRef.current) return;
      setDevices(null);
      setListError(err instanceof NmeaError ? nmeaErrorText(err, t) : t("gps.nmeaConnectFailed"));
      appendDiagnostic({
        category: "runtime",
        level: "warning",
        message: "GPS: could not list paired Bluetooth devices",
        detail: formatUnknown(err),
        source: "gps-tracking",
      });
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    mountedRef.current = true;
    void refresh();
    return () => {
      mountedRef.current = false;
    };
  }, [refresh]);

  const selected = devices?.find((d) => d.address === address) ?? null;

  const connect = () => {
    if (!selected) return;
    try {
      window.localStorage.setItem(NMEA_BLUETOOTH_DEVICE_STORAGE_KEY, selected.address);
    } catch {
      // Best-effort; the user just picks the receiver again next time.
    }
    onConnect(selected);
  };

  return (
    <div className="space-y-2">
      <Label htmlFor="gps-nmea-bt-device" className="text-xs font-normal text-muted-foreground">
        {t("gps.nmeaPairedDevice")}
      </Label>
      <div className="flex gap-2">
        <Select
          id="gps-nmea-bt-device"
          className="min-w-0 flex-1"
          value={address}
          disabled={loading || !devices?.length}
          onChange={(e) => setAddress(e.target.value)}
        >
          {devices?.length ? (
            devices.map((d) => (
              <option key={d.address} value={d.address}>
                {d.type === "le" ? t("gps.nmeaDeviceBleOnly", { name: d.name }) : d.name}
              </option>
            ))
          ) : (
            <option value="">
              {loading ? t("gps.nmeaLoadingDevices") : t("gps.nmeaNoPairedDevices")}
            </option>
          )}
        </Select>
        <Button
          size="icon"
          variant="outline"
          disabled={loading}
          onClick={() => void refresh()}
          aria-label={t("gps.nmeaRefreshDevices")}
          title={t("gps.nmeaRefreshDevices")}
        >
          <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
        </Button>
      </div>
      <Button
        size="sm"
        disabled={!selected || selected.type === "le" || disabled}
        onClick={connect}
      >
        <Bluetooth className="me-1 h-3.5 w-3.5" />
        {connecting ? t("gps.nmeaConnecting") : t("gps.nmeaConnectReceiver")}
      </Button>
      {listError && <p className="text-xs text-destructive">{listError}</p>}
      <p className="text-xs text-muted-foreground">{t("gps.nmeaAndroidBluetoothHint")}</p>
    </div>
  );
}
