import { styleValue, type LayerStyle, type LineDecoration } from "@geolibre/core";

/**
 * Line decorations (arrows and repeated shapes) as an ArcGIS CIM line symbol:
 * one vector marker placed along the line at the style's spacing and turned
 * to follow it, so an arrow points the way the line is digitized, as the 2D
 * map's `symbol-placement: "line"` icons do (`line-decorations.ts`). The
 * shapes are the same geometry that module draws on its sprite canvas, with
 * the same white halo. Pure JSON: the SDK autocasts `{ type: "cim" }`.
 */

const DECORATION_SHAPES: ReadonlySet<LineDecoration> = new Set([
  "arrow",
  "triangle",
  "circle",
  "square",
]);

/** CSS pixels to the points CIM sizes are expressed in. */
const PT_PER_PX = 0.75;

/** The decoration size in CSS pixels, clamped as the 2D sprite is. */
function decorationSize(style: LayerStyle): number {
  const size = styleValue(style, "lineDecorationSize");
  if (!Number.isFinite(size)) return 12;
  return Math.min(64, Math.max(4, Math.round(size)));
}

/**
 * The shape's closed ring in a frame of `size` units centred on the origin,
 * x along the line (y up, the canvas drawing mirrored, which the symmetric
 * shapes do not notice).
 */
function decorationRing(shape: LineDecoration, size: number): number[][] {
  const r = (size / 2) * 0.82;
  switch (shape) {
    case "arrow":
      return [
        [r, 0],
        [-r, -r * 0.78],
        [-r * 0.35, 0],
        [-r, r * 0.78],
        [r, 0],
      ];
    case "triangle":
      return [
        [r, 0],
        [-r, -r],
        [-r, r],
        [r, 0],
      ];
    case "square": {
      const h = r * 0.85;
      return [
        [-h, -h],
        [-h, h],
        [h, h],
        [h, -h],
        [-h, -h],
      ];
    }
    default: {
      const radius = r * 0.9;
      const ring: number[][] = [];
      for (let i = 0; i <= 32; i++) {
        const angle = (-i / 32) * Math.PI * 2;
        ring.push([radius * Math.cos(angle), radius * Math.sin(angle)]);
      }
      return ring;
    }
  }
}

/**
 * The CIM symbol drawing a layer's line decorations; callers check
 * {@link hasLineDecoration} first.
 *
 * @param style - The layer style.
 * @param color - The decoration colour as the SDK's `[r, g, b, a]` (alpha 0–1).
 * @returns An SDK `cim` symbol JSON.
 */
export function arcgisLineDecorationSymbol(
  style: LayerStyle,
  color: [number, number, number, number],
): Record<string, unknown> & { type: string } {
  const shape = styleValue(style, "lineDecoration");
  const size = decorationSize(style);
  const spacing = Math.max(1, styleValue(style, "lineDecorationSpacing") || 80);
  const half = size / 2;
  // CIM colours carry alpha on a 0–255 scale.
  const cimColor = [color[0], color[1], color[2], Math.round(color[3] * 255)];
  return {
    type: "cim",
    data: {
      type: "CIMSymbolReference",
      symbol: {
        type: "CIMLineSymbol",
        symbolLayers: [
          {
            type: "CIMVectorMarker",
            enable: true,
            anchorPointUnits: "Relative",
            size: size * PT_PER_PX,
            frame: { xmin: -half, ymin: -half, xmax: half, ymax: half },
            respectFrame: true,
            scaleSymbolsProportionally: true,
            markerPlacement: {
              type: "CIMMarkerPlacementAlongLineSameSize",
              angleToLine: true,
              // MapLibre spaces line icons by `symbol-spacing` pixels and
              // starts half an interval in.
              offsetAlongLine: (spacing / 2) * PT_PER_PX,
              placementTemplate: [spacing * PT_PER_PX],
              endings: "Custom",
              customEndingOffset: (spacing / 2) * PT_PER_PX,
            },
            markerGraphics: [
              {
                type: "CIMMarkerGraphic",
                geometry: { rings: [decorationRing(shape, size)] },
                symbol: {
                  type: "CIMPolygonSymbol",
                  // The first layer draws on top: the halo over the fill, as
                  // the sprite strokes after filling.
                  symbolLayers: [
                    {
                      type: "CIMSolidStroke",
                      enable: true,
                      width: PT_PER_PX,
                      color: [255, 255, 255, 230],
                    },
                    { type: "CIMSolidFill", enable: true, color: cimColor },
                  ],
                },
              },
            ],
          },
        ],
      },
    },
  };
}

/** Whether a style draws line decorations. */
export function hasLineDecoration(style: LayerStyle): boolean {
  return DECORATION_SHAPES.has(styleValue(style, "lineDecoration"));
}
