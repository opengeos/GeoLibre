/**
 * A registration point for "here are some files, put them on the map".
 *
 * The full import pipeline — reading a batch of `File`s through
 * `loadDroppedVectorFiles`, confirming an oversized dataset, then turning the
 * result into store layers (which is not one call: a KMZ can yield ground
 * overlays, super-overlay tile pyramids and `<Model>` scenegraphs alongside its
 * vectors) — lives in `DesktopShell`, because that is where the store setters
 * and the confirmation prompt are.
 *
 * Anything that acquires files from somewhere other than a drop needs that same
 * pipeline. The Add Data dialog renders inside `TopToolbar`, several components
 * away from the shell, so this mirrors the `setKmlFileImportHandler` pattern
 * already used by the vector plugin: the shell registers the handler on mount,
 * and callers reach it through {@link importVectorFiles} without a prop chain.
 *
 * Kept deliberately tiny and dependency-free so importing it costs nothing.
 */

/**
 * Imports a batch of files and reports how many layers reached the store.
 * The count can legitimately be zero — every file may have been declined at the
 * oversized-dataset prompt, or held no features.
 */
export type VectorFileImportHandler = (files: File[]) => Promise<number>;

let handler: VectorFileImportHandler | null = null;

/**
 * Registers (or clears, with null) the shell's import pipeline.
 *
 * @param next - The handler to install, or null to unregister
 */
export function setVectorFileImportHandler(next: VectorFileImportHandler | null): void {
  handler = next;
}

/** Whether a handler is currently registered. */
export function canImportVectorFiles(): boolean {
  return handler !== null;
}

/**
 * Runs the registered import pipeline over a batch of files.
 *
 * @param files - The files to import; classified by name, as in a drop
 * @returns The number of layers added
 * @throws Error when no handler is registered, or the import itself fails
 */
export async function importVectorFiles(files: File[]): Promise<number> {
  if (!handler) {
    throw new Error("The map is not ready to import files yet.");
  }
  return handler(files);
}
