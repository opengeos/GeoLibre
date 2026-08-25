"""Tests for Map helpers that do not require a running widget/server."""

from __future__ import annotations

import sys
import types

import pytest

import geolibre.geolibre as gmod
from geolibre.geolibre import Map


@pytest.fixture
def m(monkeypatch):
    """A Map instance with the static server stubbed out (no bundle needed)."""
    monkeypatch.setattr(gmod, "serve_app", lambda *_a, **_k: "http://127.0.0.1:0/")
    monkeypatch.setattr(gmod, "app_port", lambda: 0)
    return Map()


def _last_layer(widget):
    return widget.project["layers"][-1]


def test_remote_mode_explicit():
    assert Map._resolve_remote_mode(True) == "remote"
    assert Map._resolve_remote_mode(False) == ""


def test_remote_mode_auto_local(monkeypatch):
    monkeypatch.delenv("JUPYTERHUB_SERVICE_PREFIX", raising=False)
    assert Map._resolve_remote_mode("auto") == ""


def test_remote_mode_auto_jupyterhub(monkeypatch):
    monkeypatch.setenv("JUPYTERHUB_SERVICE_PREFIX", "/user/alice/")
    assert Map._resolve_remote_mode("auto") == "remote"


def test_remote_mode_invalid():
    with pytest.raises(ValueError):
        Map._resolve_remote_mode("bogus")


def test_remote_mode_colab_forces_direct(monkeypatch):
    # Colab uses its own port proxy (front-end), which needs the localhost
    # server; an explicit server_proxy=True must not switch it to the remote
    # path.
    monkeypatch.setattr(Map, "_running_on_colab", staticmethod(lambda: True))
    assert Map._resolve_remote_mode(True) == ""


def test_remote_mode_non_colab_uses_remote(monkeypatch):
    monkeypatch.setattr(Map, "_running_on_colab", staticmethod(lambda: False))
    assert Map._resolve_remote_mode(True) == "remote"


def test_add_wms_appends_record_and_bumps_seq(m):
    seq = m._seq
    layer_id = m.add_wms("https://e/wms", "a,b")
    layer = _last_layer(m)
    assert layer["id"] == layer_id
    assert layer["type"] == "wms"
    assert m._seq == seq + 1


def test_add_wmts(m):
    m.add_wmts("https://t/{z}/{y}/{x}.png")
    assert _last_layer(m)["type"] == "wmts"


def test_add_ee_layer_from_map_id(m):
    class TileFetcher:
        url_format = "https://earthengine.googleapis.com/maps/test/tiles/{z}/{x}/{y}"

    class Image:
        def getMapId(self, vis_params):
            assert vis_params == {"min": 0, "max": 3000, "palette": ["blue", "green"]}
            return {"mapid": "test-map", "tile_fetcher": TileFetcher()}

    layer_id = m.add_ee_layer(
        Image(),
        {"min": 0, "max": 3000, "palette": ["blue", "green"]},
        name="Elevation",
        shown=False,
        opacity=0.4,
    )
    layer = _last_layer(m)
    assert layer["id"] == layer_id
    assert layer["name"] == "Elevation"
    assert layer["type"] == "xyz"
    assert layer["visible"] is False
    assert layer["opacity"] == 0.4
    assert layer["source"]["tiles"] == [TileFetcher.url_format]
    assert layer["source"]["attribution"] == "Google Earth Engine"
    assert layer["metadata"]["sourceKind"] == "xyz-url"
    assert layer["metadata"]["provider"] == "earth-engine"
    assert layer["metadata"]["earthEngineMapId"] == "test-map"


@pytest.mark.parametrize("opacity", [-0.1, 1.1, float("nan"), "bad"])
def test_add_ee_layer_rejects_invalid_opacity(m, opacity):
    with pytest.raises(ValueError, match="opacity must"):
        m.add_ee_layer(object(), opacity=opacity)


def test_add_ee_layer_requires_tile_url(m):
    class Image:
        def getMapId(self, _vis_params):
            return {"mapid": "missing-fetcher"}

    with pytest.raises(ValueError, match="without a tile URL"):
        m.add_ee_layer(Image())


def test_add_ee_layer_wraps_earth_engine_errors(m):
    class Image:
        def getMapId(self, _vis_params):
            raise RuntimeError("not initialized")

    with pytest.raises(RuntimeError, match="Authenticate and initialize"):
        m.add_ee_layer(Image())


def test_add_ee_layer_mosaics_image_collection(monkeypatch, m):
    class TileFetcher:
        url_format = "https://earthengine.googleapis.com/maps/collection/tiles/{z}/{x}/{y}"

    class Image:
        def getMapId(self, vis_params):
            assert vis_params == {"bands": ["B4", "B3", "B2"]}
            return {"tile_fetcher": TileFetcher()}

    class ImageCollection:
        # The real ee.ImageCollection exposes getMapId, so dispatch must not
        # take a duck-typed shortcut past mosaic().
        def getMapId(self, _vis_params):  # pragma: no cover - must not be called
            raise AssertionError("ImageCollection.getMapId must not be called")

        def mosaic(self):
            return Image()

    fake_ee = types.SimpleNamespace(
        Image=Image,
        ImageCollection=ImageCollection,
        FeatureCollection=type("FeatureCollection", (), {}),
        Feature=type("Feature", (), {}),
        Geometry=type("Geometry", (), {}),
    )
    monkeypatch.setitem(sys.modules, "ee", fake_ee)
    m.add_ee_layer(ImageCollection(), {"bands": ["B4", "B3", "B2"]})
    assert _last_layer(m)["source"]["tiles"] == [TileFetcher.url_format]


