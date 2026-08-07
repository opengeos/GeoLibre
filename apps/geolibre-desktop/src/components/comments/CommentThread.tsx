import React, { useState } from "react";
import { useTranslation } from "react-i18next";
import type { ProjectComment } from "@geolibre/core";
import { Button, Textarea, cn } from "@geolibre/ui";
import {
  MapPin,
  Layers,
  CheckCircle2,
  RotateCcw,
  Trash2,
  CornerDownRight,
  Send,
  Navigation,
} from "lucide-react";

interface CommentThreadProps {
  comment: ProjectComment;
  index: number;
  onReply: (commentId: string, body: string) => void;
  onToggleResolve: (commentId: string, resolved: boolean) => void;
  onDelete: (commentId: string) => void;
  onZoomTo: (comment: ProjectComment) => void;
  readOnly?: boolean;
  selected?: boolean;
}

export function CommentThread({
  comment,
  index,
  onReply,
  onToggleResolve,
  onDelete,
  onZoomTo,
  readOnly = false,
  selected = false,
}: CommentThreadProps) {
  const { t } = useTranslation();
  const [replyText, setReplyText] = useState("");
  const [isReplying, setIsReplying] = useState(false);

  const handleSubmitReply = (e: React.FormEvent) => {
    e.preventDefault();
    if (!replyText.trim() || readOnly) return;
    onReply(comment.id, replyText.trim());
    setReplyText("");
    setIsReplying(false);
  };

  return (
    <div
      className={cn(
        "p-3 rounded-lg border text-xs space-y-2 transition-all",
        comment.resolved
          ? "bg-muted/30 border-border/40 opacity-70"
          : "bg-card border-border shadow-xs hover:border-border/80",
        selected && "border-primary ring-1 ring-inset ring-primary",
      )}
    >
      {/* Thread Header */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2 flex-wrap min-w-0">
          <span
            className="w-2 h-2 rounded-full shrink-0"
            style={{ backgroundColor: comment.author?.color || "#3b82f6" }}
          />
          <span className="font-semibold text-foreground truncate">
            {comment.author?.name || "Author"}
          </span>
          <span className="text-[10px] text-muted-foreground">
            {new Date(comment.createdAt).toLocaleDateString(undefined, {
              month: "short",
              day: "numeric",
              hour: "2-digit",
              minute: "2-digit",
            })}
          </span>
          {comment.resolved && (
            <span className="text-[10px] bg-emerald-500/10 text-emerald-500 font-medium px-1.5 py-0.5 rounded border border-emerald-500/20">
              Resolved
            </span>
          )}
        </div>

        <div className="flex items-center gap-0.5 shrink-0">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-7 w-7 text-muted-foreground hover:text-foreground"
            onClick={() => onZoomTo(comment)}
            title="Zoom to location"
          >
            <Navigation className="h-3.5 w-3.5" />
          </Button>

          {!readOnly && (
            <>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className={cn(
                  "h-7 w-7",
                  comment.resolved
                    ? "text-emerald-500 hover:text-emerald-600"
                    : "text-muted-foreground hover:text-emerald-500",
                )}
                onClick={() => onToggleResolve(comment.id, !comment.resolved)}
                title={comment.resolved ? "Reopen comment thread" : "Mark as resolved"}
              >
                {comment.resolved ? (
                  <RotateCcw className="h-3.5 w-3.5" />
                ) : (
                  <CheckCircle2 className="h-3.5 w-3.5" />
                )}
              </Button>

              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-7 w-7 text-muted-foreground hover:text-destructive"
                onClick={() => {
                  if (
                    typeof window !== "undefined" &&
                    window.confirm(t("comments.confirmDelete"))
                  ) {
                    onDelete(comment.id);
                  }
                }}
                title="Delete comment thread"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </>
          )}
        </div>
      </div>

      {/* Anchor Badge */}
      <div className="flex items-center gap-1.5 mb-2 text-[11px] text-muted-foreground bg-muted/50 px-2 py-1 rounded border border-border/40">
        {comment.anchor.type === "feature" ? (
          <>
            <Layers className="h-3 w-3 text-sky-400 shrink-0" />
            <span className="truncate">
              Feature #{String(comment.anchor.featureId)} ({comment.anchor.layerId})
            </span>
          </>
        ) : (
          <>
            <MapPin className="h-3 w-3 text-amber-400 shrink-0" />
            <span>
              Point (
              {comment.anchor.lngLat
                ? `${comment.anchor.lngLat[1].toFixed(4)}, ${comment.anchor.lngLat[0].toFixed(4)}`
                : "Map"}
              )
            </span>
          </>
        )}
      </div>

      {/* Comment Body */}
      <p className="text-foreground text-xs leading-relaxed whitespace-pre-wrap">{comment.body}</p>

      {/* Replies List */}
      {comment.replies && comment.replies.length > 0 && (
        <div className="mt-2.5 space-y-2 ps-2.5 border-s-2 border-border/60">
          {comment.replies.map((reply) => (
            <div key={reply.id} className="space-y-1">
              <div className="flex items-center gap-1.5">
                <span
                  className="w-1.5 h-1.5 rounded-full shrink-0"
                  style={{ backgroundColor: reply.author?.color || "#3b82f6" }}
                />
                <span className="font-semibold text-foreground text-[11px]">
                  {reply.author?.name || "Author"}
                </span>
                <span className="text-[10px] text-muted-foreground">
                  {new Date(reply.createdAt).toLocaleDateString(undefined, {
                    month: "short",
                    day: "numeric",
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </span>
              </div>
              <p className="text-foreground/90 text-xs whitespace-pre-wrap">{reply.body}</p>
            </div>
          ))}
        </div>
      )}

      {/* Reply Trigger or Reply Form */}
      {!readOnly &&
        (!isReplying ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="text-xs text-muted-foreground hover:text-foreground gap-1.5 h-6 px-2"
            onClick={() => setIsReplying(true)}
          >
            <CornerDownRight className="h-3 w-3" />
            <span>Reply</span>
          </Button>
        ) : (
          <form onSubmit={handleSubmitReply} className="mt-2 space-y-2">
            <Textarea
              value={replyText}
              onChange={(e) => setReplyText(e.target.value)}
              placeholder="Write a reply..."
              rows={2}
              className="text-xs min-h-14 resize-none"
              autoFocus
            />
            <div className="flex items-center justify-end gap-1.5">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  setIsReplying(false);
                  setReplyText("");
                }}
              >
                Cancel
              </Button>
              <Button type="submit" variant="default" size="sm" className="gap-1">
                <Send className="h-3 w-3" />
                <span>Reply</span>
              </Button>
            </div>
          </form>
        ))}
    </div>
  );
}
