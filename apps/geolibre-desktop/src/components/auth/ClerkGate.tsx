import {
  ClerkLoaded,
  ClerkLoading,
  ClerkProvider,
  Show,
  SignIn,
  UserButton,
  Waitlist,
} from "@clerk/react";
import { useSyncExternalStore, type ReactNode } from "react";

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
  // Read unconditionally: hooks cannot be called behind a prop check, and the
  // subscription is inert when the waitlist is off.
  const onWaitlistRoute = useOnWaitlistRoute();
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
