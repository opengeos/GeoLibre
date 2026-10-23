import type { Texture, Framebuffer } from '@luma.gl/core';
import { Deck } from '@deck.gl/core';
import { Model } from '@luma.gl/engine';
interface Renderer {
    redraw: () => void;
}
export type RenderResources = {
    deck: Deck;
    texture: Texture;
    model: Model;
    fbo: Framebuffer;
};
export declare function initializeResources(this: Renderer, gl: WebGL2RenderingContext): Promise<RenderResources>;
export declare function render(resources: RenderResources, viewport: {
    width: number;
    height: number;
    longitude: number;
    latitude: number;
    zoom: number;
    altitude?: number;
    pitch: number;
    bearing: number;
    views?: unknown;
    viewState?: unknown;
}): void;
export declare function finalizeResources(resources: RenderResources): void;
export {};
