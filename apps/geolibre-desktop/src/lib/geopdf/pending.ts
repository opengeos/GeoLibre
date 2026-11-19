/**
 * Hand a dropped GeoPDF to the Add Data dialog's GeoPDF form (GH #3523).
 *
 * A drop opens the dialog at the GeoPDF source, which needs the file to show
 * its pages and layers before anything is added; the form takes the file from
 * here when it mounts.
 */

/** A PDF waiting for the GeoPDF form. */
export interface PendingGeoPdf {
  name: string;
  bytes: Uint8Array;
}

let pending: PendingGeoPdf | null = null;

/** Leave a PDF for the GeoPDF form to pick up. */
export function setPendingGeoPdf(file: PendingGeoPdf): void {
  pending = file;
}

/** Take the waiting PDF, if any, clearing it. */
export function takePendingGeoPdf(): PendingGeoPdf | null {
  const file = pending;
  pending = null;
  return file;
}

/** Whether a file name is a PDF. */
export function isPdfFileName(name: string): boolean {
  return /\.pdf$/i.test(name.trim());
}
