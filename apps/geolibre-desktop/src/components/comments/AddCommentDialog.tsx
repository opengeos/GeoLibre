import { useState } from "react";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Input,
  Textarea,
} from "@geolibre/ui";
import { MapPin, Layers, MessageSquare, Send, User } from "lucide-react";
import type { PendingCommentState } from "./useCommentTool";

interface AddCommentDialogProps {
  pendingComment: PendingCommentState;
  onSubmit: (body: string, authorName?: string) => void;
  onCancel: () => void;
}

export function AddCommentDialog({ pendingComment, onSubmit, onCancel }: AddCommentDialogProps) {
  const [savedName, setSavedName] = useState<string | null>(() => {
    try {
      return typeof localStorage !== "undefined"
        ? localStorage.getItem("geolibre_author_name")
        : null;
    } catch {
      return null;
    }
  });
  const hasSavedName = !!savedName && savedName.trim().length > 0;

  const [text, setText] = useState("");
  const [authorName, setAuthorName] = useState(savedName ?? "");

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!text.trim()) return;

    const finalName = authorName.trim() || savedName?.trim() || "Author";
    if (typeof localStorage !== "undefined" && finalName) {
      try {
        localStorage.setItem("geolibre_author_name", finalName);
        setSavedName(finalName);
      } catch {
        // ignore storage errors
      }
    }

    onSubmit(text.trim(), finalName);
    setText("");
  };

  const anchor = pendingComment.anchor;
  const lngLat = anchor.lngLat;

  return (
    <Dialog
      open={true}
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <DialogContent className="max-w-md p-5 sm:max-w-md">
        <DialogHeader className="mb-2">
          <DialogTitle className="flex items-center gap-2 text-sm">
            <MessageSquare className="h-4 w-4 text-primary" />
            <span>Add Review Comment</span>
          </DialogTitle>
          <DialogDescription className="text-xs text-muted-foreground">
            Post an anchored note on this project for team review or offline reference.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-3.5">
          <div className="flex items-center gap-2 text-xs text-muted-foreground bg-muted/50 p-2.5 rounded-md border border-border/60">
            {anchor.type === "feature" ? (
              <>
                <Layers className="h-3.5 w-3.5 text-sky-400 shrink-0" />
                <span className="truncate font-medium text-foreground">
                  Anchored to Feature #{String(anchor.featureId)} ({anchor.layerId})
                </span>
              </>
            ) : (
              <>
                <MapPin className="h-3.5 w-3.5 text-amber-400 shrink-0" />
                <span className="font-medium text-foreground">
                  Anchored to (
                  {lngLat ? `${lngLat[1].toFixed(4)}, ${lngLat[0].toFixed(4)}` : "Map Point"})
                </span>
              </>
            )}
          </div>

          {/* Prompt for name 1 time if not saved in localStorage */}
          {!hasSavedName ? (
            <div className="space-y-1">
              <label
                htmlFor="author-name-input"
                className="text-[11px] font-medium text-muted-foreground flex items-center gap-1"
              >
                <User className="h-3 w-3 text-primary" />
                <span>Your Name (Asked once, saved automatically)</span>
              </label>
              <Input
                id="author-name-input"
                value={authorName}
                onChange={(e) => setAuthorName(e.target.value)}
                placeholder="e.g. Alex or Sarah"
                className="text-xs h-8"
                autoFocus
              />
            </div>
          ) : (
            <div className="flex items-center justify-between text-[11px] text-muted-foreground px-1">
              <span>
                Posting as <strong className="text-foreground">{savedName}</strong>
              </span>
              <button
                type="button"
                onClick={() => {
                  if (typeof localStorage !== "undefined") {
                    try {
                      localStorage.removeItem("geolibre_author_name");
                    } catch {}
                  }
                  setSavedName(null);
                  setAuthorName("");
                }}
                className="text-primary hover:underline text-[10px]"
              >
                Change Name
              </button>
            </div>
          )}

          <div className="space-y-1">
            <label
              htmlFor="comment-text-input"
              className="text-[11px] font-medium text-muted-foreground"
            >
              Comment / Feedback
            </label>
            <Textarea
              id="comment-text-input"
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Type your review note or feedback here..."
              rows={3}
              className="text-xs min-h-20 resize-none"
              autoFocus={hasSavedName}
            />
          </div>

          <div className="flex items-center justify-end gap-2 pt-1">
            <Button type="button" variant="outline" size="sm" onClick={onCancel}>
              Cancel
            </Button>
            <Button
              type="submit"
              variant="default"
              size="sm"
              className="gap-1.5"
              disabled={!text.trim() || (!hasSavedName && !authorName.trim())}
            >
              <Send className="h-3.5 w-3.5" />
              <span>Post Comment</span>
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
