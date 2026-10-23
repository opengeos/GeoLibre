// Open/closed state of the Image control dialog, shared by the Controls menu
// and the command palette (neither owns the dialog).

let open = false;
const listeners = new Set<() => void>();

export function isImageControlDialogOpen(): boolean {
  return open;
}

export function subscribeImageControlDialog(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function setImageControlDialogOpen(next: boolean): void {
  if (open === next) return;
  open = next;
  for (const listener of listeners) listener();
}
