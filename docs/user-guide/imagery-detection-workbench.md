# Imagery Detection Workbench

The **Imagery Detection Workbench** turns raster imagery loaded in GeoLibre into reviewed,
sensor-aware vessel annotations. It is the first stage of the maritime model-training workflow:
load imagery, draw oriented boxes, classify detections, and export a training-data ledger.

## Start an annotation session

1. Add a raster, COG, WMS, WMTS, XYZ, or image layer to the map.
2. Enable **Imagery Detection Workbench** from the Plugins menu.
3. Select the imagery layer in the workbench.
4. Review the metadata GeoLibre auto-fills from the layer and its STAC item. Correct it if needed.
5. Create the 6 × 6 coverage grid and review the scene in order instead of roaming the image.
6. Press **B** (or click **Draw vessel box**), then drag along the vessel's long axis.
7. Press a home-row class key to save the classification.

When supplied by the source, the workbench fills platform/sensor, modality, acquisition time,
ground sample distance, bands/assets, processing level, pixel dimensions, and bounds. STAC layers
from Planetary Computer and STAC Search preserve these fields when they enter the GeoLibre store.

## Discover candidates with SAM

For COG and STAC imagery, zoom the map to the area you want to inspect and click
**Analyze visible imagery**. GeoLibre retrieves only that area from the selected source asset—no
second file selection is required. The workbench downloads and caches the approximately 39 MB
SlimSAM model on first use, then performs inference locally in the browser. Each surviving mask becomes an oriented, unreviewed proposal, and the
proposal queue zooms directly to each object for classification. SAM is classless, so waves,
wakes, docks, cloud edges, and land features may appear and should be marked **Not a vessel** (`;`).

SAM runs over overlapping 896-pixel tiles with a 128-pixel overlap. The model sessions are loaded
once for the batch, and overlapping proposals are merged afterward. This preserves small targets
better than shrinking the entire AOI into one model input and avoids losing vessels at tile edges.

For Sentinel-2, **Use Sentinel-2 SCL water/coastal mask** is enabled by default. When the matching
Scene Classification Layer is accessible, the workbench rejects confident inland land, cloud,
cloud-shadow, cirrus, snow, saturated, and no-data candidates. Water is retained, as is an
approximately 100-metre coastal margin for ports, piers, canals, and near-shore vessels. The mask
is advisory: it can be disabled, and if SCL cannot be retrieved the run continues without it.

Rendered services such as WMS or XYZ may not expose their original source pixels. For those layers,
**Choose local GeoTIFF** remains available as a fallback. After reviewing the proposals, use the
coverage grid to inspect for objects SAM missed.

Annotations are stored in the ordinary GeoJSON layer named **Imagery vessel annotations**,
so they persist in the GeoLibre project. The imagery metadata used for a detection is copied
onto the feature at creation time; later changes to the source layer do not silently rewrite
the training provenance.

## Classification keys

| Key | Class                         |
| --- | ----------------------------- |
| `A` | Cargo                         |
| `S` | Tanker                        |
| `D` | Fishing                       |
| `F` | Passenger                     |
| `G` | Working vessel                |
| `H` | Military / law enforcement    |
| `J` | Small boat                    |
| `K` | Sailboat                      |
| `L` | Unknown vessel                |
| `;` | Not a vessel / false positive |

Other shortcuts:

| Key             | Action                                                                             |
| --------------- | ---------------------------------------------------------------------------------- |
| `B`             | Draw an oriented vessel box                                                        |
| `Q` / `E`       | Previous / next review chip (or detection before a grid is created)                |
| `Space`         | Mark the current chip reviewed and advance                                         |
| `W`             | Skip the current chip and advance (or skip the detection before a grid is created) |
| `Z`             | Undo the last edit                                                                 |
| `Shift` + class | Classify without advancing                                                         |
| `Esc`           | Cancel drawing                                                                     |

Workbench shortcuts are active only while its panel is open and do not fire while typing in a
form field.

## Exports

- **GeoJSON** is the geospatial master annotation layer.
- **Manifest CSV** records source-scene provenance and annotation counts.
- **Annotations CSV** is a flat review ledger with one row per detection.
- **COCO JSON** contains accepted vessel boxes and polygon segmentations in source-pixel space.
- **YOLO OBB** contains normalized four-corner oriented boxes for accepted vessels.

COCO and YOLO exports require known geographic bounds plus the original image width and height.
The current pixel conversion assumes a north-up image spanning those bounds. Use GeoJSON for
rotated or otherwise transformed rasters until the workbench gains full affine-transform export.

The first version references the source image URI in its manifest. It does not yet cut or package
the source pixels into image chips. A later chip service will read local/fetchable GeoTIFF or COG
pixels, preserve their checksums and preprocessing recipes, and refuse sources whose access terms
do not permit local retention.

## Current scope

This version is for systematic manual dataset creation. Coverage progress currently lasts for the
open workbench session; annotations themselves persist in the project. Automatic model proposals, SAM mask refinement,
chip generation, AIS matching, collaborative review, and model training are planned additions.
It accepts multiple imagery types, but the annotation interface being sensor-agnostic does not
make a trained model sensor-agnostic: model compatibility and evaluation must remain sensor-aware.
