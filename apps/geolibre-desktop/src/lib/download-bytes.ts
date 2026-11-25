/** Save bytes to the user's downloads via a transient object URL. */
export function downloadBytes(bytes: Uint8Array, filename: string): void {
  // Cast required: TS types Uint8Array as Uint8Array<ArrayBufferLike>, which is
  // not directly assignable to BlobPart under this lib (mirrors DesktopShell).
  const url = URL.createObjectURL(new Blob([bytes as BlobPart]));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Defer revoke so the browser can fetch the blob first (Firefox races and
  // silently drops the download if the URL is revoked synchronously).
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
