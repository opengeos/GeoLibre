/**
 * Hand a dropped GeoPDF to the Add Data dialog's GeoPDF form (GH #3523).
 *
 * A drop opens the dialog at the GeoPDF source, which needs the file to show
 * its pages and layers before anything is added. The form takes the file from
 * here when it mounts, and an open form is told about a later drop through
 * {@link subscribePendingGeoPdf}, so a second PDF dropped onto an open form
 * loads at once rather than waiting for an unrelated later open.
 */

/** A PDF waiting for the GeoPDF form. */
export interface PendingGeoPdf {
  name: string;
  bytes: Uint8Array;
  /** Other PDFs dropped with it, which the form reports as not opened. */
  skipped?: string[];
}

let pending: PendingGeoPdf | null = null;
const listeners = new Set<() => void>();

/** Leave a PDF for the GeoPDF form to pick up, and tell an open form. */
export function setPendingGeoPdf(file: PendingGeoPdf): void {
  pending = file;
  for (const listener of listeners) listener();
}

/** Take the waiting PDF, if any, clearing it. */
export function takePendingGeoPdf(): PendingGeoPdf | null {
  const file = pending;
  pending = null;
  return file;
}

/**
 * Be told when a PDF is left for the form.
 *
 * Args:
 *   listener: Called after each {@link setPendingGeoPdf}.
 *
 * Returns:
 *   A function that stops the notifications.
 */
export function subscribePendingGeoPdf(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Whether a file name is a PDF. */
export function isPdfFileName(name: string): boolean {
  return /\.pdf$/i.test(name.trim());
}

/**
 * Hand the first readable PDF of a drop to the GeoPDF form and open it. The
 * form takes one PDF at a time, so the others are named in the pending entry
 * for the form to report; a PDF that cannot be read is skipped for the next.
 *
 * Args:
 *   files: The dropped PDFs.
 *   nameOf: A file's display name.
 *   read: Reads a file's bytes.
 *   open: Opens the GeoPDF form (once a file is waiting).
 *
 * Returns:
 *   The name of the PDF handed over.
 *
 * Raises:
 *   Error: The first read error, when no PDF could be read.
 */
export async function handOffDroppedPdfs<T>(
  files: readonly T[],
  nameOf: (file: T) => string,
  read: (file: T) => Promise<Uint8Array>,
  open: () => void,
): Promise<string> {
  let firstError: unknown = null;
  for (const [index, file] of files.entries()) {
    const name = nameOf(file);
    try {
      const bytes = await read(file);
      const skipped = files.filter((_, i) => i !== index).map(nameOf);
      setPendingGeoPdf({ name, bytes, ...(skipped.length ? { skipped } : {}) });
      open();
      return name;
    } catch (error) {
      firstError ??= error;
    }
  }
  throw firstError instanceof Error ? firstError : new Error(String(firstError ?? "No PDF"));
}
