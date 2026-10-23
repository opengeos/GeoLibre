import type { IControl, Map, ControlPosition } from "maplibre-gl";
import type { VantorControlOptions, StacItem, BBox, VantorTranslate } from "./types";
import { StacClient } from "./stac-client";
import { PanelUI } from "./panel";
import type { PanelEventDetail } from "./panel";
import { FootprintLayer } from "./footprint-layer";
import { HighlightLayer } from "./highlight-layer";
import { DrawBBox } from "./draw-bbox";
import { CogLayer } from "./cog-layer";
import { Downloader } from "./download";

const DEFAULT_CATALOG_URL = "https://vantor-opendata.s3.amazonaws.com/events/catalog.json";

export class VantorControl implements IControl {
  private map: Map | null = null;
  private container: HTMLDivElement | null = null;
  private panel: PanelUI | null = null;
  private stacClient: StacClient;
  private footprintLayer: FootprintLayer | null = null;
  private highlightLayer: HighlightLayer | null = null;
  private drawBBox: DrawBBox | null = null;
  private cogLayer: CogLayer | null = null;
  private downloader: Downloader;
  private options: VantorControlOptions;
  private disposed = false;
  private mapLoadHandler: (() => void) | null = null;

  private items: StacItem[] = [];
  private drawnBBox: BBox | null = null;
  private selectionLock = false;
  private isDrawing = false;

  constructor(options: VantorControlOptions = {}) {
    this.options = options;
    this.stacClient = new StacClient(options.catalogUrl || DEFAULT_CATALOG_URL);
    this.downloader = new Downloader(options.translate);
  }

  onAdd(map: Map): HTMLElement {
    this.disposed = false;
    this.map = map;

    this.container = document.createElement("div");
    this.container.className = "maplibregl-ctrl maplibregl-ctrl-vantor";

    this.panel = new PanelUI(
      this.container,
      this.options.collapsed,
      this.options.panelWidth,
      this.options.maxHeight,
      this.options.theme,
      this.options.renderEngine,
      this.options.translate,
    );
    this.bindEvents();
    this.loadCatalog();
    this.cogLayer = new CogLayer(
      map,
      this.options.rasterLoader,
      this.options.cogAdder,
      this.options.renderEngine,
      this.options.cogRenderEngineSetter,
    );

    const initLayers = () => {
      this.mapLoadHandler = null;
      if (this.disposed || this.map !== map) return;
      this.footprintLayer = new FootprintLayer(map);
      this.highlightLayer = new HighlightLayer(map);
      this.drawBBox = new DrawBBox(map);

      // Bind footprint click after layer is ready
      this.footprintLayer.onClick((itemId) => {
        this.handleFootprintClick(itemId);
      });
    };

    if (map.isStyleLoaded()) {
      initLayers();
    } else {
      this.mapLoadHandler = initLayers;
      map.once("load", this.mapLoadHandler);
    }

    return this.container;
  }

  onRemove(): void {
    this.disposed = true;
    this.downloader.cancel();
    if (this.map && this.mapLoadHandler) {
      this.map.off("load", this.mapLoadHandler);
      this.mapLoadHandler = null;
    }
    this.footprintLayer?.remove();
    this.highlightLayer?.remove();
    this.drawBBox?.removeLayers();
    this.cogLayer?.remove();

    this.container?.remove();
    this.map = null;
    this.container = null;
    this.panel = null;
    this.footprintLayer = null;
    this.highlightLayer = null;
    this.drawBBox = null;
    this.cogLayer = null;
  }

  getDefaultPosition(): ControlPosition {
    return this.options.position || "top-right";
  }

  getCogLayer(): CogLayer | null {
    return this.cogLayer;
  }

  expand(): void {
    this.options.collapsed = false;
    this.panel?.expand();
  }

  setTranslator(translate?: VantorTranslate): void {
    this.options.translate = translate;
    this.downloader.setTranslator(translate);
    this.panel?.setTranslator(translate);
  }

  /**
   * Switch the panel color theme at runtime. Useful for syncing with a host
   * application that has its own dark-mode toggle.
   */
  setTheme(theme: "auto" | "light" | "dark"): void {
    this.options.theme = theme;
    this.panel?.setTheme(theme);
  }