def test_add_ee_layer_rejects_unsupported_object(monkeypatch, m):
    fake_ee = types.SimpleNamespace(
        Image=type("Image", (), {}),
        ImageCollection=type("ImageCollection", (), {}),
        FeatureCollection=type("FeatureCollection", (), {}),
        Feature=type("Feature", (), {}),
        Geometry=type("Geometry", (), {}),
    )
    monkeypatch.setitem(sys.modules, "ee", fake_ee)
    with pytest.raises(TypeError, match="ee_object must be"):
        m.add_ee_layer(object())


def test_add_ee_layer_styles_feature_collection(monkeypatch, m):
    captured = {}

    class TileFetcher:
        url_format = "https://earthengine.googleapis.com/maps/features/tiles/{z}/{x}/{y}"

    class Image:
        def getMapId(self, vis_params):
            captured["map_params"] = vis_params
            return {"tile_fetcher": TileFetcher()}

    class FeatureCollection:
        # The real ee.FeatureCollection exposes getMapId, but it honours only
        # `color`; styling must run so width/fillColor/pointSize survive.
        def getMapId(self, _vis_params):  # pragma: no cover - must not be called
            raise AssertionError("FeatureCollection.getMapId must not be called")

        def style(self, **style):
            captured["style"] = style
            return Image()

    fake_ee = types.SimpleNamespace(
        Image=Image,
        ImageCollection=type("ImageCollection", (), {}),
        FeatureCollection=FeatureCollection,
        Feature=type("Feature", (), {}),
        Geometry=type("Geometry", (), {}),
    )
    monkeypatch.setitem(sys.modules, "ee", fake_ee)
    m.add_ee_layer(FeatureCollection(), {"color": "ff0000", "width": 4})
    assert captured["style"]["color"] == "ff0000"
    assert captured["style"]["width"] == 4
    assert captured["style"]["fillColor"] == "00000000"
    assert captured["map_params"] == {}


@pytest.mark.parametrize("vis_params", [["min", "max"], "min", 3])
def test_add_ee_layer_rejects_non_mapping_vis_params(m, vis_params):
    with pytest.raises(TypeError, match="vis_params must be a mapping"):
        m.add_ee_layer(object(), vis_params)


def _fake_vector_ee(captured):
    """Fake `ee` module whose vector types record the conversion chain."""

    class TileFetcher:
        url_format = "https://earthengine.googleapis.com/maps/vector/tiles/{z}/{x}/{y}"

    class Image:
        def getMapId(self, vis_params):
            captured["map_params"] = vis_params
            return {"tile_fetcher": TileFetcher()}

    class Geometry:
        pass

    class Feature:
        def __init__(self, geometry=None):
            captured["feature_from"] = geometry

    class FeatureCollection:
        def __init__(self, features=None):
            captured["collection_from"] = features

        def style(self, **style):
            captured["style"] = style
            return Image()

    fake_ee = types.SimpleNamespace(
        Image=Image,
        ImageCollection=type("ImageCollection", (), {}),
        FeatureCollection=FeatureCollection,
        Feature=Feature,
        Geometry=Geometry,
    )
    return fake_ee, TileFetcher.url_format


def test_add_ee_layer_wraps_feature_in_collection(monkeypatch, m):
    captured = {}
    fake_ee, url = _fake_vector_ee(captured)
    monkeypatch.setitem(sys.modules, "ee", fake_ee)

    feature = fake_ee.Feature()
    m.add_ee_layer(feature, {"color": "00ff00"})

    assert captured["collection_from"] == [feature]
    assert captured["style"]["color"] == "00ff00"
    assert captured["style"]["pointSize"] == 3
    assert captured["map_params"] == {}
    assert _last_layer(m)["source"]["tiles"] == [url]


def test_add_ee_layer_wraps_geometry_in_feature_and_collection(monkeypatch, m):
    captured = {}
    fake_ee, url = _fake_vector_ee(captured)
    monkeypatch.setitem(sys.modules, "ee", fake_ee)

    geometry = fake_ee.Geometry()
    m.add_ee_layer(geometry, {"width": 5})

    assert captured["feature_from"] is geometry
    assert isinstance(captured["collection_from"][0], fake_ee.Feature)
    assert captured["style"]["width"] == 5
    assert captured["style"]["fillColor"] == "00000000"
    assert captured["map_params"] == {}
    assert _last_layer(m)["source"]["tiles"] == [url]


def test_add_ee_layer_rejects_image_vis_params_on_vector(monkeypatch, m):
    class FeatureCollection:
        def style(self, **_style):  # pragma: no cover - must not be reached
            raise AssertionError("style() must not be called with bad vis_params")

    fake_ee = types.SimpleNamespace(
        Image=type("Image", (), {}),
        ImageCollection=type("ImageCollection", (), {}),
        FeatureCollection=FeatureCollection,
        Feature=type("Feature", (), {}),
        Geometry=type("Geometry", (), {}),
    )
    monkeypatch.setitem(sys.modules, "ee", fake_ee)
    with pytest.raises(ValueError, match="may only contain"):
        m.add_ee_layer(FeatureCollection(), {"min": 0, "max": 3000})


def test_add_ee_layer_wraps_preparation_errors(monkeypatch, m):
    class ImageCollection:
        def mosaic(self):
            raise RuntimeError("collection is empty")

    fake_ee = types.SimpleNamespace(
        Image=type("Image", (), {}),
        ImageCollection=ImageCollection,
        FeatureCollection=type("FeatureCollection", (), {}),
        Feature=type("Feature", (), {}),
        Geometry=type("Geometry", (), {}),
    )
    monkeypatch.setitem(sys.modules, "ee", fake_ee)
    with pytest.raises(RuntimeError, match="could not prepare this object"):
        m.add_ee_layer(ImageCollection())


