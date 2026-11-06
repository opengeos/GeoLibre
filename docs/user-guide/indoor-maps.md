# Indoor Maps and BIM

GeoLibre can show the inside of a building in 3D: floor plans stacked by level, one floor at a time, and full BIM models. This page ties the pieces together and shows how to bring each kind of indoor data in.

## Floor plans with a level attribute

Rooms, corridors and doors from OpenStreetMap indoor mapping, a GeoPackage, a Shapefile or GeoJSON usually carry the floor each feature is on (`level`, `floor`, `ordinal`, ...).

1. **Stack the floors.** In the Style panel, turn on **3D extrusion**, set **Base property** to the level field and **Base scale** to the storey height (for example 3.5 m), and give every feature a **Floor height** (for example 3 m). See [Stacking floors](styling.md#vector-styling).
2. **Pick a floor.** In the Style panel's **Floor picker** section, choose the **Floor field**. A **Floor** control appears on the map: click a floor to draw only that floor, or add **+ below** to keep the floors under it. See [Floor picker](styling.md#floor-picker).

**Add Data → Vector Layer → Load sample data → Berlin Hbf indoor (OSM)** is a ready-made example with three floors.

## IMDF venues

An IMDF archive (Indoor Mapping Data Format, the zip of GeoJSON files that Apple Maps and many indoor-mapping tools export) opens as a ready-made venue: one layer per feature type, the floors stacked and linked to the floor picker. Pick or drop the `.zip`, or load it by URL in the Add Vector panel. **Load sample data → Dinoseum indoor venue (IMDF)** opens Apple's IMDF sample. See [Adding data](adding-data.md).

## BIM models as I3S Building Scene Layers

An ArcGIS I3S **Building Scene Layer** is a BIM model published as a scene service. Add its `.../SceneServer/layers/<n>` URL with **Add Data → 3D Tiles Layer**. It opens on its Overview (the building shell); the Style panel's **Building** section switches to the **Full model** and turns its disciplines (Architectural, Structural, Electrical, ...) and categories (Walls, Windows, Doors, ...) on and off. The choice is saved with the project. Scene layers have to be in WGS84 to draw on the 2D map.

## IFC files

GeoLibre has no IFC reader of its own. Convert the model with one of these routes, depending on what you need:

| You want | Route |
| --- | --- |
| The full BIM model, by discipline and category | Publish it as an I3S Building Scene Layer (for example with ArcGIS Pro's BIM file workspace and scene layer tools), then add the scene service URL as above. |
| A 3D Tiles tileset | Upload the IFC to Cesium ion, which tiles it as 3D Tiles, and add it with **Add Data → Cesium Ion Asset** on the Cesium engine. |
| Rooms as floor plans you can style, filter and pick floors on | Export the rooms (`IfcSpace`) as GeoJSON with a `level` field, with the script below, and add the GeoJSON as a vector layer. |

### Rooms to GeoJSON with IfcOpenShell

The script below reads every room (`IfcSpace`), takes its footprint from the IFC geometry, places it from the site's reference latitude and longitude (`IfcSite.RefLatitude` / `RefLongitude`), and writes `level` (0 for the lowest storey), `storey`, `elevation`, `name` and `number`. It needs `pip install ifcopenshell shapely`.

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
from shapely.geometry import MultiPolygon, Polygon, mapping
from shapely.ops import unary_union


def dms(angle):
    """IFC compound angle (deg, min, sec, millionths) to decimal degrees."""
    sign = -1 if any(v < 0 for v in angle) else 1
    d, m, s, *rest = (abs(v) for v in angle)
    return sign * (d + m / 60 + (s + (rest[0] if rest else 0) / 1e6) / 3600)


def main(src, dst):
    model = ifcopenshell.open(src)
    site = model.by_type("IfcSite")[0]
    lat0, lon0 = dms(site.RefLatitude), dms(site.RefLongitude)
    # Metres east/north to degrees, around the site's reference point.
    m_per_deg_lat = 111_132.954
    m_per_deg_lon = 111_319.488 * math.cos(math.radians(lat0))

    storeys = sorted(model.by_type("IfcBuildingStorey"), key=lambda s: s.Elevation or 0)
    level_of = {storey.id(): index for index, storey in enumerate(storeys)}
    settings = ifcopenshell.geom.settings()
    settings.set("use-world-coords", True)

    features = []
    for space in model.by_type("IfcSpace"):
        shape = ifcopenshell.geom.create_shape(settings, space)
        verts = shape.geometry.verts
        faces = shape.geometry.faces
        triangles = []
        for i in range(0, len(faces), 3):
            pts = [(verts[3 * j], verts[3 * j + 1]) for j in faces[i : i + 3]]
            tri = Polygon(pts)
            if tri.area > 1e-6:
                triangles.append(tri)
        footprint = unary_union(triangles).buffer(0)
        # Rooms are usually aggregated into their storey (IfcRelAggregates),
        # sometimes contained in it (IfcRelContainedInSpatialStructure).
        storey = ifcopenshell.util.element.get_aggregate(space) or ifcopenshell.util.element.get_container(space)
        if storey is not None and not storey.is_a("IfcBuildingStorey"):
            storey = None
        def to_lnglat(geom):
            def ring(coords):
                return [(lon0 + x / m_per_deg_lon, lat0 + y / m_per_deg_lat) for x, y in coords]
            polys = geom.geoms if isinstance(geom, MultiPolygon) else [geom]
            out = [Polygon(ring(p.exterior.coords), [ring(r.coords) for r in p.interiors]) for p in polys]
            return out[0] if len(out) == 1 else MultiPolygon(out)
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
            "geometry": mapping(to_lnglat(footprint)),
        })
    with open(dst, "w") as out:
        json.dump({"type": "FeatureCollection", "features": features}, out)
    print(f"{len(features)} rooms on {len(storeys)} storeys -> {dst}")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
```

Then add `rooms.geojson` with **Add Data → Vector Layer**, stack the floors with **Base property** `level`, and choose `level` as the **Floor field**. With the KIT FZK-Haus sample model (`AC20-FZK-Haus.ifc`), this gives the six ground-floor rooms on level 0 and the gallery on level 1.

The placement assumes the model's x/y axes point east and north. A model whose site has a true north rotation, or that is georeferenced through `IfcMapConversion` instead, needs that transform applied first.

### Why there is no built-in IFC converter

A converter in the Python sidecar was considered and not added for now: IfcOpenShell is a large native dependency, IFC files are georeferenced in several inconsistent ways (or not at all), and the two published routes above (I3S Building Scene Layers and 3D Tiles) keep the full BIM structure that a quick in-app conversion would lose. This can be revisited if converting rooms in the app turns out to be a common need.
