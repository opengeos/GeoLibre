import type { CollaborationMode, CollaborationParticipant } from "@geolibre/core";
import { Eye, Pencil } from "lucide-react";
import { useTranslation } from "react-i18next";
import { participantCanEdit } from "../../lib/collab-protocol";

interface CollaborationParticipantRowProps {
  participant: CollaborationParticipant;
  /** Current session mode, used to derive effective edit permission. */
  mode: CollaborationMode;
  /** True when this row is the local user (adds a "(you)" tag). */
  isSelf: boolean;
  /** True when the viewer is the host and may change this participant's
   *  permission. A toggle button replaces the read-only indicator. The host's
   *  own row never shows a control. */
  canManage: boolean;
  onSetParticipantMode: (clientId: string, canEdit: boolean) => void;
  /** Render the smaller variant used in the on-canvas badge roster. */
  compact?: boolean;
}

/**
 * One participant row shared by the Collaborate dialog roster and the on-canvas
 * status-badge roster (#754): color swatch, name, "you" / host tags, and either
 * a host-only per-participant permission toggle or a read-only permission
 * indicator. `compact` selects the badge's tighter sizing.
 */
export function CollaborationParticipantRow({
  participant: p,
  mode,
  isSelf,
  canManage,
  onSetParticipantMode,
  compact = false,
}: CollaborationParticipantRowProps) {
  const { t } = useTranslation();
  const editable = participantCanEdit(p, mode);
  const isHostRow = p.role === "host";
  // The host can pin any guest (never themselves) to view-only / edit.
  const showToggle = canManage && !isHostRow;
  const permIcon = editable ? (
    <Pencil className="h-3 w-3" aria-hidden="true" />
  ) : (
    <Eye className="h-3 w-3" aria-hidden="true" />
  );
  const permLabel = editable ? t("collaborate.canEdit") : t("collaborate.viewOnly");

  return (
    <li className={`flex items-center gap-2 ${compact ? "text-xs" : "text-sm"}`}>
      <span
        className={`${compact ? "h-2.5 w-2.5" : "h-3 w-3"} shrink-0 rounded-full`}
        style={{ backgroundColor: p.color }}
      />
      <span className="truncate">{p.displayName}</span>
      {isSelf && <span className="text-xs text-muted-foreground">({t("collaborate.you")})</span>}
      {isHostRow && (
        <span
          className={`rounded bg-muted py-0.5 ${compact ? "px-1 text-[10px]" : "px-1.5 text-xs"}`}
        >
          {t("collaborate.host")}
        </span>
      )}
      {!isHostRow &&
        (showToggle ? (
          <button
            type="button"
            onClick={() => onSetParticipantMode(p.clientId, !editable)}
            // A binary "can edit" vs "view-only" setting reads as a switch to
            // assistive tech, rather than a momentary press (aria-pressed).
            role="switch"
            aria-checked={editable}
            title={editable ? t("collaborate.setViewOnly") : t("collaborate.allowEdit")}
            className={`ms-auto flex shrink-0 items-center gap-1 rounded border py-0.5 text-muted-foreground transition hover:bg-accent hover:text-foreground ${compact ? "px-1 text-[10px]" : "px-1.5 text-xs"}`}
          >
            {permIcon}
            {permLabel}
          </button>
        ) : (
          // Non-host viewers still see each guest's current permission.
          <span
            className={`ms-auto flex shrink-0 items-center gap-1 text-muted-foreground ${compact ? "text-[10px]" : "text-xs"}`}
          >
            {permIcon}
            {permLabel}
          </span>
        ))}
    </li>
  );
}
