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
/**
 * Caps both preview paths. A host that accepts the connection but never
 * completes the response would otherwise leave the swatch promise unsettled and
 * the row on its placeholder for good — the snapshot path has always had this,
 * and the fetch needs it for the same reason.
 */
const PREVIEW_TIMEOUT_MS = 6000;
const STATE_RANK: Record<string, number> = { skip: 0, pending: 1, ready: 2, loaded: 3 };

/**
 * Whether a row currently showing `current` may be repainted as `next`.
 *
 * The flat-colour swatch and the real render race independently, and
 * `snapCache` outlives dispose(), so a reopened panel can paint "loaded" before
 * a slow swatch fetch settles. A row only ever moves forward. An unrecognized
 * state is treated as advancing, so a future state cannot silently freeze a row.
 */
export function advances(current: string | null, next: string): boolean {
  if (!current) return true;
  return !(STATE_RANK[current] >= STATE_RANK[next]);
}
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
function hasUnresolvedPlaceholder(value: string, substituted?: RegExp): boolean {
  return (value.match(/\{[^{}]*\}/g) ?? []).some((token) => !substituted?.test(token));
}

/** The zoom every raster preview tile is sampled at. */
const PREVIEW_Z = 2;

export function rasterPreviewUrl(basemap: BasemapDefinition): string | null {
  if (basemap.source.type !== "raster" || !basemap.source.tiles?.[0]) return null;
  const template = basemap.source.tiles[0];
  if (hasUnresolvedPlaceholder(template, SUBSTITUTED_TOKEN)) return null;
  // A `tms` source numbers rows from the bottom (MapLibre flips `{y}` for it),
  // so an xyz row index would fetch the vertically mirrored tile — a different
  // part of the world than the basemap actually renders there.
  const y = basemap.source.scheme === "tms" ? 2 ** PREVIEW_Z - 1 - 1 : 1;
  return template
    .replace(/\{z\}/g, String(PREVIEW_Z))
    .replace(/\{x\}/g, "1")
    .replace(/\{y\}/g, String(y))
    .replace(/\{s\}/g, "a");
}

export function styleUrlOf(basemap: BasemapDefinition): string | null {
  if (basemap.source.type !== "style" && basemap.source.type !== "vector-style") return null;
  // Nothing substitutes a token in a style URL — it is fetched verbatim — so
  // even the tile tokens rasterPreviewUrl fills in make it unusable here.
  return hasUnresolvedPlaceholder(basemap.source.url) ? null : basemap.source.url;
}

