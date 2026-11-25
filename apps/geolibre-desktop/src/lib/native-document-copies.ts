import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "@geolibre/core";

/** Complete authorization and path rebasing before startup can load a project. */
export async function initializeNativeDocumentCopies(): Promise<string[]> {
  const { root, problems } = await invoke<{ root: string | null; problems: string[] }>(
    "initialize_native_document_copies",
  );
  useAppStore.getState().setNativeDocumentCopyRoot(root);
  return problems;
}