def test_add_raster_is_cog(m):
    m.add_raster("https://e/dem.tif", bands=[1, 2, 3])
    layer = _last_layer(m)
    assert layer["type"] == "cog"
    assert layer["metadata"]["rasterState"]["bands"] == [1, 2, 3]


def test_add_vector_url_uses_control(m):
    m.add_vector("https://e/data.fgb", data_format="flatgeobuf")
    layer = _last_layer(m)
    assert layer["type"] == "geojson"
    assert layer["metadata"]["sourceKind"] == "maplibre-gl-vector"


def test_add_geoparquet_sets_format(m):
    m.add_geoparquet("https://e/d.parquet")
    assert _last_layer(m)["metadata"]["vectorState"]["format"] == "parquet"


def test_add_flatgeobuf_sets_format(m):
    m.add_flatgeobuf("https://e/d.fgb")
    assert _last_layer(m)["metadata"]["vectorState"]["format"] == "flatgeobuf"


def test_format_convenience_methods(m):
    m.add_kml("https://e/data.kml")
    assert _last_layer(m)["metadata"]["vectorState"]["format"] == "kml"
    m.add_gpkg("https://e/data.gpkg", layer="roads")
    layer = _last_layer(m)
    assert layer["metadata"]["vectorState"]["format"] == "gpkg"
    assert layer["metadata"]["vectorState"]["sourceLayer"] == "roads"


def test_add_vector_tiles(m):
    m.add_vector_tiles("https://e/tiles.json", source_layer="x")
    layer = _last_layer(m)
    assert layer["type"] == "vector-tiles"
    assert layer["source"]["sourceLayer"] == "x"


def test_add_pmtiles(m):
    m.add_pmtiles("https://e/x.pmtiles", source_layers=["roads"])
    layer = _last_layer(m)
    assert layer["type"] == "pmtiles"
    assert layer["metadata"]["sourceLayers"] == ["roads"]


def test_add_3d_tiles(m):
    m.add_3d_tiles("https://e/tileset.json", altitude_offset=5)
    layer = _last_layer(m)
    assert layer["type"] == "3d-tiles"
    assert layer["source"]["altitudeOffset"] == 5


def test_add_video_wraps_single_url(m):
    m.add_video("https://e/a.mp4", [[0, 0], [1, 0], [1, 1], [0, 1]])
    assert _last_layer(m)["source"]["urls"] == ["https://e/a.mp4"]


def test_add_wfs_inlines_geojson(monkeypatch, m):
    fake_fc = {
        "type": "FeatureCollection",
        "features": [{"type": "Feature", "properties": {}, "geometry": None}],
    }
    monkeypatch.setattr(gmod._project, "load_featurecollection", lambda _url: fake_fc)
    m.add_wfs("https://e/wfs", "topp:states")
    layer = _last_layer(m)
    assert layer["type"] == "geojson"
    assert layer["geojson"] == fake_fc
    assert layer["metadata"]["service"] == "wfs"
    assert layer["metadata"]["sourceKind"] == "wfs-getfeature"
    assert layer["metadata"]["typeName"] == "topp:states"
    assert layer["metadata"]["featureCount"] == 1
    # Protocol fields are persisted on the source for round-trip editing.
    assert layer["source"]["service"] == "wfs"
    assert layer["source"]["typeName"] == "topp:states"
    assert layer["source"]["version"] == "2.0.0"
    assert layer["source"]["outputFormat"] == "application/json"


def test_add_vector_local_file_inlined(monkeypatch, m):
    fake_fc = {"type": "FeatureCollection", "features": []}
    captured = {}

    def fake_read(path, data_format=None, source_layer=None):
        captured["path"] = path
        captured["data_format"] = data_format
        captured["source_layer"] = source_layer
        return fake_fc

    monkeypatch.setattr(gmod, "_read_local_vector", fake_read)
    # add_geoparquet routes a local path with the parquet hint threaded through.
    m.add_geoparquet("/data/cities.parquet")
    layer = _last_layer(m)
    assert layer["type"] == "geojson"
    assert layer["geojson"] == fake_fc
    assert captured["data_format"] == "parquet"


def test_add_vector_local_file_warns_on_ignored_render_mode(monkeypatch, m):
    monkeypatch.setattr(
        gmod,
        "_read_local_vector",
        lambda _p, data_format=None, source_layer=None: {"type": "x"},
    )
    with pytest.warns(UserWarning, match="ignored for local files"):
        m.add_vector("/data/parcels.shp", render_mode="tiles")


def test_add_gpkg_forwards_local_source_layer(monkeypatch, m):
    captured = {}

    def fake_read(path, data_format=None, source_layer=None):
        captured.update(path=path, data_format=data_format, source_layer=source_layer)
        return {"type": "FeatureCollection", "features": []}

    monkeypatch.setattr(gmod, "_read_local_vector", fake_read)
    m.add_gpkg("/data/maps.gpkg", layer="roads")
    assert captured == {
        "path": "/data/maps.gpkg",
        "data_format": "gpkg",
        "source_layer": "roads",
    }


def test_read_local_vector_warns_on_parquet_source_layer(monkeypatch, tmp_path):
    class _FakeGdf:
        crs = None

        def to_json(self):
            return '{"type": "FeatureCollection", "features": []}'

    path = tmp_path / "data.parquet"
    path.write_bytes(b"")
    fake_geopandas = types.SimpleNamespace(read_parquet=lambda _p: _FakeGdf())
    monkeypatch.setitem(sys.modules, "geopandas", fake_geopandas)
    with pytest.warns(UserWarning, match="source_layer is ignored"):
        gmod._read_local_vector(path, source_layer="roads")


