import { useState, useEffect, useRef } from "react";
import { useAppStore, type ProjectComment, type CommentReply } from "@geolibre/core";
import type { MapController } from "@geolibre/map";
import { Button, Input, ScrollArea, cn } from "@geolibre/ui";
import {
  MessageSquare,
  Plus,
  MessageCircle,
  Copy,
  Link2,
  KeyRound,
  Radio,
  User,
  Pencil,
  Check,
} from "lucide-react";
import { v4 as uuidv4 } from "uuid";
import { CommentThread } from "./CommentThread";
import { resolveCommentCoordinates } from "./CommentMapOverlay";
import type { CollaborationApi } from "../../hooks/useCollaboration";

const LS_NAME_KEY = "geolibre_author_name";

function getStoredName(): string {
  try {
    return (typeof localStorage !== "undefined" && localStorage.getItem(LS_NAME_KEY)) || "";
  } catch {
    return "";
  }
}

function saveStoredName(name: string): void {
  try {
    if (typeof localStorage !== "undefined") {
      if (name.trim()) {
        localStorage.setItem(LS_NAME_KEY, name.trim());
      } else {
        localStorage.removeItem(LS_NAME_KEY);
      }
    }
  } catch {
    // ignore
  }
}

interface CommentsPanelProps {
  mapControllerRef: React.RefObject<MapController | null>;
  collaboration?: CollaborationApi;
  onActivateCommentTool?: () => void;
  isCommentToolActive?: boolean;
  /** Called when the resolved-pins visibility should change. Receives `true`
   *  when the "Resolved" or "All" filter is active, `false` for "Open". */
  onShowResolvedChange?: (showResolved: boolean) => void;
}

