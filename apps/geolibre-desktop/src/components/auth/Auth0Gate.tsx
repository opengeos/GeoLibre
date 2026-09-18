import { Auth0Provider, useAuth0, type AppState } from "@auth0/auth0-react";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@geolibre/ui";
import { AlertTriangle, LogOut, User } from "lucide-react";
import { useCallback, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useBeforeUnloadGuard } from "../../hooks/useBeforeUnloadGuard";
import { CALLBACK_PARAMS, stashAuthReturnQuery } from "../../lib/auth-return-url";

interface Auth0GateProps {
  /** Tenant (or custom) domain, already normalized to a bare hostname. */
  domain: string;
  /** The Auth0 application's client ID, which is public by design. */
  clientId: string;
  children: ReactNode;
}

/**
 * The URL Auth0 returns to after a login or logout.
 *
 * Resolved from the build's base URL rather than the current location, so it is
 * one stable value an operator can paste into the Auth0 application's **Allowed
 * Callback URLs** and **Allowed Logout URLs** — Auth0 matches those exactly, and
 * a per-entry-path value would be unmatchable. Subpath deployments
 * (`GEOLIBRE_APP_BASE`) resolve to their own prefix; the relative-base demo
 * build resolves against the directory currently being served.
 */
function redirectUri(): string {
  return new URL(import.meta.env.BASE_URL || "/", window.location.href).href;
}

/**
 * Strip the authorization-code parameters Auth0 appends to the return URL.
 *
 * They are single-use and meaningless once exchanged, and leaving them in the
 * address bar means a reload (or a copied link) re-runs a callback that can only
 * fail. `returnTo` carries the URL the visitor asked for before being sent to
 * Auth0, so a link with GeoLibre's own query parameters survives the round trip.
 */
function onRedirectCallback(appState?: AppState): void {
  const url = new URL(appState?.returnTo ?? window.location.href, window.location.href);
  for (const param of CALLBACK_PARAMS) {
    url.searchParams.delete(param);
  }
  window.history.replaceState({}, "", url.toString());
}

/** Full-screen centered layout shared by the loading, error, and signed-out screens. */
function AuthScreen({ children, alert = false }: { children: ReactNode; alert?: boolean }) {
  return (
    <main
      {...(alert ? { role: "alert" } : {})}
      className="flex min-h-screen flex-col items-center justify-center gap-4 bg-background p-8 text-center"
    >
      {children}
    </main>
  );
}