def test_add_vector_geo_interface_inlined(m):
    class Fake:
        __geo_interface__ = {"type": "FeatureCollection", "features": []}

    m.add_vector(Fake(), name="GDF")
    layer = _last_layer(m)
    assert layer["type"] == "geojson"
    assert layer["name"] == "GDF"


def test_add_vector_geo_interface_warns_on_ignored_kwargs(m):
    class Fake:
        __geo_interface__ = {"type": "FeatureCollection", "features": []}

    with pytest.warns(UserWarning, match="__geo_interface__ objects"):
        m.add_vector(Fake(), render_mode="tiles")


# -- local raster ---------------------------------------------------------


def test_add_raster_local_path_served(monkeypatch, m):
    monkeypatch.setattr(
        gmod, "register_local_file", lambda path: f"http://127.0.0.1:0/served/{path}"
    )
    m.add_raster("/data/dem.tif", colormap="terrain")
    layer = _last_layer(m)
    assert layer["type"] == "cog"
    assert layer["source"]["url"] == "http://127.0.0.1:0/served//data/dem.tif"
    assert layer["metadata"]["rasterState"]["colormap"] == "terrain"


def test_add_raster_url_not_served(monkeypatch, m):
    called = {"n": 0}

    def boom(_path):
        called["n"] += 1
        raise AssertionError("URL rasters must not be routed to the file server")

    monkeypatch.setattr(gmod, "register_local_file", boom)
    m.add_raster("https://e/dem.tif")
    assert called["n"] == 0
    assert _last_layer(m)["source"]["url"] == "https://e/dem.tif"


def _fake_xarray_modules(monkeypatch):
    """Install tiny xarray/rioxarray stand-ins for conversion unit tests."""

    class Rio:
        def __init__(self, owner):
            self.owner = owner
            self.crs = owner.crs

        def set_spatial_dims(self, *, x_dim, y_dim, inplace):
            assert not inplace
            self.owner.spatial_dims = (x_dim, y_dim)
            return self.owner

        def write_crs(self, crs, *, inplace):
            assert not inplace
            self.owner.crs = crs
            self.crs = crs
            return self.owner

        def write_nodata(self, nodata, *, inplace):
            assert not inplace
            self.owner.nodata = nodata
            return self.owner

        def to_raster(self, path, **options):
            self.owner.raster_options = options
            path.write_bytes(b"fake geotiff")

    class DataArray:
        def __init__(self, dims=("lat", "lon"), crs=None):
            self.dims = dims
            self.crs = crs
            self.rio = Rio(self)

        def isel(self, indexers):
            self.indexers = indexers
            return self

    class Dataset(DataArray):
        def __init__(self, variables):
            super().__init__()
            self.data_vars = variables

        def __getitem__(self, key):
            return self.data_vars[key]

        def __setitem__(self, key, value):
            self.data_vars[key] = value

        def copy(self):
            """Model xarray's shallow copy: a new Dataset over the same variables."""
            duplicate = Dataset(dict(self.data_vars))
            duplicate.dims = self.dims
            duplicate.crs = self.crs
            duplicate.rio.crs = self.crs
            return duplicate

    monkeypatch.setitem(
        sys.modules, "xarray", types.SimpleNamespace(DataArray=DataArray, Dataset=Dataset)
    )
    monkeypatch.setitem(sys.modules, "rioxarray", types.SimpleNamespace())
    return DataArray, Dataset


def test_add_raster_xarray_dataarray_materializes_geotiff(monkeypatch, m):
    DataArray, _ = _fake_xarray_modules(monkeypatch)
    captured = {}
    monkeypatch.setattr(
        gmod,
        "register_local_file",
        lambda path: captured.update(path=path) or "http://127.0.0.1/xarray.tif",
    )

    array = DataArray()
    m.add_raster(array, colormap="viridis", array_args={"nodata": -9999, "compress": "LZW"})

    assert array.spatial_dims == ("lon", "lat")
    assert array.crs == "EPSG:4326"
    assert array.nodata == -9999
    assert array.raster_options == {"driver": "COG", "compress": "LZW"}
    assert captured["path"].read_bytes() == b"fake geotiff"
    assert _last_layer(m)["source"]["url"] == "http://127.0.0.1/xarray.tif"
    m.close()
    assert not captured["path"].exists()


def test_add_raster_xarray_dataset_selects_variable(monkeypatch, m):
    DataArray, Dataset = _fake_xarray_modules(monkeypatch)
    selected = DataArray(dims=("time", "y", "x"), crs="EPSG:3857")
    dataset = Dataset({"temperature": selected})
    monkeypatch.setattr(gmod, "register_local_file", lambda _path: "http://local/x.tif")

    m.add_raster(
        dataset,
        array_args={"variable": "temperature", "isel": {"time": 0}},
    )

    assert selected.indexers == {"time": 0}
    assert selected.spatial_dims == ("x", "y")
    m.close()


def test_add_raster_xarray_dataset_applies_nodata_to_each_variable(monkeypatch, m):
    DataArray, Dataset = _fake_xarray_modules(monkeypatch)
    red = DataArray()
    green = DataArray()
    dataset = Dataset({"red": red, "green": green})
    monkeypatch.setattr(gmod, "register_local_file", lambda _path: "http://local/rgb.tif")

    m.add_raster(dataset, array_args={"nodata": 255})

    assert red.nodata == 255
    assert green.nodata == 255
    # The GeoTIFF must be written from the copy, not from the caller's Dataset.
    assert not hasattr(dataset, "raster_options")
    m.close()


