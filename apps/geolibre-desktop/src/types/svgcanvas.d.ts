declare module "svgcanvas" {
  /** Canvas 2D API implemented by svgcanvas, with SVG serialization helpers. */
  export interface Context extends CanvasRenderingContext2D {
    getSvg(): SVGSVGElement;
    getSerializedSvg(): string;
  }

  export const Context: {
    new (width: number, height: number): Context;
  };
}
