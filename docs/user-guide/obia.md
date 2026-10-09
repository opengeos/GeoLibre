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

Coming from eCognition? [Coming from eCognition](obia-ecognition.md) maps its
concepts and algorithms to the workbench.

## 1. Segment

1. Add a GeoTIFF or COG raster layer to the map, then open the workbench. It
   picks the first raster layer; choose another under **Image**.
2. Tick the **Bands** to segment on. Each band is standardized (z-scored)
   first, so a band with a larger value range does not dominate. Keep the
   original multispectral bands (for example red, green, blue and near-infrared)
   rather than a display rendering.
3. Choose the **Area**: the **Whole image**, or the part in the **Current map
   view**. The line under it says how many pixels a run reads, and at which
   resolution (see [Large images](#large-images)).
4. Set the parameters and click **Segment**.

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

### Native segmentation in the desktop app

The desktop app can also segment natively, in its processing server, with
scikit-image instead of the in-browser engine. Pick a native method under
**Method**:

| Method | Parameters |
| --- | --- |
| SLIC superpixels | **Object size (pixels)**: about how many pixels each object gets. **Compactness**: larger gives more regular, square objects; smaller follows the image more closely. |
| Felzenszwalb graph | **Scale**: larger gives larger objects. **Smoothing (sigma)**: Gaussian smoothing first. **Minimum object size (pixels)**: smaller objects merge into a neighbor. |

A native run reads the image from its file, so the image must have been added
from a local GeoTIFF (an image added by URL uses the browser engine). It reads
up to 120 million pixels with SLIC and 25 million with Felzenszwalb (whose
graph needs far more memory), the same way as the browser engine reads its area
(whole image or map view, from an overview when needed), and the Measure step
then measures in the processing server too, with the same feature names, so
labels, rules, classifiers, accuracy and export work the same. GLCM texture is
measured only in the browser. The first native run installs scikit-image into
the processing server, which takes a minute.

Native runs are repeatable: both methods are deterministic, so a reopened
project rebuilds the same objects.

On the 4-band, 9222 × 5089-pixel (47-million-pixel) Sentinel-2 sample, with
the default parameters (segmentation, then spectral, shape and neighbor
features):

| Engine | Objects | Segment | Measure | Peak memory |
| --- | --- | --- | --- | --- |
| Browser, region growing | 63,942 | 369 s | 208 s | 7.6 GB |
| Native, SLIC | 94,887 | 46 s | 33 s | 3.9 GB |
| Native, Felzenszwalb | 234,343 | 131 s | 36 s | 16.9 GB |

The browser figures are the engine run outside a browser on the whole scene,
which the workbench itself would read from an overview. These numbers compare
speed and memory only: comparing segmentation quality needs independent
reference objects and validation data (the eCognition pilot workflows of
[#3053](https://github.com/opengeos/GeoLibre/issues/3053)).

### Large images

A run reads at most about 16.8 million pixels (4096 × 4096). A larger image
still works:

- **Current map view** reads only the part of the image in view. Zoom in until
  the line under **Area** says *at full resolution*.
- When the area is over the limit at full resolution, the workbench reads it
  from the image's overviews instead, at the finest overview that fits (for
  example 20 m pixels for a 10 m Sentinel-2 scene). The objects are then
  coarser, and the line under **Area** says so. An image without overviews
  has to be zoomed into, or clipped first, for example with **Processing →
  GeoLibre Toolbox → Raster → Clip by extent**.

A COG added by URL is read with HTTP range requests: listing its bands reads
only its header, and a run fetches only the tiles of the area and overview it
reads, so a large remote scene is never downloaded in full.

The segmented area and overview are recorded with the run, so measuring,
exporting and a reloaded project all read exactly the same pixels, and
**Provenance** lists them. Exports are on the segmented area's grid.

The limit keeps a run within a browser tab's memory and a reasonable time. In
a benchmark of the engine on a 4-band Sentinel-2 scene, 16.8 million pixels
took about 2 minutes to segment and 1 minute to measure, while the whole
47-million-pixel scene took about 10 minutes and over 7 GB of memory.

### Import from other software

Under **Import from other software** (below the Segment step) the workbench
takes in what another OBIA tool, such as eCognition, exported. Add the vector
files to the map first; they then appear in the layer lists.

- **Objects**: a polygon layer becomes the objects, as if segmented. Its
  polygons are burned onto the image chosen under **Segment** (a pixel belongs
  to a polygon when its center is inside; the whole image is read, from an
  overview when it is over the pixel limit). The object ids come from a field
  holding distinct positive whole numbers (for example the exported object
  ids), or are numbered in order. Polygons covering no pixel center are left
  out, and the step says how many. The original attributes stay on the
  objects. After a reload the labels are rebuilt by burning the objects again.
- **Samples**: a point (or polygon, by its centroid) layer labels the objects
  under it, with the class in a field you choose and the role (training or
  validation) from a field or the role you choose. Classes it names that the
  workbench does not have yet are added.
- **Class list**: a JSON list of `{"name": ..., "color": "#rrggbb"}` (or
  `{"classes": [...]}`), or a CSV with `name` and `color` columns. Classes the
  workbench has take the file's colors; new ones are added.
- **Feature table**: a CSV with a `segment_id` column and one column per
  feature, such as exported object features. They join the measured features
  (replacing any of the same name), so rules and the classifier can use them.
- **Level mapping**: a CSV of `child_id,parent_id` rows (by those headers, or
  the first two columns) builds the level above the current one from the
  mapping instead of by merging; objects the mapping leaves out have no
  parent.

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

## 3. Levels

Objects can be grouped into coarser levels, as in an eCognition object
hierarchy: buildings, then blocks, then neighborhoods. **Build coarser level**
merges the current level's objects into a new level: neighbors merge, the most
alike first, until the next merge would raise an object's spread of band values
(its size-weighted standard deviation, in standardized band units, summed over
the bands) by more than scale². Larger scales give larger, more varied objects.
This is the color criterion of multiresolution segmentation, applied to whole
objects.

Each object of a coarser level is made of whole objects of the level below, so
the levels nest exactly. Each object of the level below records its parent in
`obia_parent`, and each object of the coarser level has a `child_count`. A
coarser level needs spectral statistics measured on the level it merges, and
its features are computed from that level: band statistics are pooled exactly
from the children's, and shape and neighbor features are measured on the
merged objects (GLCM texture is not carried up). Coarser levels are built in
the browser, from segmentations of up to 16.8 million pixels.

### Context features

**Add context features** adds features from each object's surroundings to the
level you work on, so rules and the classifier can use them:

| Field | Meaning |
| --- | --- |
| `nb_contrast_b<n>` | The object's band mean minus its neighbors', weighted by the length of the shared border |
| `parent_<feature>` | The parent's band means, indices, size and `child_count`, from the level above |
| `parent_is_<class>` | 1 when the parent is classified as the class, 0 otherwise (class inheritance as a feature) |
| `child_frac_<class>` | The share of the object's area in each class of the level below, once that level is classified |

Class names become part of the field name in lower case, with other characters
replaced by `_` (`parent_is_trees_shrubs` for "Trees, shrubs"). Adding context
features again replaces the earlier ones, so run it again after classifying
another level.

Under **Work on**, choose the level the later steps use: samples, the
classifier, accuracy and export belong to that level, and each level keeps its
own. Applying to other images uses level 1. A new segmentation starts a new
hierarchy, and measuring a level again drops the levels built on it; their
objects layers stay on the map, so remove them if you no longer need them.

## 4. Label samples

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
Each **Split** works on the training samples still left, so splitting again
moves a further share to validation.

Labels are stored on the objects themselves, in the `obia_class` and
`obia_sample` (`training` or `validation`) properties, so they are saved with
the project and visible in the attribute table.

## 5. Classify

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
- **Ruleset** runs a ruleset, as in eCognition: fuzzy class descriptions and a
  process tree, written as JSON (see [Rulesets](#rulesets)).
- **Inherit from level above** gives each object its parent's class, from the
  classified level above (see [Levels](#3-levels)). Classify a coarse level
  first, then inherit its classes down and refine them: with threshold rules on
  the context features (`parent_is_<class>`), for example "built-up objects
  inside a parent classified as water are boats".

The Whitebox catalog's "SVM" and "ensemble" object classifiers are the same
random forest with a different number of trees, so the workbench offers only
the random forest.

### Rulesets

A ruleset is a list of processes run in order. Each process acts on a
**domain**: the objects whose current class is one of `classes` (`""` is
unclassified; leave `classes` out for any class) and that meet every condition
in `conditions` (a feature, an operator `>`, `>=`, `<`, `<=`, `==` or `!=`, and
a value). There are three kinds of process:

- `assign` gives the domain's objects `className`.
- `fuzzy` classifies the domain's objects by fuzzy class descriptions. Each
  class combines membership functions with `and` (the minimum, the default),
  `or` (the maximum) or `mean`; an object takes the class with the highest
  membership if it reaches `minMembership` (0.1 by default), and is left as it
  is otherwise. A membership function reads one feature: `larger` rises from 0
  at `from` to 1 at `to`, `smaller` falls from 1 at `from` to 0 at `to`, and
  `about` peaks at 1 at `center` and falls to 0 at `width` away.
- `loop` repeats its own processes until a pass changes nothing (or
  `maxIterations`, 100 by default).

Besides the measured and context features, conditions and memberships can read
`nb_border_<class>`: the share of an object's border shared with neighbors
currently of that class, recomputed before each process. With it a loop can grow
a class outwards, ring by ring. For example, starting from unclassified
objects:

```json
{
  "processes": [
    {
      "kind": "fuzzy",
      "name": "spectral classes",
      "minMembership": 0.5,
      "classes": [
        { "className": "vegetation", "memberships": [{ "field": "ndvi", "type": "larger", "from": 0.1, "to": 0.4 }] },
        { "className": "built", "memberships": [{ "field": "ndvi", "type": "smaller", "from": -0.1, "to": 0.1 }] }
      ]
    },
    {
      "kind": "loop",
      "name": "grow vegetation",
      "processes": [
        {
          "kind": "assign",
          "domain": {
            "classes": [""],
            "conditions": [
              { "field": "nb_border_vegetation", "op": ">=", "value": 0.5 },
              { "field": "ndvi", "op": ">", "value": 0 }
            ]
          },
          "className": "vegetation"
        }
      ]
    }
  ]
}
```

**Insert example** writes this ruleset for your classes and features; **Open**
and **Save** read and write it as a file. The ruleset is checked as you type,
and the message names the first problem. Tick **Start from the current
classification** to refine an existing classification instead of starting from
unclassified objects. Objects still unclassified at the end get the default
class. After a run, a line per process says how many objects it changed (and,
for a loop, in how many passes). A ruleset reads only features and the object
graph, so **Apply to other images** runs it on them as it is.

## 6. Assess accuracy

After classifying, the workbench scores the predictions against the
validation samples, which the random forest never trained on. The score
updates as you relabel samples.

- **Overall accuracy**: the share of validation objects whose predicted class
  matches their label.
- **Kappa**: Cohen's kappa, agreement beyond what chance would give.
- **Area-weighted**: overall accuracy with each validation object weighted by
  its pixel area, since a large misclassified object misstates more of the map
  than a small one. It needs the shape features.
- The **confusion matrix** has the reference classes as rows and the
  predicted classes as columns, with each class's producer's accuracy (how
  much of the class was found) and user's accuracy (how reliable a prediction
  of the class is).

**Download report (CSV)** saves the matrix and the figures.

For an honest score, label validation samples spread across the scene rather
than next to training samples, and do not tune the classifier on them
repeatedly; otherwise they stop being independent.

## 7. Export

The objects layer is already the vector result: each object's
`obia_predicted` property holds its class, so its layer menu exports the
classification to GeoJSON, GeoPackage, Shapefile and the other vector formats
(and **Processing → GeoLibre Toolbox → Vector → Dissolve** merges objects by
class). The Export step also burns the classes onto the image's pixel grid:

- **Add classified raster** adds a color rendering in the class colors.
- **Save class codes (GeoTIFF)** saves a single-band Cloud-Optimized GeoTIFF of
  class codes on the segmented area's grid, in the source image's CRS, with 0
  as NoData. Codes follow the class list (the first class is 1), so a class
  keeps its code from run to run; a rules default class outside the list comes
  after.
- **Save legend (CSV)** saves the code, class name and color of each class.

## 8. Apply to other images

Once an image is classified, **Apply to other images** runs the same workflow
on other raster layers in the project: tick the images and click **Apply**.
Each image is segmented over its whole extent (from an overview when it is
over the pixel limit) with the same bands and parameters, measured with the
same features, and classified with the current classifier:

- **Rules** apply unchanged.
- **Random forest** is trained on this image's training samples and predicts
  the other image's objects, so the other images must have the same bands in
  the same order (the same sensor and processing level), or the forest sees
  different values than it learned from.
  It uses the training samples as they are when you click **Apply** and the
  features the last Classify run used, so classify again after changing
  samples if you want the batch to match the displayed classification.

Each image gets its own objects layer, colored by class, and a line under the
step lists its object and class counts. Labels, accuracy and export stay with
the first image.

## Progress and cancelling

While a step runs, the line under its button shows the tool running and the
elapsed time. **Cancel** stops it: the running tool is stopped at once and the
step leaves its earlier results as they were. Cancelling a batch keeps the
images it already finished.

## Saving and provenance

The workbench is saved with the project. Reopening a project restores the
image and band choices, the parameters, the classes and the classifier
settings, and the results of each step: the objects layer keeps its measured
features, labels and predicted classes, so the attribute table, the accuracy
assessment and the export pick up where you left off. The object hierarchy is saved too:
each level, with its own samples and classification, and the level you were
working on. A coarser level's label raster is rebuilt from the level below and
its objects' `obia_parent` links.

Expand **Provenance** at the bottom of the workbench to see how the current
results were made:

- the image (layer name, and its file path or URL when it has one), its size
  and the bands used;
- for each step, when it ran, the exact tool calls with their arguments, and
  the `geolibre-wasm` engine and GeoLibre versions (for a coarser level, which
  level it merged and at what scale);
- each hold-out split's share, seed and the number of samples it moved;
- for the random forest, the number of trees, features and training samples
  (the engine fixes the forest's random seed);
- for each image the workflow was applied to, its tool calls and versions.

**Copy as JSON** copies this record, the same one the project stores in its
`obia` field (see the [project format](../project-format.md)).

The project does not store the label raster, which can be large. When a step
needs it after a reload (measuring again, or exporting), the workbench re-runs
the recorded segmentation on the source image; segmentation is deterministic,
and the workbench checks the rebuilt labels against a fingerprint saved with
the segmentation (the object count and a hash of every pixel's label) before
using them. If the image was removed from the project or no longer gives the same
objects, the step says so: segment again. An image added from a local file in
the web app is not saved with the project, so add imagery by URL (or use the
desktop app) when you want to rerun steps after reopening.
