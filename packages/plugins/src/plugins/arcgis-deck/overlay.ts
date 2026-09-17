import type { SceneDeckRenderer } from "./deck-renderer.js";
import type { DeckProps } from "@deck.gl/core";
import type { ArcgisEngine } from "@geolibre/map";
import { arcgisModuleUrl } from "@geolibre/map/arcgis-sdk";
import { initializeResources, render, finalizeResources, type RenderResources } from "./commons.js";

type ArcgisView = NonNullable<ReturnType<ArcgisEngine["getView"]>>;
type DeckPickingInfo = Parameters<NonNullable<DeckProps["onHover"]>>[0];
type NativeLayer = ArcgisView["map"]["layers"] extends { toArray(): (infer L)[] } ? L : never;
type Subclass<T> = {
  createSubclass(definition: Record<string, unknown>): new (props: Record<string, unknown>) => T;
};
interface LayerView {
  context: WebGL2RenderingContext;
  requestRender(): void;
}

async function importModule(path: string): Promise<{ default: unknown }> {
  return import(/* @vite-ignore */ arcgisModuleUrl(path));
}

/** CDN-backed equivalent of deck.gl's DeckLayer, with explicit store-driven props. */
export class ArcgisDeckOverlay {
  private map: ArcgisView["map"];
  private native: NativeLayer | null = null;
  private resources: RenderResources | null = null;
  private layerView: LayerView | null = null;
  private generation = 0;
  private disposed = false;
  private events: { remove(): void }[] = [];
  private hoverFrame: number | null = null;
  private hoverInfo: DeckPickingInfo | null = null;
  private pendingHover: (() => void) | null = null;
  private props: DeckProps;
  private sceneRenderer: SceneDeckRenderer | null = null;

  constructor(
    private view: ArcgisView,
    props: DeckProps,
    private loadModule = importModule,
    private createResources = initializeResources,
  ) {
    this.props = props;
    this.map = view.map;
  }

  private mountPromise: Promise<void> | null = null;
  mount(): Promise<void> {
    return (this.mountPromise ??= this.attach().catch((error) => {
      this.clearEvents();
      this.mountPromise = null;
      throw error;
    }));
  }
  private async attach(): Promise<void> {
    if (this.disposed || this.native) return;
    if (this.view.type === "3d" && this.view.viewingMode !== "local") return;
    // Deck uses an offscreen canvas, so ArcGIS owns pointer delivery.
    for (const [eventType, callback] of [
      ["click", "onClick"],
      ["pointer-move", "onHover"],
    ] as const) {
      if (!this.view.on) continue;
      this.events.push(
        this.view.on(eventType, (event) => {
          const pick = () => {
            const info = this.getDeck()?.pickObject({ x: event.x, y: event.y });
            if (!info) {
              if (callback === "onClick") {
                this.props.onClick?.(
                  {
                    picked: false,
                    object: null,
                    index: -1,
                    layer: null,
                    x: event.x,
                    y: event.y,
                  } as DeckPickingInfo,
                  event as never,
                );
                return;
              }
              if (!this.hoverInfo) return;
              this.clearHover(event);
              return;
            }
            if (callback === "onHover") {
              if (
                this.hoverInfo &&
                (this.hoverInfo.layer !== info.layer ||
                  this.hoverInfo.object !== info.object ||
                  this.hoverInfo.index !== info.index)
              )
                this.clearHover(event);
              this.hoverInfo = info;
            }
            const handled = info.layer?.props[callback]?.(info, event as never);
            if (!handled) this.props[callback]?.(info, event as never);
          };
          if (eventType === "click") {
            pick();
          } else {
            this.pendingHover = pick;
            if (this.hoverFrame === null) {
              this.hoverFrame = requestAnimationFrame(() => {
                this.hoverFrame = null;
                const latest = this.pendingHover;
                this.pendingHover = null;
                if (!this.disposed) latest?.();
              });
            }
          }
        }),
      );
    }
    if (this.view.type === "3d") {
      const [module, { default: factory }] = await Promise.all([
        this.loadModule("views/3d/webgl/RenderNode"),
        import("./deck-renderer.js"),
      ]);
      if (!this.disposed) {
        const Renderer = factory(DeckState, module.default);
        this.sceneRenderer = new Renderer(this.view, this.props);
      }
      return;
    }
    const paths = ["layers/Layer", "views/2d/layers/BaseLayerViewGL2D"];
    const [layerModule, viewModule] = await Promise.all(paths.map((path) => this.loadModule(path)));
    if (this.disposed) return;
    const Layer = layerModule.default as Subclass<NativeLayer>;
    const BaseLayerView = viewModule.default as Subclass<LayerView>;
    const overlay = this;
    const DeckView = BaseLayerView.createSubclass({
      async attach(this: LayerView) {
        const generation = ++overlay.generation;
        overlay.layerView = this;
        for (let attempt = 0; attempt < 3; attempt++) {
          if (overlay.disposed || generation !== overlay.generation) return;
          let resources: RenderResources;
          try {
            resources = await overlay.createResources.call(
              { redraw: () => this.requestRender() },
              this.context,
            );
          } catch (error) {
            if (overlay.disposed || generation !== overlay.generation) return;
            if (attempt === 2) {
              overlay.props.onError?.(error as Error);
              return;
            }
            await new Promise((resolve) => setTimeout(resolve, 250));
            continue;
          }
          if (overlay.disposed || generation !== overlay.generation) {
            finalizeResources(resources);
            return;
          }
          overlay.resources = resources;
          resources.deck.setProps(overlay.props);
          overlay.props.onDeviceInitialized?.(resources.model.device);
          this.requestRender();
          return;
        }
      },
      detach() {
        overlay.generation++;
        if (overlay.resources) finalizeResources(overlay.resources);
        overlay.resources = null;
        overlay.layerView = null;
      },
      render({ state }: { state: { size: [number, number]; scale: number; rotation: number } }) {
        if (!overlay.resources) return;
        const [width, height] = state.size;
        render(overlay.resources, {
          width,
          height,
          latitude: overlay.view.center.latitude,
          longitude: overlay.view.center.longitude,
          // ArcGIS scales use 256px tiles; Deck's Mercator viewport uses 512px.
          zoom: Math.log2(591657527.591555 / state.scale) - 1,
          bearing: -state.rotation,
          pitch: 0,
        });
      },
    });
    const DeckLayer = Layer.createSubclass({
      createLayerView(view: ArcgisView) {
        return new DeckView({ view, layer: overlay.native });
      },
    });
    this.native = new DeckLayer({ title: "deck.gl", listMode: "hide" });
    this.map.add(this.native);
  }