/** The signed-in user's avatar, with a menu offering sign-out. */
function UserMenu() {
  const { t } = useTranslation();
  const { user, logout } = useAuth0();
  const label = user?.name || user?.email || user?.nickname;
  return (
    <div className="fixed end-2 top-2 z-[100]">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            aria-label={t("auth.account")}
            className="h-8 w-8 overflow-hidden rounded-full border border-border bg-background p-0 shadow-sm"
          >
            {user?.picture ? (
              // Auth0 serves the avatar from the identity provider (Gravatar, a
              // social login). referrerPolicy keeps the deployment URL out of
              // that request; a broken image just falls back to the icon below.
              <img
                src={user.picture}
                alt=""
                referrerPolicy="no-referrer"
                className="h-full w-full object-cover"
              />
            ) : (
              <User className="h-4 w-4" />
            )}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          {label ? (
            <>
              <DropdownMenuLabel className="truncate text-start font-normal">
                {label}
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
            </>
          ) : null}
          <DropdownMenuItem
            onSelect={() => {
              void logout({ logoutParams: { returnTo: redirectUri() } });
            }}
          >
            <LogOut className="me-2 h-4 w-4" />
            {t("auth.signOut")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

/** The three signed-out states: still resolving, failed, or waiting on the visitor. */
function Auth0Screens({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const { isLoading, isAuthenticated, error, loginWithRedirect } = useAuth0();

  // Preserve the URL the visitor arrived on — Auth0 returns to the registered
  // callback URL, which would otherwise drop a shared `?project=…` link.
  // `returnTo` restores the address bar once the SDK has processed the callback;
  // the stash additionally puts the query back *before* the next load reads it,
  // for the settings resolved during boot (`?locale=`, `?theme=`). See
  // lib/auth-return-url.ts.
  const signIn = useCallback(() => {
    stashAuthReturnQuery();
    void loginWithRedirect({ appState: { returnTo: window.location.href } });
  }, [loginWithRedirect]);

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <div
          aria-hidden="true"
          className="h-8 w-8 animate-spin rounded-full border-2 border-muted border-t-primary"
        />
      </div>
    );
  }

  // Covers an unreachable tenant as much as a login Auth0 itself refused (an
  // Action denying an unapproved user answers `access_denied`). Without this the
  // gate would sit on the sign-in card with no hint of why nothing happened.
  if (error) {
    return (
      <AuthScreen alert>
        <AlertTriangle className="h-10 w-10 text-destructive" />
        <div className="space-y-1">
          <h1 className="text-lg font-semibold">{t("auth.unavailableTitle")}</h1>
          <p className="max-w-md text-sm text-muted-foreground">
            {error.message || t("auth.unavailableDescription")}
          </p>
        </div>
        <Button onClick={signIn}>{t("auth.retry")}</Button>
      </AuthScreen>
    );
  }

  if (!isAuthenticated) {
    return (
      <AuthScreen>
        <div className="space-y-1">
          <h1 className="text-lg font-semibold">{t("auth.signInTitle")}</h1>
          <p className="max-w-md text-sm text-muted-foreground">{t("auth.signInDescription")}</p>
        </div>
        <Button onClick={signIn}>{t("auth.signIn")}</Button>
      </AuthScreen>
    );
  }

  return (
    <>
      {children}
      <UserMenu />
    </>
  );
}

/**
 * Optional whole-app sign-in gate for hosted web deployments, backed by Auth0.
 *
 * The sibling of {@link ../auth/ClerkGate.ClerkGate}: the two are configured
 * independently and only one is ever loaded, since this module is dynamically
 * imported only when an Auth0 domain and client ID are configured. Normal web,
 * Tauri, mobile, and embedded builds initialize neither.
 *
 * Auth0 has no drop-in embedded sign-in card, so this uses Universal Login: the
 * visitor is redirected to the tenant's hosted login page and returned here.
 * That is Auth0's supported flow — embedded cross-origin login depends on
 * third-party cookies that browsers now block.
 *
 * It gates *rendering* only, and is not a server authorization boundary: the
 * deployment must still validate sessions (or another credential) at the reverse
 * proxy for `/sidecar`, `/ai`, and any other upstream service. See the Auth0
 * section of docs/getting-started.md.
 */
export function Auth0Gate({ domain, clientId, children }: Auth0GateProps) {
  // Keep the unsaved-work prompt alive across the signed-out screens, for the
  // same reason ClerkGate does: <App /> mounts the same guard, but it unmounts
  // the moment the session ends — on an expiry as much as on a sign-out click —
  // and the project state survives in the module-scope store, so the tab could
  // otherwise be closed with unsaved changes and no "Leave site?" prompt.
  useBeforeUnloadGuard();
  return (
    <Auth0Provider
      domain={domain}
      clientId={clientId}
      authorizationParams={{ redirect_uri: redirectUri() }}
      onRedirectCallback={onRedirectCallback}
      // Persist the session across reloads. The default in-memory cache would
      // restore it through a hidden silent-authentication iframe, which fails
      // wherever third-party cookies are blocked (Safari by default), sending
      // the visitor back to the sign-in card after every refresh.
      //
      // The trade is that the cached entry outlives the tab and is readable by
      // anything running on this origin, plugins included. What it holds is
      // bounded on purpose: no API audience is requested, so it is an identity
      // assertion that opens no upstream service on its own, and
      // `useRefreshTokens` is left off, so no refresh token is stored — renewal
      // goes back through silent authentication against the tenant, which only
      // succeeds while the Auth0 session cookie is there to answer it.
      // Documented for operators in the Auth0 section of docs/getting-started.md.
      cacheLocation="localstorage"
    >
      <Auth0Screens>{children}</Auth0Screens>
    </Auth0Provider>
  );
}