  private bindEvents(): void {
    if (!this.panel) return;

    this.panel.addEventListener("panel-action", ((e: CustomEvent<PanelEventDetail>) => {
      const detail = e.detail;

      switch (detail.type) {
        case "search":
          this.handleSearch();
          break;
        case "refresh":
          this.loadCatalog();
          break;
        case "draw-bbox":
          this.handleDrawBBox();
          break;
        case "clear-bbox":
          this.handleClearBBox();
          break;
        case "row-click":
          if (detail.itemId) this.handleTableRowClick(detail.itemId);
          break;
        case "visualize":
          this.handleVisualize();
          break;
        case "download":
          this.handleDownload();
          break;
        case "cancel-download":
          this.downloader.cancel();
          break;
        case "select-all":
        case "deselect-all":
        case "selection-change":
          this.options.onSelectionChange?.(this.panel?.getCheckedItems() ?? []);
          break;
      }
    }) as EventListener);
  }

  private async loadCatalog(): Promise<void> {
    const panel = this.panel;
    if (!panel) return;

    panel.setStatus(this.t("vantor.status.fetchingCatalog", "Fetching catalog..."), "info");
    panel.setLoading(true);

    try {
      const events = await this.stacClient.fetchCatalog();
      if (this.panel !== panel || this.disposed) return;
      panel.setEvents(events);
      panel.setStatus(
        this.t(
          "vantor.status.eventsFound",
          `Found ${events.length} event(s). Select an event and click Search.`,
          { count: events.length },
        ),
        "success",
      );
    } catch (err) {
      if (this.panel !== panel || this.disposed) return;
      panel.setStatus(
        this.t(
          "vantor.status.catalogFailed",
          `Failed to fetch catalog: ${(err as Error).message}`,
          { message: (err as Error).message },
        ),
        "error",
      );
    } finally {
      if (this.panel === panel && !this.disposed) panel.setLoading(false);
    }
  }

  private async handleSearch(): Promise<void> {
    const panel = this.panel;
    if (!panel || !this.map) return;

    const eventUrl = panel.getSelectedEventUrl();
    if (!eventUrl) {
      panel.setStatus(
        this.t("vantor.status.selectEvent", "Please select an event first."),
        "warning",
      );
      return;
    }

    panel.setLoading(true);
    panel.setStatus(this.t("vantor.status.fetchingItems", "Fetching items..."), "info");

    try {
      let items = await this.stacClient.fetchItems(eventUrl);
      if (this.panel !== panel || this.disposed) return;

      // Apply bbox filter
      const bbox = this.getSearchBBox();
      if (bbox) {
        items = this.stacClient.filterItemsByBBox(items, bbox);
      }

      // Apply phase filter
      const phase = panel.getPhase();
      if (phase !== "all") {
        items = this.stacClient.filterItemsByPhase(items, phase as "pre" | "post");
      }

      this.items = items;
      panel.setItems(items);
      this.footprintLayer?.setItems(items);
      this.footprintLayer?.fitToBounds(items);
      this.highlightLayer?.clear();

      panel.setStatus(
        this.t(
          "vantor.status.itemsFound",
          `Found ${items.length} item(s). Check items to visualize or download.`,
          { count: items.length },
        ),
        "success",
      );

      this.options.onItemsLoaded?.(items);
    } catch (err) {
      if (this.panel !== panel || this.disposed) return;
      panel.setStatus(
        this.t("vantor.status.itemsFailed", `Failed to fetch items: ${(err as Error).message}`, {
          message: (err as Error).message,
        }),
        "error",
      );
    } finally {
      if (this.panel === panel && !this.disposed) panel.setLoading(false);
    }
  }

  private getSearchBBox(): BBox | null {
    if (this.drawnBBox) return this.drawnBBox;

    if (this.panel?.isUseMapExtent() && this.map) {
      const bounds = this.map.getBounds();
      return {
        west: bounds.getWest(),
        south: bounds.getSouth(),
        east: bounds.getEast(),
        north: bounds.getNorth(),
      };
    }

    return null;
  }

  private async handleDrawBBox(): Promise<void> {
    const panel = this.panel;
    const drawBBox = this.drawBBox;
    if (!drawBBox || !panel) return;

    if (this.isDrawing) {
      drawBBox.deactivate();
      this.isDrawing = false;
      panel.setDrawBBoxActive(false);
      panel.setStatus(this.t("vantor.status.drawingCancelled", "BBox drawing cancelled."), "info");
      return;
    }

    this.isDrawing = true;
    panel.setDrawBBoxActive(true);
    panel.setStatus(
      this.t("vantor.status.drawRectangle", "Draw a rectangle on the map..."),
      "info",
    );

    try {
      const bbox = await drawBBox.activate();
      if (this.panel !== panel || this.disposed) return;
      this.drawnBBox = bbox;
      panel.setBBoxInfo(
        `${bbox.west.toFixed(4)}, ${bbox.south.toFixed(4)}, ${bbox.east.toFixed(4)}, ${bbox.north.toFixed(4)}`,
      );
      panel.setStatus(
        this.t("vantor.status.bboxSet", "Bounding box set. Click Search to filter."),
        "success",
      );
    } catch {
      if (this.panel === panel && !this.disposed) {
        panel.setStatus(
          this.t("vantor.status.drawingCancelled", "BBox drawing cancelled."),
          "info",
        );
      }
    } finally {
      this.isDrawing = false;
      if (this.panel === panel && !this.disposed) panel.setDrawBBoxActive(false);
    }
  }

