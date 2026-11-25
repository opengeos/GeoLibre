import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "@geolibre/core";
import i18next from "i18next";
import en from "../i18n/locales/en.json";
import { notify } from "./notify";

/** Complete authorization and path rebasing before startup can load a project. */
export async function initializeNativeDocumentCopies(): Promise<string[]> {
  const { root, problems } = await invoke<{ root: string | null; problems: string[] }>(
    "initialize_native_document_copies",
  );
  useAppStore.getState().setNativeDocumentCopyRoot(root);
  return problems;
}

/** Finish native import recovery without preventing the workspace from opening. */
export async function restoreNativeDocumentCopies(
  translationReady: Promise<unknown>,
): Promise<void> {
  try {
    const problems = await initializeNativeDocumentCopies();
    if (problems.length > 0) {
      console.error("[GeoLibre] Some retained imports are unavailable", problems);
      await translationReady;
      notify.error(i18next.t("notifications.nativeDocumentCopiesFailed"));
    }
  } catch (error) {
    const key = "notifications.nativeDocumentCopiesInitFailed";
    // Block publication immediately, before translation readiness or the first render.
    useAppStore
      .getState()
      .setNativeDocumentCopyError(
        i18next.t(key, { defaultValue: en.notifications.nativeDocumentCopiesInitFailed }),
      );
    console.error("[GeoLibre] Failed to restore retained imports", error);
    await translationReady;
    const message = i18next.t(key);
    useAppStore.getState().setNativeDocumentCopyError(message);
    notify.error(message, { error });
  }
}
