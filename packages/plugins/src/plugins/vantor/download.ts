import type { StacItem, VantorTranslate } from "./types";
import { isHttpsUrl } from "./utils";

export class Downloader {
  private cancelled = false;
  private translate?: VantorTranslate;

  constructor(translate?: VantorTranslate) {
    this.translate = translate;
  }

  setTranslator(translate?: VantorTranslate): void {
    this.translate = translate;
  }

  async downloadItems(
    items: StacItem[],
    getCogUrl: (item: StacItem) => string | null,
    onProgress?: (current: number, total: number, message: string) => void,
  ): Promise<{ started: number; failed: number }> {
    this.cancelled = false;
    const total = items.length;
    let started = 0;
    let failed = 0;

    for (let i = 0; i < items.length; i++) {
      if (this.cancelled) {
        onProgress?.(
          i,
          total,
          this.t(
            "vantor.downloadProgress.cancelled",
            `Download cancelled. ${started} download(s) started.`,
            { count: started },
          ),
        );
        break;
      }

      const item = items[i];
      const cogUrl = getCogUrl(item);
      if (!cogUrl || !isHttpsUrl(cogUrl)) {
        failed++;
        onProgress?.(
          i + 1,
          total,
          this.t("vantor.downloadProgress.invalidUrl", `Skipped ${item.id}: invalid HTTPS URL.`, {
            id: item.id,
          }),
        );
        continue;
      }

      const filename = `${item.id}.tif`;

      try {
        onProgress?.(
          i,
          total,
          this.t("vantor.downloadProgress.starting", `Starting ${filename}...`, { filename }),
        );

        // Use direct link to let the browser handle the download natively.
        // This avoids loading the entire file into memory via fetch+blob,
        // which fails for large COG files (hundreds of MB).
        const a = document.createElement("a");
        a.href = cogUrl;
        a.download = filename;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);

        started++;
        onProgress?.(
          i + 1,
          total,
          this.t("vantor.downloadProgress.started", `Started ${filename} (${started}/${total})`, {
            filename,
            started,
            total,
          }),
        );

        // Keep every click in the original user-activation task. Delaying later
        // clicks causes browsers to block them as automatic downloads.
      } catch (e) {
        failed++;
        onProgress?.(
          i + 1,
          total,
          this.t(
            "vantor.downloadProgress.failed",
            `Failed to start ${filename}: ${(e as Error).message}`,
            { filename, message: (e as Error).message },
          ),
        );
      }
    }

    return { started, failed };
  }

  cancel(): void {
    this.cancelled = true;
  }

  private t(key: string, defaultValue: string, params?: Record<string, string | number>): string {
    return this.translate?.(key, defaultValue, params) ?? defaultValue;
  }
}