  private handleClearBBox(): void {
    this.drawnBBox = null;
    this.drawBBox?.clear();
    this.panel?.setBBoxInfo("");
    this.panel?.setStatus(this.t("vantor.status.bboxCleared", "Bounding box cleared."), "info");
  }

  private handleTableRowClick(itemId: string): void {
    if (this.selectionLock) return;
    this.selectionLock = true;

    try {
      const item = this.items.find((i) => i.id === itemId);
      if (!item) return;

      this.highlightLayer?.highlight(item);
      this.panel?.highlightRow(itemId);
    } finally {
      setTimeout(() => {
        this.selectionLock = false;
      }, 100);
    }
  }

  private handleFootprintClick(itemId: string): void {
    if (this.selectionLock) return;
    this.selectionLock = true;

    try {
      const item = this.items.find((i) => i.id === itemId);
      if (!item) return;

      this.highlightLayer?.highlight(item);
      this.panel?.highlightRow(itemId);
      // Selecting a footprint on the map also checks its result row, so it is
      // included in Visualize/Download actions.
      this.panel?.setRowChecked(itemId, true);
    } finally {
      setTimeout(() => {
        this.selectionLock = false;
      }, 100);
    }
  }

  private async handleVisualize(): Promise<void> {
    const panel = this.panel;
    const cogLayer = this.cogLayer;
    if (!panel || !cogLayer) return;

    const checked = panel.getCheckedItems();
    if (checked.length === 0) {
      panel.setStatus(
        this.t("vantor.status.noSelection", "No items selected. Check items first."),
        "warning",
      );
      return;
    }

    await cogLayer.setRenderEngine(panel.getRenderEngine());

    panel.setStatus(
      this.t("vantor.status.addingLayers", `Adding ${checked.length} COG layer(s)...`, {
        count: checked.length,
      }),
      "info",
    );

    let added = 0;
    for (const item of checked) {
      try {
        await cogLayer.addCogLayer(item);
        if (this.panel !== panel || this.disposed) return;
        added++;
      } catch (err) {
        if (this.panel !== panel || this.disposed) return;
        panel.setStatus(
          this.t("vantor.status.addFailed", `Failed to add ${item.id}: ${(err as Error).message}`, {
            id: item.id,
            message: (err as Error).message,
          }),
          "error",
        );
      }
    }

    if (added > 0) {
      panel.setStatus(
        this.t("vantor.status.layersAdded", `Added ${added} COG layer(s).`, { count: added }),
        "success",
      );
    }
  }

  private async handleDownload(): Promise<void> {
    const panel = this.panel;
    if (!panel) return;

    const checked = panel.getCheckedItems();
    if (checked.length === 0) {
      panel.setStatus(
        this.t("vantor.status.noSelection", "No items selected. Check items first."),
        "warning",
      );
      return;
    }

    panel.setDownloading(true);
    panel.setProgress(0);
    panel.setStatus(
      this.t("vantor.status.startingDownloads", `Starting ${checked.length} download(s)...`, {
        count: checked.length,
      }),
      "info",
    );

    const result = await this.downloader.downloadItems(
      checked,
      (item) => this.stacClient.getCogUrl(item),
      (current, total, message) => {
        if (this.panel !== panel || this.disposed) return;
        panel.setProgress((current / total) * 100);
        panel.setStatus(message, "info");
      },
    );

    if (this.panel !== panel || this.disposed) return;
    panel.setDownloading(false);

    if (result.started > 0) {
      panel.setStatus(
        this.t(
          "vantor.status.downloadsStarted",
          `Started ${result.started} download(s).${result.failed > 0 ? ` ${result.failed} failed.` : ""}`,
          { started: result.started, failed: result.failed },
        ),
        result.failed > 0 ? "warning" : "success",
      );
    } else {
      panel.setStatus(
        this.t("vantor.status.downloadCancelled", "Download cancelled or failed."),
        "warning",
      );
    }
  }

  private t(key: string, defaultValue: string, params?: Record<string, string | number>): string {
    return this.options.translate?.(key, defaultValue, params) ?? defaultValue;
  }
}
