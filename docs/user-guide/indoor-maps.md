# Indoor Maps and BIM

GeoLibre can show the inside of a building in 3D: floor plans stacked by level, one floor at a time, and full BIM models. This page ties the pieces together and shows how to bring each kind of indoor data in.

## Floor plans with a level attribute

Rooms, corridors and doors from OpenStreetMap indoor mapping, a GeoPackage, a Shapefile or GeoJSON usually carry the floor each feature is on (`level`, `floor`, `ordinal`, ...).

1. **Stack the floors.** In the Style panel, turn on **3D extrusion**, set **Base property** to the level field and **Base scale** to the storey height (for example 3.5 m), and give every feature a **Floor height** (for example 3 m). See [Stacking floors](styling.md#vector-styling).
2. **Pick a floor.** In the Style panel's **Floor picker** section, choose the **Floor field**. A **Floor** control appears on the map: click a floor to draw only that floor, add **+ below** to keep the floors under it, or while **All** is selected click a room on the map to switch to its floor and center on it. See [Floor picker](styling.md#floor-picker).

**Add Data → Vector Layer → Load sample data → Berlin Hbf indoor (OSM)** is a ready-made example with three floors.

## IMDF venues

An IMDF archive (Indoor Mapping Data Format, the zip of GeoJSON files that Apple Maps and many indoor-mapping tools export) opens as a ready-made venue: one layer per feature type, the floors stacked and linked to the floor picker. Pick or drop the `.zip`, or load it by URL with **Add Data → Vector Layer**. **Load sample data → Dinoseum indoor venue (IMDF)** opens Apple's IMDF sample. See [Adding data](adding-data.md).

## IndoorGML buildings

An OGC IndoorGML 1.0 document (`.gml` or `.xml`) opens with **Add Data → IndoorGML Layer** as three layers linked to the floor picker:

- **Cells** — rooms (`GeneralSpace`), corridors and stairs (`TransitionSpace`), doors (`ConnectionSpace`) and anchors (`AnchorSpace`), extruded from each cell's floor (`base_z`) to its ceiling (`top_z`) and colored by space kind.
- **Navigation network** — the transitions of the dual graph, drawn in 3D at their node elevations.
- **Navigation nodes** — the states of the dual graph (hidden at first).

Floors come from a cell's `storey` when the file names one, or from grouping cell base elevations (counting floor `0` from the floor nearest elevation zero). When the file does not name an EPSG coordinate reference system (`srsName`), enter the **Source CRS** or check **Local coordinates (place at map centre)** for a model in local building metres. **Load sample data → FJK-Haus (OGC IndoorGML sample)** opens a two-storey house with its navigation graph. See [IndoorGML buildings](adding-data.md#indoorgml-buildings).

## BIM models as I3S Building Scene Layers

An ArcGIS I3S **Building Scene Layer** is a BIM model published as a scene service. Add its `.../SceneServer/layers/<n>` URL with **Add Data → 3D Tiles Layer**. It opens on its Overview (the building shell); the Style panel's **Building** section switches to the **Full model** and turns its disciplines (Architectural, Structural, Electrical, ...) and categories (Walls, Windows, Doors, ...) on and off. The choice is saved with the project. Scene layers have to be in WGS84 to draw on the 2D map. **Load sample data → Redlands Building E (ArcGIS I3S BIM)** opens one of Esri's sample buildings.

Scene layers store absolute elevations. On the flat 2D map and on the 3D globe without terrain, a layer whose geometry starts above 0 m is lowered by its lowest point so it sits on the ground; with terrain on, it is drawn at its own elevations. The lowering is one value for the whole layer, so a city-wide layer on hilly ground still has its higher buildings above the flat map; turn terrain on for those. Use the Style panel's **Height offset** to nudge it further. The globe honours the same **Building** settings (Overview or Full model, disciplines and categories) as the 2D map.

## IFC files

GeoLibre has no IFC reader of its own. Convert the model with one of these routes, depending on what you need:

| You want | Route |
| --- | --- |
| The full BIM model, by discipline and category | Publish it as an I3S Building Scene Layer (for example with ArcGIS Pro's BIM file workspace and scene layer tools), then add the scene service URL as above. |
| A 3D Tiles tileset | Upload the IFC to Cesium ion, which tiles it as 3D Tiles, and add it with **Add Data → Cesium Ion Asset** on the Cesium engine. |
| Rooms as floor plans you can style, filter and pick floors on | Export the rooms (`IfcSpace`) as GeoJSON with a `level` field, with the script below, and add the GeoJSON as a vector layer. |

### Rooms to GeoJSON with IfcOpenShell

The script below reads every room (`IfcSpace`), takes its footprint from the IFC geometry, places it from the site's reference latitude and longitude (`IfcSite.RefLatitude` / `RefLongitude`), and writes `level` (0 for the lowest storey), `storey`, `elevation`, `name` and `number`. It needs `pip install ifcopenshell shapely`. Save it as `ifc_rooms_to_geojson.py` and run:

```bash
python ifc_rooms_to_geojson.py model.ifc rooms.geojson
```

```python
"""Export an IFC model's rooms (IfcSpace) as GeoJSON floor plans with a level field.

Usage: python ifc_rooms_to_geojson.py model.ifc rooms.geojson
"""
import json
import math
import sys

import ifcopenshell
import ifcopenshell.geom
import ifcopenshell.util.element
import ifcopenshell.util.placement
import ifcopenshell.util.unit
from shapely.geometry import MultiPolygon, Polygon, mapping
from shapely.ops import unary_union


def dms(angle):
    """IFC compound angle (deg, min, sec, millionths) to decimal degrees."""
    sign = -1 if any(v < 0 for v in angle) else 1
    d, m, s, *rest = (abs(v) for v in angle)
    return sign * (d + m / 60 + (s + (rest[0] if rest else 0) / 1e6) / 3600)


def storey_of(space):
    """The storey a room belongs to, through any rooms it is nested in."""
    node = space
    while node is not None:
        # Rooms are usually aggregated into their storey (IfcRelAggregates),
        # sometimes contained in it (IfcRelContainedInSpatialStructure), and
        # sometimes nested in a larger room.
        parent = ifcopenshell.util.element.get_aggregate(node) or ifcopenshell.util.element.get_container(node)
        if parent is None or parent.is_a("IfcBuildingStorey"):
            return parent
        node = parent if parent.is_a("IfcSpace") else None
    return None


def placement_origin(element):
    """The origin of an element's placement, in project units."""
    if not element.ObjectPlacement:
        return (0.0, 0.0, 0.0)
    matrix = ifcopenshell.util.placement.get_local_placement(element.ObjectPlacement)
    return (matrix[0][3], matrix[1][3], matrix[2][3])


def to_lnglat(geom, origin):
    """Shapely geometry in metres east/north of the site origin to lon/lat."""
    lon0, lat0, m_per_deg_lon, m_per_deg_lat = origin

    def ring(coords):
        return [(lon0 + x / m_per_deg_lon, lat0 + y / m_per_deg_lat) for x, y in coords]

    polys = geom.geoms if isinstance(geom, MultiPolygon) else [geom]
    out = [Polygon(ring(p.exterior.coords), [ring(r.coords) for r in p.interiors]) for p in polys]
    return out[0] if len(out) == 1 else MultiPolygon(out)


def main(src, dst):
    model = ifcopenshell.open(src)
    site = model.by_type("IfcSite")[0]
    if site.RefLatitude is None or site.RefLongitude is None:
        sys.exit("The IfcSite has no RefLatitude/RefLongitude, so the model cannot be placed on the map.")
    lat0, lon0 = dms(site.RefLatitude), dms(site.RefLongitude)
    # Metres east/north to degrees, around the site's reference point.
    origin = (lon0, lat0, 111_319.488 * math.cos(math.radians(lat0)), 111_132.954)
    # The geometry comes in metres from the project origin, but the reference
    # latitude/longitude locate the site's own placement, so measure from that.
    scale = ifcopenshell.util.unit.calculate_unit_scale(model)
    site_x, site_y, _ = (v * scale for v in placement_origin(site))

    # Lowest storey first; a storey with no Elevation is placed by its placement.
    storeys = sorted(
        model.by_type("IfcBuildingStorey"),
        key=lambda s: s.Elevation if s.Elevation is not None else placement_origin(s)[2],
    )
    level_of = {storey.id(): index for index, storey in enumerate(storeys)}
    settings = ifcopenshell.geom.settings()
    settings.set("use-world-coords", True)

    features = []
    for space in model.by_type("IfcSpace"):
        try:
            shape = ifcopenshell.geom.create_shape(settings, space)
        except RuntimeError:
            continue  # a room with no usable geometry
        verts = shape.geometry.verts
        faces = shape.geometry.faces
        triangles = []
        for i in range(0, len(faces), 3):
            pts = [(verts[3 * j] - site_x, verts[3 * j + 1] - site_y) for j in faces[i : i + 3]]
            tri = Polygon(pts)
            if tri.area > 1e-6:
                triangles.append(tri)
        if not triangles:
            continue
        footprint = unary_union(triangles).buffer(0)
        storey = storey_of(space)
        features.append({
            "type": "Feature",
            "properties": {
                "name": space.LongName or space.Name,
                "number": space.Name,
                "storey": storey.Name if storey else None,
                "level": level_of.get(storey.id()) if storey else None,
                "elevation": storey.Elevation if storey else None,
                "global_id": space.GlobalId,
            },
            "geometry": mapping(to_lnglat(footprint, origin)),
        })
    with open(dst, "w") as out:
        json.dump({"type": "FeatureCollection", "features": features}, out)
    print(f"{len(features)} rooms on {len(storeys)} storeys -> {dst}")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
```

Then add `rooms.geojson` with **Add Data → Vector Layer** and set it up as in [Floor plans with a level attribute](#floor-plans-with-a-level-attribute): **3D extrusion** with **Base property** `level`, a **Base scale** of the storey height and a **Floor height**, then `level` as the **Floor field**. With the KIT FZK-Haus sample model (`AC20-FZK-Haus.ifc`), this gives the six ground-floor rooms on level 0 and the gallery on level 1.

The placement assumes the model's x/y axes point east and north. A model whose site has a true north rotation, or that is georeferenced through `IfcMapConversion` instead, needs that transform applied first. Levels count the storeys of the whole file from the lowest up, so a file with several buildings whose storeys sit at different elevations numbers them together; export one building at a time if their floors should line up.

### Why there is no built-in IFC converter

A converter in the Python sidecar was considered and not added for now: IfcOpenShell is a large native dependency, IFC files are georeferenced in several inconsistent ways (or not at all), and the two published routes above (I3S Building Scene Layers and 3D Tiles) keep the full BIM structure that a quick in-app conversion would lose. This can be revisited if converting rooms in the app turns out to be a common need.
