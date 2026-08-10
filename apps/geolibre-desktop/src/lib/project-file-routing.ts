/**
 * Return whether a recent project should be read through Tauri's Android-aware
 * filesystem plugin instead of the local-filesystem-only Rust command.
 */
export function shouldUseTauriFsForRecentProject(
  path: string,
  platformIsAndroid: boolean,
): boolean {
  return platformIsAndroid && path.startsWith("content://");
}
