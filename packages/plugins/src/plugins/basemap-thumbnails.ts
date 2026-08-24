import type { BasemapControl, BasemapDefinition } from "maplibre-gl-basemap-control";
import { Map as MapLibreMap } from "maplibre-gl";

/**
 * The panel class, row class and row id attribute below mirror the DOM
 * `maplibre-gl-basemap-control` renders (`_createPanel`/`_renderResults`). None
 * of them are exported or typed by that package — only `BasemapControl` and
 * `BasemapDefinition` are — so a rename on a version bump does not fail the
 * build: the queries simply stop matching and thumbnails silently stop
 * appearing. Re-check them whenever `maplibre-gl-basemap-control` is bumped in
 * `packages/plugins/package.json`, including Dependabot PRs;
 * `tests/basemap-thumbnails.test.ts` builds a real control and fails if they
 * drift. Same convention as `GLOBE_CONTROL_TOGGLE_SELECTOR` and
 * `MAP_PANEL_SELECTOR`.
 */
export const BASEMAP_PANEL_SELECTOR = ".basemap-control-panel";
export const BASEMAP_ROW_SELECTOR = ".basemap-control-result";
export const BASEMAP_ROW_ID_ATTR = "data-basemap-id";

const ATTR = "data-geolibre-basemap-preview";
/**
 * How long a basemap switch keeps the preview map off the GPU. The caller has
 * no completion signal for the style swap, so the gate reopens on its own
 * rather than stranding every row that is waiting for a snapshot.
 */
const PAUSE_MS = 1500;
/** A row only ever moves forward — see `paint`. */
const STATE_RANK: Record<string, number> = { skip: 0, pending: 1, ready: 2, loaded: 3 };
const swatchCache = new Map<string, Promise<string | null>>();
const snapCache = new Map<string, string>();

/** The placeholders `rasterPreviewUrl` substitutes below. */
const SUBSTITUTED_TOKEN = /^\{[zxys]\}$/;

/**
 * Reject a template that still carries a placeholder nothing has filled in.
 *
 * `maplibre-gl-basemap-control` substitutes the user's credentials into
 * provider URLs before it loads a basemap (`{api-key}` and `{aws-region}` in
 * the catalog it ships today — `API_KEY_PLACEHOLDER`/`AWS_REGION_PLACEHOLDER`
 * in that package). Mirroring that list would silently miss a new provider's
 * placeholder and fetch a URL with the literal token still in it, so match the
 * complement instead: anything other than the tile coordinates this module
 * itself resolves counts as unresolved. That also covers raster templates whose
 * scheme is not filled in here (`{quadkey}`, `{-y}`, ...), which would render a
 * broken tile rather than a preview.
 */
function hasUnresolvedPlaceholder(value: string): boolean {
  return (value.match(/\{[^{}]*\}/g) ?? []).some((token) => !SUBSTITUTED_TOKEN.test(token));
}

export function rasterPreviewUrl(basemap: BasemapDefinition): string | null {
  if (basemap.source.type !== "raster" || !basemap.source.tiles?.[0]) return null;
  const template = basemap.source.tiles[0];
  if (hasUnresolvedPlaceholder(template)) return null;
  return template
    .replace(/\{z\}/g, "2")
    .replace(/\{x\}/g, "1")
    .replace(/\{y\}/g, "1")
    .replace(/\{s\}/g, "a");
}

export function styleUrlOf(basemap: BasemapDefinition): string | null {
  if (basemap.source.type !== "style" && basemap.source.type !== "vector-style") return null;
  return hasUnresolvedPlaceholder(basemap.source.url) ? null : basemap.source.url;
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
  // A transient fetch failure must not be cached for the lifetime of the page,
  // or the row keeps its placeholder and never retries on a later panel open.
  void next.then((src) => {
    if (src === null && swatchCache.get(url) === next) swatchCache.delete(url);
  });
  return next;
}

