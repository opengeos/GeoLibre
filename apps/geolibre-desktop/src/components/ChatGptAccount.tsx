import { Button } from "@geolibre/ui";
import { ExternalLink, Info, Loader2, LogOut, TriangleAlert, UserRound } from "lucide-react";
import { useEffect, useRef, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { useChatGptStatus } from "../hooks/useChatGptStatus";
import {
  CHATGPT_USAGE_URL,
  cancelChatGptSignIn,
  isChatGptSignInAvailable,
  openChatGptPage,
  signInWithChatGpt,
  signOutOfChatGpt,
} from "../lib/assistant/chatgpt";

/**
 * The account block of a "ChatGPT (sign in)" AI profile: sign in with ChatGPT
 * in the system browser, see who is signed in, and sign out. The sign-in is
 * shared by every ChatGPT profile, and its tokens never leave the desktop
 * backend.
 */
export function ChatGptAccount(): ReactElement {
  const { t } = useTranslation();
  const status = useChatGptStatus();
  const [busy, setBusy] = useState(false);
  const [signInUrl, setSignInUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Leaving the settings stops waiting here; the backend keeps the attempt
  // until it finishes or times out, and the status picks it up.
  useEffect(() => () => abortRef.current?.abort(), []);

  if (!isChatGptSignInAvailable()) {
    return (
      <div className="flex items-start gap-2 rounded-md border border-sky-500/40 bg-sky-500/10 p-3 text-xs text-sky-700 dark:text-sky-300">
        <Info className="mt-0.5 h-4 w-4 shrink-0" />
        <span>{t("settings.ai.chatgpt.desktopOnly")}</span>
      </div>
    );
  }

  const signIn = async (anotherAccount: boolean) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await signInWithChatGpt({
        anotherAccount,
        onUrl: setSignInUrl,
        signal: controller.signal,
      });
    } catch (cause) {
      if (!(cause instanceof DOMException && cause.name === "AbortError")) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = null;
        setBusy(false);
        setSignInUrl(null);
      }
    }
  };

  const cancel = async () => {
    abortRef.current?.abort();
    await cancelChatGptSignIn().catch(() => undefined);
  };

  const signOut = async (forget: boolean) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const { revoked } = await signOutOfChatGpt(forget);
      if (!revoked) setNotice(t("settings.ai.chatgpt.revokeUnconfirmed"));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const waiting = busy && signInUrl !== null;

  return (
    <div className="space-y-3 rounded-md border p-3 text-xs">
      <div className="flex items-center gap-2">
        <UserRound className="h-4 w-4 shrink-0 text-muted-foreground" />
        <span className="font-medium text-foreground">{t("settings.ai.chatgpt.account")}</span>
      </div>

      {status.signedIn ? (
        <div className="space-y-2">
          <p className="text-foreground">
            {t("settings.ai.chatgpt.signedInAs", { email: status.email || "—" })}
          </p>
          {status.planAllowed ? (
            <p className="text-muted-foreground">{t("settings.ai.chatgpt.usingPlan")}</p>
          ) : (
            <p className="flex items-start gap-1.5 text-amber-700 dark:text-amber-300">
              <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>{t("settings.ai.chatgpt.planDeclined")}</span>
            </p>
          )}
          {!status.remembered ? (
            <p className="text-muted-foreground">{t("settings.ai.chatgpt.notRemembered")}</p>
          ) : null}
          <div className="flex flex-wrap items-center gap-2">
            {!status.planAllowed ? (
              <Button size="sm" disabled={busy} onClick={() => void signIn(false)}>
                {t("settings.ai.chatgpt.signInAgain")}
              </Button>
            ) : null}
            <Button size="sm" variant="outline" disabled={busy} onClick={() => void signOut(false)}>
              <LogOut className="me-1 h-3.5 w-3.5" />
              {t("settings.ai.chatgpt.signOut")}
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => void signOut(true)}>
              {t("settings.ai.chatgpt.useAnotherAccount")}
            </Button>
          </div>
          <a
            className="inline-flex items-center gap-1 text-primary underline"
            href={CHATGPT_USAGE_URL}
            target="_blank"
            rel="noreferrer noopener"
          >
            <ExternalLink className="h-3 w-3" />
            {t("settings.ai.chatgpt.usage")}
          </a>
        </div>
      ) : waiting ? (
        <div className="space-y-2">
          <p className="flex items-center gap-1.5 text-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            {t("settings.ai.chatgpt.waiting")}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => signInUrl && void openChatGptPage(signInUrl)}
            >
              {t("settings.ai.chatgpt.openAgain")}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => void cancel()}>
              {t("settings.ai.cancel")}
            </Button>
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          <p className="text-muted-foreground">{t("settings.ai.chatgpt.intro")}</p>
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" disabled={busy} onClick={() => void signIn(false)}>
              {busy ? <Loader2 className="me-1 h-3.5 w-3.5 animate-spin" /> : null}
              {t("settings.ai.chatgpt.continue")}
            </Button>
            {status.registered ? (
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => void signIn(true)}>
                {t("settings.ai.chatgpt.useAnotherAccount")}
              </Button>
            ) : null}
          </div>
        </div>
      )}

      {error ? (
        <p role="alert" className="flex items-start gap-1.5 text-destructive">
          <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{error}</span>
        </p>
      ) : null}
      {notice ? <p className="text-muted-foreground">{notice}</p> : null}
    </div>
  );
}