def test_add_raster_xarray_requires_recognizable_spatial_dims(monkeypatch, m):
    DataArray, _ = _fake_xarray_modules(monkeypatch)
    with pytest.raises(ValueError, match="Could not identify x/y dimensions"):
        m.add_raster(DataArray(dims=("row", "column")))


def test_add_raster_xarray_temp_file_removed_without_close(monkeypatch):
    """The finalizer must clean up when the user never calls Map.close()."""
    monkeypatch.setattr(gmod, "serve_app", lambda *_a, **_k: "http://127.0.0.1:0/")
    monkeypatch.setattr(gmod, "app_port", lambda: 0)
    DataArray, _ = _fake_xarray_modules(monkeypatch)
    captured = {}
    monkeypatch.setattr(
        gmod,
        "register_local_file",
        lambda path: captured.update(path=path) or "http://local/x.tif",
    )

    unregistered = []
    monkeypatch.setattr(gmod, "unregister_local_file", unregistered.append)

    widget = Map()
    widget.add_raster(DataArray())
    assert captured["path"].exists()

    assert widget._raster_cleanup.alive
    widget._raster_cleanup()  # what weakref runs at interpreter exit
    assert not captured["path"].exists()
    assert widget._temporary_rasters == []
    # The static server's token goes with the file, so a looping session does
    # not leave a registry entry per materialization behind.
    assert unregistered == [captured["path"]]


def test_add_raster_xarray_round_trip_with_real_rioxarray(monkeypatch, m):
    """Pin real rioxarray behavior the fake modules above cannot model.

    The Dataset nodata path copies the Dataset and reassigns every variable,
    which drops rio's cached spatial dims (hence the explicit re-set) but not
    the CRS, which lives in each variable's ``spatial_ref``. Assert the written
    COG really keeps both, so a rioxarray change is caught here rather than by
    a user staring at an unplaced raster.
    """
    xr = pytest.importorskip("xarray")
    pytest.importorskip("rioxarray")
    rasterio = pytest.importorskip("rasterio")
    np = pytest.importorskip("numpy")

    dataset = xr.Dataset(
        {
            "red": (("lat", "lon"), np.zeros((4, 5), dtype="float32")),
            "green": (("lat", "lon"), np.ones((4, 5), dtype="float32")),
        },
        coords={"lat": np.linspace(40, 30, 4), "lon": np.linspace(-100, -90, 5)},
    )
    captured = {}
    monkeypatch.setattr(
        gmod,
        "register_local_file",
        lambda path: captured.update(path=path) or "http://local/ds.tif",
    )

    m.add_raster(dataset, array_args={"nodata": 255})

    with rasterio.open(captured["path"]) as src:
        assert src.crs.to_string() == "EPSG:4326"  # inferred from lon/lat
        assert src.count == 2
        assert src.nodata == 255
        assert src.driver == "GTiff"  # what rasterio reports for a COG
    m.close()
    assert not captured["path"].exists()


def test_add_raster_xarray_uses_xyz_tiles_on_colab(monkeypatch, m):
    DataArray, _ = _fake_xarray_modules(monkeypatch)
    monkeypatch.setattr(Map, "_running_on_colab", staticmethod(lambda: True))
    captured = {}
    monkeypatch.setattr(
        gmod,
        "register_raster_tiles",
        lambda path, **options: (
            captured.update(path=path, options=options)
            or "http://127.0.0.1:1234/_geolibre_tiles/token/{z}/{x}/{y}.png"
        ),
    )

    m.add_raster(
        DataArray(),
        name="Temperature",
        bands=[1],
        colormap="turbo",
        rescale=[[-5, 35]],
    )

    layer = _last_layer(m)
    assert layer["type"] == "xyz"
    assert layer["name"] == "Temperature"
    assert "_geolibre_tiles/token/{z}/{x}/{y}.png" in layer["source"]["tiles"][0]
    assert captured["options"] == {
        "bands": [1],
        "colormap": "turbo",
        "rescale": [[-5, 35]],
    }


def test_add_cog_on_colab_computes_bounds_from_the_local_raster(monkeypatch, m, tmp_path):
    """The Colab tile branch reads the raster's own extent, reprojected to WGS84."""
    rasterio = pytest.importorskip("rasterio")
    np = pytest.importorskip("numpy")
    from rasterio.transform import from_bounds

    raster = tmp_path / "dem.tif"
    with rasterio.open(
        raster,
        "w",
        driver="GTiff",
        width=4,
        height=4,
        count=1,
        dtype="float32",
        crs="EPSG:4326",
        transform=from_bounds(-120, 30, -100, 45, 4, 4),
    ) as dst:
        dst.write(np.zeros((1, 4, 4), dtype="float32"))

    monkeypatch.setattr(Map, "_running_on_colab", staticmethod(lambda: True))
    monkeypatch.setattr(
        gmod,
        "register_raster_tiles",
        lambda path, **_options: "http://127.0.0.1:1234/_geolibre_tiles/t/{z}/{x}/{y}.png",
    )
    # "~" is what GDAL will not expand on its own, so hand add_cog that form.
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("USERPROFILE", str(tmp_path))

    m.add_cog("~/dem.tif", name="DEM")

    bounds = _last_layer(m)["source"]["bounds"]
    assert bounds == pytest.approx([-120, 30, -100, 45], abs=1e-6)


