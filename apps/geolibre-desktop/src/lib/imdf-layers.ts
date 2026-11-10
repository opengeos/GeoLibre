import type { LayerStyle, VectorStyleStop } from "@geolibre/core";
import i18next from "i18next";
import type { FeatureCollection } from "geojson";
import type { LoadedVectorLayer } from "./file-io/loaded-layer";
import type { ImdfImport, ImdfLayer } from "./imdf";

/**
 * Turn a parsed IMDF archive (issue #3341) into ready-styled layers.
 *
 * Units and level outlines are extruded and stacked from each feature's
 * `ordinal` (the lowest floor sits on the ground), and every layer on a floor
 * is linked to the floor picker by `ordinal`, so a venue opens as a 3D
 * building that can be explored one floor at a time. All layers share one
 * group named after the venue.
 */

/** Metres between floors when stacking an IMDF venue. */
export const IMDF_FLOOR_SPACING = 4;
/** Height of a unit's solid (leaving a gap under the floor above). */
const UNIT_HEIGHT = 3;
/** Thickness of a level's floor slab. */
const SLAB_HEIGHT = 0.2;

/** Unit colors by IMDF category, so rooms, circulation and voids read apart. */
const UNIT_CATEGORY_COLORS: [string[], string][] = [
  [
    ["room", "office", "classroom", "conferenceroom", "laboratory", "library", "auditorium"],
    "#60a5fa",
  ],
  [["walkway", "lobby", "foyer", "unspecified"], "#e5e7eb"],
  [["stairs", "elevator", "escalator", "ramp", "steps", "movingwalkway"], "#f59e0b"],
  [
    [
      "restroom",
      "restroom.female",
      "restroom.male",
      "restroom.unisex",
      "restroom.family",
      "restroom.transgender",
      "restroom.wheelchair",
    ],
    "#a78bfa",
  ],
  [
    ["nonpublic", "privatelounge", "storage", "mechanical", "unenclosedarea", "opentobelow"],
    "#9ca3af",
  ],
  [["parking", "vehiclelane", "road"], "#6b7280"],
  [["shop", "restaurant", "foodservice", "retail"], "#34d399"],
];

/** The fallback unit color, for categories outside {@link UNIT_CATEGORY_COLORS}. */
const UNIT_FALLBACK_COLOR = "#bfdbfe";

/** The color a unit category draws in. */
function unitCategoryColor(category: string): string {
  for (const [categories, color] of UNIT_CATEGORY_COLORS) {
    if (categories.includes(category)) return color;
  }
  return UNIT_FALLBACK_COLOR;
}

/**
 * The categorized renderer for an archive's units (issue #3388): one stop per
 * distinct `category`, in sorted order. Units are colored through the regular
 * categorized renderer rather than a raw expression, so the Style pane shows
 * (and can edit) the classes the map draws.
 *
 * `opentobelow` keeps its stop even though the unit filter hides those
 * features: the Style pane counts every distinct value for "All (N)" and
 * regenerates the stops from all of them, so leaving it out would make the
 * class list change shape the first time the user edits it. Its color is
 * never drawn. Blank categories get no stop, because the categorized renderer
 * drops blank values.
 *
 * @param layer - The archive's unit layer.
 * @returns The stops, and a class count equal to their number so the Style
 *   pane selects "All" for them.
 */
export function unitCategoryClasses(layer: ImdfLayer): {
  stops: VectorStyleStop[];
  classCount: number;
} {
  const categories = new Set<string>();
  for (const feature of layer.geojson.features) {
    const category = feature.properties?.category;
    if (typeof category === "string" && category.trim()) categories.add(category);
  }
  const stops = [...categories]
    .sort()
    .map((category) => ({ value: category, color: unitCategoryColor(category), label: category }));
  return { stops, classCount: Math.max(1, stops.length) };
}

