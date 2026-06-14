import { useAppStore, type CollaborationMode } from "@geolibre/core";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  Select,
} from "@geolibre/ui";
import { Check, Copy, Loader2, LogOut, Users } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { CollaborationApi } from "../../hooks/useCollaboration";

// A small fixed palette so participant colors stay distinct and legible. Each
// entry pairs a hex value with a human-readable name for the swatch aria-label.
const COLOR_PALETTE = [
  { hex: "#2563eb", name: "blue" },
  { hex: "#dc2626", name: "red" },
  { hex: "#16a34a", name: "green" },
  { hex: "#d97706", name: "amber" },
  { hex: "#9333ea", name: "purple" },
  { hex: "#0891b2", name: "cyan" },
  { hex: "#db2777", name: "pink" },
  { hex: "#65a30d", name: "lime" },
];
const DEFAULT_COLOR = COLOR_PALETTE[0]?.hex ?? "#2563eb";

interface CollaborateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  api: CollaborationApi;
}

/**
 * Dialog for starting, joining, and managing a live collaboration session.
 * Reads live session state from the store and drives it through the
 * {@link CollaborationApi} provided by `useCollaboration`.
 */
export function CollaborateDialog({
  open,
  onOpenChange,
  api,
}: CollaborateDialogProps) {
  const { t } = useTranslation();
  const collaboration = useAppStore((s) => s.collaboration);
  const isActive = collaboration.isActive;

  const [name, setName] = useState("");
  const [color, setColor] = useState<string>(DEFAULT_COLOR);
  const [mode, setMode] = useState<CollaborationMode>("co-edit");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<"code" | "link" | null>(null);
  const copyTimer = useRef<number | null>(null);

  // Seed from a prior session (or a ?collab= deep link) when the dialog opens.
  useEffect(() => {
    if (!open) return;
    setError(null);
    setBusy(false);
    setName((prev) => prev || collaboration.selfName);
    setColor((prev) => collaboration.selfColor || prev);
    const url = new URL(window.location.href);
    const fromUrl = url.searchParams.get("collab");
    if (fromUrl) {
      setCode(fromUrl);
      // Strip the code from the address bar (and thus history/referrer) once
      // read, so the session code doesn't linger after joining.
      url.searchParams.delete("collab");
      window.history.replaceState({}, "", url.toString());
    }
  }, [open, collaboration.selfName, collaboration.selfColor]);

  useEffect(
    () => () => {
      if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
    },
    [],
  );

  const shareLink = useMemo(() => {
    if (!collaboration.sessionId) return "";
    const url = new URL(window.location.href);
    url.searchParams.set("collab", collaboration.sessionId);
    return url.toString();
  }, [collaboration.sessionId]);

  const handleCopy = (kind: "code" | "link", value: string) => {
    navigator.clipboard
      .writeText(value)
      .then(() => {
        if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
        setCopied(kind);
        copyTimer.current = window.setTimeout(() => setCopied(null), 2000);
      })
      .catch(() => {
        setError(t("collaborate.copyFailed"));
      });
  };

  const handleStart = async () => {
    if (!name.trim()) {
      setError(t("collaborate.nameRequired"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.start(name.trim(), color, mode);
    } catch (err) {
      // Show a localized message; keep the raw error in the console for
      // diagnostics (collab-client throws human-readable English strings).
      console.error("[GeoLibre] Collaboration error", err);
      setError(t("collaborate.connectFailed"));
    } finally {
      setBusy(false);
    }
  };

  const handleJoin = async () => {
    if (!name.trim()) {
      setError(t("collaborate.nameRequired"));
      return;
    }
    if (!code.trim()) {
      setError(t("collaborate.codeRequired"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.join(code.trim(), name.trim(), color);
    } catch (err) {
      // Show a localized message; keep the raw error in the console for
      // diagnostics (collab-client throws human-readable English strings).
      console.error("[GeoLibre] Collaboration error", err);
      setError(t("collaborate.connectFailed"));
    } finally {
      setBusy(false);
    }
  };

  const handleLeave = () => {
    api.leave();
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Users className="h-4 w-4" />
            {t("collaborate.title")}
          </DialogTitle>
          <DialogDescription>{t("collaborate.description")}</DialogDescription>
        </DialogHeader>

        {isActive ? (
          <ActiveSession
            shareLink={shareLink}
            copied={copied}
            onCopy={handleCopy}
            onLeave={handleLeave}
            onSetMode={api.setMode}
            onSetFollowHost={api.setFollowHost}
          />
        ) : (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="collab-name">{t("collaborate.displayName")}</Label>
                <Input
                  id="collab-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder={t("collaborate.displayNamePlaceholder")}
                  maxLength={40}
                  disabled={busy}
                  autoFocus
                />
              </div>
              <div className="space-y-1.5">
                <Label>{t("collaborate.color")}</Label>
                <div className="flex flex-wrap gap-1.5 pt-1">
                  {COLOR_PALETTE.map((c) => (
                    <button
                      key={c.hex}
                      type="button"
                      aria-label={c.name}
                      aria-pressed={color === c.hex}
                      onClick={() => setColor(c.hex)}
                      // Selection is an outer ring (offset from the swatch), so
                      // the colored circle stays the same size — a border would
                      // inset the fill and make the selected one look smaller.
                      className={`h-6 w-6 rounded-full transition ${
                        color === c.hex
                          ? "ring-2 ring-offset-2 ring-offset-background ring-foreground"
                          : ""
                      }`}
                      style={{ backgroundColor: c.hex }}
                    />
                  ))}
                </div>
              </div>
            </div>

            <div className="space-y-2 rounded-md border p-3">
              <p className="text-sm font-medium">
                {t("collaborate.startHeading")}
              </p>
              <div className="space-y-1.5">
                <Label htmlFor="collab-mode">{t("collaborate.mode")}</Label>
                <Select
                  id="collab-mode"
                  value={mode}
                  onChange={(e) => setMode(e.target.value as CollaborationMode)}
                  disabled={busy}
                >
                  <option value="co-edit">{t("collaborate.modeCoEdit")}</option>
                  <option value="view-only">
                    {t("collaborate.modeViewOnly")}
                  </option>
                </Select>
              </div>
              <Button
                type="button"
                onClick={() => void handleStart()}
                disabled={busy}
                className="w-full"
              >
                {busy ? (
                  <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Users className="mr-2 h-3.5 w-3.5" />
                )}
                {t("collaborate.start")}
              </Button>
            </div>

            <div className="space-y-2 rounded-md border p-3">
              <p className="text-sm font-medium">
                {t("collaborate.joinHeading")}
              </p>
              <div className="flex gap-2">
                <Input
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  placeholder={t("collaborate.sessionCodePlaceholder")}
                  disabled={busy}
                  className="font-mono uppercase"
                />
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => void handleJoin()}
                  disabled={busy}
                >
                  {t("collaborate.join")}
                </Button>
              </div>
            </div>

            {/* Show local validation errors and connect failures, the latter
                arriving asynchronously in the store (the WebSocket handshake
                fails after this dialog's call already resolved). */}
            {(error || collaboration.error) && (
              <p className="rounded-md bg-destructive/10 p-2 text-sm text-destructive">
                {error || collaboration.error}
              </p>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function ActiveSession({
  shareLink,
  copied,
  onCopy,
  onLeave,
  onSetMode,
  onSetFollowHost,
}: {
  shareLink: string;
  copied: "code" | "link" | null;
  onCopy: (kind: "code" | "link", value: string) => void;
  onLeave: () => void;
  onSetMode: (mode: CollaborationMode) => void;
  onSetFollowHost: (enabled: boolean) => void;
}) {
  const { t } = useTranslation();
  const collaboration = useAppStore((s) => s.collaboration);
  const isHost = collaboration.role === "host";

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 text-sm">
        {collaboration.connecting ? (
          <>
            <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
            <span className="text-muted-foreground">
              {t("collaborate.reconnecting")}
            </span>
          </>
        ) : (
          <>
            <span className="h-2 w-2 rounded-full bg-green-500" />
            <span className="text-muted-foreground">
              {t("collaborate.connected")}
            </span>
          </>
        )}
      </div>

      {/* Cameras are independent by default; a non-host can opt to follow the
          host's viewport (presenter mode). */}
      {!isHost && (
        <label className="flex cursor-pointer items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={collaboration.followHost}
            onChange={(e) => onSetFollowHost(e.target.checked)}
            className="h-4 w-4 accent-foreground"
          />
          {t("collaborate.followHost")}
        </label>
      )}

      <div className="space-y-1.5">
        <Label>{t("collaborate.sessionCode")}</Label>
        <div className="flex gap-2">
          <Input
            readOnly
            value={collaboration.sessionId ?? ""}
            className="font-mono text-sm tracking-widest"
          />
          <Button
            type="button"
            variant="secondary"
            aria-label={t("collaborate.copyCode")}
            onClick={() => onCopy("code", collaboration.sessionId ?? "")}
          >
            {copied === "code" ? (
              <Check className="h-3.5 w-3.5" />
            ) : (
              <Copy className="h-3.5 w-3.5" />
            )}
          </Button>
        </div>
      </div>

      <div className="space-y-1.5">
        <Label>{t("collaborate.shareLink")}</Label>
        <div className="flex gap-2">
          <Input readOnly value={shareLink} className="text-xs" />
          <Button
            type="button"
            variant="secondary"
            aria-label={t("collaborate.copyLink")}
            onClick={() => onCopy("link", shareLink)}
          >
            {copied === "link" ? (
              <Check className="h-3.5 w-3.5" />
            ) : (
              <Copy className="h-3.5 w-3.5" />
            )}
          </Button>
        </div>
        {/* Scan to join from a phone/tablet without typing the code. */}
        <div className="flex flex-col items-center gap-1.5 pt-1">
          <div className="rounded-md bg-white p-2">
            <QRCodeSVG
              value={shareLink}
              size={132}
              marginSize={0}
              title={t("collaborate.scanToJoin")}
            />
          </div>
          <p className="text-xs text-muted-foreground">
            {t("collaborate.scanToJoin")}
          </p>
        </div>
      </div>

      <div className="space-y-1.5">
        <Label>{t("collaborate.participants", {
          count: collaboration.participants.length,
        })}</Label>
        <ul className="space-y-1">
          {collaboration.participants.map((p) => (
            <li key={p.clientId} className="flex items-center gap-2 text-sm">
              <span
                className="h-3 w-3 shrink-0 rounded-full"
                style={{ backgroundColor: p.color }}
              />
              <span className="truncate">{p.displayName}</span>
              {p.clientId === collaboration.clientId && (
                <span className="text-xs text-muted-foreground">
                  ({t("collaborate.you")})
                </span>
              )}
              {p.role === "host" && (
                <span className="rounded bg-muted px-1.5 py-0.5 text-xs">
                  {t("collaborate.host")}
                </span>
              )}
            </li>
          ))}
        </ul>
      </div>

      {collaboration.error && (
        <p className="rounded-md bg-destructive/10 p-2 text-sm text-destructive">
          {collaboration.error}
        </p>
      )}

      <div className="flex justify-between gap-2">
        {isHost ? (
          <Button
            type="button"
            variant="outline"
            onClick={() =>
              onSetMode(
                collaboration.mode === "co-edit" ? "view-only" : "co-edit",
              )
            }
          >
            {collaboration.mode === "co-edit"
              ? t("collaborate.switchToViewOnly")
              : t("collaborate.switchToCoEdit")}
          </Button>
        ) : (
          <span />
        )}
        <Button type="button" variant="destructive" onClick={onLeave}>
          <LogOut className="mr-2 h-3.5 w-3.5" />
          {t("collaborate.leave")}
        </Button>
      </div>
    </div>
  );
}
