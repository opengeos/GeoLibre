/**
 * RTK corrections (NTRIP) for GPS Tracking (issue #3400): the caster settings
 * panel. Session ownership lives in the useNtripCorrections hook.
 * The client itself runs natively in the Android plugin.
 */
import { useTranslation } from "react-i18next";
import { Button, Input, Label } from "@geolibre/ui";
import { CircleStop, Satellite } from "lucide-react";
import {
  formatNtripBytes,
  ntripConfigProblem,
  ntripSessionRunning,
  type NtripConfig,
  type NtripStatus,
} from "../../lib/ntrip";

interface NtripControlsProps {
  config: NtripConfig;
  onConfigChange: (config: NtripConfig) => void;
  /** Null when no session is running. */
  status: NtripStatus | null;
  onStart: () => void;
  onStop: () => void;
}

/**
 * Caster settings and status for RTK corrections (issue #3400). The settings
 * are locked while a session runs; Stop, edit, and Start again to change them.
 */
export function NtripControls({
  config,
  onConfigChange,
  status,
  onStart,
  onStop,
}: NtripControlsProps) {
  const { t } = useTranslation();
  // A fatal error (bad login, unknown mountpoint) has stopped the client, so
  // the form unlocks and offers Start again; a retrying error has not.
  const running = ntripSessionRunning(status);
  const problem = ntripConfigProblem(config);
  const set = (patch: Partial<NtripConfig>) => onConfigChange({ ...config, ...patch });

  let statusText: string | null = null;
  if (status) {
    if (status.state === "connecting") statusText = t("gps.ntripConnecting");
    else if (status.state === "connected")
      statusText =
        status.bytes > 0
          ? t("gps.ntripReceiving", { size: formatNtripBytes(status.bytes) })
          : t("gps.ntripWaiting");
    else if (status.state === "error") {
      if (status.code === "auth-failed") statusText = t("gps.ntripAuthFailed");
      else if (status.code === "mountpoint")
        statusText = t("gps.ntripMountpointMissing", { mountpoint: config.mountpoint.trim() });
      else if (status.code === "tls") statusText = t("gps.ntripTlsFailed");
      else if (status.code === "not-started")
        statusText = t("gps.ntripStartFailed", { message: status.message ?? "" });
      else statusText = t("gps.ntripRetrying", { message: status.message ?? "" });
    }
  }
  const statusIsError = status?.state === "error";

  return (
    <div className="space-y-2 rounded-md border p-2">
      <div className="text-sm font-medium">{t("gps.ntripTitle")}</div>
      <div className="flex gap-2">
        <div className="min-w-0 flex-1 space-y-1">
          <Label htmlFor="gps-ntrip-host" className="text-xs font-normal text-muted-foreground">
            {t("gps.ntripHost")}
          </Label>
          <Input
            id="gps-ntrip-host"
            value={config.host}
            disabled={running}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            placeholder="caster.example.com"
            onChange={(e) => set({ host: e.target.value })}
          />
        </div>
        <div className="w-24 space-y-1">
          <Label htmlFor="gps-ntrip-port" className="text-xs font-normal text-muted-foreground">
            {t("gps.ntripPort")}
          </Label>
          <Input
            id="gps-ntrip-port"
            inputMode="numeric"
            value={config.port || ""}
            disabled={running}
            onChange={(e) => set({ port: Number(e.target.value.replace(/\D/g, "")) })}
          />
        </div>
      </div>
      <div className="space-y-1">
        <Label htmlFor="gps-ntrip-mount" className="text-xs font-normal text-muted-foreground">
          {t("gps.ntripMountpoint")}
        </Label>
        <Input
          id="gps-ntrip-mount"
          value={config.mountpoint}
          disabled={running}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          onChange={(e) => set({ mountpoint: e.target.value })}
        />
      </div>
      <div className="flex gap-2">
        <div className="min-w-0 flex-1 space-y-1">
          <Label htmlFor="gps-ntrip-user" className="text-xs font-normal text-muted-foreground">
            {t("gps.ntripUsername")}
          </Label>
          <Input
            id="gps-ntrip-user"
            value={config.username}
            disabled={running}
            autoCapitalize="none"
            autoCorrect="off"
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => set({ username: e.target.value })}
          />
        </div>
        <div className="min-w-0 flex-1 space-y-1">
          <Label htmlFor="gps-ntrip-pass" className="text-xs font-normal text-muted-foreground">
            {t("gps.ntripPassword")}
          </Label>
          <Input
            id="gps-ntrip-pass"
            type="password"
            value={config.password}
            disabled={running}
            autoComplete="off"
            onChange={(e) => set({ password: e.target.value })}
          />
        </div>
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={config.tls}
          disabled={running}
          onChange={(e) => set({ tls: e.target.checked })}
        />
        {t("gps.ntripTls")}
      </label>
      {running ? (
        <Button size="sm" variant="outline" onClick={onStop}>
          <CircleStop className="me-1 h-3.5 w-3.5" />
          {t("gps.ntripStop")}
        </Button>
      ) : (
        <Button size="sm" disabled={problem != null} onClick={onStart}>
          <Satellite className="me-1 h-3.5 w-3.5" />
          {t("gps.ntripStart")}
        </Button>
      )}
      {statusText && (
        <p
          className={`text-xs ${statusIsError ? "text-destructive" : "text-muted-foreground"} tabular-nums`}
          role="status"
        >
          {statusText}
        </p>
      )}
      {!running && problem && config.host.trim() !== "" && (
        <p className="text-xs text-muted-foreground">{t(`gps.${problem}`)}</p>
      )}
      {!config.tls && config.password !== "" && (
        <p className="text-xs text-muted-foreground">{t("gps.ntripCleartextHint")}</p>
      )}
      <p className="text-xs text-muted-foreground">{t("gps.ntripHint")}</p>
    </div>
  );
}
