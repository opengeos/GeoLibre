import {
  ClerkFailed,
  ClerkLoaded,
  ClerkLoading,
  ClerkProvider,
  Show,
  SignIn,
  UserButton,
  Waitlist,
} from "@clerk/react";
import { Button } from "@geolibre/ui";
import { AlertTriangle } from "lucide-react";
import { useSyncExternalStore, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useBeforeUnloadGuard } from "../../hooks/useBeforeUnloadGuard";

interface ClerkGateProps {
  publishableKey: string;
  /**
   * Whether to serve Clerk's waitlist form at {@link WAITLIST_HASH}. Off unless
   * the deployment opts in, because it only makes sense for a Clerk instance in
   * waitlist sign-up mode.
   */
  waitlist?: boolean;
  children: ReactNode;
}

// The gate lives on a single page with no router, so the two signed-out screens
// are told apart by the URL hash. `<SignIn routing="hash" />` owns the root hash
// and writes its own sub-steps (`#/factor-one`, `#/sso-callback`) there, so the
// waitlist takes a distinct prefix that those can never collide with.
const WAITLIST_HASH = "#/waitlist";
const SIGN_IN_HASH = "#/";

function subscribeToHash(onStoreChange: () => void): () => void {
  window.addEventListener("hashchange", onStoreChange);
  return () => window.removeEventListener("hashchange", onStoreChange);
}

function readHash(): string {
  return window.location.hash;
}

/**
 * Track the hash so Clerk's own cross-links between the two screens work.
 *
 * Both links are plain same-document navigations (`#/waitlist` ⇄ `#/`), which
 * fire `hashchange` rather than reloading — reloading would re-download the
 * whole bundle just to swap one card.
 */
function useOnWaitlistRoute(): boolean {
  const hash = useSyncExternalStore(subscribeToHash, readHash, () => "");
  return hash.startsWith(WAITLIST_HASH);
}

/**
 * Optional whole-app sign-in gate for hosted web deployments.
 *
 * This module is dynamically imported only when a Clerk key is configured, so
 * normal web, Tauri, mobile, and embedded builds do not initialize Clerk.
 *
 * It gates *rendering* only, and is not a server authorization boundary: the
 * deployment must still validate Clerk sessions (or another credential) at the
 * reverse proxy for `/sidecar`, `/ai`, and any other upstream service. See the
 * Clerk section of docs/getting-started.md. That holds for the waitlist too —
 * approving someone in the Clerk Dashboard decides who sees the interface, not
 * who can reach the APIs behind it.
 */
export function ClerkGate({ publishableKey, waitlist = false, children }: ClerkGateProps) {
  const { t } = useTranslation();
  // Read unconditionally: hooks cannot be called behind a prop check, and the
  // subscription is inert when the waitlist is off.
  const onWaitlistRoute = useOnWaitlistRoute();
  // Keep the unsaved-work prompt alive across the signed-out screens. <App />
  // mounts the same guard, but it unmounts the moment the session ends — on an
  // expiry or revocation as much as on a sign-out click. The project itself
  // survives that (useAppStore is module-scope, so signing back in re-renders
  // the same state), but without this the tab could then be closed or reloaded
  // with unsaved changes and no "Leave site?" prompt, which is where the work
  // would actually be lost. Duplicated while signed in, where both listeners
  // read the same isDirty and the browser shows one prompt.
  useBeforeUnloadGuard();
  return (
    <ClerkProvider publishableKey={publishableKey}>
      <ClerkLoading>
        <div className="flex min-h-screen items-center justify-center bg-background">
          <div
            aria-hidden="true"
            className="h-8 w-8 animate-spin rounded-full border-2 border-muted border-t-primary"
          />
        </div>
      </ClerkLoading>
      {/* Clerk reports a distinct "error" status (a key that no longer resolves,
          an unreachable Frontend API, an outage). Both ClerkLoading and
          ClerkLoaded render null in that state, so without this branch the gate
          leaves a blank page with no way to tell a stuck deployment from a slow
          one. */}
      <ClerkFailed>
        <main
          role="alert"
          className="flex min-h-screen flex-col items-center justify-center gap-4 bg-background p-8 text-center"
        >
          <AlertTriangle className="h-10 w-10 text-destructive" />
          <div className="space-y-1">
            <h1 className="text-lg font-semibold">{t("auth.unavailableTitle")}</h1>
            <p className="max-w-md text-sm text-muted-foreground">
              {t("auth.unavailableDescription")}
            </p>
          </div>
          <Button onClick={() => window.location.reload()}>{t("auth.retry")}</Button>
        </main>
      </ClerkFailed>
      <ClerkLoaded>
        <Show when="signed-out">
          <main className="flex min-h-screen items-center justify-center bg-background p-4">
            {waitlist && onWaitlistRoute ? (
              <Waitlist signInUrl={SIGN_IN_HASH} />
            ) : (
              // `waitlistUrl` fills the "Join the waitlist" link Clerk renders
              // inside the sign-in card when the instance is in waitlist mode.
              // Left unset otherwise, so a restricted (invite-only) deployment
              // shows no route to a form nobody can act on.
              <SignIn routing="hash" waitlistUrl={waitlist ? WAITLIST_HASH : undefined} />
            )}
          </main>
        </Show>
        <Show when="signed-in">
          {children}
          <div className="fixed end-2 top-2 z-[100]">
            <UserButton />
          </div>
        </Show>
      </ClerkLoaded>
    </ClerkProvider>
  );
}
