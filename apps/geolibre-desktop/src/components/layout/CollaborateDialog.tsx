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
import { ArrowRight, Check, Copy, Loader2, LogOut, Users } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { CollaborationApi } from "../../hooks/useCollaboration";
import { CollaborationParticipantRow } from "./CollaborationParticipantRow";

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
export function CollaborateDialog({ open, onOpenChange, api }: CollaborateDialogProps) {
  const { t } = useTranslation();
  const collaboration = useAppStore((s) => s.collaboration);
  const isActive = collaboration.isActive;

  const [name, setName] = useState("");
  const [color, setColor] = useState<string>(DEFAULT_COLOR);
  const [mode, setMode] = useState<CollaborationMode>("co-edit");
  const [code, setCode] = useState("");
  // True when the dialog was opened from a `?collab=` invite link, which
  // streamlines the layout to a single Join action (the "Start a session"
  // controls are irrelevant to an invited participant). Cleared if the user
  // explicitly chooses to host instead, or after a failed join, so they can
  // still fall back to the full layout.
  const [invited, setInvited] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<"code" | "link" | null>(null);
  const copyTimer = useRef<number | null>(null);

  // Seed from a prior session (or a ?collab= deep link) when the dialog opens.
  useEffect(() => {
    if (!open) {
      // Forget any prior invite context on close. The `?collab=` code is
      // stripped from the URL on first read, so a later manual reopen has no
      // invite link and should show the full layout, not the invited view.
      setInvited(false);
      return;
    }
    setError(null);
    setBusy(false);
    setName((prev) => prev || collaboration.selfName);
    setColor((prev) => collaboration.selfColor || prev);
    const url = new URL(window.location.href);
    const fromUrl = url.searchParams.get("collab");
    if (fromUrl) {
      setCode(fromUrl);
      setInvited(true);
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
      // The invite link could not connect (e.g. an expired or invalid code), so
      // reveal the full layout and let the user fix the code or host instead.
      setInvited(false);
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
            onDismiss={() => onOpenChange(false)}
            onSetMode={api.setMode}
            onSetParticipantMode={api.setParticipantMode}
            onSetFollowHost={api.setFollowHost}
          />
        ) : (
          <div className="space-y-4">
            {/* Name and color feed both actions below, so group them in a
                shaded panel above the cards to read as shared profile inputs
                rather than belonging to either Start or Join (#706). */}
            <div className="space-y-3 rounded-md border bg-muted/40 p-3">
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
                {/* Full panel width keeps every swatch on one row instead of
                    wrapping a lone dot to a second line (#706). */}
                <div className="flex flex-wrap gap-2 pt-1">
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

            {/* An invited participant (arrived via a `?collab=` link) only needs
                to join, so collapse the layout to a single Join action and hide
                the "Start a session" controls that are irrelevant to them
                (#753). They can still fall back to hosting via the link below. */}
            {invited ? (
              <div className="space-y-3 rounded-md border p-3">
                <div className="space-y-1">
                  <p className="text-sm font-medium">{t("collaborate.invitedHeading")}</p>
                  <p className="text-sm text-muted-foreground">
                    {t("collaborate.invitedDescription")}
                  </p>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="collab-code">{t("collaborate.sessionCode")}</Label>
                  <Input
                    id="collab-code"
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                    placeholder={t("collaborate.sessionCodePlaceholder")}
                    disabled={busy}
                    className="font-mono uppercase"
                  />
                </div>
                <Button
                  type="button"
                  onClick={() => void handleJoin()}
                  disabled={busy || !name.trim() || !code.trim()}
                  className="w-full"
                >
                  {busy ? (
                    <Loader2 className="me-2 h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Users className="me-2 h-3.5 w-3.5" />
                  )}
                  {t("collaborate.joinSession")}
                </Button>
                <button
                  type="button"
                  // Keep the prefilled `code` so the join field stays populated
                  // if the user changes their mind; the full layout shows Start
                  // as the primary action, so leaving it is non-destructive.
                  onClick={() => setInvited(false)}
                  disabled={busy}
                  className="cursor-pointer text-xs text-muted-foreground underline-offset-2 hover:underline disabled:cursor-default disabled:opacity-50"
                >
                  {t("collaborate.startInstead")}
                </button>
              </div>
            ) : (
              <>
                <div className="space-y-2 rounded-md border p-3">
                  <p className="text-sm font-medium">{t("collaborate.startHeading")}</p>
                  <div className="space-y-1.5">
                    <Label htmlFor="collab-mode">{t("collaborate.mode")}</Label>
                    <Select
                      id="collab-mode"
                      value={mode}
                      onChange={(e) => setMode(e.target.value as CollaborationMode)}
                      disabled={busy}
                    >
                      <option value="co-edit">{t("collaborate.modeCoEdit")}</option>
                      <option value="view-only">{t("collaborate.modeViewOnly")}</option>
                    </Select>
                  </div>
                  <Button
                    type="button"
                    onClick={() => void handleStart()}
                    disabled={busy || !name.trim()}
                    className="w-full"
                  >
                    {busy ? (
                      <Loader2 className="me-2 h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Users className="me-2 h-3.5 w-3.5" />
                    )}
                    {t("collaborate.start")}
                  </Button>
                </div>

                <div className="space-y-2 rounded-md border p-3">
                  <p className="text-sm font-medium">{t("collaborate.joinHeading")}</p>
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
                      disabled={busy || !name.trim() || !code.trim()}
                    >
                      {t("collaborate.join")}
                    </Button>
                  </div>
                </div>
              </>
            )}

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
  onDismiss,
  onSetMode,
  onSetParticipantMode,
  onSetFollowHost,
}: {
  shareLink: string;
  copied: "code" | "link" | null;
  onCopy: (kind: "code" | "link", value: string) => void;
  onLeave: () => void;
  onDismiss: () => void;
  onSetMode: (mode: CollaborationMode) => void;
  onSetParticipantMode: (clientId: string, canEdit: boolean) => void;
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
            <span className="text-muted-foreground">{t("collaborate.reconnecting")}</span>
          </>
        ) : (
          <>
            <span className="h-2 w-2 rounded-full bg-green-500" />
            <span className="text-muted-foreground">{t("collaborate.connected")}</span>
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
        {/* Only the host invites others, so the scan-to-join QR is host-only. */}
        {isHost && (
          <div className="flex flex-col items-center gap-1.5 pt-1">
            <div className="rounded-md bg-white p-2">
              <QRCodeSVG
                value={shareLink}
                size={132}
                marginSize={0}
                title={t("collaborate.scanToJoin")}
              />
            </div>
            <p className="text-xs text-muted-foreground">{t("collaborate.scanToJoin")}</p>
          </div>
        )}
      </div>

      <div className="space-y-1.5">
        <Label>
          {t("collaborate.participants", {
            count: collaboration.participants.length,
          })}
        </Label>
        <ul className="space-y-1">
          {collaboration.participants.map((p) => (
            <CollaborationParticipantRow
              key={p.clientId}
              participant={p}
              mode={collaboration.mode}
              isSelf={p.clientId === collaboration.clientId}
              canManage={isHost}
              onSetParticipantMode={onSetParticipantMode}
            />
          ))}
        </ul>
      </div>

      {collaboration.error && (
        <p className="rounded-md bg-destructive/10 p-2 text-sm text-destructive">
          {collaboration.error}
        </p>
      )}

      {/* Primary way out of the dialog: dismiss it while keeping the session
          live, so the host isn't tempted to use the "X" (which they fear ends
          the session) to get back to the map (#754). */}
      <Button type="button" className="w-full" onClick={onDismiss}>
        {/* A view-only guest cannot edit, so "collaborate" would mislead; offer
            "watch" wording for that case. */}
        {isHost || collaboration.mode === "co-edit"
          ? t("collaborate.goToMap")
          : t("collaborate.goToMapViewOnly")}
        <ArrowRight className="ms-2 h-3.5 w-3.5" />
      </Button>

      <div className="flex justify-between gap-2">
        {isHost ? (
          <Button
            type="button"
            variant="outline"
            onClick={() => onSetMode(collaboration.mode === "co-edit" ? "view-only" : "co-edit")}
          >
            {collaboration.mode === "co-edit"
              ? t("collaborate.switchToViewOnly")
              : t("collaborate.switchToCoEdit")}
          </Button>
        ) : (
          <span />
        )}
        <Button type="button" variant="destructive" onClick={onLeave}>
          <LogOut className="me-2 h-3.5 w-3.5" />
          {t("collaborate.leave")}
        </Button>
      </div>
    </div>
  );
}
