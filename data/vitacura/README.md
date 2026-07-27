# Vitacura 3D Model

Detailed 3D geospatial model of Vitacura commune (Santiago, Chile) generated with synthetic data.

## Overview

This dataset contains **955 geofeatures** representing the urban layout of Vitacura:

- **🏢 764 Buildings**: Multi-story buildings (low-rise, mid-rise, high-rise) with elevation and height data
- **🛣️ 150 Roads**: Street network including arterial roads and secondary streets
- **🌳 25 Parks**: Green spaces and nature reserves with realistic distribution
- **💧 16 Water Features**: Streams, ponds, and water bodies

## Files

```
data/vitacura/
├── vitacura_3d_complete.geojson       # Complete model (all features)
├── vitacura_buildings.geojson         # Building footprints with heights
├── vitacura_roads.geojson            # Street network
├── vitacura_parks.geojson            # Parks and green spaces
└── vitacura_water.geojson            # Water features
```

## GeoJSON Structure

Each feature includes 3D coordinates (lon, lat, elevation) and properties:

```json
{
  "type": "Feature",
  "geometry": {
    "type": "Polygon|LineString",
    "coordinates": [[[lon, lat, elevation], ...]]
  },
  "properties": {
    "height": 25.5,           // Building/feature height in meters
    "elevation": 570.2,       // Ground elevation in meters
    "category": "mid-rise",   // Building category
    "building_type": "residential"
  }
}
```

## Using in GeoLibre

### 1. Load in Desktop App

```bash
npm run tauri:dev
# Then drag/drop or File → Add Data → vitacura_3d_complete.geojson
```

### 2. 3D Visualization with deck.gl

GeoLibre automatically renders 3D layers when:
- Geometries have elevation in coordinates `[lon, lat, elevation]`
- Features include `height` property for extrusion

### 3. Styling Options

Layer rendering by type:

```javascript
// Buildings - colored by height/category
// Parks - green fill
// Water - blue fill
// Roads - line renderer with width property
```

## Technical Details

- **Coordinate System**: WGS84 (EPSG:4326)
- **Bounds**: 
  - West: -70.586°, East: -70.518°
  - South: -33.415°, North: -33.374°
- **Base Elevation**: ~570m (Santiago baseline)
- **Elevation Variation**: ±100m (realistic topography)

## Data Generation

Generated using the script: `scripts/vitacura_3d_model.py`

```bash
python3 scripts/vitacura_3d_model.py
```

To regenerate or modify:
- Edit building counts in `generate_buildings()`
- Adjust road network in `generate_roads()`
- Modify park distribution in `generate_parks()`

## Future Enhancements

- [ ] DEM integration for realistic topography
- [ ] Real OSM data import (buildings, roads, POIs)
- [ ] Building height inference from property data
- [ ] Satellite imagery base layer
- [ ] Urban analysis metrics (density, green space %)
- [ ] 3D terrain mesh generation

## Example Use Cases

1. **Urban Planning**: Visualize development density and green space distribution
2. **3D GIS Analysis**: Perform height-based queries and volume calculations
3. **City Visualization**: Create 3D tour presentations
4. **Data Import**: Test GeoLibre's 3D capabilities with real-like data
5. **Cartography**: Design maps with elevation context

## License

Generated data for demonstration and educational purposes.
