import React, { useState } from "react";
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
}

export function CommentThread({
  comment,
  index,
  onReply,
  onToggleResolve,
  onDelete,
  onZoomTo,
}: CommentThreadProps) {
  const [replyText, setReplyText] = useState("");
  const [isReplying, setIsReplying] = useState(false);

  const handleSubmitReply = (e: React.FormEvent) => {
    e.preventDefault();
    if (!replyText.trim()) return;
    onReply(comment.id, replyText.trim());
    setReplyText("");
    setIsReplying(false);
  };

  const isFeature = comment.anchor.type === "feature";
  const anchorLngLat = comment.anchor.lngLat;

  const formattedDate = new Date(comment.createdAt).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

  return (
    <div
      className={cn(
        "group relative rounded-lg border bg-card text-card-foreground p-3.5 shadow-sm transition-all duration-150",
        comment.resolved
          ? "border-border/50 bg-muted/30 opacity-75"
          : "border-border hover:border-border/80 hover:shadow-md",
      )}
    >
      {/* Thread Header */}
      <div className="flex items-start justify-between gap-2 mb-2">
        <div className="flex items-center gap-2 min-w-0">
          <div
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-bold text-white shadow-sm"
            style={{ backgroundColor: comment.author?.color || "hsl(var(--primary))" }}
          >
            #{index + 1}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <span className="truncate text-xs font-semibold text-foreground">
                {comment.author?.name || "Author"}
              </span>
              <span className="text-[10px] text-muted-foreground">• {formattedDate}</span>
            </div>
          </div>
        </div>

        {/* Action Buttons */}
        <div className="flex items-center gap-1 opacity-90 group-hover:opacity-100">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-7 w-7 text-muted-foreground hover:text-primary"
            onClick={() => onZoomTo(comment)}
            title="Zoom to comment location on map"
          >
            <Navigation className="h-3.5 w-3.5" />
          </Button>

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
            onClick={() => onDelete(comment.id)}
            title="Delete comment thread"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
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
              {anchorLngLat
                ? `${anchorLngLat[1].toFixed(4)}, ${anchorLngLat[0].toFixed(4)}`
                : "Map Point"}
              )
            </span>
          </>
        )}
      </div>

      {/* Comment Body */}
      <p className="text-xs text-foreground/90 whitespace-pre-wrap leading-relaxed mb-3">
        {comment.body}
      </p>

      {/* Replies List */}
      {comment.replies && comment.replies.length > 0 && (
        <div className="space-y-2 mb-3 pl-2.5 border-l-2 border-border/60">
          {comment.replies.map((reply) => (
            <div key={reply.id} className="bg-muted/40 rounded p-2 text-xs">
              <div className="flex items-center justify-between gap-1 mb-1">
                <div className="flex items-center gap-1.5">
                  <span
                    className="inline-block h-2 w-2 rounded-full"
                    style={{ backgroundColor: reply.author?.color || "hsl(var(--primary))" }}
                  />
                  <span className="font-semibold text-foreground text-[11px]">
                    {reply.author?.name || "Author"}
                  </span>
                </div>
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
      {!isReplying ? (
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
      )}
    </div>
  );
}
