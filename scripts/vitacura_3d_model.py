#!/usr/bin/env python3
"""
Generate a detailed 3D model of Vitacura commune with synthetic realistic data
Based on Vitacura's actual geography and urban layout
"""

import json
from pathlib import Path
from random import choice, gauss, randint, uniform

import numpy as np

OUTPUT_DIR = Path(__file__).parent.parent / "data" / "vitacura"
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

# Vitacura bounds (Santiago, Chile)
WEST, SOUTH, EAST, NORTH = -70.586, -33.415, -70.518, -33.374
CENTER_LAT = (SOUTH + NORTH) / 2
CENTER_LON = (WEST + EAST) / 2

# Elevation data (Santiago is ~570m, Vitacura varies 500-700m due to terrain)
BASE_ELEVATION = 570
ELEVATION_VARIATION = 100


def random_point():
    """Generate random point within Vitacura bounds"""
    return (uniform(WEST, EAST), uniform(SOUTH, NORTH))


def generate_buildings(count=800):
    """Generate realistic building footprints with heights"""
    features = []

    # High-rise buildings (downtown core)
    downtown_buildings = randint(30, 50)
    for _ in range(downtown_buildings):
        lon = uniform(CENTER_LON - 0.02, CENTER_LON + 0.01)
        lat = uniform(CENTER_LAT - 0.01, CENTER_LAT + 0.005)

        size = uniform(0.0003, 0.0008)
        height = uniform(30, 80)  # 30-80m
        elevation = BASE_ELEVATION + gauss(0, 20)

        coords = [
            [lon - size, lat - size, elevation],
            [lon + size, lat - size, elevation],
            [lon + size, lat + size, elevation],
            [lon - size, lat + size, elevation],
            [lon - size, lat - size, elevation],
        ]

        features.append(
            {
                "type": "Feature",
                "geometry": {"type": "Polygon", "coordinates": [coords]},
                "properties": {
                    "building": "yes",
                    "height": float(height),
                    "elevation": float(elevation),
                    "category": "high-rise",
                    "building_type": choice(["residential", "commercial", "office"]),
                },
            }
        )

    # Mid-rise buildings
    mid_buildings = randint(200, 300)
    for _ in range(mid_buildings):
        lon, lat = random_point()
        size = uniform(0.0002, 0.0005)
        height = uniform(10, 25)
        elevation = BASE_ELEVATION + gauss(0, 20)

        coords = [
            [lon - size, lat - size, elevation],
            [lon + size, lat - size, elevation],
            [lon + size, lat + size, elevation],
            [lon - size, lat + size, elevation],
            [lon - size, lat - size, elevation],
        ]

        features.append(
            {
                "type": "Feature",
                "geometry": {"type": "Polygon", "coordinates": [coords]},
                "properties": {
                    "building": "yes",
                    "height": float(height),
                    "elevation": float(elevation),
                    "category": "mid-rise",
                    "building_type": choice(["residential", "commercial"]),
                },
            }
        )

    # Low-rise buildings (houses)
    low_buildings = randint(400, 600)
    for _ in range(low_buildings):
        lon, lat = random_point()
        size = uniform(0.00008, 0.0002)
        height = uniform(5, 15)
        elevation = BASE_ELEVATION + gauss(0, 20)

        coords = [
            [lon - size, lat - size, elevation],
            [lon + size, lat - size, elevation],
            [lon + size, lat + size, elevation],
            [lon - size, lat + size, elevation],
            [lon - size, lat - size, elevation],
        ]

        features.append(
            {
                "type": "Feature",
                "geometry": {"type": "Polygon", "coordinates": [coords]},
                "properties": {
                    "building": "yes",
                    "height": float(height),
                    "elevation": float(elevation),
                    "category": "low-rise",
                    "building_type": "residential",
                },
            }
        )

    return features


