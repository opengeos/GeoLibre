# Coming from eCognition

This page maps eCognition concepts and algorithms to the
[Object-Based Analysis](obia.md) workbench, so you can tell which parts of an
eCognition land-cover workflow carry over, which need rework, and which are not
available. It is a manual translation guide: the workbench does not read
eCognition rulesets (`.dcp`) or projects (`.dpr`). Bring results over with
[Import from other software](obia.md#import-from-other-software) instead.

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
| Relative border to class | `nb_border_<class>` (in rulesets) | **Yes** |
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
| Membership functions (larger than, smaller than, about range) | Ruleset `fuzzy` with `larger`, `smaller`, `about` | **Partly**: linear ramps only, no sigmoid or custom curves |
| Logical terms and, or, mean | `combine`: `and` (min), `or` (max), `mean` | **Yes** |
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
   id), and each level's parent ids.
2. In GeoLibre, add the image and the exported layers to the map, then use
   [Import from other software](obia.md#import-from-other-software): objects
   (with the id field), the feature table, the level mapping, the class list
   and the samples.
3. Rebuild the rules: threshold rules or a ruleset over the imported and
   measured features, using the tables above to find the equivalents. Where
   an algorithm is marked **No**, keep that part's result from eCognition
   (import its objects or classes) rather than recreating it.
4. Check the result against eCognition's with
   [Assess accuracy](obia.md#6-assess-accuracy), using validation samples
   from the eCognition classification.

Validating whole rulesets automatically against eCognition reference outputs
needs real exported rulesets and their results; that work is tracked in
[#3053](https://github.com/opengeos/GeoLibre/issues/3053).
