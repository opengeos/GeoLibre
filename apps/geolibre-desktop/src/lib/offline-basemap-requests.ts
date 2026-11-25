interface BasemapContext {
  projectLoadCount: number;
  basemapChoiceGeneration: number;
}

/** Own asynchronous basemap applications across file reads, checksum checks,
 * and extraction. A newer choice, project, or panel lifetime supersedes them. */
export class OfflineBasemapRequests {
  private generation = 0;

  constructor(private readonly readContext: () => BasemapContext) {}

  begin() {
    const { projectLoadCount, basemapChoiceGeneration } = this.readContext();
    const generation = ++this.generation;
    const isLatest = () => generation === this.generation;
    const isProjectCurrent = () =>
      isLatest() && this.readContext().projectLoadCount === projectLoadCount;
    return {
      isLatest,
      // Catalog errors still belong to this project after our own basemap
      // application advances its choice generation.
      isProjectCurrent,
      isCurrent: () => {
        const current = this.readContext();
        return isProjectCurrent() && current.basemapChoiceGeneration === basemapChoiceGeneration;
      },
    };
  }

  invalidate(): void {
    this.generation++;
  }
}