function createStyleCamera(): {
  snapshot(url: string): Promise<string | null>;
  pause(): void;
  dispose(): void;
} {
  let hidden: { map: MapLibreMap; el: HTMLDivElement } | null = null;
  let tail = Promise.resolve();
  let disposed = false;
  // Closed while the main map applies a new style. Queued jobs wait on it
  // rather than resolving null, so their rows still get a thumbnail once it
  // reopens — a synchronous flag would be back to `false` before any job, which
  // all run in a later microtask off `tail`, could ever observe it.
  let gate: Promise<void> = Promise.resolve();
  let openGate: (() => void) | null = null;
  let resumeTimer = 0;

  const resume = () => {
    window.clearTimeout(resumeTimer);
    resumeTimer = 0;
    openGate?.();
    openGate = null;
  };

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
      const job = async (): Promise<string | null> => {
        await gate;
        if (disposed) return null;
        return new Promise<string | null>((resolve) => {
          const { map } = ensure();
          let settled = false;
          let loaded = false;
          const finish = (src: string | null) => {
            if (settled) return;
            settled = true;
            window.clearTimeout(timer);
            map.off("style.load", onLoad);
            map.off("error", onError);
            resolve(src);
          };
          const timer = window.setTimeout(() => finish(null), 6000);
          // An unreachable or invalid style URL emits `error` and never fires
          // `style.load`. Without this the job would hold the serialized queue
          // for the full timeout, delaying every later preview by 6s. Errors
          // raised *after* the style loaded are individual tile failures — the
          // render is still worth capturing, so they are ignored.
          const onError = () => {
            if (!loaded) finish(null);
          };
          const onLoad = () => {
            loaded = true;
            window.setTimeout(() => {
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
          map.on("error", onError);
          map.setStyle(url, { diff: false });
        });
      };
      const next = tail.then(job, job);
      tail = next.then(
        () => undefined,
        () => undefined,
      );
      return next;
    },
    pause() {
      if (disposed) return;
      teardown();
      if (!openGate) {
        gate = new Promise<void>((resolveGate) => {
          openGate = resolveGate;
        });
      }
      window.clearTimeout(resumeTimer);
      resumeTimer = window.setTimeout(resume, PAUSE_MS);
    },
    dispose() {
      disposed = true;
      // Release anything waiting on the gate so it can observe `disposed` and
      // bail instead of resurrecting the hidden map after teardown.
      resume();
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
  // The guessed z=2 raster tile can 404 — a source whose minzoom is deeper, a
  // dead endpoint, hotlink protection. Drop the image so the row falls back to
  // the name-only layout instead of showing the browser's broken-image glyph,
  // and mark the row skipped so the CSS placeholder does not linger either.
  img.addEventListener("error", () => {
    img.remove();
    row.setAttribute(ATTR, "skip");
  });
  img.src = src;
  row.prepend(img);
}

function paint(id: string, src: string, state: string): void {
  document
    .querySelectorAll<HTMLElement>(
      `${BASEMAP_ROW_SELECTOR}[${BASEMAP_ROW_ID_ATTR}="${CSS.escape(id)}"]`,
    )
    .forEach((row) => {
      // The flat-colour swatch and the real render race independently, and
      // `snapCache` outlives dispose(), so a reopened panel can paint "loaded"
      // before a slow swatch fetch settles. Never let a row move backwards.
      const current = row.getAttribute(ATTR);
      if (current && STATE_RANK[current] >= STATE_RANK[state]) return;
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
  let panel: HTMLElement | null = null;
  let visible: IntersectionObserver | null = null;

  function onVisible(entries: IntersectionObserverEntry[]): void {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const row = entry.target as HTMLElement;
      visible?.unobserve(row);
      const url = row.dataset.previewUrl;
      const id = row.getAttribute(BASEMAP_ROW_ID_ATTR);
      if (!url || !id) continue;
      void camera.snapshot(url).then((src) => {
        if (src) paint(id, src, "loaded");
      });
    }
  }

  function enhance(): void {
    if (!panel) return;
    const catalog = control.getBasemaps();
    panel.querySelectorAll<HTMLElement>(`${BASEMAP_ROW_SELECTOR}:not([${ATTR}])`).forEach((row) => {
      const id = row.getAttribute(BASEMAP_ROW_ID_ATTR);
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
  }

  // Every scan is scoped to the control's own panel: rooting them at
  // `document.body` would rebuild the catalog and re-scan the whole document on
  // every unrelated UI mutation, and would make the IntersectionObserver treat
  // rows scrolled out of the panel as visible.
  const scoped = new MutationObserver(() => enhance());

  function attach(): void {
    const found = document.querySelector<HTMLElement>(BASEMAP_PANEL_SELECTOR);
    if (found === panel) return;
    panel = found;
    scoped.disconnect();
    visible?.disconnect();
    visible = null;
    if (!panel) return;
    scoped.observe(panel, { childList: true, subtree: true });
    if (typeof IntersectionObserver === "function") {
      visible = new IntersectionObserver(onVisible, { root: panel, rootMargin: "80px" });
    }
    enhance();
  }

  // The control builds a fresh panel element in every `onAdd`, so the one this
  // watched can be replaced (a position change) or not exist yet. This callback
  // costs a single `isConnected` check per mutation batch while the panel is
  // healthy, and only then falls back to a lookup.
  const bootstrap = new MutationObserver(() => {
    if (!panel?.isConnected) attach();
  });
  bootstrap.observe(document.body, { childList: true, subtree: true });
  attach();

  return {
    pause: () => camera.pause(),
    dispose() {
      bootstrap.disconnect();
      scoped.disconnect();
      visible?.disconnect();
      camera.dispose();
    },
  };
}
