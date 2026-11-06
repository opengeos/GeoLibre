# 8. Sharing Maps and Reproducible Projects

!!! info "4:00 - 5:00 p.m."
    Lecture 15 min · Hands-on 25 min · Wrap-up and questions 10 min · Break 4:50 - 5:00

## Learning goals

- Build a story map that walks a reader through your findings.
- Share a project as a public link, embed it in a web page, or export it as a
  standalone HTML file.
- Reproduce a map from Python with the `geolibre` package.
- Leave with a plan for using GeoLibre in your own work.

## Lecture (15 min)

### What makes a map reproducible?

A reproducible map is one that someone else can open, inspect, and rebuild
without you. GeoLibre projects get there by design:

- A `.geolibre.json` project records **where** every layer comes from (a URL,
  service, or query), **how** it is styled, the camera, and plugin state. It
  is plain JSON, so it diffs cleanly in Git.
- Cloud-hosted data means the project points at the **same bytes** for
  everyone, not at a copy on one person's laptop.
- Layers computed in the browser (a hillshade, a SQL result) are either
  embedded in the project (small vector results) or flagged as not saved
  (rasters), so you know what a recipient will see.

### Ways to share

| Method | Result | Needs |
| --- | --- | --- |
| **Project → Save** | A `.geolibre.json` file | Nothing |
| Host the file anywhere public, open with `?url=` | A link anyone can open | Any static host (GitHub Pages, S3, a website) |
| **Project → Share...** | A public link on `share.geolibre.app` | A free share.geolibre.app sign-in |
| `?url=...&layout=viewer` in an `<iframe>` | An embedded, read-only map | A web page |
| **Project → Export → Export as HTML...** | One standalone HTML file that runs offline | Nothing |
| **Project → Story map...** | A chapter-by-chapter narrative, presented in the app or exported as HTML | Nothing |
| Python `geolibre` package | The same map built from code in Jupyter | `pip install geolibre` |

Before sharing, the Share dialog runs a **share-readiness check**: it lists
layers a recipient will not be able to load (local files, hosts without CORS,
expired URLs) and strips credentials such as API keys from the upload.

## Hands-on (25 min)

Open the Section 7 project, or your own, and rename it
`NGIS 2026 - 8 Story map and sharing`. If the Time slider is still bound,
deactivate it with **Plugins → Time slider** so all earthquakes show.

### Exercise 8.1: Build a three-chapter story map (12 min)

1. Choose **Project → Story map...**.
2. Fill in **Title** `Ten Years of Nevada Earthquakes`, **Subtitle**
   `M2.5+ events, 2016-2025 (USGS ComCat)`, and **Byline** with your name.
3. Zoom the map to all of Nevada and click **Add chapter**. Each chapter
   captures the current camera. Title it `A restless state` and add a
   one-sentence description.
4. Use **View → Set view...** to move to the Monte Cristo Range
   (longitude `-117.87`, latitude `38.17`, zoom `9.2`, pitch `45`). Click **Add
   chapter**, title it `Monte Cristo Range, May 2020`, and describe the M6.5
   event and its aftershocks.
5. Move to Reno and Lake Tahoe (longitude `-119.85`, latitude `39.35`, zoom
   `8.8`, pitch `30`). Add a third chapter, `Close to home: Reno and Lake
   Tahoe`.
6. If you moved the map after adding a chapter, open the chapter and click
   **Set to current view** to re-capture it.
7. Click **Present**. Step through the chapters with the arrows, or click
   **Play automatically**. Click **Exit** when done.

![A chapter of the story map presented in GeoLibre](https://assets.geolibre.app/images/workshops/ngis-2026/s08-story-present.webp)

### Exercise 8.2: Share it (8 min)

Pick at least one:

- **A file plus a link.** Save the project, put the file on any public web
  host (for example a GitHub repository with Pages turned on), and open it
  with:

    ```text
    https://web.geolibre.app/?url=https://YOUR-HOST/your-map.geolibre.json
    ```

- **share.geolibre.app.** Choose **Project → Share...**, click **Sign in**,
  approve the popup, review the readiness list, and share. You get a public
  URL like `https://share.geolibre.app/you/my-map.geolibre.json`.
- **Embed.** Paste this into any HTML page (here using the finished project):

    ```html
    <iframe
      src="https://web.geolibre.app/?url=https://assets.geolibre.app/projects/workshops/ngis-2026/08-story-map.geolibre.json&layout=viewer"
      width="100%" height="600" style="border:0" allowfullscreen>
    </iframe>
    ```

- **Standalone HTML.** **Project → Export → Export as HTML...** writes one file
  you can email or open from disk. The story map builder also has
  **Export HTML** for a scroll-driven story page and **Handout (PDF)**.

### Exercise 8.3: The same map from Python (5 min, optional)

In any Jupyter environment (a local notebook, JupyterLab, VS Code, or Google
Colab):

```python
# pip install geolibre
from geolibre import Map

base = "https://assets.geolibre.app/data/workshops/ngis-2026/"
m = Map(center=(-119.8, 39.4), zoom=8)
m.add_basemap("positron")
m.add_cog(base + "reno_tahoe_dem.tif", name="Reno-Tahoe DEM", colormap="terrain")
m.add_geojson(base + "nv_counties.geojson", name="Nevada counties")
m.add_csv(base + "nv_earthquakes.csv", name="Nevada earthquakes")
m.save_project("my-workshop.geolibre.json")
m
```

The full GeoLibre app renders inside the cell. The saved
`my-workshop.geolibre.json` opens in the web and desktop apps, so a notebook
and a point-and-click session produce the same artifact. To open a project in
a notebook, use `m.load_project("08-story-map.geolibre.json")`.

## Wrap-up (10 min)

Today you:

1. Read data where it lives: GeoJSON, CSV, FlatGeobuf, GeoParquet, COG,
   PMTiles, Zarr, and EPT, all over HTTP.
2. Found imagery through a STAC catalog and combined it with OGC map and
   feature services.
3. Ran spatial SQL, buffers, and terrain analysis without a server.
4. Streamed a billions-of-points LiDAR survey of Reno in 3D.
5. Extended the app with plugins and an AI assistant.
6. Packaged everything as projects that open from a single link.

Take two minutes to write down one dataset or workflow from your own job that
you could move to this model, and what is blocking it today (data format,
hosting, CORS, credentials, or habits).

**Keep learning**

- [GeoLibre documentation](../../index.md), [Tutorials](../../tutorials/index.md),
  and [Video Tutorials](../../tutorials/videos.md)
- [Gallery](../../gallery.md) of shared projects to open and fork
- Source code and issue tracker: [github.com/opengeos/GeoLibre](https://github.com/opengeos/GeoLibre)
- Questions, bugs, and feature requests: open an issue or a discussion on
  GitHub

## Check your work

[Open the finished project](https://web.geolibre.app/?url=https://assets.geolibre.app/projects/workshops/ngis-2026/08-story-map.geolibre.json){ .md-button .md-button--primary }

The finished project opens straight into the story map presentation.

---

**End of workshop, 5:00 p.m.** Thank you for attending! Return to the
[workshop overview](index.md).