/** Extrusion settings that stack a feature on its floor. */
function stacked(lowestOrdinal: number, height: number): Partial<LayerStyle> {
  return {
    extrusionEnabled: true,
    // base = (ordinal - lowest) * spacing, so the lowest floor stands on the ground.
    extrusionBase: -lowestOrdinal * IMDF_FLOOR_SPACING,
    extrusionBaseProperty: "ordinal",
    extrusionBaseScale: IMDF_FLOOR_SPACING,
    extrusionFloorHeight: height,
  };
}

/** The translated layer name for a feature type. */
function layerName(type: string): string {
  const key = `addData.imdf.layer.${type}`;
  return i18next.exists(key) ? i18next.t(key as never) : type;
}

/** The style and initial visibility for one feature type. */
function presentation(
  layer: ImdfLayer,
  lowestOrdinal: number,
): { style?: Partial<LayerStyle>; visible?: boolean; filterExpression?: unknown[] } {
  switch (layer.featureType) {
    case "venue":
    case "footprint":
      // The site outline: drawn flat, not filled over the floors.
      return {
        style: {
          fillColor: "#94a3b8",
          fillOpacity: 0.08,
          strokeColor: "#475569",
          strokeWidth: 1.5,
        },
      };
    case "level":
      return {
        style: {
          ...stacked(lowestOrdinal, SLAB_HEIGHT),
          extrusionColor: "#cbd5e1",
          extrusionOpacity: 0.6,
        },
      };
    case "unit": {
      const classes = unitCategoryClasses(layer);
      return {
        style: {
          ...stacked(lowestOrdinal, UNIT_HEIGHT),
          // The categorized renderer colors the extrusion too, and features
          // whose category has no stop fall back to the extrusion color.
          extrusionColor: UNIT_FALLBACK_COLOR,
          extrusionOpacity: 0.85,
          fillColor: UNIT_FALLBACK_COLOR,
          vectorStyleMode: "categorized",
          vectorStyleProperty: "category",
          vectorStyleStops: classes.stops,
          vectorStyleClassCount: classes.classCount,
        },
        // An open-to-below unit is the void of an atrium; drawing it as a solid
        // would plug the hole it describes. A unit with no resolvable level has
        // no ordinal, so it cannot be stacked and is left out rather than placed
        // on the ground floor.
        filterExpression: ["all", ["!=", ["get", "category"], "opentobelow"], ["has", "ordinal"]],
      };
    }
    case "opening":
      return { style: { strokeColor: "#dc2626", strokeWidth: 3 } };
    case "amenity":
    case "occupant":
    case "kiosk":
      return { style: { fillColor: "#0ea5e9", strokeColor: "#ffffff", circleRadius: 5 } };
    case "geofence":
      // Geofences are invisible boundaries by design; keep them for analysis.
      return { visible: false };
    default:
      return {};
  }
}

/**
 * Build the layers an IMDF archive adds.
 *
 * @param archive - The parsed archive.
 * @param path - The archive's file name or path (the layers' source).
 * @returns One layer per drawable feature type, bottom first, grouped under
 *   the venue's name.
 */
export function imdfLoadedLayers(archive: ImdfImport, path: string): LoadedVectorLayer[] {
  const lowest = archive.ordinalRange?.min ?? 0;
  const group =
    archive.venueName ??
    path
      .split(/[\\/]/)
      .pop()
      ?.replace(/\.zip$/i, "") ??
    "IMDF";
  return archive.layers.map((layer) => {
    const { style, visible, filterExpression } = presentation(layer, lowest);
    return {
      data: layer.geojson as unknown as FeatureCollection,
      name: layerName(layer.featureType),
      path,
      sourceEntry: `imdf:${layer.featureType}`,
      groupPath: [group],
      ...(style ? { style } : {}),
      ...(visible === false ? { visible } : {}),
      ...(filterExpression ? { filterExpression } : {}),
      ...(layer.onLevels
        ? { levelFilter: { field: "ordinal", mode: "all" as const, level: null } }
        : {}),
    };
  });
}