def test_add_cog_on_colab_tolerates_an_unreadable_raster(monkeypatch, m, tmp_path):
    """A file rasterio cannot open still yields a layer, just without bounds."""
    raster = tmp_path / "not-a.tif"
    raster.write_bytes(b"fake geotiff")
    monkeypatch.setattr(Map, "_running_on_colab", staticmethod(lambda: True))
    monkeypatch.setattr(
        gmod,
        "register_raster_tiles",
        lambda path, **_options: "http://127.0.0.1:1234/_geolibre_tiles/t/{z}/{x}/{y}.png",
    )

    m.add_cog(raster, name="DEM")

    assert _last_layer(m)["source"].get("bounds") is None


def test_add_raster_accepts_deprecated_url_keyword(m):
    """The pre-rename `url=` keyword still works, with a DeprecationWarning."""
    with pytest.warns(DeprecationWarning, match="add_raster\\(url=...\\) is deprecated"):
        m.add_raster(url="https://e/dem.tif", name="DEM")
    assert _last_layer(m)["source"]["url"] == "https://e/dem.tif"


def test_add_raster_rejects_source_and_url_together(m):
    with pytest.raises(TypeError, match="deprecated alias"):
        m.add_raster("https://e/a.tif", url="https://e/b.tif")


def test_add_raster_requires_a_source(m):
    with pytest.raises(TypeError, match="missing required argument"):
        m.add_raster()


def test_add_raster_rejects_non_raster_object(monkeypatch, m):
    _fake_xarray_modules(monkeypatch)
    with pytest.raises(TypeError, match="xarray DataArray/Dataset"):
        m.add_raster(object())


# -- markers --------------------------------------------------------------


def test_add_marker_single_point(m):
    m.add_marker(-100, 40, properties={"name": "Center"}, fillColor="#ff0000")
    layer = _last_layer(m)
    assert layer["type"] == "geojson"
    feature = layer["geojson"]["features"][0]
    assert feature["geometry"]["coordinates"] == [-100.0, 40.0]
    assert feature["properties"]["name"] == "Center"
    assert layer["style"]["fillColor"] == "#ff0000"


def test_add_markers_from_pairs(m):
    m.add_markers([(-100, 40), (-90, 35)])
    features = _last_layer(m)["geojson"]["features"]
    assert [f["geometry"]["coordinates"] for f in features] == [
        [-100.0, 40.0],
        [-90.0, 35.0],
    ]


def test_add_markers_from_dicts_keeps_properties(m):
    m.add_markers([{"lon": -100, "lat": 40, "pop": 5}, {"x": -90, "y": 35}])
    features = _last_layer(m)["geojson"]["features"]
    assert features[0]["properties"] == {"pop": 5}
    assert features[1]["geometry"]["coordinates"] == [-90.0, 35.0]


def test_add_markers_rejects_bad_pair(m):
    with pytest.raises(ValueError, match="lng, lat"):
        m.add_markers([(-100, 40, 1)])


def test_add_markers_rejects_dict_missing_coords(m):
    with pytest.raises(ValueError, match="longitude"):
        m.add_markers([{"pop": 5}])


def test_add_markers_rejects_non_point_geojson(m):
    polygon_fc = {
        "type": "FeatureCollection",
        "features": [
            {
                "type": "Feature",
                "properties": {},
                "geometry": {"type": "Polygon", "coordinates": [[[0, 0], [1, 0], [1, 1], [0, 0]]]},
            }
        ],
    }
    with pytest.raises(ValueError, match="Point/MultiPoint"):
        m.add_markers(polygon_fc)


def test_add_markers_from_geojson(m):
    fc = {
        "type": "FeatureCollection",
        "features": [
            {
                "type": "Feature",
                "properties": {},
                "geometry": {"type": "Point", "coordinates": [1, 2]},
            }
        ],
    }
    m.add_markers(fc)
    assert _last_layer(m)["geojson"]["features"][0]["geometry"]["coordinates"] == [1, 2]


def test_add_circle_markers_sets_radius(m):
    m.add_circle_markers([(0, 0)], radius=12)
    assert _last_layer(m)["style"]["circleRadius"] == 12


def test_add_heatmap_sets_renderer(m):
    m.add_heatmap([(0, 0), (1, 1)], radius=42, intensity=1.5)
    style = _last_layer(m)["style"]
    assert style["pointRenderer"] == "heatmap"
    assert style["heatmapRadius"] == 42
    assert style["heatmapIntensity"] == 1.5


def test_add_heatmap_validates_parameters(m):
    with pytest.raises(ValueError, match="radius"):
        m.add_heatmap([(0, 0)], radius=0)
    with pytest.raises(ValueError, match="intensity"):
        m.add_heatmap([(0, 0)], intensity=-1)
    with pytest.raises(ValueError, match="radius"):
        m.add_heatmap([(0, 0)], radius=float("nan"))
    with pytest.raises(ValueError, match="radius"):
        m.add_heatmap([(0, 0)], radius=float("inf"))
    with pytest.raises(ValueError, match="intensity"):
        m.add_heatmap([(0, 0)], intensity=float("nan"))


def test_add_xy_data_from_records(m):
    m.add_xy_data(
        [{"lon": "-100", "lat": "40", "city": "A"}],
        x="lon",
        y="lat",
    )
    feature = _last_layer(m)["geojson"]["features"][0]
    assert feature["geometry"]["coordinates"] == [-100.0, 40.0]
    assert feature["properties"] == {"city": "A"}


def test_add_csv_from_text(m):
    m.add_csv("longitude,latitude,name\n-100,40,A\n")
    feature = _last_layer(m)["geojson"]["features"][0]
    assert feature["properties"]["name"] == "A"


