# Object-Based Analysis

**Processing → Object-Based Analysis** opens a workbench for object-based
image analysis (OBIA): instead of classifying pixels one at a time, it groups
pixels into image objects (segments) and works with those. Objects carry
spectral, shape and texture measurements that pixels lack, which suits
high-resolution imagery where a single land-cover patch spans many pixels.

The workbench runs entirely in the browser on GeoLibre's WASM tool engine
(`geolibre-wasm`), so it needs no Python sidecar and works on the web build.
It opens as a panel in the right sidebar, beside the Style panel, so the map
stays clear while you work. It is not on the sidebar rail until you first open
it; after that its rail icon switches back to it, and closing it from its
header removes it from the rail. Closing and reopening it keeps the current
session.

## 1. Segment

1. Add a GeoTIFF or COG raster layer to the map, then open the workbench. It
   picks the first raster layer; choose another under **Image**.
2. Tick the **Bands** to segment on. Each band is standardized (z-scored)
   first, so a band with a larger value range does not dominate. Keep the
   original multispectral bands (for example red, green, blue and near-infrared)
   rather than a display rendering.
3. Set the parameters and click **Segment**.

| Parameter | Meaning |
| --- | --- |
| Similarity threshold | How far, in standardized band units, a pixel may differ from its region's seed and still join it. Larger values give fewer, larger objects. |
| Minimum object size (pixels) | Objects smaller than this merge into their most similar neighbor. |
| Seed steps | Pixels are seeded in this many groups, most homogeneous first, so regions grow out of uniform areas before edges. |

The result is a vector layer named `<image> objects` with one polygon per
object, outlined over the image. Each feature's `segment_id` property (also
its feature id) is the object's label, so the attribute table, selection and
the later workbench steps all refer to the same objects. Tick **Also add the
label raster to the map** to add the label raster itself.

### About the algorithm

The method is Whitebox's seeded region growing (`image_segmentation`). It is
not eCognition's multiresolution segmentation, so an eCognition scale
parameter does not carry over: tune the threshold and minimum size on your own
imagery. The Whitebox catalog's other segmentation tools (SLIC superpixels,
Felzenszwalb graph, marker watershed) are wrappers around this same region
growing with a remapped threshold, which is why the workbench offers it under
its real name.

### Limits

The workbench processes up to about 16.7 million pixels (4096 × 4096) per
image. Clip a larger scene to your area of interest first, for example with
**Processing → GeoLibre Toolbox → Raster → Clip by extent**.
