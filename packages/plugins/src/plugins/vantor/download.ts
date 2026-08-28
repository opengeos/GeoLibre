import type { StacItem } from './types';

export class Downloader {
  private cancelled = false;

  async downloadItems(
    items: StacItem[],
    getCogUrl: (item: StacItem) => string | null,
    onProgress?: (current: number, total: number, message: string) => void,
  ): Promise<{ completed: number; failed: number }> {
    this.cancelled = false;
    const total = items.length;
    let completed = 0;
    let failed = 0;

    for (let i = 0; i < items.length; i++) {
      if (this.cancelled) {
        onProgress?.(i, total, `Download cancelled. ${completed} file(s) completed.`);
        break;
      }

      const item = items[i];
      const cogUrl = getCogUrl(item);
      if (!cogUrl) {
        failed++;
        continue;
      }

      const filename = `${item.id}.tif`;

      try {
        onProgress?.(i, total, `Downloading ${filename}...`);

        // Use direct link to let the browser handle the download natively.
        // This avoids loading the entire file into memory via fetch+blob,
        // which fails for large COG files (hundreds of MB).
        const a = document.createElement('a');
        a.href = cogUrl;
        a.download = filename;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);

        completed++;
        onProgress?.(i + 1, total, `Started ${filename} (${completed}/${total})`);

        // Small delay between downloads to avoid browser throttling
        if (i < items.length - 1) {
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
      } catch (e) {
        failed++;
        onProgress?.(
          i + 1,
          total,
          `Failed to download ${filename}: ${(e as Error).message}`,
        );
      }
    }

    return { completed, failed };
  }

  cancel(): void {
    this.cancelled = true;
  }
}
