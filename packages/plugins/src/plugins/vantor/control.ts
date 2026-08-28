import type { IControl, Map, ControlPosition } from "maplibre-gl";
import type { VantorControlOptions, StacItem, BBox } from "./types";
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

  private items: StacItem[] = [];
  private drawnBBox: BBox | null = null;
  private selectionLock = false;
  private isDrawing = false;

  constructor(options: VantorControlOptions = {}) {
    this.options = options;
    this.stacClient = new StacClient(options.catalogUrl || DEFAULT_CATALOG_URL);
    this.downloader = new Downloader();
  }

  onAdd(map: Map): HTMLElement {
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
    );
    this.bindEvents();
    this.loadCatalog();
    this.cogLayer = new CogLayer(
      map,
      this.options.rasterLoader,
      this.options.cogAdder,
      this.options.renderEngine,
    );

    const initLayers = () => {
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
      map.once("load", initLayers);
    }

    return this.container;
  }

  onRemove(): void {
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
          this.options.onSelectionChange?.(this.panel!.getCheckedItems());
          break;
      }
    }) as EventListener);
  }

  private async loadCatalog(): Promise<void> {
    if (!this.panel) return;

    this.panel.setStatus("Fetching catalog...", "info");
    this.panel.setLoading(true);

    try {
      const events = await this.stacClient.fetchCatalog();
      this.panel.setEvents(events);
      this.panel.setStatus(
        `Found ${events.length} event(s). Select an event and click Search.`,
        "success",
      );
    } catch (err) {
      this.panel.setStatus(`Failed to fetch catalog: ${(err as Error).message}`, "error");
    } finally {
      this.panel.setLoading(false);
    }
  }

  private async handleSearch(): Promise<void> {
    if (!this.panel || !this.map) return;

    const eventUrl = this.panel.getSelectedEventUrl();
    if (!eventUrl) {
      this.panel.setStatus("Please select an event first.", "warning");
      return;
    }

    this.panel.setLoading(true);
    this.panel.setStatus("Fetching items...", "info");

    try {
      let items = await this.stacClient.fetchItems(eventUrl);

      // Apply bbox filter
      const bbox = this.getSearchBBox();
      if (bbox) {
        items = this.stacClient.filterItemsByBBox(items, bbox);
      }

      // Apply phase filter
      const phase = this.panel.getPhase();
      if (phase !== "all") {
        items = this.stacClient.filterItemsByPhase(items, phase as "pre" | "post");
      }

      this.items = items;
      this.panel.setItems(items);
      this.footprintLayer?.setItems(items);
      this.footprintLayer?.fitToBounds(items);
      this.highlightLayer?.clear();

      this.panel.setStatus(
        `Found ${items.length} item(s). Check items to visualize or download.`,
        "success",
      );

      this.options.onItemsLoaded?.(items);
    } catch (err) {
      this.panel.setStatus(`Failed to fetch items: ${(err as Error).message}`, "error");
    } finally {
      this.panel.setLoading(false);
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
    if (!this.drawBBox || !this.panel) return;

    if (this.isDrawing) {
      this.drawBBox.deactivate();
      this.isDrawing = false;
      this.panel.setDrawBBoxActive(false);
      this.panel.setStatus("BBox drawing cancelled.", "info");
      return;
    }

    this.isDrawing = true;
    this.panel.setDrawBBoxActive(true);
    this.panel.setStatus("Draw a rectangle on the map...", "info");

    try {
      const bbox = await this.drawBBox.activate();
      this.drawnBBox = bbox;
      this.panel.setBBoxInfo(
        `${bbox.west.toFixed(4)}, ${bbox.south.toFixed(4)}, ${bbox.east.toFixed(4)}, ${bbox.north.toFixed(4)}`,
      );
      this.panel.setStatus("Bounding box set. Click Search to filter.", "success");
    } catch {
      this.panel.setStatus("BBox drawing failed.", "error");
    } finally {
      this.isDrawing = false;
      this.panel.setDrawBBoxActive(false);
    }
  }

  private handleClearBBox(): void {
    this.drawnBBox = null;
    this.drawBBox?.clear();
    this.panel?.setBBoxInfo("");
    this.panel?.setStatus("Bounding box cleared.", "info");
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
    if (!this.panel || !this.cogLayer) return;

    const checked = this.panel.getCheckedItems();
    if (checked.length === 0) {
      this.panel.setStatus("No items selected. Check items first.", "warning");
      return;
    }

    this.cogLayer.setRenderEngine(this.panel.getRenderEngine());

    this.panel.setStatus(`Adding ${checked.length} COG layer(s)...`, "info");

    let added = 0;
    for (const item of checked) {
      try {
        await this.cogLayer.addCogLayer(item);
        added++;
      } catch (err) {
        this.panel.setStatus(`Failed to add ${item.id}: ${(err as Error).message}`, "error");
      }
    }

    if (added > 0) {
      this.panel.setStatus(`Added ${added} COG layer(s).`, "success");
    }
  }

  private async handleDownload(): Promise<void> {
    if (!this.panel) return;

    const checked = this.panel.getCheckedItems();
    if (checked.length === 0) {
      this.panel.setStatus("No items selected. Check items first.", "warning");
      return;
    }

    this.panel.setDownloading(true);
    this.panel.setProgress(0);
    this.panel.setStatus(`Downloading ${checked.length} file(s)...`, "info");

    const result = await this.downloader.downloadItems(
      checked,
      (item) => this.stacClient.getCogUrl(item),
      (current, total, message) => {
        this.panel?.setProgress((current / total) * 100);
        this.panel?.setStatus(message, "info");
      },
    );

    this.panel.setDownloading(false);

    if (result.completed > 0) {
      this.panel.setStatus(
        `Downloaded ${result.completed} file(s).${result.failed > 0 ? ` ${result.failed} failed.` : ""}`,
        result.failed > 0 ? "warning" : "success",
      );
    } else {
      this.panel.setStatus("Download cancelled or failed.", "warning");
    }
  }
}