  setProps(props: DeckProps): void {
    this.props = { ...this.props, ...props };
    this.resources?.deck.setProps(props);
    this.sceneRenderer?.deck.set(props);
    this.sceneRenderer?.redraw();
    this.layerView?.requestRender();
  }

  getDeck() {
    return this.resources?.deck ?? this.sceneRenderer?.resources?.deck ?? null;
  }

  private clearHover(event: unknown): void {
    if (!this.hoverInfo) return;
    const cleared = { ...this.hoverInfo, picked: false, object: null, index: -1 };
    this.hoverInfo = null;
    const handled = cleared.layer?.props.onHover?.(cleared, event as never);
    if (!handled) this.props.onHover?.(cleared, event as never);
  }

  private clearEvents(): void {
    for (const event of this.events) event.remove();
    this.events = [];
    if (this.hoverFrame !== null) cancelAnimationFrame(this.hoverFrame);
    this.hoverFrame = null;
    this.pendingHover = null;
    this.hoverInfo = null;
  }

  finalize(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearEvents();
    this.generation++;
    this.sceneRenderer?.dispose();
    this.sceneRenderer = null;
    if (this.native && !this.native.destroyed) {
      this.map.remove(this.native);
      this.native.destroy();
      this.native = null;
    }
    if (this.resources) finalizeResources(this.resources);
    this.resources = null;
    this.layerView = null;
  }
}

/** Upstream's props Accessor contract without the removed SDK Accessor.watch API. */
class DeckState {
  private listeners = new Set<(props: DeckProps) => void>();
  constructor(private props: DeckProps = {}) {}
  on(_event: string, callback: (props: DeckProps) => void): void {
    this.listeners.add(callback);
  }
  set(props: DeckProps): void {
    this.props = { ...this.props, ...props };
    for (const callback of this.listeners) callback(props);
  }
  toJSON(): DeckProps {
    return this.props;
  }
  clear(): void {
    this.listeners.clear();
  }
}