export function CommentsPanel({
  mapControllerRef,
  collaboration,
  onActivateCommentTool,
  isCommentToolActive,
  onShowResolvedChange,
}: CommentsPanelProps) {
  const comments = useAppStore((s) => s.comments);
  const replyToComment = useAppStore((s) => s.replyToComment);
  const toggleResolveComment = useAppStore((s) => s.toggleResolveComment);
  const deleteComment = useAppStore((s) => s.deleteComment);
  const collab = useAppStore((s) => s.collaboration);

  const [filter, setFilter] = useState<"all" | "open" | "resolved">("open");

  // Notify parent whenever resolved pins should show/hide so the map overlay
  // stays in sync with the sidebar filter.
  useEffect(() => {
    onShowResolvedChange?.(filter !== "open");
  }, [filter, onShowResolvedChange]);

  const [joinCodeInput, setJoinCodeInput] = useState<string>("");
  const [copied, setCopied] = useState<boolean>(false);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // ── Display name ──────────────────────────────────────────────────────────
  // When a collab session is active the name comes from the session identity.
  // When offline, the user sets it here once and it persists to localStorage.
  const [storedName, setStoredName] = useState<string>(getStoredName);
  const [editingName, setEditingName] = useState<boolean>(false);
  const [nameInput, setNameInput] = useState<string>("");
  const nameInputRef = useRef<HTMLInputElement>(null);

  const selfAuthorName = collab.isActive && collab.selfName ? collab.selfName : storedName || "";
  const selfAuthorColor = collab.isActive && collab.selfColor ? collab.selfColor : "#3b82f6";

  const handleEditName = () => {
    setNameInput(storedName);
    setEditingName(true);
    // Focus after state flush
    setTimeout(() => nameInputRef.current?.focus(), 0);
  };

  const handleSaveName = () => {
    const trimmed = nameInput.trim();
    saveStoredName(trimmed);
    setStoredName(trimmed);
    setEditingName(false);
  };

  const handleNameKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") handleSaveName();
    if (e.key === "Escape") setEditingName(false);
  };

  // The real session code comes from the store once start() has resolved.
  const activeCode = collab.sessionId ?? "";

  const handleCopyCode = async () => {
    if (!activeCode) return;
    try {
      await navigator.clipboard.writeText(activeCode);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // ignore clipboard error
    }
  };

  const handleConnectSession = async () => {
    const targetCode = joinCodeInput.trim().toUpperCase();
    if (!targetCode || !collaboration) return;
    setSessionError(null);
    setBusy(true);
    try {
      await collaboration.join(targetCode, selfAuthorName, selfAuthorColor);
    } catch (err: unknown) {
      setSessionError(err instanceof Error ? err.message : "Failed to join session.");
    } finally {
      setBusy(false);
    }
  };

  const handleStartHostingSession = async () => {
    if (!collaboration) return;
    setSessionError(null);
    setBusy(true);
    try {
      await collaboration.start(selfAuthorName, selfAuthorColor, "co-edit");
    } catch (err: unknown) {
      setSessionError(err instanceof Error ? err.message : "Failed to start session.");
    } finally {
      setBusy(false);
    }
  };

  const handleDisconnectSession = () => {
    collaboration?.leave();
  };

  const canModifyComments = !collab.isActive || (collaboration?.canEdit() ?? true);

  const handleReply = (commentId: string, body: string) => {
    if (!canModifyComments) return;
    const reply: CommentReply = {
      id: uuidv4(),
      author: { name: selfAuthorName, color: selfAuthorColor },
      body,
      createdAt: new Date().toISOString(),
    };
    replyToComment(commentId, reply);
    if (collab.isActive) {
      collaboration?.sendCommentMutation({ type: "reply", commentId, reply });
    }
  };

  const handleToggleResolve = (commentId: string, resolved: boolean) => {
    if (!canModifyComments) return;
    toggleResolveComment(commentId, resolved);
    if (collab.isActive) {
      collaboration?.sendCommentMutation({ type: "toggle-resolve", commentId, resolved });
    }
  };

  const handleDelete = (commentId: string) => {
    if (!canModifyComments) return;
    deleteComment(commentId);
    if (collab.isActive) {
      collaboration?.sendCommentMutation({ type: "delete", commentId });
    }
  };

  const handleZoomTo = (comment: ProjectComment) => {
    const map = mapControllerRef.current?.getMap() ?? null;
    if (!map) return;
    const coords = resolveCommentCoordinates(comment, map);
    if (coords) {
      map.flyTo({ center: coords, zoom: Math.max(map.getZoom(), 15), duration: 800 });
    }
  };

  const unresolvedComments = comments.filter((c) => !c.resolved);
  const resolvedComments = comments.filter((c) => c.resolved);
  const filteredComments = comments.filter((c) => {
    if (filter === "open") return !c.resolved;
    if (filter === "resolved") return c.resolved;
    return true;
  });

  return (
    <div className="flex flex-col h-full bg-background text-foreground overflow-hidden select-none">
      {/* Panel Header */}
      <div className="flex items-center justify-between h-10 px-3 border-b border-border bg-card shrink-0">
        <div className="flex items-center gap-2">
          <MessageSquare className="h-4 w-4 text-primary" />
          <span className="font-semibold text-xs text-foreground">Comments</span>
          <span className="inline-flex items-center justify-center h-4 px-1.5 text-[10px] font-bold rounded-full bg-muted text-muted-foreground">
            {unresolvedComments.length}
          </span>
        </div>
        {onActivateCommentTool && (
          <Button
            type="button"
            variant={isCommentToolActive ? "default" : "secondary"}
            size="sm"
            onClick={onActivateCommentTool}
            className="gap-1 h-7 px-2 text-xs"
            title="Place a new review comment on the map"
          >
            <Plus className="h-3.5 w-3.5" />
            <span>Add Comment</span>
          </Button>
        )}
      </div>

      {/* Display Name — shown when not in an active collab session */}
      {!collab.isActive && (
        <div className="flex items-center gap-2 px-3 py-2 border-b border-border bg-muted/20 shrink-0">
          <User className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
          {editingName ? (
            <div className="flex items-center gap-1.5 flex-1 min-w-0">
              <Input
                ref={nameInputRef}
                value={nameInput}
                onChange={(e) => setNameInput(e.target.value)}
                onKeyDown={handleNameKeyDown}
                onBlur={handleSaveName}
                placeholder="Your name…"
                className="h-6 text-xs flex-1 min-w-0 px-1.5"
              />
              <button
                type="button"
                onMouseDown={(e) => {
                  e.preventDefault();
                  handleSaveName();
                }}
                className="text-emerald-500 hover:text-emerald-600 shrink-0"
                title="Save name"
              >
                <Check className="h-3.5 w-3.5" />
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-1.5 flex-1 min-w-0">
              {selfAuthorName ? (
                <span className="text-[11px] text-foreground font-medium truncate">
                  {selfAuthorName}
                </span>
              ) : (
                <span className="text-[11px] text-muted-foreground italic truncate">
                  No name set — comments will show as "Author"
                </span>
              )}
              <button
                type="button"
                onClick={handleEditName}
                className="text-muted-foreground hover:text-foreground shrink-0 ms-auto"
                title={selfAuthorName ? "Change name" : "Set your name"}
              >
                <Pencil className="h-3 w-3" />
              </button>
            </div>
          )}
        </div>
      )}

      {/* Session Controls — only shown when the relay is configured */}
      {collaboration?.enabled && (
        <div className="p-2.5 space-y-2 border-b border-border bg-muted/30 shrink-0">
          {/* Session code — only shown once a session is active */}
          {collab.isActive && activeCode ? (
            <div className="flex items-center justify-between gap-2 p-2 rounded-md bg-card border border-border">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1 text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
                  <KeyRound className="h-3 w-3 text-primary shrink-0" />
                  <span>Session Code</span>
                </div>
                <div className="font-mono text-xs font-bold text-primary tracking-widest truncate mt-0.5">
                  {activeCode}
                </div>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleCopyCode}
                className="h-7 px-2 text-[11px] shrink-0"
                title="Copy session code"
              >
                <Copy className="h-3 w-3 me-1" />
                {copied ? "Copied" : "Copy"}
              </Button>
            </div>
          ) : (
            /* Host button — starts a new session */
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={handleStartHostingSession}
              disabled={busy || !collaboration}
              className="w-full h-8 text-xs gap-1.5"
            >
              <Radio className="h-3.5 w-3.5 text-emerald-500" />
              {busy ? "Starting…" : "Start Live Session"}
            </Button>
          )}

          {/* Join input — only shown when not already active */}
          {!collab.isActive && (
            <div className="flex items-center gap-1.5 p-2 rounded-md bg-card border border-border">
              <Input
                value={joinCodeInput}
                onChange={(e) =>
                  setJoinCodeInput(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))
                }
                placeholder="ENTER SESSION CODE"
                className="h-7 font-mono text-xs uppercase tracking-wider"
                disabled={busy}
              />
              <Button
                type="button"
                variant="default"
                size="sm"
                onClick={handleConnectSession}
                disabled={busy || !joinCodeInput.trim() || !collaboration}
                className="h-7 px-2.5 text-[11px] gap-1 shrink-0"
              >
                <Link2 className="h-3 w-3" />
                <span>{busy ? "Joining…" : "Connect"}</span>
              </Button>
            </div>
          )}

          {/* Status indicator */}
          <div className="flex items-center justify-between p-2 rounded-md bg-card border border-border text-xs">
            <div className="flex items-center gap-2 min-w-0">
              <span
                className={cn(
                  "h-2.5 w-2.5 rounded-full shrink-0",
                  collab.isActive ? "bg-emerald-500 animate-pulse" : "bg-muted-foreground/40",
                )}
              />
              <span className="font-medium text-[11px] truncate">
                {collab.connecting
                  ? "Connecting…"
                  : collab.isActive
                    ? `Live Sync (${collab.participants?.length ?? 1} online)`
                    : "Offline / Private Workspace"}
              </span>
            </div>
            {collab.isActive && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={handleDisconnectSession}
                className="h-6 px-1.5 text-[10px] text-destructive hover:text-destructive hover:bg-destructive/10 shrink-0"
              >
                Disconnect
              </Button>
            )}
          </div>

          {sessionError && (
            <div className="text-[11px] text-destructive bg-destructive/10 p-1.5 rounded border border-destructive/30">
              {sessionError}
            </div>
          )}
        </div>
      )}

      {/* Filter Bar */}
      <div className="flex items-center gap-1 p-2 border-b border-border bg-muted/20 shrink-0">
        {(["open", "resolved", "all"] as const).map((f) => (
          <button
            key={f}
            type="button"
            onClick={() => setFilter(f)}
            className={cn(
              "flex-1 py-1 px-2 text-[11px] font-medium rounded transition-colors text-center",
              filter === f
                ? "bg-card text-foreground shadow-xs border border-border"
                : "text-muted-foreground hover:text-foreground hover:bg-muted/50",
            )}
          >
            {f === "open"
              ? `Open (${unresolvedComments.length})`
              : f === "resolved"
                ? `Resolved (${resolvedComments.length})`
                : `All (${comments.length})`}
          </button>
        ))}
      </div>

      {/* Threads */}
      <ScrollArea className="flex-1 p-3">
        {filteredComments.length === 0 ? (
          <div className="flex flex-col items-center justify-center min-h-[160px] text-center p-4 border border-dashed border-border/60 rounded-lg bg-card/40 my-2">
            <MessageCircle className="h-8 w-8 text-muted-foreground/50 mb-2" />
            <p className="text-xs font-medium text-foreground mb-1">
              {filter === "resolved" ? "No resolved comments" : "No open comments"}
            </p>
            <p className="text-[11px] text-muted-foreground max-w-[200px]">
              Click &quot;Add Comment&quot; above and select any location or feature on the map to
              drop a review note.
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {filteredComments.map((comment) => {
              const originalIndex = comments.findIndex((c) => c.id === comment.id);
              return (
                <CommentThread
                  key={comment.id}
                  comment={comment}
                  index={originalIndex >= 0 ? originalIndex : 0}
                  onReply={handleReply}
                  onToggleResolve={handleToggleResolve}
                  onDelete={handleDelete}
                  onZoomTo={handleZoomTo}
                />
              );
            })}
          </div>
        )}
      </ScrollArea>
    </div>
  );
}
