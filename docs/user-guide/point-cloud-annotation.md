# Point cloud annotation

The **Point Cloud Annotation** plugin labels LiDAR points with ASPRS
classes directly on the map. Use it to fix misclassified points (for
example, stadium seating left as "never classified") or to build training
labels for point cloud segmentation models. It is the first slice of the
plan tracked in
[opengeos/GeoLibre#2749](https://github.com/opengeos/GeoLibre/issues/2749).

## Start a session

1. Load a point cloud with **Add Data → LiDAR Layer** (LAS, LAZ, COPC, or
   EPT).
2. Zoom to the area you want to label. A COPC or EPT cloud streams by level
   of detail, so the session holds the points loaded at the current view:
   zoom in further to label at full density.
3. Open **Plugins → Point Cloud Annotation**, pick the cloud, and choose
   **Start annotating**.

While a session runs, the plugin colours the cloud by classification and
pauses streaming, so no edited point is dropped when you move the map.
Scroll to zoom and right-drag to tilt or rotate as usual.

## Select and assign

- **Box (B)** and **Lasso (L)**: drag on the map to select points. Hold
  **Shift** to add to the selection or **Alt** to remove from it, or pick a
  mode in the panel. **Pan** returns left-drag to moving the map.
- Selection goes through all depths, like a camera frustum. Narrow it with
  the **Min Z** / **Max Z** filter (metres) or **Only points in class**,
  which relabels just the points currently in one class.
- Hidden classes (toggled in the LiDAR panel's legend) and points outside the
  LiDAR panel's elevation filter are never selected.
- Selected points are drawn in yellow. Choose the class to assign and press
  **Apply (Enter)**; **Clear (Esc)** drops the selection. Clicking a row in
  **Classes in session** makes it the class to assign.
- **Undo** and **Redo** step through the class assignments of the session.

## Export

Edits live in memory, so export before finishing the session:

- **LAS 1.4** writes every point loaded in the session (point format 7 with
  RGB, or 6 without) with its edited class, intensity, returns, GPS time and
  scan angle. Coordinates are written back in the source file's CRS, feet
  included, when its WKT is known, and in WGS 84 otherwise.
- **Segments.ai JSON** writes a
  [`pointcloud-segmentation`](https://docs.segments.ai/reference/label-types)
  label. Its `point_annotations` line up point for point with the LAS file,
  one annotation per class with `category_id` set to the ASPRS code.

**Finish session** resumes streaming. Streaming may evict edited points once
you move the map, which is why labels need to be exported first.

## Limitations

- MapLibre renderer only.
- Labels are not saved in the project yet, and LAZ/COPC output is not
  available (the browser has no LAZ encoder); convert the LAS with PDAL or
  laspy if you need compression.
- Cuboids, instance labels, and assisted pre-labeling are later phases of
  #2749.
