# Danish site-planning data: Datafordeler, current imagery, and historic plans

This desktop workflow combines current official Danish map data with historic plan scans without confusing either for a survey. It is useful for an early courtyard, streetscape, landscape, or mobility study.

You need a Datafordeler API key with access to GeoDanmark Ortofoto and Matriklen2. Keep the key in a secret manager or local password store. Never put it in a shared `.geolibre.json` file or a public project.

## 1. Add the current official orthophoto

Datafordeler's spring orthophoto is updated annually and supports WMS 1.3.0 and Web Mercator, so it can be displayed as a live GeoLibre WMS layer.

1. Open **Add Data → WMS Layer**.
2. In the service library, choose **Datafordeler Ortofoto (Denmark; API key required)**.
3. Replace `<YOUR_API_KEY>` in the service URL with your own local API key, then click **Retrieve layers**.
4. Select `orto_foraar`, keep WMS version `1.3.0`, and add it.

The preset contains no credential. It uses:

```text
https://wms.datafordeler.dk/GeoDanmarkOrto/orto_foraar/1.0.0/WMS?apikey=<YOUR_API_KEY>
```

!!! warning "Do not share a live keyed layer"
    A WMS URL is saved with a project. Before saving or sharing a project, remove the live keyed WMS layer and replace it with a local orthophoto export such as a GeoTIFF/COG. Store the API key only in your local secret manager.

## 2. Add current cadastral reference geometry

Datafordeler's Matriklen2 WFS returns GML. Download a small area as GML, then use **Add Data → Vector Layer** to load the local file; GeoLibre reprojects vector input to its map coordinate system.

For example, set an API-key environment variable in a terminal and make a bounded request:

```sh
export DATAFORDELER_API_KEY='…'

curl --get 'https://wfs.datafordeler.dk/MATRIKLEN2/MatGaeldendeOgForeloebigWFS/1.0.0/WFS' \
  --data-urlencode "apikey=$DATAFORDELER_API_KEY" \
  --data-urlencode 'service=WFS' \
  --data-urlencode 'version=2.0.0' \
  --data-urlencode 'request=GetFeature' \
  --data-urlencode 'typenames=mat:Jordstykke_Gaeldende' \
  --data-urlencode 'srsName=EPSG:25832' \
  --data-urlencode 'bbox=<min-easting>,<min-northing>,<max-easting>,<max-northing>,EPSG:25832' \
  --output parcels.gml
```

Also request `mat:Matrikelskel_Gaeldende` when you need visible boundary lines. Use **ETRS89 / UTM zone 32N (`EPSG:25832`)** for Datafordeler requests. Cadastral geometry is an authoritative reference map, but construction boundaries and registered rights still require the relevant authority or surveyor.

## 3. Make an offline working base

For a design workshop, use local files rather than live credentials:

- a georeferenced current orthophoto as GeoTIFF/COG;
- the downloaded parcel/boundary GML, or an exported GeoPackage;
- GeoPackage layers for `historic`, `existing`, `rights/constraints`, and `proposal` geometry.

Lock the current imagery and cadastral layers. Draw site observations and design alternatives in separate editable layers.

## 4. Register historical drawings as evidence

Use **Processing → Georeferencing** to add a scanned PDF page exported as PNG/JPG. First register the historic garage or site plan to the orthophoto using at least four unchanged facade or ramp corners. Then register a drainage plan to that already-registered plan, recording every ground-control point and residual.

The tool uses an affine fit. A historic plan that needs a visibly non-uniform stretch is evidence of an older condition, not a current-survey base—keep it labelled as such rather than forcing it to match. Use a surveyor and engineer for construction levels, deck structure, drainage falls, utilities and set-out.

## 5. Use AI only as a drafting accelerator

After the orthophoto is georeferenced, **Processing → AI Segmentation** can create candidate polygons for paving, planting, roofs or cars. Review and correct every result before writing it to an `existing` or `proposal` layer. It cannot establish legal boundaries, parking rights, underground structure, drains or levels.

## Sources

- [Datafordeler: Ortofoto forår WMS](https://datafordeler.dk/dataoversigt/geodanmark-ortofoto/ortofoto-foraar-wms/)
- [Datafordeler: Matriklen2 gældende og foreløbig WFS](https://datafordeler.dk/dataoversigt/matriklen-mat/matriklen2-gaeldende-og-foreloebig-wfs/)
