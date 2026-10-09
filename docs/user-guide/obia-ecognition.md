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
read) and converts its process tree:

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
(`parent_is_<class>`, after context features) and a customized NDVI or NDWI
(as `ndvi` or `ndwi`, by the band roles set under Measure). Any other feature
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
