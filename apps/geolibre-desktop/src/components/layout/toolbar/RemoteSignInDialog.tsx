import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@geolibre/ui";
import { Loader2, LogIn } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { RemoteSignInPrompt } from "../../../hooks/useProjectFileActions";
import { ShareOAuthError, shareOAuthErrorKey, signInToShare } from "../../../lib/share-oauth";
import { openSettingsSection } from "../SettingsDialog";

interface RemoteSignInDialogProps {
  prompt: RemoteSignInPrompt | null;
  onSettle: (prompt: RemoteSignInPrompt | null, signedIn: boolean) => void;
}

export function RemoteSignInDialog({ prompt, onSettle }: RemoteSignInDialogProps) {
  const { t } = useTranslation();
  const [signingIn, setSigningIn] = useState(false);
  const [signInError, setSignInError] = useState<string | null>(null);

  useEffect(() => {
    if (prompt === null) {
      setSigningIn(false);
      setSignInError(null);
    }
  }, [prompt]);

  return (
    <Dialog
      open={prompt !== null}
      onOpenChange={(open: boolean) => {
        if (!open) onSettle(prompt, false);
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {t("toolbar.remoteSave.signInTitle", {
              shareHost: prompt?.shareHost,
            })}
          </DialogTitle>
          <DialogDescription>
            {prompt?.oauthSupported
              ? t("toolbar.remoteSave.signInDescriptionOAuth", {
                  shareHost: prompt?.shareHost,
                })
              : t("toolbar.remoteSave.signInDescriptionToken", {
                  shareHost: prompt?.shareHost,
                })}
          </DialogDescription>
        </DialogHeader>
        {prompt?.oauthSupported ? (
          <div className="space-y-3">
            {signInError ? (
              <p role="alert" className="text-xs text-destructive">
                {signInError}
              </p>
            ) : null}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => onSettle(prompt, false)}>
                {t("common.cancel")}
              </Button>
              <Button
                type="button"
                disabled={signingIn}
                onClick={() => {
                  setSignInError(null);
                  setSigningIn(true);
                  signInToShare()
                    .then((signedIn) => {
                      setSigningIn(false);
                      if (!signedIn) {
                        setSignInError(t("share.oauthFailed"));
                        return;
                      }
                      onSettle(prompt, true);
                    })
                    .catch((err: unknown) => {
                      setSigningIn(false);
                      setSignInError(
                        t(
                          err instanceof ShareOAuthError
                            ? shareOAuthErrorKey(err.code)
                            : "share.oauthFailed",
                        ),
                      );
                    });
                }}
              >
                {signingIn ? (
                  <Loader2 className="me-2 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <LogIn className="me-2 h-3.5 w-3.5" />
                )}
                {t("toolbar.remoteSave.signInButton")}
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => onSettle(prompt, false)}>
              {t("common.cancel")}
            </Button>
            <Button
              type="button"
              onClick={() => {
                onSettle(prompt, false);
                openSettingsSection("environment", { focus: "shareToken" });
              }}
            >
              {t("toolbar.remoteSave.openSettingsButton")}
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
