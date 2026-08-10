import { ClerkLoaded, ClerkLoading, ClerkProvider, Show, SignIn, UserButton } from "@clerk/react";
import type { ReactNode } from "react";

interface ClerkGateProps {
  publishableKey: string;
  children: ReactNode;
}

/**
 * Optional whole-app sign-in gate for hosted web deployments.
 *
 * This module is dynamically imported only when a Clerk key is configured, so
 * normal web, Tauri, mobile, and embedded builds do not initialize Clerk.
 */
export function ClerkGate({ publishableKey, children }: ClerkGateProps) {
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
            <SignIn routing="hash" />
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
