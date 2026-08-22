import { useState, type ComponentType, type FormEvent, type ReactElement } from "react";
import { Trans, useTranslation } from "react-i18next";
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
import { formatShortcut, isMacPlatform, matchesShortcut, type Shortcut } from "../../lib/commands";

// `shift` is explicit: omitting it means "ignored", which would post on
// Ctrl/⌘+Shift+Enter too, a chord the button never advertises.
export const POST_COMMENT_SHORTCUT: Shortcut = { key: "Enter", mod: true, shift: false };

const postingAsComponents: Record<string, ReactElement> = {
  strong: <strong className="text-foreground" />,
};

type PostingAsTransProps = {
  i18nKey: "comments.postingAs";
  values: { name: string | null };
  components: Record<string, ReactElement>;
};

const PostingAsTrans = Trans as ComponentType<PostingAsTransProps>;

interface AddCommentDialogProps {
  pendingComment: PendingCommentState;
  onSubmit: (body: string, authorName?: string) => void;
  onCancel: () => void;
}

export function AddCommentDialog({ pendingComment, onSubmit, onCancel }: AddCommentDialogProps) {
  const { t } = useTranslation();
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
  const canSubmit = !!text.trim() && (hasSavedName || !!authorName.trim());
  const shortcutLabel = formatShortcut(POST_COMMENT_SHORTCUT, isMacPlatform());

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!text.trim()) return;

    const finalName = authorName.trim() || savedName?.trim() || t("comments.defaultAuthorName");
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
            <span>{t("comments.addDialogTitle")}</span>
          </DialogTitle>
          <DialogDescription className="text-xs text-muted-foreground">
            {t("comments.addDialogDescription")}
          </DialogDescription>
        </DialogHeader>

        <form
          onSubmit={handleSubmit}
          onKeyDown={(event) => {
            if (
              canSubmit &&
              matchesShortcut(event.nativeEvent, POST_COMMENT_SHORTCUT, isMacPlatform())
            ) {
              event.preventDefault();
              event.currentTarget.requestSubmit();
            }
          }}
          className="space-y-3.5"
        >
          <div className="flex items-center gap-2 text-xs text-muted-foreground bg-muted/50 p-2.5 rounded-md border border-border/60">
            {anchor.type === "feature" ? (
              <>
                <Layers className="h-3.5 w-3.5 text-sky-400 shrink-0" />
                <span className="truncate font-medium text-foreground">
                  {t("comments.anchoredToFeature", {
                    id: String(anchor.featureId),
                    layer: anchor.layerId,
                  })}
                </span>
              </>
            ) : (
              <>
                <MapPin className="h-3.5 w-3.5 text-amber-400 shrink-0" />
                <span className="font-medium text-foreground">
                  {t("comments.anchoredToPoint", {
                    coords: lngLat
                      ? `${lngLat[1].toFixed(4)}, ${lngLat[0].toFixed(4)}`
                      : t("comments.mapPoint"),
                  })}
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
                <span>{t("comments.authorNameLabel")}</span>
              </label>
              <Input
                id="author-name-input"
                value={authorName}
                onChange={(e) => setAuthorName(e.target.value)}
                placeholder={t("comments.authorNamePlaceholder")}
                className="text-xs h-8"
                autoFocus
              />
            </div>
          ) : (
            <div className="flex items-center justify-between text-[11px] text-muted-foreground px-1">
              <span>
                <PostingAsTrans
                  i18nKey="comments.postingAs"
                  values={{ name: savedName }}
                  components={postingAsComponents}
                />
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
                {t("comments.changeName")}
              </button>
            </div>
          )}

          <div className="space-y-1">
            <label
              htmlFor="comment-text-input"
              className="text-[11px] font-medium text-muted-foreground"
            >
              {t("comments.commentLabel")}
            </label>
            <Textarea
              id="comment-text-input"
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={t("comments.commentPlaceholder")}
              rows={3}
              className="text-xs min-h-20 resize-none"
              autoFocus={hasSavedName}
            />
          </div>

          <div className="flex items-center justify-end gap-2 pt-1">
            <Button type="button" variant="outline" size="sm" onClick={onCancel}>
              {t("common.cancel")}
            </Button>
            <Button
              type="submit"
              variant="default"
              size="sm"
              className="gap-1.5"
              disabled={!canSubmit}
              title={t("comments.postShortcutTooltip", { shortcut: shortcutLabel })}
              aria-keyshortcuts="Control+Enter Meta+Enter"
            >
              <Send className="h-3.5 w-3.5" />
              <span>{t("comments.post")}</span>
              <kbd className="ms-1 text-[10px] font-normal opacity-70">{shortcutLabel}</kbd>
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
