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
import { Check, Copy, ExternalLink, Loader2, Share2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useDesktopSettingsStore } from "../../hooks/useDesktopSettings";
import { openExternalLink } from "../../lib/open-external";
import {
  isShareableTitle,
  uploadProjectToShare,
  type ShareUploadResult,
  type ShareVisibility,
} from "../../lib/share-geolibre";

interface ShareProjectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The current project name, used to seed the title field. */
  currentTitle: string;
  /**
   * Lazily serialize the current project (under the given title) when the user
   * confirms the upload.
   */
  getProject: (title: string) => { content: string; filename: string };
}

const SETTINGS_TOKEN_URL = "https://share.geolibre.app/settings";

export function ShareProjectDialog({
  open,
  onOpenChange,
  currentTitle,
  getProject,
}: ShareProjectDialogProps) {
  const shareToken = useDesktopSettingsStore((s) => s.desktopSettings.shareToken);
  const [title, setTitle] = useState("");
  const [visibility, setVisibility] = useState<ShareVisibility>("unlisted");
  const [status, setStatus] = useState<"idle" | "uploading">("idle");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ShareUploadResult | null>(null);
  const [copied, setCopied] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const copyTimeoutRef = useRef<number | null>(null);

  // Reset transient state whenever the dialog is (re)opened so a prior result or
  // error never lingers into a new share. Seed the title from the current
  // project name, but leave it blank when the project still has its default
  // placeholder name so the field reads as a prompt.
  useEffect(() => {
    if (open) {
      setTitle(isShareableTitle(currentTitle) ? currentTitle.trim() : "");
      setStatus("idle");
      setError(null);
      setResult(null);
      setCopied(false);
    } else {
      abortRef.current?.abort();
      abortRef.current = null;
    }
  }, [open, currentTitle]);

  // Cancel a pending "copied" reset if the dialog unmounts mid-window.
  useEffect(
    () => () => {
      if (copyTimeoutRef.current !== null) {
        window.clearTimeout(copyTimeoutRef.current);
      }
    },
    [],
  );

  const hasToken = shareToken.trim().length > 0;
  const titleValid = isShareableTitle(title);

  const handleShare = async () => {
    // Guard re-entry synchronously: a second click before the disabled state
    // renders would otherwise start a concurrent, non-idempotent upload.
    if (abortRef.current) return;
    setError(null);
    setStatus("uploading");
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const { content, filename } = getProject(title.trim());
      const uploaded = await uploadProjectToShare({
        token: shareToken,
        filename,
        content,
        visibility,
        signal: controller.signal,
      });
      setResult(uploaded);
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      setError(err instanceof Error ? err.message : "Could not share the project.");
    } finally {
      // Only the controller that is still current clears state, so an aborted
      // (superseded) request never flips a newer one back to idle.
      if (abortRef.current === controller) {
        abortRef.current = null;
        setStatus("idle");
      }
    }
  };

  const handleCopy = () => {
    if (!result) return;
    // Only show the "copied" checkmark if the write actually succeeds; the
    // promise rejects when clipboard permission is denied or the page is
    // unfocused, and swallowing it would flip the icon misleadingly.
    navigator.clipboard
      .writeText(result.projectUrl)
      .then(() => {
        if (copyTimeoutRef.current !== null) {
          window.clearTimeout(copyTimeoutRef.current);
        }
        setCopied(true);
        copyTimeoutRef.current = window.setTimeout(() => setCopied(false), 2000);
      })
      .catch(() => {
        // Clipboard unavailable; leave the icon unchanged.
      });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Share2 className="h-4 w-4" />
            Share project
          </DialogTitle>
          <DialogDescription>
            Upload the current project to share.geolibre.app and get a shareable
            link.
          </DialogDescription>
        </DialogHeader>

        {!hasToken ? (
          <div className="space-y-3 text-sm">
            <p className="text-muted-foreground">
              Add a share.geolibre.app API token in Settings &gt; Environment
              before sharing. Create one under Settings &gt; API tokens on the
              website.
            </p>
            <Button
              type="button"
              variant="outline"
              onClick={() => void openExternalLink(SETTINGS_TOKEN_URL)}
            >
              <ExternalLink className="mr-2 h-3.5 w-3.5" />
              Open share.geolibre.app settings
            </Button>
          </div>
        ) : result ? (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Your project is live at:
            </p>
            <div className="flex gap-2">
              <Input readOnly value={result.projectUrl} className="text-xs" />
              <Button
                type="button"
                variant="secondary"
                aria-label="Copy link"
                onClick={handleCopy}
              >
                {copied ? (
                  <Check className="h-3.5 w-3.5" />
                ) : (
                  <Copy className="h-3.5 w-3.5" />
                )}
              </Button>
            </div>
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => void openExternalLink(result.projectUrl)}
              >
                <ExternalLink className="mr-2 h-3.5 w-3.5" />
                Open
              </Button>
              <Button type="button" onClick={() => onOpenChange(false)}>
                Done
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="share-title">Project title</Label>
              <Input
                id="share-title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Name your project"
                disabled={status === "uploading"}
                autoFocus={!titleValid}
              />
              {!titleValid && (
                <p className="text-xs text-muted-foreground">
                  Enter a project title before sharing.
                </p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="share-visibility">Visibility</Label>
              <Select
                id="share-visibility"
                value={visibility}
                onChange={(e) =>
                  setVisibility(e.target.value as ShareVisibility)
                }
                disabled={status === "uploading"}
              >
                <option value="unlisted">Unlisted (anyone with the link)</option>
                <option value="public">Public (listed in the gallery)</option>
                <option value="private">Private (only you)</option>
              </Select>
            </div>

            {error && (
              <p className="rounded-md bg-destructive/10 p-2 text-sm text-destructive">
                {error}
              </p>
            )}

            <div className="flex justify-end gap-2">
              {/* Stays enabled during upload: closing the dialog aborts the
                  in-flight request via the open effect's cleanup. */}
              <Button
                type="button"
                variant="outline"
                onClick={() => onOpenChange(false)}
              >
                Cancel
              </Button>
              <Button
                type="button"
                onClick={() => void handleShare()}
                disabled={status === "uploading" || !titleValid}
              >
                {status === "uploading" ? (
                  <>
                    <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                    Sharing…
                  </>
                ) : (
                  <>
                    <Share2 className="mr-2 h-3.5 w-3.5" />
                    Share
                  </>
                )}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
