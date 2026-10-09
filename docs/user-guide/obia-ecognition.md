# Coming from eCognition

This page maps eCognition concepts and algorithms to the
[Object-Based Analysis](obia.md) workbench, so you can tell which parts of an
eCognition land-cover workflow carry over, which need rework, and which are not
available. The workbench reads the classification part of eCognition rule
sets (`.dcp`) and projects (`.dpr`), see
[Importing a rule set](#importing-a-rule-set); the rest is translated by hand
with the tables below, and results come over with
[Import from other software](obia.md#import-from-other-software).

Legend: **Yes** works the same way; **Partly** is available with the
differences noted; **No** is not available.

## Image objects and the hierarchy

| eCognition | Workbench | |
| --- | --- | --- |
| Image object level | [Levels](obia.md#3-levels) | **Yes** |
| Multiresolution segmentation (first level) | Seeded region growing, SLIC or Felzenszwalb | **Partly**: different algorithms, so a scale parameter does not carry over; tune on your imagery |
| Multiresolution segmentation (level above) | **Build coarser level** | **Partly**: the same color heterogeneity criterion on whole objects, best-first; no shape criterion (compactness/smoothness weights) |
| Chessboard / quadtree segmentation | None | **No** |
| Spectral difference segmentation | **Build coarser level** with a small scale | **Partly**: merges by heterogeneity increase, not by mean difference |
| Super-objects contain sub-objects | Every coarser level is a union of whole children (`obia_parent`, `child_count`) | **Yes** |
| Merge region (by class) | None (merging is by heterogeneity only) | **No** |
| Split, grow, shrink, morphology on objects | None | **No** |
| Level created from exported objects | Import objects, then a level mapping | **Yes** |

## Features

| eCognition | Workbench field | |
| --- | --- | --- |
| Layer mean, standard deviation, min, max | `mean_b<n>`, `std_b<n>`, `min_b<n>`, `max_b<n>` | **Yes** |
| Brightness | `brightness` (mean of the band means) | **Partly**: unweighted |
| Customized arithmetic features (indices) | `ndvi`, `ndwi`; or import a feature table | **Partly** |
| Area, border length | `area_px`, `perimeter_px` (pixels and pixel edges) | **Yes**, in pixel units |
| Compactness, roundness, shape index | `compactness` (4π·area/perimeter²) | **Partly**: one shape measure of that family |
| Length/width, asymmetry | `elongation` (bounding box), `bbox_width_px`, `bbox_height_px` | **Partly** |
| GLCM homogeneity, contrast, entropy | `glcm_contrast_b<n>`, `glcm_homogeneity_b<n>`, `glcm_energy_b<n>`, `glcm_entropy_b<n>` | **Partly**: one symmetric GLCM per object on one band, distance 1, horizontal and vertical pairs pooled (browser engine only) |
| Number of neighbors, border to neighbors | `neighbor_count`, `shared_boundary_total`, `mean_shared_boundary` | **Yes** |
| Mean difference to neighbors | `nb_contrast_b<n>` (border-weighted) | **Yes** |
| Relative border to class | `nb_border_<class>` (in rulesets; the class name as a field-safe suffix) | **Yes** |
| Super-object features | `parent_<feature>` | **Yes** for band means, indices and size |
| Existence of super-object of class | `parent_is_<class>` | **Yes** |
| Sub-object features (number, relative area of class) | `child_count`, `child_frac_<class>` | **Yes** |
| Distance to class, thematic layer features | None | **No** |

## Classification and rulesets

| eCognition | Workbench | |
| --- | --- | --- |
| Nearest neighbor / standard NN | Random forest | **Partly**: a different classifier on the same samples |
| Random trees, SVM, decision tree (classifier algorithm) | Random forest | **Partly** |
| Assign class (threshold) | Threshold rules, or a ruleset `assign` with conditions | **Yes** |
| Membership functions (larger than, smaller than, about range, sigmoids, custom) | Ruleset `fuzzy` with `larger`, `smaller`, `about`, or `curve` (eCognition's own points) | **Yes** |
| Thresholds in class descriptions | `threshold` memberships | **Yes** |
| Remove classification | Ruleset `unassign` | **Yes** |
| Logical terms and, or, mean | `combine`: `and` (min), `or` (max), `mean` | **Yes** (the importer reads and and or) |
| Minimum membership value | `minMembership` | **Yes** |
| Class hierarchy inheritance | Inherit from level above; `parent_is_<class>` in rules | **Partly**: class-to-level inheritance, not inheritance of class descriptions |
| Process tree, domains (level, class filter, conditions) | Ruleset processes with a `domain` (classes and conditions) on the level you work on | **Partly**: a domain cannot name another level |
| Loops, "while something changes" | `loop` until nothing changes, or `maxIterations` | **Yes** |
| Variables, arrays, customized algorithms | None | **No** |
| Accuracy assessment (error matrix) | [Assess accuracy](obia.md#6-assess-accuracy) | **Yes** |
| Export classification (vector, raster) | Objects layer exports; [Export](obia.md#7-export) | **Yes** |

## Migrating a workflow

1. Run the eCognition workflow and export what it produced: the image objects
   of each level (polygons with their ids), the samples, the class hierarchy
   (names and colors), the object features you rely on (a CSV with the object
   id), and each level's parent ids. Object ids must be distinct positive
   whole numbers up to 16,777,216; renumber larger ones before importing.
2. In GeoLibre, add the image and the exported layers to the map, then use
   [Import from other software](obia.md#import-from-other-software): objects
   (with the id field), the feature table, the level mapping, the class list
   and the samples.
3. Import the rule set (see below), then rebuild what did not convert: a
   ruleset or threshold rules over the imported and measured features, using
   the tables above to find the equivalents. Where an algorithm is marked
   **No**, keep that part's result from eCognition (import its objects or
   classes) rather than recreating it.
4. Check the result against eCognition's with
   [Assess accuracy](obia.md#6-assess-accuracy), using validation samples
   from the eCognition classification.

## Importing a rule set

Under [Import from other software](obia.md#import-from-other-software),
**eCognition rule set** reads a `.dcp` rule set or a `.dpr` project (from
eCognition / Definiens Developer 7 onwards; encrypted rule sets cannot be
read; files up to 128 MB) and converts its process tree:

| eCognition | Converted to |
| --- | --- |
| Execute child processes | Its children, in order; a loop when it repeats (a count, or "while something changes", up to 1000 passes) |
| Assign class | `assign` (`unassign` for unclassified) |
| Remove classification | `unassign` |
| Classification (class descriptions) | `fuzzy`: each active class's description, membership functions as `curve`, thresholds as `threshold`, combined by and(min) or or(max); the class hierarchy's minimum membership |
| Image object domain: class filter, conditions joined by "and" | The process's `domain` |

Features become the workbench's fields where it computes the same thing:
`Mean <layer>`, `Standard deviation <layer>`, `Max. pixel value <layer>` and
`Min. pixel value <layer>` (by the layer's band), `Brightness`, `Area` (in
pixels), `Number of pixels`, `Border length` (in pixels), `Rel. border to
<class>` (`nb_border_<class>`), `Existence of <class> (0)` (a neighbor of the
class: `nb_border_<class>` above 0), `Existence of super objects <class> (1)`
(`parent_is_<class>`, after context features) and a customized normalized
difference of two layer means (as `ndvi` or `ndwi` when its layers are read
from the bands Measure uses for them). Any other feature
keeps its eCognition name: import a feature table exported from eCognition
with that column and the ruleset can use it.

Not converted, and listed with the reason: segmentation (redo it under
Segment), export and display processes, conditions joined by "or" or compared
with a variable, other domains (pixel level, linked objects, maps), nearest
neighbor and other operators in class descriptions, variables and arrays,
merging, growing and shrinking objects, level management, samples and
supervised classification, and any algorithm not in the table. The converted
processes all run on the level you work on, whatever level the rule set
named.

How much of a rule set converts depends on how much of it is classification
logic. Over public rule sets (a container process counts as converted when
any of its children does):

| Rule set | Processes | Converted | Mostly not converted |
| --- | --- | --- | --- |
| [Buildings and water, Hamden NY](https://github.com/khdelphine/eCognition_rulesets) | 54 | 39 | merge region |
| [Laughing gull nests](https://figshare.com/articles/dataset/14214182) | 64 | 45 | merge region, level management |
| [Water, seed growing](https://sees-rsrc.science.uq.edu.au/CRSSIS_old/OOIA/process_tree_library.htm) | 27 | 14 | segmentation, merge region |
| [Historical imagery, NAIP](https://github.com/mveitzel/historical-imagery) | 20 | 7 | segmentation, merge region |
| [Seafloor geomorphology](https://github.com/GeologicalMethodical/eCognition_Developer_Ruleset) | 22 | 9 | segmentation, object resizing |
| [NSW estuarine habitats](https://figshare.com/articles/software/27297483) | 240 | 35 | manual classification, variables, levels |
| [Yalova land cover](https://github.com/peterhofmann1/Yalova-S-2-LULC) | 2,813 | 191 | supervised classification, samples, maps |
| [Field boundaries](https://github.com/fkroeber/field_boundary_delineation) | 292 | 11 | variables, layer arithmetic, levels |

## Validation pilot

To see how far a translated eCognition workflow gets, the workbench was run
against an eCognition result.

- **Data:** a Landsat 7 ETM+ scene (September 1999) of upland North Wales,
  1001 × 1001 pixels at 15 m: the panchromatic band plus the six
  multispectral bands resampled to it, the layers and resolution the
  eCognition project used. The reference is that project's 18-class
  eCognition land-cover classification of the same area (24,807 objects on
  the grid).
- **Ruleset:** a six-class threshold ruleset from an eCognition training
  course (water and non-vegetation by NDVI, forest, improved grassland and
  bog/heath by band means and NDVI, then a catch-all class), translated by
  hand. The 18 reference classes are grouped into its six for comparison.

### Classification

Agreement with the eCognition classification, by area:

| Run | Agreement | Kappa |
| --- | --- | --- |
| Translated ruleset, whole scene | 67.2% | 0.55 |
| Translated ruleset, held-out blocks | 66.9% | 0.55 |
| Random forest, 6 classes, held-out blocks | 55% to 62% | 0.38 to 0.49 |
| Random forest, 18 classes, held-out blocks | 30% to 37% | 0.24 to 0.31 |

Per class, the translated ruleset reached a producer's/user's accuracy of
0.91/0.95 for water, 0.82/0.87 for forest, 0.69/0.90 for bog/heath,
0.78/0.70 for non-vegetation and 0.86/0.50 for improved grassland. The
catch-all class was the weakest (0.20/0.24), which the course itself expects
of this ruleset.

The random forest was trained in 2.5 km checkerboard blocks and checked in
the others, with eCognition's classes moved onto the workbench's objects at
one point per eCognition object (up to 400 per class, or all of them).
scikit-learn's random forest, trained on the same features and labels (all
samples), reached an out-of-bag accuracy of 0.74 (6 classes) and 0.44 (18
classes), and agreed with the workbench's forest on 85% of the objects. The
fine 18 classes, and labels moved onto objects drawn differently from
eCognition's, limit it more than the classifier does.

### Segmentation

Each method's objects, compared with eCognition's objects (multiresolution
segmentation with a shape weight of 0.1):

- **Class purity:** the area-weighted share of an object in its main
  eCognition class.
- **Object purity:** the same share for the main eCognition object.
- **Kept whole:** the share of an eCognition object in its largest
  workbench object.

A chessboard of square objects of a similar size is the baseline. Times are
for the segmentation alone; turning the objects into polygons adds 15 to 25
seconds in the browser at these object counts.

| Method | Objects | Class purity | Object purity | Kept whole | Time |
| --- | --- | --- | --- | --- | --- |
| Region growing (browser), threshold 1.0 | 13,379 | 0.743 | 0.670 | 0.487 | 1.0 s |
| Region growing (browser), threshold 0.8 (default) | 20,058 | 0.776 | 0.725 | 0.414 | 1.4 s |
| Region growing (browser), threshold 0.6 | 29,469 | 0.808 | 0.778 | 0.306 | 1.2 s |
| Region growing (browser), threshold 0.5 | 35,179 | 0.817 | 0.794 | 0.237 | 1.5 s |
| Felzenszwalb (browser), scale 200 | 18,424 | 0.756 | 0.733 | 0.294 | 2.7 s |
| Felzenszwalb (browser or native), scale 30 | 28,312 | 0.790 | 0.776 | 0.210 | 0.9 s |
| SLIC (native), size 40 | 27,495 | 0.788 | 0.777 | 0.190 | 1.1 s |
| Chessboard 9 × 9 (baseline) | 12,544 | 0.702 | 0.689 | 0.227 | |
| Chessboard 7 × 7 (baseline) | 20,449 | 0.733 | 0.723 | 0.193 | |
| Chessboard 6 × 6 (baseline) | 27,889 | 0.753 | 0.745 | 0.174 | |

The region-growing runs used a minimum object size of 10 pixels, and the
Felzenszwalb runs a smoothing of 0.5 and a minimum size of 10. Every method
gave the same objects when run again. Native runs peaked at about 580 MB,
including the Python process. The browser and native Felzenszwalb found the
same objects (an adjusted Rand index of 0.98 between them at scale 30).

Every method produces purer objects than a chessboard with as many objects.
At a given object count, region growing produces the purest objects, and it
keeps eCognition's objects whole best. Boundary agreement within one pixel
(F1) was 0.70 to 0.74 for the methods, against 0.59 to 0.62 for the
chessboard.

These figures compare label rasters on the image grid. On the map, objects
of an image in a CRS with a datum shift, such as this one, are currently
placed off their image (see
[#3080](https://github.com/opengeos/GeoLibre/issues/3080)); comparing their
polygons rather than their labels understated every browser result in an
earlier version of this section.

### Conclusions

- **Recommended workflow:**
  1. Segment with region growing (in the browser), or with Felzenszwalb or
     SLIC.
  2. Measure the objects.
  3. Import or translate the eCognition classification rules, check what did
     not convert, and assess the result against the eCognition output.
- **What carries over:** the classification logic (thresholds, membership
  functions, class order and domains) translates directly and gives similar
  results.
- **What does not:** eCognition's segmentation, whose objects no method here
  reproduces, and processes that work across levels. These are the main
  differences to expect.
