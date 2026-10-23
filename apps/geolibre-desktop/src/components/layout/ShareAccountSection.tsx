import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@geolibre/ui";
import { CircleCheck, LoaderCircle, LogIn, LogOut } from "lucide-react";
import { useCredentialStorageStatus } from "../../lib/credential-store";
import { isDesktopRuntime } from "../../lib/is-mobile";
import {
  ShareOAuthError,
  cancelShareSignIn,
  shareOAuthErrorKey,
  shareRefreshTokenAccount,
  signInToShare,
  signOutOfShare,
  supportsShareOAuth,
  useShareOAuthStore,
} from "../../lib/share-oauth";
import {
  SessionManagementError,
  authorizeShareSessionManagement,
  closeShareSessionManagement,
  getShareAccountIdentity,
  listShareSessions,
  revokeOtherShareSessions,
  revokeShareSession,
  type ManagedSession,
  type SessionPage,
  type ShareAccountIdentity,
} from "../../lib/share-session-management";

const PAGE_SIZE = 10;

type AccountError =
  | "reauthorize"
  | "account-mismatch"
  | "no-project-session"
  | "request-failed"
  | { oauth: ShareOAuthError["code"] };

function managementError(error: unknown): AccountError {
  if (error instanceof SessionManagementError) return error.code;
  if (error instanceof ShareOAuthError) return { oauth: error.code };
  return "request-failed";
}