def test_add_xy_data_rejects_missing_or_invalid_coordinates(m):
    with pytest.raises(ValueError, match="missing coordinate"):
        m.add_xy_data([{"longitude": 1}])
    with pytest.raises(ValueError, match="invalid coordinates"):
        m.add_xy_data([{"longitude": "nope", "latitude": 1}])
    with pytest.raises(ValueError, match="invalid coordinates"):
        m.add_xy_data([{"longitude": "nan", "latitude": 1}])
    with pytest.raises(ValueError, match="invalid coordinates"):
        m.add_xy_data([{"longitude": 1, "latitude": float("inf")}])


def test_add_csv_keeps_extra_fields_under_a_string_key(m):
    m.add_csv("longitude,latitude\n-100,40,spill\n")
    properties = _last_layer(m)["geojson"]["features"][0]["properties"]
    assert properties == {gmod._CSV_RESTKEY: ["spill"]}


def test_add_csv_rejects_non_public_url(m):
    with pytest.raises(ValueError, match="non-public address"):
        m.add_csv("http://127.0.0.1/points.csv")


def test_add_csv_rejects_oversized_file(monkeypatch, tmp_path, m):
    path = tmp_path / "points.csv"
    path.write_text("longitude,latitude\n-100,40\n", encoding="utf-8")
    monkeypatch.setattr(gmod, "_MAX_TABULAR_BYTES", 4)
    with pytest.raises(ValueError, match="size limit"):
        m.add_csv(str(path))


def test_add_gdf_requires_geo_interface(m):
    with pytest.raises(TypeError, match="__geo_interface__"):
        m.add_gdf([{"x": 1}])


def test_add_marker_cluster_enables_clustering(m):
    m.add_marker_cluster([(0, 0), (1, 1)], cluster_radius=80, cluster_max_zoom=10)
    style = _last_layer(m)["style"]
    assert style["pointRenderer"] == "cluster"
    assert style["clusterRadius"] == 80
    assert style["clusterMaxZoom"] == 10


# -- choropleth -----------------------------------------------------------


def _choropleth_fc():
    return {
        "type": "FeatureCollection",
        "features": [
            {"type": "Feature", "properties": {"pop": v}, "geometry": None}
            for v in (0, 10, 20, 30, 40)
        ],
    }


def test_add_choropleth_builds_graduated_style(m):
    m.add_choropleth(_choropleth_fc(), "pop", class_count=5, colormap="blues")
    style = _last_layer(m)["style"]
    assert style["vectorStyleMode"] == "graduated"
    assert style["vectorStyleProperty"] == "pop"
    assert style["vectorStyleColorRamp"] == "blues"
    assert len(style["vectorStyleStops"]) == 5
    assert style["vectorStyleStops"][0]["value"] == 0.0
    assert style["vectorStyleStops"][-1]["value"] == 40.0


def test_add_choropleth_missing_column_raises(m):
    with pytest.raises(ValueError, match="not found"):
        m.add_choropleth(_choropleth_fc(), "missing")


def test_add_choropleth_non_numeric_column_raises(m):
    fc = {
        "type": "FeatureCollection",
        "features": [
            {"type": "Feature", "properties": {"name": label}, "geometry": None}
            for label in ("alpha", "beta", "gamma")
        ],
    }
    with pytest.raises(ValueError, match="numeric value"):
        m.add_choropleth(fc, "name")


def test_add_choropleth_style_override_wins(m):
    m.add_choropleth(_choropleth_fc(), "pop", strokeColor="#000000")
    assert _last_layer(m)["style"]["strokeColor"] == "#000000"


def test_add_data_without_column_is_plain_geojson(m):
    m.add_data(_choropleth_fc())
    assert _last_layer(m)["style"]["vectorStyleMode"] == "single"


def test_add_data_with_column_is_choropleth(m):
    m.add_data(_choropleth_fc(), column="pop")
    assert _last_layer(m)["style"]["vectorStyleMode"] == "graduated"


# -- split map / legend / colorbar -------------------------------------------


def _plugins(widget):
    return widget.project.get("plugins", {})


def test_split_map_activates_swipe_plugin(m):
    a = m.add_geojson(_choropleth_fc(), name="A")
    b = m.add_geojson(_choropleth_fc(), name="B")
    m.split_map(a, b, position=40, control_position="bottom-right")
    plugins = _plugins(m)
    assert "maplibre-gl-swipe" in plugins["activePluginIds"]
    assert plugins["mapControlPositions"]["maplibre-gl-swipe"] == "bottom-right"
    swipe = plugins["settings"]["maplibre-gl-swipe"]
    assert swipe["leftLayers"] == [a]
    assert swipe["rightLayers"] == [b]
    assert swipe["position"] == 40
    assert swipe["active"] is True


def test_plugins_block_seeds_default_active(m):
    # A fresh plugins block must keep the app's default plugins active, else
    # restoreProjectState would tear down the layer control / deck.gl overlay.
    m.split_map()
    active = _plugins(m)["activePluginIds"]
    for plugin_id in (
        "maplibre-layer-control",
        "maplibre-deckgl-viz",
        "maplibre-atmosphere-effects",
    ):
        assert plugin_id in active


def test_split_map_accepts_layer_objects_and_lists(m):
    a = m.add_geojson(_choropleth_fc(), name="A")
    layer = m.get_layer(a)
    m.split_map(layer, ["__basemap__"])
    swipe = _plugins(m)["settings"]["maplibre-gl-swipe"]
    assert swipe["leftLayers"] == [a]
    assert swipe["rightLayers"] == ["__basemap__"]


def test_split_map_clamps_position(m):
    m.split_map(position=999)
    assert _plugins(m)["settings"]["maplibre-gl-swipe"]["position"] == 100


