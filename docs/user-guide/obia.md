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

## 2. Measure

Once objects exist, **Measure** computes per-object features on the original
bands (not a display rendering) and writes them onto the objects layer. Open
the layer's attribute table to explore them, or style the layer by any of them.
Measuring again replaces the earlier values but keeps other properties, such as
training labels.

| Group | Fields |
| --- | --- |
| Spectral statistics | `mean_b<n>`, `std_b<n>`, `min_b<n>`, `max_b<n>` for each segmented band `n` (numbered as in the source image) |
| Spectral indices | `brightness` (mean of the band means), `ndvi` from the red and near-infrared bands, `ndwi` (McFeeters) from the green and near-infrared bands. Pick which bands play each role; a 4-band image defaults to red = 1, green = 2, near-infrared = 4. |
| Shape | `area_px`, `perimeter_px`, `compactness`, `bbox_width_px`, `bbox_height_px`, `elongation` |
| GLCM texture | `glcm_contrast_b<n>`, `glcm_homogeneity_b<n>`, `glcm_energy_b<n>`, `glcm_entropy_b<n>` on the chosen band. Objects too small to form a pixel pair get no value. |
| Neighborhood | `neighbor_count`, `shared_boundary_total`, `mean_shared_boundary` |

Segmenting again starts a new set of objects, so measure them again before
training a classifier.

## 3. Label samples

Classification needs examples. Add a class for each land cover with **Add
class**, then name it and pick its color. To label objects:

1. Select objects on the objects layer with any of GeoLibre's selection tools:
   the map selection tools, rows in the attribute table, or **Edit → Select by
   Expression...** (for example `[">", ["get", "ndvi"], 0.2]` to pick
   vegetated objects once they are measured).
2. Choose whether new labels are **Training** or **Validation** samples.
3. Click the tag button on a class. The objects fill in the class color, and
   the class row counts its training / validation samples.

**Clear labels of selected** removes labels from the selection. Removing a
class removes its labels too, and renaming a class relabels its objects.

Accuracy assessment needs validation samples the classifier never trained on.
Label them separately, or **Split** to move a share of each class's training
samples (rounded, at least one per class) to validation. The split is
stratified by class and reproducible: the same seed picks the same samples.

Labels are stored on the objects themselves, in the `obia_class` and
`obia_sample` (`training` or `validation`) properties, so they are saved with
the project and visible in the attribute table.

## 4. Classify

Once objects are measured, **Classify** predicts a class for every object and
writes it to the `obia_predicted` property; the layer is then filled by
predicted class in the class colors.

- **Random forest** trains on the training samples (validation samples are left
  out) using the ticked features, all of them by default. The engine
  (`classify_objects_random_forest`) fixes its random seed, so the same inputs
  always give the same classification. Objects missing a feature value (GLCM
  texture of a tiny object, for example) get the feature's mean, and the step
  says which features that affected.
- **Threshold rules** assign classes without training: each rule compares one
  feature with a value, and an object takes the class of the first rule it
  matches, top to bottom. Objects matching no rule get the default class
  (shown in gray). Order the rules from most to least specific.

The Whitebox catalog's "SVM" and "ensemble" object classifiers are the same
random forest with a different number of trees, so the workbench offers only
the random forest.

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
