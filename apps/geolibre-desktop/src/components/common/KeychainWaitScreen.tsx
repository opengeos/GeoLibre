/** Shown before the app renders while the OS keychain answers (e.g. a locked Linux keyring). */
export function KeychainWaitScreen({ title, detail }: { title: string; detail: string }) {
  return (
    <div
      role="status"
      className="flex h-full min-h-screen flex-col items-center justify-center gap-2 bg-background p-6 text-center text-foreground"
    >
      <p className="text-sm font-medium text-foreground">{title}</p>
      <p className="max-w-md text-xs text-muted-foreground">{detail}</p>
    </div>
  );
}