def generate_roads(count=150):
    """Generate road network"""
    features = []

    # Main arterial roads (Av. Vitacura, Av. Escuela Militar, etc.)
    main_roads = [
        {
            "name": "Av. Vitacura",
            "start": (CENTER_LON - 0.04, CENTER_LAT - 0.02),
            "end": (CENTER_LON + 0.03, CENTER_LAT + 0.02),
            "width": 0.00015,
            "type": "primary",
        },
        {
            "name": "Av. Escuela Militar",
            "start": (CENTER_LON - 0.03, CENTER_LAT - 0.03),
            "end": (CENTER_LON + 0.01, CENTER_LAT + 0.015),
            "width": 0.00012,
            "type": "primary",
        },
        {
            "name": "Av. Nueva Constitución",
            "start": (CENTER_LON - 0.04, CENTER_LAT + 0.02),
            "end": (CENTER_LON + 0.02, CENTER_LAT - 0.01),
            "width": 0.0001,
            "type": "secondary",
        },
    ]

    for road in main_roads:
        start_lon, start_lat = road["start"]
        end_lon, end_lat = road["end"]

        # Create road with some curves
        coords = []
        steps = randint(15, 25)
        for i in range(steps):
            t = i / steps
            # Add some curve
            curve = 0.0002 * np.sin(t * np.pi * 2)
            lon = start_lon + (end_lon - start_lon) * t + curve
            lat = start_lat + (end_lat - start_lat) * t + curve
            elevation = BASE_ELEVATION + gauss(0, 15)
            coords.append([lon, lat, elevation])

        features.append(
            {
                "type": "Feature",
                "geometry": {"type": "LineString", "coordinates": coords},
                "properties": {
                    "name": road["name"],
                    "highway": road["type"],
                    "width": float(road["width"]),
                    "lanes": randint(2, 4),
                    "elevation": float(BASE_ELEVATION),
                },
            }
        )

    # Secondary streets
    for _ in range(count - len(main_roads)):
        start_lon, start_lat = random_point()
        end_lon = start_lon + uniform(-0.01, 0.01)
        end_lat = start_lat + uniform(-0.01, 0.01)

        coords = [
            [start_lon, start_lat, BASE_ELEVATION + gauss(0, 15)],
            [end_lon, end_lat, BASE_ELEVATION + gauss(0, 15)],
        ]

        features.append(
            {
                "type": "Feature",
                "geometry": {"type": "LineString", "coordinates": coords},
                "properties": {
                    "highway": choice(["residential", "tertiary"]),
                    "width": uniform(0.00005, 0.0001),
                    "lanes": randint(1, 2),
                    "elevation": float(BASE_ELEVATION),
                },
            }
        )

    return features


def generate_parks(count=25):
    """Generate parks and green spaces"""
    features = []

    # Major parks
    major_parks = [
        {
            "name": "Parque Araucano",
            "center": (CENTER_LON - 0.015, CENTER_LAT - 0.005),
            "size": 0.002,
        },
        {
            "name": "Parque Bicentenario",
            "center": (CENTER_LON + 0.01, CENTER_LAT + 0.01),
            "size": 0.0025,
        },
    ]

    for park in major_parks:
        center_lon, center_lat = park["center"]
        size = park["size"]

        # Create park as polygon
        coords = []
        steps = 20
        for i in range(steps + 1):
            angle = (i / steps) * 2 * np.pi
            lon = center_lon + size * np.cos(angle)
            lat = center_lat + size * np.sin(angle)
            elevation = BASE_ELEVATION + gauss(0, 10)
            coords.append([lon, lat, elevation])

        features.append(
            {
                "type": "Feature",
                "geometry": {"type": "Polygon", "coordinates": [coords]},
                "properties": {
                    "name": park["name"],
                    "leisure": "park",
                    "elevation": float(BASE_ELEVATION),
                    "area": float(size**2),
                    "vegetation": "mixed",
                },
            }
        )

    # Small neighborhood parks
    for _ in range(count - len(major_parks)):
        center_lon, center_lat = random_point()
        size = uniform(0.0005, 0.001)

        coords = []
        steps = 12
        for i in range(steps + 1):
            angle = (i / steps) * 2 * np.pi
            lon = center_lon + size * np.cos(angle)
            lat = center_lat + size * np.sin(angle)
            elevation = BASE_ELEVATION + gauss(0, 10)
            coords.append([lon, lat, elevation])

        features.append(
            {
                "type": "Feature",
                "geometry": {"type": "Polygon", "coordinates": [coords]},
                "properties": {
                    "leisure": "park",
                    "elevation": float(BASE_ELEVATION),
                    "area": float(size**2),
                },
            }
        )

    return features