def test_split_map_rejects_bad_orientation(m):
    with pytest.raises(ValueError, match="orientation"):
        m.split_map(orientation="diagonal")


def test_split_map_rejects_bad_layer_reference(m):
    with pytest.raises(ValueError, match="layer id"):
        m.split_map([123])


def test_split_map_rejects_bare_non_iterable(m):
    # A bare non-iterable must raise the documented ValueError, not TypeError.
    with pytest.raises(ValueError, match="layer id"):
        m.split_map(123)


def test_existing_plugins_block_is_not_reseeded(m):
    # A project that already carries a plugins block reflects deliberate choices,
    # so adding a control must not inject the default-active ids into it.
    project = m.to_project()
    project["plugins"] = {
        "manifestUrls": [],
        "activePluginIds": ["maplibre-layer-control"],
        "mapControlPositions": {},
        "settings": {},
    }
    m.load_project(project)
    m.add_legend(legend_dict={"a": "#111"})
    assert _plugins(m)["activePluginIds"] == ["maplibre-layer-control"]


def _components(widget):
    return _plugins(widget)["settings"]["maplibre-gl-components"]


def test_add_legend_from_dict(m):
    m.add_legend("Cover", legend_dict={"Water": "#0000ff", "Land": "#00ff00"})
    # The Components plugin restores from settings alone; it is not added to
    # activePluginIds (that would mount the full Components toolbar).
    assert "maplibre-gl-components" not in _plugins(m)["activePluginIds"]
    legend = _components(m)["legend"]
    assert legend["visible"] is True
    assert legend["title"] == "Cover"
    assert legend["hasLegend"] is True
    assert legend["selectedLegendIndex"] == 0
    assert legend["legends"][0]["items"] == [
        {"label": "Water", "color": "#0000ff", "shape": "square"},
        {"label": "Land", "color": "#00ff00", "shape": "square"},
    ]


def test_add_legend_from_labels_and_colors(m):
    m.add_legend(labels=["a", "b"], colors=["#111", "#222"], shape="circle")
    items = _components(m)["legend"]["legends"][0]["items"]
    assert [i["label"] for i in items] == ["a", "b"]
    assert all(i["shape"] == "circle" for i in items)


def test_add_legend_builtin_nlcd(m):
    m.add_legend(builtin="nlcd")
    legend = _components(m)["legend"]
    assert legend["title"] == "NLCD Land Cover"
    labels = [i["label"] for i in legend["legends"][0]["items"]]
    assert "Open Water" in labels


def test_add_legend_builtin_esa_alias(m):
    m.add_legend(builtin="esa")
    assert _components(m)["legend"]["title"] == "ESA WorldCover"


def test_add_legend_unknown_builtin_raises(m):
    with pytest.raises(ValueError, match="Unknown built-in legend"):
        m.add_legend(builtin="nope")


def test_add_legend_requires_entries(m):
    with pytest.raises(ValueError, match="Provide legend entries"):
        m.add_legend("Empty")


def test_add_legend_mismatched_labels_colors(m):
    with pytest.raises(ValueError, match="same length"):
        m.add_legend(labels=["a", "b"], colors=["#111"])


def test_add_legend_rejects_combined_sources(m):
    # The three entry sources are mutually exclusive.
    with pytest.raises(ValueError, match="exactly one of"):
        m.add_legend(builtin="nlcd", legend_dict={"a": "#111"})


def test_add_legend_appends_multiple(m):
    m.add_legend(legend_dict={"a": "#111"})
    m.add_legend(legend_dict={"b": "#222"}, position="top-right")
    legend = _components(m)["legend"]
    assert len(legend["legends"]) == 2
    assert legend["selectedLegendIndex"] == 1
    assert legend["legends"][1]["legendPosition"] == "top-right"


def test_add_colorbar_named(m):
    m.add_colorbar(colormap="plasma", vmin=0, vmax=255, label="Elevation", units="m")
    colorbar = _components(m)["colorbar"]
    assert colorbar["visible"] is True
    assert colorbar["mode"] == "named"
    assert colorbar["colormap"] == "plasma"
    assert colorbar["vmin"] == 0
    assert colorbar["vmax"] == 255
    assert colorbar["colorbars"][0]["label"] == "Elevation"


def test_add_colorbar_custom_colors(m):
    m.add_colorbar(colors=["#000000", "#ffffff"])
    colorbar = _components(m)["colorbar"]
    assert colorbar["mode"] == "custom"
    assert colorbar["customColors"] == "#000000, #ffffff"


def test_add_colorbar_empty_custom_colors_raises(m):
    with pytest.raises(ValueError, match="non-empty"):
        m.add_colorbar(colors=[])


def test_add_colorbar_bad_position_raises(m):
    with pytest.raises(ValueError, match="position"):
        m.add_colorbar(position="middle")


def test_add_colorbar_rejects_inverted_range(m):
    with pytest.raises(ValueError, match="must be less than"):
        m.add_colorbar(vmin=100, vmax=0)


def test_add_colormap_is_colorbar_alias(m):
    m.add_colormap("inferno", vmin=1, vmax=9, units="K")
    colorbar = _components(m)["colorbar"]
    assert colorbar["colormap"] == "inferno"
    assert colorbar["vmin"] == 1
    assert colorbar["vmax"] == 9


def test_legend_and_colorbar_coexist(m):
    m.add_legend(legend_dict={"a": "#111"})
    m.add_colorbar(colormap="viridis")
    components = _components(m)
    # Adding a colorbar must not drop the existing legend, and vice versa.
    assert "legend" in components
    assert "colorbar" in components
