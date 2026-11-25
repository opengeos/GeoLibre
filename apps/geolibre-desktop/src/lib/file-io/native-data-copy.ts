import i18next from "i18next";
import { isMobile } from "../is-mobile";
import { notify } from "../notify";
import { open, type OpenDialogOptions } from "@tauri-apps/plugin-dialog";

/** Pick durable data files and report real native failures, including control-only callers. */
export async function pickNativeDataFiles(
  options: Pick<OpenDialogOptions, "multiple" | "filters">,
) {
  try {
    return await open({ ...options, fileAccessMode: "copy" });
  } catch (error) {
    notify.error(i18next.t("fileDialogs.dataImportError"), {
      description: error instanceof Error ? error.message : String(error),
      error,
      dedupeKey: "native-data-copy-error",
    });
    throw error;
  }
}

/** Explain native mobile data imports before an edit can be mistaken for provider write-back. */
export function notifyNativeDataCopies(paths: readonly string[]): void {
  if (!isMobile() || paths.length === 0) return;
  notify.info(i18next.t("fileDialogs.importedDataCopies", { count: paths.length }), {
    description: i18next.t("fileDialogs.importedDataCopiesDescription"),
    dedupeKey: "native-data-copies",
    durationMs: 10000,
  });
}