function formatDate(value: string | null, fallback: string): string {
  if (!value) return fallback;
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? fallback
    : new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

export function ShareAccountSection({
  shareHost,
  hasPersonalToken,
}: {
  shareHost: string;
  hasPersonalToken: boolean;
}) {
  const { t } = useTranslation();
  const issuer = useShareOAuthStore((state) => state.issuer);
  const sessionRevision = useShareOAuthStore((state) => state.sessionRevision);
  const pending = useShareOAuthStore((state) => state.pending);
  const setupError = useShareOAuthStore((state) => state.setupError);
  const startupError = useShareOAuthStore((state) => state.startupError);
  const supported = supportsShareOAuth();
  const desktop = isDesktopRuntime();
  // Only this sign-in's own persistence decides the wording: a failure on some
  // other credential (or one that a retry already fixed) must not claim the
  // session is memory-only.
  const desktopSessionOnly = useShareOAuthStore((state) => state.desktopSessionOnly);
  const refreshSaveFailed = useCredentialStorageStatus((state) =>
    issuer ? state.failedAccounts[shareRefreshTokenAccount(issuer)] === true : false,
  );
  const [oauthError, setOauthError] = useState<string | null>(null);
  const [signingOut, setSigningOut] = useState(false);
  const [identity, setIdentity] = useState<ShareAccountIdentity | null>(null);
  const [identityLoading, setIdentityLoading] = useState(false);
  const [identityError, setIdentityError] = useState<AccountError | null>(null);
  const [managing, setManaging] = useState(false);
  const [page, setPage] = useState<SessionPage | null>(null);
  const [offset, setOffset] = useState(0);
  const [busy, setBusy] = useState(false);
  const [managementFailure, setManagementFailure] = useState<AccountError | null>(null);
  const [confirmOthers, setConfirmOthers] = useState(false);
  const [confirmRevokeId, setConfirmRevokeId] = useState<string | null>(null);
  const [revokeId, setRevokeId] = useState<string | null>(null);
  const request = useRef(0);
  const startedNativeConsent = useRef(false);

  useEffect(
    () => () => {
      if (startedNativeConsent.current) cancelShareSignIn();
      startedNativeConsent.current = false;
      request.current += 1;
      void closeShareSessionManagement();
    },
    [],
  );

  useEffect(() => {
    const current = ++request.current;
    setIdentity(null);
    setIdentityError(null);
    setManaging(false);
    setPage(null);
    setOffset(0);
    setManagementFailure(null);
    setConfirmOthers(false);
    setConfirmRevokeId(null);
    setBusy(false);
    setRevokeId(null);
    if (!issuer) {
      setIdentityLoading(false);
      void closeShareSessionManagement();
      return;
    }
    setIdentityLoading(true);
    void getShareAccountIdentity().then(
      (account) => {
        if (request.current !== current) return;
        setIdentity(account);
        setIdentityLoading(false);
      },
      (error: unknown) => {
        if (request.current !== current) return;
        setIdentityError(managementError(error));
        setIdentityLoading(false);
      },
    );
  }, [issuer, sessionRevision]);

  const errorText = (error: AccountError) =>
    typeof error === "string"
      ? t(`settings.env.accountError.${error}`)
      : t(shareOAuthErrorKey(error.oauth));

  const refreshIdentity = async () => {
    const current = ++request.current;
    setIdentityLoading(true);
    setIdentityError(null);
    try {
      const account = await getShareAccountIdentity();
      if (request.current === current) setIdentity(account);
    } catch (error) {
      if (request.current === current) setIdentityError(managementError(error));
    } finally {
      if (request.current === current) setIdentityLoading(false);
    }
  };

  const loadPage = async (nextOffset: number) => {
    const current = ++request.current;
    setBusy(true);
    setManagementFailure(null);
    setConfirmRevokeId(null);
    try {
      const result = await listShareSessions(PAGE_SIZE, nextOffset);
      if (request.current !== current) return;
      setPage(result);
      setOffset(result.offset);
    } catch (error) {
      if (request.current !== current) return;
      const failure = managementError(error);
      setManagementFailure(failure);
      if (
        failure === "reauthorize" ||
        failure === "account-mismatch" ||
        failure === "no-project-session"
      ) {
        setPage(null);
      }
    } finally {
      if (request.current === current) setBusy(false);
    }
  };

  const authorize = async () => {
    const current = ++request.current;
    setBusy(true);
    setManagementFailure(null);
    setPage(null);
    if (desktop) startedNativeConsent.current = true;
    try {
      const account = await authorizeShareSessionManagement();
      if (request.current !== current) return;
      setIdentity(account);
      setManaging(true);
      await loadPage(0);
    } catch (error) {
      if (request.current === current) setManagementFailure(managementError(error));
    } finally {
      startedNativeConsent.current = false;
      if (request.current === current) setBusy(false);
    }
  };

  const revoke = async (session: ManagedSession) => {
    const current = ++request.current;
    setRevokeId(session.id);
    setManagementFailure(null);
    try {
      await revokeShareSession(session.id);
      if (session.current || request.current !== current) return; // The client signs out immediately on current-session revocation.
      const nextOffset =
        page?.sessions.length === 1 && offset > 0 ? Math.max(0, offset - PAGE_SIZE) : offset;
      await loadPage(nextOffset);
    } catch (error) {
      if (request.current !== current) return;
      const failure = managementError(error);
      setManagementFailure(failure);
      if (failure !== "request-failed") setPage(null);
    } finally {
      setRevokeId((value) => (value === session.id ? null : value));
    }
  };

  const revokeOthers = async () => {
    const current = ++request.current;
    setConfirmOthers(false);
    setConfirmRevokeId(null);
    setBusy(true);
    setManagementFailure(null);
    try {
      await revokeOtherShareSessions();
      if (request.current !== current) return;
      await loadPage(0);
    } catch (error) {
      if (request.current !== current) return;
      const failure = managementError(error);
      setManagementFailure(failure);
      if (failure !== "request-failed") setPage(null);
    } finally {
      if (request.current === current) setBusy(false);
    }
  };

  const closeManager = () => {
    if (startedNativeConsent.current) cancelShareSignIn();
    startedNativeConsent.current = false;
    request.current += 1;
    setManaging(false);
    setPage(null);
    setManagementFailure(null);
    setConfirmOthers(false);
    setConfirmRevokeId(null);
    setBusy(false);
    setRevokeId(null);
    void closeShareSessionManagement();
  };

  const signIn = () => {
    setOauthError(null);
    if (desktop) startedNativeConsent.current = true;
    void signInToShare()
      .catch((error: unknown) =>
        setOauthError(
          t(
            error instanceof ShareOAuthError ? shareOAuthErrorKey(error.code) : "share.oauthFailed",
          ),
        ),
      )
      .finally(() => {
        startedNativeConsent.current = false;
      });
  };

  const signOut = () => {
    closeManager();
    setOauthError(null);
    setSigningOut(true);
    void signOutOfShare()
      .catch((error: unknown) =>
        setOauthError(
          t(
            error instanceof ShareOAuthError ? shareOAuthErrorKey(error.code) : "share.oauthFailed",
          ),
        ),
      )
      .finally(() => setSigningOut(false));
  };

  return (
    <section className="space-y-3" aria-label={t("settings.env.oauthTitle")}>
      <h3 className="text-sm font-semibold">{t("settings.env.oauthTitle")}</h3>
      <p className="text-xs text-muted-foreground">
        {t("settings.env.oauthDescription", { shareHost })}
      </p>
      {desktop && setupError ? (
        <p role="alert" className="text-xs text-destructive">
          {t(shareOAuthErrorKey("setup-failed"))}
        </p>
      ) : null}
      {desktop && startupError === "restart-required" ? (
        <p role="alert" className="text-xs text-destructive">
          {t(shareOAuthErrorKey("restart-required"))}
        </p>
      ) : null}
      {issuer ? (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <CircleCheck className="h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
            <span className="text-xs text-muted-foreground">
              {t("settings.env.oauthConnected", { shareHost })}
            </span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="ms-auto"
              onClick={signOut}
              disabled={signingOut}
            >
              {signingOut ? (
                <LoaderCircle className="me-2 h-3.5 w-3.5 animate-spin" />
              ) : (
                <LogOut className="me-2 h-3.5 w-3.5" />
              )}
              {t("settings.env.oauthSignOut")}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            {t(
              !desktop
                ? "settings.env.oauthWebLifetime"
                : desktopSessionOnly || refreshSaveFailed
                  ? "settings.env.oauthDesktopSessionOnly"
                  : "settings.env.oauthDesktopKeychain",
            )}
          </p>
          {identityLoading ? (
            <p role="status" className="text-xs text-muted-foreground">
              {t("settings.env.accountLoading")}
            </p>
          ) : identityError ? (
            <div className="space-y-2 text-xs">
              <p role="alert" className="text-destructive">
                {errorText(identityError)}
              </p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void refreshIdentity()}
              >
                {t("settings.env.accountRetry")}
              </Button>
            </div>
          ) : identity ? (
            <div className="space-y-2 text-xs">
              <p>
                {t("settings.env.accountIdentity", {
                  account: identity.username || identity.email || identity.id,
                })}
              </p>
              {identity.username && identity.email ? (
                <p className="text-muted-foreground">{identity.email}</p>
              ) : null}
              <p className="text-muted-foreground">
                {t("settings.env.accountClient", { client: identity.clientId })}
              </p>
              <p className="break-all text-muted-foreground">
                {t("settings.env.accountSession", { session: identity.sessionId })}
              </p>
              <p className="text-muted-foreground">
                {t("settings.env.accountScopes", { scopes: identity.scopes.join(", ") })}
              </p>
            </div>
          ) : null}
          {identity && !managing ? (
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={busy || !supported}
                onClick={() => void authorize()}
              >
                {busy ? <LoaderCircle className="me-2 h-3.5 w-3.5 animate-spin" /> : null}
                {t("settings.env.accountManage")}
              </Button>
              {desktop && pending && startedNativeConsent.current ? (
                <Button type="button" size="sm" variant="outline" onClick={cancelShareSignIn}>
                  {t("common.cancel")}
                </Button>
              ) : null}
            </div>
          ) : null}
          {managing ? (
            <div className="space-y-3 rounded-md border p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h4 className="text-sm font-medium">{t("settings.env.sessionsTitle")}</h4>
                <Button type="button" size="sm" variant="outline" onClick={closeManager}>
                  {t("settings.env.accountClose")}
                </Button>
              </div>
              {managementFailure ? (
                <div className="space-y-2 text-xs">
                  <p role="alert" className="text-destructive">
                    {errorText(managementFailure)}
                  </p>
                  {managementFailure === "reauthorize" ||
                  managementFailure === "account-mismatch" ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() => void authorize()}
                    >
                      {t("settings.env.accountReauthorize")}
                    </Button>
                  ) : managementFailure === "request-failed" ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() => void loadPage(offset)}
                    >
                      {t("settings.env.accountRetry")}
                    </Button>
                  ) : null}
                </div>
              ) : null}
              {busy && !page ? (
                <p role="status" className="text-xs text-muted-foreground">
                  {t("settings.env.sessionsLoading")}
                </p>
              ) : null}
              {page && !page.sessions.length ? (
                <p className="text-xs text-muted-foreground">{t("settings.env.sessionsEmpty")}</p>
              ) : null}
              {page && page.sessions.length > 0 ? (
                <>
                  <ul className="space-y-2">
                    {page.sessions.map((session) => (
                      <li key={session.id} className="space-y-1 rounded-md border p-2 text-xs">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-medium">{session.label}</span>
                          <span className="text-muted-foreground">
                            {session.clientId ??
                              t(
                                session.kind === "oauth"
                                  ? "settings.env.sessionUnknownClient"
                                  : "settings.env.sessionPersonalToken",
                              )}
                          </span>
                          {session.current ? (
                            <span className="rounded bg-secondary px-1.5 py-0.5">
                              {t("settings.env.sessionCurrent")}
                            </span>
                          ) : null}
                          {session.legacy ? (
                            <span className="rounded bg-secondary px-1.5 py-0.5">
                              {t("settings.env.sessionLegacy")}
                            </span>
                          ) : null}
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            className="ms-auto"
                            disabled={busy || revokeId !== null}
                            onClick={() => {
                              setConfirmOthers(false);
                              setConfirmRevokeId(session.id);
                            }}
                          >
                            {revokeId === session.id
                              ? t("settings.env.sessionRevoking")
                              : t("settings.env.sessionRevoke")}
                          </Button>
                        </div>
                        <p className="text-muted-foreground">
                          {t("settings.env.accountScopes", { scopes: session.scopes.join(", ") })}
                        </p>
                        <p className="text-muted-foreground">
                          {t("settings.env.sessionCreated", {
                            date: formatDate(session.createdAt, t("settings.env.sessionUnknown")),
                          })}
                        </p>
                        <p className="text-muted-foreground">
                          {t("settings.env.sessionLastUsed", {
                            date: formatDate(session.lastUsedAt, t("settings.env.sessionNever")),
                          })}
                        </p>
                        <p className="text-muted-foreground">
                          {t("settings.env.sessionExpires", {
                            date: formatDate(session.expiresAt, t("settings.env.sessionNever")),
                          })}
                        </p>
                        {confirmRevokeId === session.id ? (
                          <div className="space-y-2 rounded-md border border-destructive p-2">
                            <p>
                              {t(
                                session.kind === "personal-token"
                                  ? "settings.env.revokeTokenConfirm"
                                  : session.current
                                    ? "settings.env.revokeCurrentConfirm"
                                    : "settings.env.revokeSessionConfirm",
                                { label: session.label },
                              )}
                            </p>
                            <div className="flex flex-wrap gap-2">
                              <Button
                                type="button"
                                size="sm"
                                variant="destructive"
                                disabled={busy || revokeId !== null}
                                onClick={() => {
                                  setConfirmRevokeId(null);
                                  void revoke(session);
                                }}
                              >
                                {t("settings.env.revokeSessionConfirmButton")}
                              </Button>
                              <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                onClick={() => setConfirmRevokeId(null)}
                              >
                                {t("common.cancel")}
                              </Button>
                            </div>
                          </div>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <span className="text-muted-foreground">
                      {t("settings.env.sessionsRange", {
                        start: offset + 1,
                        end: offset + page.sessions.length,
                        total: page.total,
                      })}
                    </span>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={busy || revokeId !== null || offset === 0}
                      onClick={() => void loadPage(Math.max(0, offset - PAGE_SIZE))}
                    >
                      {t("settings.env.sessionsPrevious")}
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={
                        busy || revokeId !== null || offset + page.sessions.length >= page.total
                      }
                      onClick={() => void loadPage(offset + PAGE_SIZE)}
                    >
                      {t("settings.env.sessionsNext")}
                    </Button>
                  </div>
                </>
              ) : null}
              {page && !confirmOthers ? (
                <Button
                  type="button"
                  size="sm"
                  variant="destructive"
                  disabled={busy || revokeId !== null}
                  onClick={() => {
                    setConfirmRevokeId(null);
                    setConfirmOthers(true);
                  }}
                >
                  {t("settings.env.revokeOthers")}
                </Button>
              ) : null}
              {confirmOthers ? (
                <div className="space-y-2 rounded-md border border-destructive p-2 text-xs">
                  <p>{t("settings.env.revokeOthersConfirm")}</p>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      size="sm"
                      variant="destructive"
                      disabled={busy || revokeId !== null}
                      onClick={() => void revokeOthers()}
                    >
                      {t("settings.env.revokeOthersConfirmButton")}
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => setConfirmOthers(false)}
                    >
                      {t("common.cancel")}
                    </Button>
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}
          {!managing && managementFailure ? (
            <p role="alert" className="text-xs text-destructive">
              {errorText(managementFailure)}
            </p>
          ) : null}
        </>
      ) : supported ? (
        <div className="space-y-2">
          {hasPersonalToken ? (
            <p className="text-xs text-muted-foreground">{t("settings.env.accountPatOnly")}</p>
          ) : null}
          <Button type="button" disabled={pending} onClick={signIn}>
            {pending ? (
              <LoaderCircle className="me-2 h-3.5 w-3.5 animate-spin" />
            ) : (
              <LogIn className="me-2 h-3.5 w-3.5" />
            )}
            {t(pending ? "settings.env.oauthSigningIn" : "settings.env.oauthSignIn")}
          </Button>
          {desktop && pending && startedNativeConsent.current ? (
            <Button type="button" variant="outline" onClick={cancelShareSignIn}>
              {t("common.cancel")}
            </Button>
          ) : null}
          {oauthError ? (
            <p role="alert" className="text-xs text-destructive">
              {oauthError}
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
