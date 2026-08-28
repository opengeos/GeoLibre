import type {
  StacCatalog,
  StacCollection,
  StacItem,
  EventInfo,
  BBox,
  PhaseFilter,
  ItemProperties,
} from "./types";
import { isHttpsUrl, resolveHref } from "./utils";

const DEFAULT_CATALOG_URL = "https://vantor-opendata.s3.amazonaws.com/events/catalog.json";

export class StacClient {
  private catalogUrl: string;

  constructor(catalogUrl?: string) {
    this.catalogUrl = catalogUrl || DEFAULT_CATALOG_URL;
  }

  private async fetchJson<T>(url: string): Promise<T> {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
    }
    return response.json() as Promise<T>;
  }

  async fetchCatalog(): Promise<EventInfo[]> {
    const catalog = await this.fetchJson<StacCatalog>(this.catalogUrl);
    const events: EventInfo[] = [];

    for (const link of catalog.links) {
      if (link.rel === "child") {
        const href = resolveHref(this.catalogUrl, link.href);
        const fallbackName = href.split("/").slice(-2, -1)[0] || href;
        const title = link.title || fallbackName;
        events.push({
          id: link.title || fallbackName,
          title,
          href,
        });
      }
    }

    return events;
  }

  async fetchCollection(collectionUrl: string): Promise<StacCollection> {
    return this.fetchJson<StacCollection>(collectionUrl);
  }

  async fetchItems(collectionUrl: string): Promise<StacItem[]> {
    const collection = await this.fetchJson<StacCollection>(collectionUrl);
    const itemLinks = collection.links.filter((l) => l.rel === "item");

    const items: StacItem[] = [];
    const seenIds = new Set<string>();

    // Fetch items with concurrency limit
    const results = await this.fetchWithConcurrency<StacItem>(
      itemLinks.map((l) => resolveHref(collectionUrl, l.href)),
      6,
    );

    for (const item of results) {
      if (item && !seenIds.has(item.id)) {
        seenIds.add(item.id);
        items.push(item);
      }
    }

    return items;
  }

  private async fetchWithConcurrency<T>(urls: string[], concurrency: number): Promise<T[]> {
    const results: T[] = [];
    const queue = [...urls];

    const worker = async () => {
      while (queue.length > 0) {
        const url = queue.shift()!;
        try {
          const data = await this.fetchJson<T>(url);
          results.push(data);
        } catch {
          // Skip failed items
        }
      }
    };

    await Promise.all(Array.from({ length: Math.min(concurrency, urls.length) }, () => worker()));

    return results;
  }

  filterItemsByBBox(items: StacItem[], bbox: BBox): StacItem[] {
    return items.filter((item) => {
      const itemBbox = item.bbox;
      if (!itemBbox || itemBbox.length < 4) return true;

      const [iw, is, ie, iN] = itemBbox;
      return iw <= bbox.east && ie >= bbox.west && is <= bbox.north && iN >= bbox.south;
    });
  }

  filterItemsByPhase(items: StacItem[], phase: PhaseFilter): StacItem[] {
    if (phase === "all") return items;

    return items.filter((item) => {
      const itemPhase = (item.properties.phase || "").toLowerCase().replace("-event", "");
      return itemPhase === phase;
    });
  }

  getCogUrl(item: StacItem): string | null {
    const assets = item.assets || {};
    const visual = assets.visual;
    if (visual && isHttpsUrl(visual.href)) return visual.href;

    for (const asset of Object.values(assets)) {
      const assetType = asset.type || "";
      if ((assetType.includes("geotiff") || assetType.includes("tiff")) && isHttpsUrl(asset.href)) {
        return asset.href;
      }
    }
    return null;
  }

  getThumbnailUrl(item: StacItem): string | null {
    const thumbnail = item.assets?.thumbnail;
    return thumbnail ? thumbnail.href : null;
  }

  getItemProperties(item: StacItem): ItemProperties {
    const props = item.properties || {};
    return {
      id: item.id || "Unknown",
      datetime: (props.datetime as string) || "",
      phase: (props.phase as string) || "",
      sensor: (props.vehicle_name as string) || (props.constellation as string) || "",
      cloud_cover: props["eo:cloud_cover"] ?? "",
      pan_gsd: props.pan_gsd ?? "",
      ms_gsd: props.multispectral_gsd ?? "",
      off_nadir: props["view:off_nadir"] ?? "",
    };
  }
}