function styleSwatch(url: string): Promise<string | null> {
  const hit = swatchCache.get(url);
  if (hit) return hit;
  const next = fetch(url, { signal: AbortSignal.timeout(PREVIEW_TIMEOUT_MS) })
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
  /**
   * Snapshots already queued, keyed by url. `snapCache` only fills in once a
   * job has resolved, so without this a second request for the same style
   * before the first settles would queue a redundant full style load — the same
   * reuse `styleSwatch` gets from caching its in-flight promise.
   */
  const inFlight = new Map<string, Promise<string | null>>();
  /** Settles the job that is already waiting on the hidden map, if any. */
  let cancelInFlight: (() => void) | null = null;

  const resume = () => {
    window.clearTimeout(resumeTimer);
    resumeTimer = 0;
    openGate?.();
    openGate = null;
  };

  const teardown = () => {
    // A job already past the gate has its listeners on the map about to be
    // removed, so `style.load` can never fire for it: without this it could
    // only settle through the 6s timeout, and since jobs are serialized that
    // would stall every later preview well past PAUSE_MS.
    cancelInFlight?.();
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
      const queued = inFlight.get(url);
      if (queued) return queued;
      const job = async (): Promise<string | null> => {
        await gate;
        if (disposed) return null;
        // `ensure()` constructs a MapLibre map, which throws when a WebGL
        // context cannot be created. Every other failure here resolves to null;
        // letting this one reject would surface as an unhandled rejection
        // instead of the row falling back to name-only.
        try {
          return await capture();
        } catch {
          return null;
        }
      };
      const capture = () =>
        new Promise<string | null>((resolve) => {
          const { map } = ensure();
          let settled = false;
          let loaded = false;
          let captureTimer = 0;
          const finish = (src: string | null) => {
            if (settled) return;
            settled = true;
            if (cancelInFlight === cancel) cancelInFlight = null;
            window.clearTimeout(timer);
            window.clearTimeout(captureTimer);
            map.off("style.load", onLoad);
            map.off("error", onError);
            resolve(src);
          };
          const cancel = () => finish(null);
          const timer = window.setTimeout(cancel, PREVIEW_TIMEOUT_MS);
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
            captureTimer = window.setTimeout(() => {
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
          cancelInFlight = cancel;
          map.setStyle(url, { diff: false });
        });
      const next = tail.then(job, job);
      tail = next.then(
        () => undefined,
        () => undefined,
      );
      inFlight.set(url, next);
      void next.then(() => {
        if (inFlight.get(url) === next) inFlight.delete(url);
      });
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

function rowSelector(id: string): string {
  return `${BASEMAP_ROW_SELECTOR}[${BASEMAP_ROW_ID_ATTR}="${CSS.escape(id)}"]`;
}

function apply(row: HTMLElement, src: string, state: string): void {
  if (!advances(row.getAttribute(ATTR), state)) return;
  row.setAttribute(ATTR, state);
  stamp(row, src);
}

/** Repaint by id, for a preview that resolved long after the row was scanned. */
function paint(id: string, src: string, state: string): void {
  document.querySelectorAll<HTMLElement>(rowSelector(id)).forEach((row) => apply(row, src, state));
}

/**
 * Drop a row back to the name-only layout when no preview could be produced —
 * an unreachable style host, CORS, or the snapshot timeout. Without this the
 * row keeps its "pending" placeholder for good, where a failed *raster* tile
 * already degrades this way through `stamp`'s error handler. Rows that did get
 * an image are left alone, and a later snapshot can still upgrade a skipped row
 * because "loaded" outranks "skip".
 */
function markSkipped(id: string): void {
  document.querySelectorAll<HTMLElement>(rowSelector(id)).forEach((row) => {
    if (row.querySelector(".geolibre-basemap-thumbnail")) return;
    row.setAttribute(ATTR, "skip");
  });
}

export function installBasemapThumbnails(control: BasemapControl): {
  dispose(): void;
  pause(): void;
} {
  const noop = { dispose() {}, pause() {} };
  if (typeof window === "undefined" || !document.body) return noop;

  const camera = createStyleCamera();
  // Cleared by dispose() so an in-flight preview cannot repaint rows belonging
  // to a control the plugin has already torn down.
  let active = true;
  let panel: HTMLElement | null = null;
  let visible: IntersectionObserver | null = null;

  /**
   * Run the preview a row was prepared for. Every request a preview makes —
   * the raster tile, the style JSON and the full snapshot alike — is deferred
   * to here, so opening the panel contacts only the providers whose rows are
   * actually on screen rather than every host in the catalog at once.
   */
  function preview(row: HTMLElement): void {
    const url = row.dataset.previewUrl;
    const id = row.getAttribute(BASEMAP_ROW_ID_ATTR);
    if (!url || !id) return;
    if (row.dataset.previewKind === "raster") {
      // The tile URL is ready to show, and the row is in hand — no need to go
      // back through the document for it.
      apply(row, url, "ready");
      return;
    }
    // The swatch is a flat background colour from one small JSON fetch; the
    // snapshot is a real render. Both start here, and the rank in `paint`
    // settles which one the row ends up showing.
    void styleSwatch(url).then((src) => {
      if (!active) return;
      if (src) paint(id, src, "ready");
      else markSkipped(id);
    });
    void camera.snapshot(url).then((src) => {
      if (!active) return;
      if (src) paint(id, src, "loaded");
      else markSkipped(id);
    });
  }

  function onVisible(entries: IntersectionObserverEntry[]): void {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const row = entry.target as HTMLElement;
      visible?.unobserve(row);
      preview(row);
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
      const url = raster ?? jsonUrl;
      if (!url) {
        row.setAttribute(ATTR, "skip");
        return;
      }
      row.dataset.previewUrl = url;
      row.dataset.previewKind = raster ? "raster" : "style";
      row.setAttribute(ATTR, "pending");
      // Without an IntersectionObserver there is nothing to defer to, so fall
      // back to previewing every row as it is found.
      if (visible) visible.observe(row);
      else preview(row);
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
    watchForPanel();
    if (!panel) return;
    scoped.observe(panel, { childList: true, subtree: true });
    if (typeof IntersectionObserver === "function") {
      visible = new IntersectionObserver(onVisible, { root: panel, rootMargin: "80px" });
    }
    enhance();
  }

  // The control builds a fresh panel element in every `onAdd`, so the one this
  // watched can be replaced (a position change) or not exist yet. This callback
  // costs a single `isConnected` check per mutation batch, and only then falls
  // back to a lookup.
  const bootstrap = new MutationObserver(() => {
    if (!panel?.isConnected) attach();
  });

  /**
   * `BasemapControl` does not expose its panel, but it appends it as a direct
   * child of the map container — so once the panel has been seen, watch that
   * one element's child list rather than the whole application's DOM. A
   * body-wide subtree observer would fire on every unrelated UI mutation for as
   * long as the plugin is active, which is the whole session. The body is only
   * a bootstrap for the window before the panel first appears.
   */
  function watchForPanel(): void {
    bootstrap.disconnect();
    const host = panel?.parentElement;
    if (host) bootstrap.observe(host, { childList: true });
    else bootstrap.observe(document.body, { childList: true, subtree: true });
  }

  attach();
  // `attach` installs the watch when it finds a panel; cover the case where it
  // did not.
  if (!panel) watchForPanel();

  return {
    pause: () => camera.pause(),
    dispose() {
      active = false;
      bootstrap.disconnect();
      scoped.disconnect();
      visible?.disconnect();
      camera.dispose();
    },
  };
}
