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

- **Box (B)**, **Lasso (L)** and **Brush (P)**: drag on the map to select
  points. The brush selects everything within its radius of the dragged path;
  set its size in the panel or with **[** and **]**. Hold **Shift** to add to
  the selection or **Alt** to remove from it, or pick a mode in the panel.
  **Pan** returns left-drag to moving the map.
- **Polygon (G)**: click vertices, then double-click, press **Enter** or click
  the first vertex to close the ring and select what it encloses. **Esc**
  cancels. Hold **Shift** or **Alt** on the closing click to add or subtract.
- Selection goes through all depths, like a camera frustum. Narrow it with
  the **Min Z** / **Max Z** filter (metres) or **Only points in class**,
  which relabels just the points currently in one class.
- **Lock** a class in **Classes in session** to protect its points: locked
  classes, hidden classes (toggled in the LiDAR panel's legend) and points
  outside the LiDAR panel's elevation filter are never selected.
- Selected points are drawn in yellow. Choose the class to assign (or press
  **0**-**9** for ASPRS classes 0-9) and press **Apply (Enter)**;
  **Clear (Esc)** drops the selection. Clicking a row in
  **Classes in session** makes it the class to assign.
- **Undo** and **Redo** step through the class assignments of the session.

## Custom classes

Open **Custom classes** under the assign controls to add classes of your own
(for example *Car* or *Solar panel*). Give each a code from 19 to 255 (ASPRS
reserves 19-63 for future standard classes and leaves 64-255 to users, so the
panel suggests the first free code from 64), a name and a colour, then press
**Add**. A custom class can be assigned, locked and boxed like a standard
one; the LiDAR panel's legend and tooltips show its name and colour. Custom
classes are saved with the project, and the exports write their codes (the
LAS classification byte holds 0-255). A notebook or agent can define them ahead of time
with `Map.set_point_cloud_classes` or the `set_point_cloud_classes` MCP tool.

## Instances

Instances group points that belong to one object, such as one car or one
tree, for instance segmentation. Select its points and press **New instance
(N)**: they get the class chosen under **Assign class** and a new instance id,
as one undoable edit. **Assign class to points** on a 3D box does the same for
the points inside the box. **Instances** lists each one with its most common
class and point count; **Select** selects its points again and **Dissolve**
removes the instance while its points keep their class. Instance ids are saved
with the project like classes, and exported with the points (see below).

## Pre-labelling with Whitebox

**Pre-label (Whitebox)** runs a Whitebox LiDAR classifier on the session's
points in the browser (the same WebAssembly build as **Processing → Whitebox**)
and applies its classes as one undoable edit:

- **Ground (improved ground point filter)** separates ground (2) from
  everything else (1).
- **Ground, vegetation and unclassified (classify LiDAR)** also marks
  vegetation.

**Only relabel unclassified points (0 and 1)**, on by default, keeps every
point you or the survey already classified. Locked and hidden classes are never
changed. The tool runs in tiles of about 750,000 points with a 20 m overlap,
since the WebAssembly build runs out of memory on a few million points at once;
a 4.6 million point session takes a couple of minutes. The result is a starting
point: review it, then correct it with the selection tools.

## 3D boxes (cuboids)

Label objects such as buildings, trees or vehicles with oriented 3D boxes:

- **Auto box (A)**: click a point on an object. The annotator grows a cluster
  from it through points within 0.75 m of each other, skipping ground, water,
  noise and locked or hidden classes, and fits the tightest box around it: the
  minimum-area rectangle of the cluster's footprint, rotated to the object, and
  its full height.
- **Box from selection**: fits a box to the points you selected with the box,
  lasso or brush tools.

New boxes take the class chosen under **Assign class**. Each box in **Objects
(3D boxes)** has its own class and three actions: **Select points** (the points
inside it), **Assign class to points** (undoable like **Apply**; the points
also become a new [instance](#instances)) and **Delete**.
Click a box to open **Box views**, three orthographic views of the points
around it: top, side (along its length) and front (across it). Drag inside the
box to move it, drag an edge to resize it (the opposite face stays put), drag
the knob beyond the front edge in the top view to rotate it, and scroll to zoom
about the pointer. While a box is open in the views, the keyboard nudges it:
arrow keys move it 10 cm north/south/east/west (1 m with **Shift**), **Q** and
**E** rotate it by 1° (5° with **Shift**), and **+** / **-** raise or lower its
top by 10 cm.

Each box also has a review **status** (New, Reviewed or Flagged) and free-form
**Attributes**: name/value pairs such as `make: Ford` or `occluded: yes`, up to
32 per box. Expand **Attributes**, type a name and value and press **Add**;
edit a value in place, or **Remove** it.

Boxes on a cloud loaded from a URL are saved with the project, with their
status and attributes. Export them as **Boxes as GeoJSON** (one footprint
polygon per box, with its class, `z_min`, `z_max`, size, heading, `status` and
attributes as properties) or **Boxes as Segments.ai JSON** (a
[`pointcloud-cuboid`](https://docs.segments.ai/reference/label-types) label in
the same CRS and units as the LAS export, with the heading measured from grid
east, and the status and attributes in each annotation's `attributes`).

## Saving labels with the project

Labels on a cloud loaded from a URL are saved with the project. Each edit is
stored against the point's source node and its index in that node, not its
position in memory, so the labels are re-applied when the project reopens and
as streamed nodes load again, whatever order they arrive in. Labels on a local
file are not saved (the file cannot be reopened from the project), so export
them.

## Export

- **LAS 1.4** writes every point loaded in the session (point format 7 with
  RGB, or 6 without) with its edited class, intensity, returns, GPS time and
  scan angle. Coordinates are written back in the source file's CRS, feet
  included, when its WKT is known, and in WGS 84 otherwise. When the session
  has instances, each point also carries an `instance` extra-bytes dimension
  (uint32, 0 for none), which laspy, PDAL and LAStools read by name.
- **LAZ (compressed)** writes the same records as the LAS export, compressed
  with LASzip in the browser (a laz-rs WebAssembly build). It is typically
  about a quarter of the LAS size.
- **NumPy (.npy)** writes a structured array with `x`, `y`, `z` (float64, in
  the same CRS as the LAS export), `intensity`, `classification`, `red`,
  `green`, `blue` when the cloud has colour, and `instance` when the session
  has instances, ready for `numpy.load`.
- **Segments.ai JSON** writes a
  [`pointcloud-segmentation`](https://docs.segments.ai/reference/label-types)
  label. Its `point_annotations` line up point for point with the LAS file,
  with one annotation per instance and one per class for points in no
  instance, each with `category_id` set to the class code.

**Finish session** resumes streaming.

## Limitations

- MapLibre renderer only.
- COPC output is not available; export LAZ and convert it with PDAL
  (`writers.copc`) if you need a COPC file.
- Boxes rotate about the vertical only (no pitch or roll).
- Instances are not colored by id on the map; select one from **Instances**
  to see its points highlighted.
