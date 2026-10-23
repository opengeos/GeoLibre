import type { StyleSpecification, ExpressionSpecification } from "mapbox-gl";

export const STANDARD_OPACITY = "geolibreBasemapOpacity";
export const STANDARD_BLANK_COLOR = "geolibreBlankColor";

/** Keep camera expressions at the top level, as required by the Style Spec. */
export function standardOpacityExpression(value: unknown, blank = false): unknown {
  if (Array.isArray(value)) {
    if (value[0] === "interpolate" || value[0] === "step") {
      const start = value[0] === "step" ? 2 : 4;
      return value.map((part, index) =>
        index >= start && (index - start) % 2 === 0 ? standardOpacityExpression(part, blank) : part,
      );
    }
    if (value[0] === "let")
      return value.map((part, index) =>
        index === value.length - 1 ? standardOpacityExpression(part, blank) : part,
      );
    if (value[0] === "coalesce")
      return value.map((part, index) => (index ? standardOpacityExpression(part, blank) : part));
  }
  const scaled = ["*", value ?? 1, ["config", STANDARD_OPACITY]];
  return blank ? ["+", scaled, ["-", 1, ["config", STANDARD_OPACITY]]] : scaled;
}

/** Add an opacity config to a local copy; retain Standard's slots and config. */
export function withStandardOpacity(original: StyleSpecification): StyleSpecification {
  const style = structuredClone(original);
  style.schema = {
    ...style.schema,
    [STANDARD_OPACITY]: { type: "number", default: 1, minValue: 0, maxValue: 1 },
    [STANDARD_BLANK_COLOR]: { type: "color", default: "#ffffff" },
  };
  for (const layer of style.layers) {
    if (layer.type === "background") {
      const paint = (layer.paint ??= {});
      paint["background-color"] = [
        "interpolate",
        ["linear"],
        ["config", STANDARD_OPACITY],
        0,
        ["config", STANDARD_BLANK_COLOR],
        1,
        paint["background-color"] ?? "#000000",
      ] as ExpressionSpecification;
      // At zero opacity the blank background should keep its exact chosen color.
      paint["background-emissive-strength"] = standardOpacityExpression(
        paint["background-emissive-strength"] ?? 0,
        true,
      ) as ExpressionSpecification;
      continue;
    }
    if (
      ![
        "fill",
        "line",
        "circle",
        "symbol",
        "fill-extrusion",
        "model",
        "building",
        "raster",
        "heatmap",
      ].includes(layer.type)
    )
      continue;
    const paint = (layer.paint ??= {}) as Record<string, unknown>;
    for (const property of layer.type === "symbol"
      ? ["text-opacity", "icon-opacity"]
      : [`${layer.type}-opacity`])
      paint[property] = standardOpacityExpression(paint[property]);
  }
  if (style.fog) {
    for (const key of ["color", "high-color", "space-color"] as const) {
      const color = style.fog[key];
      if (color == null) continue;
      style.fog[key] = [
        "let",
        "geolibreFog",
        ["to-rgba", color],
        [
          "rgba",
          ["at", 0, ["var", "geolibreFog"]],
          ["at", 1, ["var", "geolibreFog"]],
          ["at", 2, ["var", "geolibreFog"]],
          ["*", ["at", 3, ["var", "geolibreFog"]], ["config", STANDARD_OPACITY]],
        ],
      ] as ExpressionSpecification;
    }
    style.fog["star-intensity"] = standardOpacityExpression(
      style.fog["star-intensity"] ?? 0,
    ) as ExpressionSpecification;
  }
  return style;
}

function standardName(url: string): string | null {
  const match =
    /^(?:mapbox:\/\/styles\/|https:\/\/api\.mapbox\.com\/styles\/v1\/)mapbox\/(standard)(?:\?|$)/.exec(
      url,
    );
  return match?.[1] ?? null;
}

export function isMapboxStandard(style: string | StyleSpecification): boolean {
  return typeof style === "string" && standardName(style) !== null;
}

const styles = new Map<string, Promise<StyleSpecification>>();

/** Prepare Standard before mounting it, avoiding an import reload on slider drags. */
export async function prepareMapboxStandard(
  style: string | StyleSpecification,
  accessToken: string,
): Promise<string | StyleSpecification> {
  if (typeof style !== "string" || !standardName(style)) return style;
  const name = standardName(style)!;
  const url = new URL(`https://api.mapbox.com/styles/v1/mapbox/${name}`);
  const query = style.includes("?")
    ? new URLSearchParams(style.slice(style.indexOf("?") + 1))
    : null;
  url.searchParams.set("access_token", query?.get("access_token") || accessToken);
  let pending = styles.get(url.href);
  if (!pending) {
    pending = fetch(url)
      .then(async (response) => {
        if (!response.ok) throw new Error(`Could not load Mapbox Standard (${response.status})`);
        return withStandardOpacity((await response.json()) as StyleSpecification);
      })
      .catch((error) => {
        styles.delete(url.href);
        throw error;
      });
    styles.set(url.href, pending);
  }
  return {
    version: 8,
    sources: {},
    imports: [
      {
        id: "basemap",
        url: `mapbox://styles/mapbox/${name}`,
        data: structuredClone(await pending),
      },
    ],
    layers: [],
  };
}
