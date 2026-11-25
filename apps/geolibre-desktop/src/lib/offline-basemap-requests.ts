interface BasemapContext {
  projectLoadCount: number;
  basemapChoiceGeneration: number;
}

/** Own asynchronous basemap applications across file reads, checksum checks,
 * and extraction. A newer choice, project, or panel lifetime supersedes them. */
export class OfflineBasemapRequests {
  private generation = 0;
  private packageId: string | undefined;
  private currentChoice?: { isCurrent: () => boolean; rebase: (generation: number) => void };

  constructor(private readonly readContext: () => BasemapContext) {}

  begin(packageId?: string) {
    this.packageId = packageId;
    const { projectLoadCount } = this.readContext();
    let { basemapChoiceGeneration } = this.readContext();
    const generation = ++this.generation;
    const isLatest = () => generation === this.generation;
    const isProjectCurrent = () =>
      isLatest() && this.readContext().projectLoadCount === projectLoadCount;
    const request = {
      isLatest,
      // Catalog errors still belong to this project after our own basemap
      // application advances its choice generation.
      isProjectCurrent,
      isCurrent: () => {
        const current = this.readContext();
        return isProjectCurrent() && current.basemapChoiceGeneration === basemapChoiceGeneration;
      },
    };
    this.currentChoice = {
      isCurrent: request.isCurrent,
      rebase: (value) => {
        basemapChoiceGeneration = value;
      },
    };
    return request;
  }

  /** Keep a still-current pending application across our synchronous fallback.
   * Never revive a request superseded by a user choice, project or newer request. */
  preservePendingDuringFallback(change: () => void): void {
    const choice = this.currentChoice;
    const current = choice?.isCurrent() === true;
    const { projectLoadCount, basemapChoiceGeneration } = this.readContext();
    change();
    const after = this.readContext();
    if (
      current &&
      choice === this.currentChoice &&
      after.projectLoadCount === projectLoadCount &&
      after.basemapChoiceGeneration === basemapChoiceGeneration + 1
    )
      choice?.rebase(after.basemapChoiceGeneration);
  }

  /** Cancel only an application belonging to the package being removed. */
  invalidatePackage(id: string): boolean {
    if (this.packageId !== id) return false;
    this.invalidate();
    return true;
  }

  invalidate(): void {
    this.packageId = undefined;
    this.currentChoice = undefined;
    this.generation++;
  }
}