def generate_water_features(count=15):
    """Generate water features (small lakes, ponds, streams)"""
    features = []

    # Rivers/streams
    for _ in range(randint(3, 5)):
        start_lon, start_lat = random_point()
        coords = []

        for step in range(randint(20, 40)):
            t = step / 30
            lon = start_lon + uniform(-0.01, 0.01) * t
            lat = start_lat + uniform(-0.01, 0.01) * t
            elevation = BASE_ELEVATION + gauss(0, 5)
            coords.append([lon, lat, elevation])

        features.append(
            {
                "type": "Feature",
                "geometry": {"type": "LineString", "coordinates": coords},
                "properties": {
                    "waterway": "stream",
                    "width": uniform(0.00001, 0.00005),
                    "elevation": float(BASE_ELEVATION),
                },
            }
        )

    # Ponds and small lakes
    for _ in range(count - 3):
        center_lon, center_lat = random_point()
        size = uniform(0.0002, 0.0008)

        coords = []
        steps = 16
        for i in range(steps + 1):
            angle = (i / steps) * 2 * np.pi
            lon = center_lon + size * np.cos(angle)
            lat = center_lat + size * np.sin(angle)
            elevation = BASE_ELEVATION + gauss(0, 5)
            coords.append([lon, lat, elevation])

        features.append(
            {
                "type": "Feature",
                "geometry": {"type": "Polygon", "coordinates": [coords]},
                "properties": {
                    "natural": "water",
                    "water": "pond",
                    "elevation": float(BASE_ELEVATION),
                },
            }
        )

    return features


def main():
    print("🏔️ Generating 3D model of Vitacura commune...\n")

    all_features = []

    # Generate buildings
    print("🏢 Generating buildings...", end=" ", flush=True)
    buildings = generate_buildings()
    print(f"✓ {len(buildings)} buildings")
    all_features.extend(buildings)

    with open(OUTPUT_DIR / "vitacura_buildings.geojson", "w") as f:
        json.dump({"type": "FeatureCollection", "features": buildings}, f)

    # Generate roads
    print("🛣️  Generating roads...", end=" ", flush=True)
    roads = generate_roads()
    print(f"✓ {len(roads)} roads")
    all_features.extend(roads)

    with open(OUTPUT_DIR / "vitacura_roads.geojson", "w") as f:
        json.dump({"type": "FeatureCollection", "features": roads}, f)

    # Generate parks
    print("🌳 Generating parks...", end=" ", flush=True)
    parks = generate_parks()
    print(f"✓ {len(parks)} parks")
    all_features.extend(parks)

    with open(OUTPUT_DIR / "vitacura_parks.geojson", "w") as f:
        json.dump({"type": "FeatureCollection", "features": parks}, f)

    # Generate water features
    print("💧 Generating water features...", end=" ", flush=True)
    water = generate_water_features()
    print(f"✓ {len(water)} water features")
    all_features.extend(water)

    with open(OUTPUT_DIR / "vitacura_water.geojson", "w") as f:
        json.dump({"type": "FeatureCollection", "features": water}, f)

    # Save combined 3D model
    combined = {"type": "FeatureCollection", "features": all_features}

    with open(OUTPUT_DIR / "vitacura_3d_complete.geojson", "w") as f:
        json.dump(combined, f)

    print(f"\n✅ Complete! Generated {len(all_features)} features\n")
    print(f"📁 Files saved to: {OUTPUT_DIR}\n")
    print("Generated files:")
    for f in sorted(OUTPUT_DIR.glob("*.geojson")):
        size = f.stat().st_size / 1024
        with open(f) as fp:
            features = len(json.load(fp).get("features", []))
        print(f"  ✓ {f.name}: {features} features ({size:.1f} KB)")


if __name__ == "__main__":
    main()
