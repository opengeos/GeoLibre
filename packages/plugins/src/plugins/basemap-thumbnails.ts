import type { BasemapControl, BasemapDefinition } from "maplibre-gl-basemap-control";
import { Map as MapLibreMap } from "maplibre-gl";

const ATTR = "data-geolibre-basemap-preview";
const swatchCache = new Map<string, Promise<string | null>>();
const snapCache = new Map<string, string>();

function needsKey(value: string): boolean {
  return /\{(api-key|access_token|key)\}/.test(value);
}

export function rasterPreviewUrl(basemap: BasemapDefinition): string | null {
  if (basemap.source.type !== "raster" || !basemap.source.tiles?.[0]) return null;
  const template = basemap.source.tiles[0];
  if (needsKey(template)) return null;
  return template
    .replace(/\{z\}/g, "2")
    .replace(/\{x\}/g, "1")
    .replace(/\{y\}/g, "1")
    .replace(/\{s\}/g, "a");
}

export function styleUrlOf(basemap: BasemapDefinition): string | null {
  if (basemap.source.type !== "style" && basemap.source.type !== "vector-style") return null;
  return needsKey(basemap.source.url) ? null : basemap.source.url;
}

function styleSwatch(url: string): Promise<string | null> {
  const hit = swatchCache.get(url);
  if (hit) return hit;
  const next = fetch(url)
    .then((response) => (response.ok ? response.json() : Promise.reject(response.status)))
    .then((style: { layers?: Array<{ type?: string; paint?: Record<string, unknown> }> }) => {
      const canvas = document.createElement("canvas");
      canvas.width = 112;
      canvas.height = 84;
      const ctx = canvas.getContext("2d");
      if (!ctx) return null;
      const color = style.layers?.find((layer) => layer.type === "background")?.paint?.[
        "background-color"
      ];
      ctx.fillStyle = typeof color === "string" ? color : "#d0d5dd";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      return canvas.toDataURL("image/png");
    })
    .catch(() => null);
  swatchCache.set(url, next);
  return next;
}

function createStyleCamera(): {
  snapshot(url: string): Promise<string | null>;
  pause(): void;
  dispose(): void;
} {
  let hidden: { map: MapLibreMap; el: HTMLDivElement } | null = null;
  let tail = Promise.resolve();
  let paused = false;

  const teardown = () => {
    hidden?.map.remove();
    hidden?.el.remove();
    hidden = null;
  };

  const ensure = () => {
    if (hidden) return hidden;
    const el = document.createElement("div");
    el.style.cssText =
      "position:fixed;top:0;left:0;width:168px;height:126px;opacity:0;pointer-events:none;z-index:-1";
    document.body.append(el);
    hidden = {
      el,
      map: new MapLibreMap({
        container: el,
        style: { version: 8, sources: {}, layers: [] },
        center: [8, 47],
        zoom: 2,
        interactive: false,
        attributionControl: false,
        fadeDuration: 0,
        pixelRatio: 1,
        canvasContextAttributes: { preserveDrawingBuffer: true },
      }),
    };
    return hidden;
  };

  return {
    snapshot(url) {
      const cached = snapCache.get(url);
      if (cached) return Promise.resolve(cached);
      const job = () =>
        new Promise<string | null>((resolve) => {
          if (paused) return resolve(null);
          const { map } = ensure();
          const finish = (src: string | null) => {
            map.off("style.load", onLoad);
            resolve(src);
          };
          const timer = window.setTimeout(() => finish(null), 6000);
          const onLoad = () => {
            window.setTimeout(() => {
              window.clearTimeout(timer);
              try {
                const src = map.getCanvas().toDataURL("image/jpeg", 0.72);
                if (src) snapCache.set(url, src);
                finish(src);
              } catch {
                finish(null);
              }
            }, 400);
          };
          map.once("style.load", onLoad);
          map.setStyle(url, { diff: false });
        });
      const next = tail.then(job, job);
      tail = next.then(() => undefined);
      return next;
    },
    pause() {
      paused = true;
      teardown();
      tail = Promise.resolve();
      paused = false;
    },
    dispose() {
      paused = true;
      teardown();
    },
  };
}

function stamp(row: HTMLElement, src: string): void {
  const existing = row.querySelector<HTMLImageElement>(".geolibre-basemap-thumbnail");
  if (existing) {
    existing.src = src;
    return;
  }
  const img = document.createElement("img");
  img.className = "geolibre-basemap-thumbnail";
  img.alt = "";
  img.src = src;
  row.prepend(img);
}

function paint(id: string, src: string, state: string): void {
  document
    .querySelectorAll<HTMLElement>(`.basemap-control-result[data-basemap-id="${CSS.escape(id)}"]`)
    .forEach((row) => {
      row.setAttribute(ATTR, state);
      stamp(row, src);
    });
}

export function installBasemapThumbnails(control: BasemapControl): {
  dispose(): void;
  pause(): void;
} {
  const noop = { dispose() {}, pause() {} };
  if (typeof window === "undefined" || !document.body) return noop;

  const camera = createStyleCamera();
  const root = document.querySelector(".basemap-control-panel") ?? document.body;
  const visible =
    typeof IntersectionObserver === "function"
      ? new IntersectionObserver(
          (entries) => {
            for (const entry of entries) {
              if (!entry.isIntersecting) continue;
              const row = entry.target as HTMLElement;
              visible?.unobserve(row);
              const url = row.dataset.previewUrl;
              const id = row.getAttribute("data-basemap-id");
              if (!url || !id) continue;
              void camera.snapshot(url).then((src) => {
                if (src) paint(id, src, "loaded");
              });
            }
          },
          {
            root: root.classList.contains("basemap-control-panel") ? root : null,
            rootMargin: "80px",
          },
        )
      : null;

  const enhance = () => {
    const catalog = control.getBasemaps();
    root.querySelectorAll<HTMLElement>(`.basemap-control-result:not([${ATTR}])`).forEach((row) => {
      const id = row.getAttribute("data-basemap-id");
      const basemap = id ? catalog.find((item) => item.id === id) : undefined;
      const raster = basemap ? rasterPreviewUrl(basemap) : null;
      const jsonUrl = !raster && basemap ? styleUrlOf(basemap) : null;
      if (raster) {
        row.setAttribute(ATTR, "ready");
        stamp(row, raster);
        return;
      }
      if (jsonUrl && id) {
        row.dataset.previewUrl = jsonUrl;
        row.setAttribute(ATTR, "pending");
        void styleSwatch(jsonUrl).then((src) => {
          if (src) paint(id, src, "ready");
        });
        visible?.observe(row);
        return;
      }
      row.setAttribute(ATTR, "skip");
    });
  };

  const observer = new MutationObserver(enhance);
  observer.observe(root, { childList: true, subtree: true });
  enhance();
  return {
    pause: () => camera.pause(),
    dispose() {
      observer.disconnect();
      visible?.disconnect();
      camera.dispose();
    },
  };
}
