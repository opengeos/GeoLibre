# GeoLibre 支持 GIS 数据格式完整清单

> **摘要**：本文完整梳理 GeoLibre 内置支持的全部 GIS 数据格式，涵盖矢量、栅格、云原生地理空间格式及每种格式的内部解析逻辑，为国内 WebGIS 开发者提供完整的技术参考清单。
>
> **原文来源**："GIS开发手记"，原文链接：<https://mp.weixin.qq.com/s/GrtQzetCBgKtYruEhjsOAw>
>
> **本文使用简体中文撰写。**

## 前言

本文完整梳理 GeoLibre 内置支持的全部地理空间数据格式，区分矢量、栅格、云原生地理格式，同时说明每种格式对应的解析依赖、读取优先级与适用场景，可供 WebGIS 开发人员快速查阅。

## 一、运行形态与平台说明

列出格式之前先说清楚「在哪儿跑」，因为后面很多格式有平台差异。

| 形态 | 怎么跑 | 说明 |
|---|---|---|
| 浏览器 | 打开 `web.geolibre.app` | 什么都不用装，加载完可离线用 |
| 桌面 | Tauri v2 原生应用 | Windows / macOS / Linux，微软商店、Homebrew、winget、AUR、Flatpak 都有 |
| 安卓 | Google Play 原生 App | 每 ABI 约 40MB |
| iOS | App Store 原生 App | iPhone 与 iPad，同一套代码经 Tauri v2 mobile 构建 |
| Jupyter | `pip install geolibre` | 整个应用嵌进 notebook 单元格 |

> **核心应用没有账号、没有服务器、没有费用。** 本地文件就地读取、不出本机，应用加载完成后本地流程也能离线继续用。例外的是那些可选的远程能力：在线目录（STAC、Source Cooperative、Overture、Planetary Computer）、从 CDN 下载底图与瓦片，以及 Earth Engine、需要鉴权的 ArcGIS 服务等，都需要联网，部分还需要各自的凭据或 OAuth 登录。

---

## 二、矢量数据格式支持

矢量数据是 GeoLibre 适配最完善的能力模块，文件选择器内置统一的格式白名单，支持拖拽自动识别，无需手动选择文件类型，覆盖 17 种主流矢量扩展名。

```text
geojson, json, gpkg, geoparquet, parquet, fgb, flatgeobuf,
csv, tsv, kml, kmz, gml, gpx, dxf, tab, shp, zip
```

**拖进去就行，不用先选「我要导入什么格式」。**

但真正有意思的是**每种格式背后是谁在读**——这决定了它的实际表现：

| 格式 | 扩展名 | 读取引擎 | 值得注意的细节 |
|---|---|---|---|
| **GeoJSON** | `.geojson` `.json` | 原生 `JSON.parse` | 带老式顶层 `crs` 成员会自动走 DuckDB 重投影到 WGS84 |
| **GeoParquet / Parquet** | `.parquet` `.geoparquet` | DuckDB `read_parquet` | 远程文件走 HTTP Range 流式读，不用整个下载 |
| **FlatGeobuf** | `.fgb` `.flatgeobuf` | DuckDB `ST_Read` | — |
| **GeoPackage** | `.gpkg` | **sql.js（SQLite WASM），不是 GDAL** | 多图层会弹选择器；会先修复 `gpkg_ogr_contents` |
| **Shapefile（散文件）** | `.shp` | shpjs | 桌面端自动读同名 `.dbf/.shx/.prj/.cpg`；3D MultiPatch 改走 DuckDB |
| **Shapefile（压缩包）** | `.zip` | fflate 解压 → shpjs | `.prj` 决定投影，`.cpg` 决定 DBF 编码（**中文属性乱码可以得到正确处理**）；自动跳过 macOS 的 `__MACOSX` |
| **KML** | `.kml` | 自研解析器 | **保留内嵌符号化**；还能吐出 GroundOverlay 图像和 `<Model>` 三维模型 |
| **KMZ** | `.kmz` | fflate 解压 | 自定义图标、格式化描述都保留 |
| **GML** | `.gml` | DuckDB `ST_Read` | — |
| **GPX** | `.gpx` | 纯 JS | **自动拆成三个图层**：航点 / 轨迹 / 路线 |
| **CSV / TSV** | `.csv` `.tsv` `.txt` `.dat` | 自研 + DuckDB 兜底 | 自动识别分隔符和经纬度列；WKT 几何列走 DuckDB；对话框可指定源坐标系 |
| **CAD（DXF/DWG）** | `.dxf` `.dwg` | DuckDB `ST_Read` | 会读出图层清单让你挑；**CAD 不带坐标系，需要手动选 EPSG** |
| **MapInfo TAB** | `.tab` | `ST_Read` | — |
| **Esri 文件地理数据库** | `.gdb` **文件夹** | Python sidecar | 桌面端专属，且要 sidecar；Mac App Store 版本里是隐藏的 |
| **OSM PBF** | `.osm.pbf` `.pbf` | osmix，跑在 Web Worker | 自动拆成点/线/面三层；超 50MB 会提示确认，5 分钟超时保护 |
| **GeoRSS** | `.xml` `.rss` `.atom` | 纯 JS | RSS 2.0 / Atom / RDF 都吃，GeoRSS Simple + GML 几何 |
| **地理标记照片** | `.jpg` `.jpeg` `.png` `.tif` `.tiff` `.webp` `.heic` `.heif` | exifr | **读 EXIF GPS 直接生成点图层**，无人机照片很实用 |

_明确不支持的：`.xlsx` / `.xls`（经全库搜索，零命中）、原始 `.osm` XML（只认 PBF）。要用 Excel 的先另存为 CSV。_

!!! tip "KML `<Model>` 的三维模型"
    KML 的 `<Model>` 这条值得关注：它会把内嵌的 COLLADA `.dae` 用 three.js 加载再导出成 GLB 加载到地图中。为了这一个边缘场景引入了 three.js。

加载完之后不是「能看见就完事」——符号化、分级配色、图例都是跟着走的：

![一个工程里叠了地铁站点、地铁线路、曼哈顿建筑高度三个矢量图层，右侧图例按建成年代自动分级](https://assets.geolibre.app/images/vector-layers-legend.webp)

![同一份数据拖时间轴：按建成年代逐年过滤建筑，矢量图层是带时间维度的](https://assets.geolibre.app/demos/vector-data-demo.gif)

---

## 三、栅格与影像

栅格这块比矢量窄，但覆盖了云原生那条主线。

| 格式 | 扩展名 | 引擎 | 平台 |
|---|---|---|---|
| **GeoTIFF / COG** | `.tif` `.tiff` | 默认 `cog-tiler-wasm`，可切 GPU 引擎 | 全平台；桌面端本地文件走 Tauri asset 协议做 Range 读 |
| **MosaicJSON / STAC item** | `.json` | 读取时按需拼接 | 全平台 |
| **地理配准图像** | 任意浏览器能解码的图 + GCP 的 `.csv`/`.txt` | 最小二乘仿射，导出用 gdal3.js | 全平台（gdal3.js 从 CDN 加载） |
| **KML GroundOverlay** | 来自 `.kml` / `.kmz` | 四角坐标图像图层 | 带 `<TimeSpan>` 的还能接时间轴动画 |
| **地理配准视频** | `.mp4` + `.webm` | MapLibre video source | 只支持 URL |
| **转换工具输入（栅格）** | `.tif .tiff .img .vrt .asc .nc .jp2 .hgt` | GDAL / rasterio sidecar | 桌面端；浏览器只收 `.tif/.tiff` |
| **Whitebox 栅格 I/O** | `.tif .tiff .img .bil .flt .sdat .rdc .asc` | whitebox-wasm | 全平台 |

![Google 影像底图与栅格样式面板](https://assets.geolibre.app/images/raster-style-panel.webp)

_注意这个不对等：`.img`、`.vrt`、`.asc`、`.jp2`、`.hgt` 这些只在**转换工具**里认，不能直接当图层拖进去。直接拖只认 GeoTIFF。_

---

## 四、点云与 LiDAR

| 项 | 支持 | 说明 |
|---|---|---|
| **LiDAR 图层** | COPC / LAZ（URL 方式） | 走 `maplibre-gl-lidar` + deck.gl 渲染 |
| **USGS 3DEP** | 在线点云流式加载 | 独立插件，会附带 3DEP 高程索引 WMS 覆盖图 |
| **Whitebox LiDAR 工具** | `.las .laz .zlidar .copc .e57 .ply`，输出 `.laz` | 这是全库唯一出现 `.e57` / `.ply` 的地方 |

_LiDAR 图层面板本身的扩展名白名单**不在这个仓库里**，定义在上游 npm 包中。仓库里唯一的直接证据是一个 `.copc.laz` 的示例 URL。LAS/LAZ/COPC/EPT 大概率都支持，但从源码无法百分百确认。_

---

## 五、三维模型、瓦片与高斯泼溅

开篇那个「收到 3D Tiles 想看一眼」的场景，这节就是答案。

| 格式 | 输入方式 | 引擎 | 说明 |
|---|---|---|---|
| **OGC 3D Tiles** | tileset URL | `maplibre-gl-3d-tiles` + deck.gl `Tile3DLayer` | **支持自定义请求头**，带鉴权的切片也能加 |
| **Google 照片级 3D Tiles** | 内置 URL | 同上 | 需要 Google Maps API key，走请求头传，不落盘 |
| **ArcGIS I3S 场景图层** | `…/SceneServer` URL | deck.gl + loaders.gl `I3SLoader` | 整合网格和三维对象图层都支持 |
| **glTF / GLB** | **只能填 URL** | deck.gl `ScenegraphLayer` | 没有本地文件选择器，这是目前最明显的缺口 |
| **COLLADA `.dae`** | 只能通过 KML `<Model>` 内嵌 | three.js → GLB | — |
| **高斯泼溅** | URL | `maplibre-gl-splat` | 存储层类型是 `gaussian-splat` |

![3D Tiles 加载面板：左侧图层列表里 3D-TILES、矢量、XYZ、glTF 模型、高斯泼溅混排](https://assets.geolibre.app/images/3dtiles.webp)

上面这张图挺能说明问题：**左侧图层面板里 3D Tiles、矢量、XYZ、glTF 模型、高斯泼溅是叠在同一个列表里的**，右边直接就是渲染结果。「加载 3D Tiles 要起服务器写页面」这件事在这儿就是**粘贴一个 URL**。

_没找到的：`.obj` 完全不支持（零命中）。`.b3dm`/`.pnts`/`.cmpt` 这些 3D Tiles 内部格式在仓库里也搜不到——它们被上游加载器透明处理了，不用你操心。高斯泼溅的扩展名清单同样在上游包里。_

---

## 六、瓦片与 OGC 服务

存储层的图层类型枚举一共 20 种：

```text
geojson, raster, wms, wmts, xyz, vector-tiles, arcgis, pmtiles,
mbtiles, zarr, lidar, gaussian-splat, 3d-tiles, cog, flatgeobuf,
geoparquet, duckdb-query, deckgl-viz, video, image
```

「添加数据 → Web 服务」里能填的：

| 服务 | 细节 |
|---|---|
| **XYZ** | `{z}/{x}/{y}` 模板，栅格或矢量瓦片都行 |
| **WMS** | **GetCapabilities 自动拉图层下拉框**；点击要素走 GetFeatureInfo；开发态自带 CORS 代理 |
| **WMTS** | RESTful 瓦片模板 |
| **WFS** | GetCapabilities 拉 typeName；可选自动刷新 |
| **OGC API - Features** | 落地页 / `/collections` / 单个集合 / 完整 `/items` URL 都认，自动翻 `next` 链接，默认取 1000 条 |
| **OGC API - Tiles（矢量）** | TileJSON 或 MVT 模板，可另填 Mapbox style URL 来解析 `source-layer` 名 |
| **ArcGIS** | 对话框里**只有两个**：FeatureServer（以 `f=geojson` 拉）和 VectorTileServer |
| **ArcGIS MapServer / ImageServer** | 不在添加数据对话框里，只能通过 NASA Earthdata GIS、EnviroAtlas 这类插件间接用 |
| **MBTiles** | `.mbtiles` 本地文件，自定义协议 + Rust 后端读取。**桌面端专属** |
| **PMTiles** | `.pmtiles`，矢量栅格都行，自动嗅探文件头 |
| **PostgreSQL / PostGIS** | 连接 → 选表 → 出 MVT，靠内置的 Martin 服务。**桌面端专属** |
| **deck.gl 可视化图层** | 14 种：散点、热力、六边形、格网、屏幕格网、等值线、弧线、线、大圆、GeoJSON、图标、文本、轨迹、场景图 |

![OpenFreeMap 3D 底图与绘制工具](https://assets.geolibre.app/images/drawing-tools.webp)

---

## 七、云原生格式与数据目录

这一节是 GeoLibre 和传统桌面 GIS 拉开距离的地方。

**科学数据格式：**

| 格式 | 支持范围 |
|---|---|
| **Zarr** | 远程 store URL，或本地文件夹。变量和维度选择器会显示真实坐标值。_本地文件夹在浏览器里需要 File System Access API，Firefox / Safari 用不了_ |
| **NetCDF / HDF** | 两条路：远程走 **kerchunk 引用 JSON + HTTP Range**（云优化 NetCDF）；本地支持 `.nc .nc4 .cdf .h5 .hdf5`（NetCDF-3 走 netcdfjs，NetCDF-4/HDF5 走 h5wasm）。**HDF4 的 `.hdf` 明确不支持** |
| **COG** | 见栅格一节 |

**在线数据目录（打开就能浏览的）：**

- **STAC** —— 静态目录和 STAC API 都支持，通过 STAC Index 发现目录。只有可视化资产（GeoTIFF / GeoJSON）能直接加
- **Source Cooperative** —— 桶浏览器，认 `.pmtiles` `.parquet` `.geoparquet` `.tif` `.geojson` `.geojsonl` `.ndjson` `.fgb` `.gpkg` `.csv`
- **Natural Earth** —— 本质是 Source Coop 面板锁定到 `opengeos/natural-earth`
- **Hugging Face Hub** —— 浏览数据集仓库，甚至能建仓库上传
- **Overture Maps** —— 主题化矢量瓦片，默认只显示建筑
- **Microsoft Planetary Computer** —— STAC + TiTiler
- **Google Earth Engine** —— OAuth 登录，桌面端有原生 OAuth 流程
- **NASA Earthdata GIS** —— EOSDIS 的 ImageServer / MapServer / FeatureServer / 已发布 web 地图
- **OpenAerialMap** / **Esri Wayback**（历史影像） / **Mapillary** / **Google 街景**
- **联邦数据服务** —— FEMA 洪水图、EPA EnviroAtlas、USGS National Map
- **气象与延时** —— RainViewer 实时雷达、NASA GIBS、EOX 无云年度底图

**行星数据**（这是一个超出预期的设计）：**月球、火星来自 OpenPlanetaryMap，水星、金星、伽利略卫星、土卫六、冥王星、卡戎来自 USGS Astrogeology**。关键细节是**每个工程独立的椭球体参数**，所以距离和面积量算跟你测的那颗星球是对得上的。

![月球：底图来自 OpenPlanetaryMap，比例尺是 300 km](https://assets.geolibre.app/images/moon-map.webp)

![火星：同一套界面，换个工程就是另一颗星球](https://assets.geolibre.app/images/mars.webp)

![冥王星：这张来自 USGS Astrogeology，那块「心形」的 Sputnik Planitia 清晰可见](https://assets.geolibre.app/images/pluto.webp)

> **编者注：** 最初以为这只是表面文章，但每个工程独立的椭球体参数这个细节改变了这一看法——项目对坐标系的处理是严谨的，不是简单地贴图了事。

---

## 八、工程与样式互通

这条容易被忽略，但决定了你能不能将它集成到现有工作流中。

| 格式 | 扩展名 | 方向 |
|---|---|---|
| GeoLibre 工程 | `.geolibre` / `.geolibre.json` | 读 + 写 |
| **QGIS 工程** | `.qgz` `.qgs` | **只能导入**。用 DOMParser 解析 XML，不执行任何 QGIS 代码；只导入它认识的 17 种矢量格式和 GeoTIFF |
| **Mapbox GL / MapLibre 样式** | `.json` | 导入 + 导出 |
| **OGC SLD** | `.sld` `.xml` | 导入 + 导出 |
| **QGIS QML** | `.qml` | 导入 + 导出 |

> **关键启发：** 你在 QGIS 里配好的符号化可以搬过来，反过来也行。样式导入的格式是**按内容判断的，不看扩展名**——扔个改错后缀的文件也能认出来。

另外还有一堆 `.json` 形态的库：样式库、图层库（「我的数据」）、服务库、图例、相机漫游、故事地图，都能导入导出。

---

## 九、导出与格式转换：相当于一个免费的 GDAL 前端

这块被官网说得太轻，但是最实用的功能之一。

### 图层直接导出

右键图层就能导出，**全部在浏览器里完成，不用后端**：

`.geojson` · `.csv` · `.kml` · `.kmz` · `.parquet`（GeoParquet） · `.gpkg`（GeoPackage） · `.zip`（Shapefile）

**GeoPackage 和 Shapefile 的写出是纯 JS 实现的**——因为 DuckDB-WASM 写不了 GeoPackage，作者干脆用 sql.js 手写了一个 GeoPackage 1.3 写入器；Shapefile 则是手工拼 `.shp/.shx/.dbf/.prj/.cpg` 五个文件再打包。

### 格式转换工具（9 个）

| 工具 | 输入 | 输出 |
|---|---|---|
| 矢量 → 矢量 | `geojson geojsonl json parquet geoparquet fgb gpkg shp zip kml gml gpx` | 桌面端 14 种驱动：GeoJSON、GeoJSONSeq、FlatGeobuf、GPKG、Shapefile、GML、KML、CSV、SQLite、GMT、DXF、MapInfo、JML、GPX |
| 矢量 → GeoParquet | 同上 | `.parquet`，压缩可选 `zstd / snappy / gzip / lz4 / 不压缩` |
| 矢量 → FlatGeobuf | 同上 | `.fgb` |
| 矢量 → Shapefile | 同上 | `.zip` |
| 矢量 → GeoPackage | 同上 | `.gpkg` |
| CSV → GeoParquet | `csv tsv txt` | `.parquet` |
| **矢量 → PMTiles** | `parquet geoparquet geojson json gpkg fgb shp` | `.pmtiles`。**桌面端最高 24 级**，浏览器端因为用 WASM 切片器层级要浅一些 |
| **栅格 → PMTiles** | 只收 `.tif/.tiff` | `.pmtiles`（单波段过色带，不是真彩色） |
| **栅格 → COG** | 桌面 `tif tiff img vrt asc nc jp2 hgt`，浏览器只收 tif | `.tif`，压缩可选 `deflate zstd lzw webp jpeg packbits raw` |

_浏览器端输出格式是子集：geojson / json / csv / parquet / geoparquet / gpkg / zip / fgb。想要完整的 14 种驱动得用桌面版（走 Python sidecar）。_

### 其它导出

栅格图层导 GeoTIFF、按框裁栅格子集、底图抽取成 PMTiles 离线包、打印布局出 PNG/PDF/多页 ZIP、**整个工程导成一个独立 HTML 文件**、故事地图导 HTML/PDF、地图录屏 WebM、图表导 SVG/PNG。

!!! tip "工程导成独立 HTML"
    这条功能被严重低估了——给协作者分享单文件网页查看成果，比让对方安装专用软件现实得多。

---

## 十、平台差异：注意事项

前面零散提过，这里集中一次。**这是最容易吃亏的地方。**

| 限制 | 影响什么 |
|---|---|
| **桌面端（Tauri）专属** | 原生文件/文件夹对话框、本地 MBTiles、本地栅格读取、Shapefile 同名文件自动发现、PostGIS/Martin、文件地理数据库、本地文件监听重载 |
| **需要 Python sidecar** | 文件地理数据库、桌面端的全部转换工具（首选路径）、栅格工具（rasterio）、AI 分割、PostGIS、Sedona |
| **Mac App Store 版本** | 不带 Python sidecar：隐藏 PostgreSQL 和 GDB 数据源、隐藏 AI 分割；Whitebox、转换、栅格、矢量工具全部退回浏览器/WASM 引擎；Shapefile companion 文件要手动多选 |
| **安卓 / iOS 移动端** | 隐藏栅格工具、转换工具、AI 分割、PostgreSQL——这些都依赖 sidecar。Whitebox 工具箱走 WASM，依然可用 |
| **浏览器端** | 无本地 MBTiles/GDB/PostGIS；转换输出是子集；矢量转换不收 `.zip`；栅格转 COG 只收 GeoTIFF；Zarr 本地文件夹在 Firefox/Safari 不可用 |

---

## 十一、架构：它凭什么能吃下这么多格式

前面列了一百多种格式，容易让人觉得「过于复杂」。所以简单说一下它如何支撑的。

**核心是一个引擎无关的 store。** `@geolibre/core` 这个包不依赖 MapLibre、不依赖 Cesium、不依赖 deck.gl——它只存两样东西：一组扁平的图层记录（id、类型、source、样式、可见性…）和一个五个字段的 `MapViewState`（center / zoom / bearing / pitch / bbox）。

**所有 UI 操作都只改 store，再由同步层推给渲染引擎，严格单向。** 你在界面上拖透明度滑块，改的是 store，不是 MapLibre 对象。

这个设计的红利就是**加格式很便宜**：新格式只要能变成一条图层记录，就自动获得图层面板、透明度、排序、工程保存、样式导出的全部能力。

**三个渲染器的分工**（注意这里没有「引擎抽象层」）：

- **MapLibre** 是默认主地图，绝大多数图层由它渲染
- **deck.gl** 不占独立视图，是**交织进 MapLibre 画布内**的 overlay，负责 COG、3D Tiles、I3S、带 Z 值的矢量、可视化图层。这里有个硬约束：所有交织生产者必须共用**同一个** overlay 实例，否则后来的会把前面的图层清掉（作者实际遇到过这个问题）
- **Cesium** 是分屏里的一个视图模式，不是替换。它只支持 GeoJSON、3D Tiles 和影像类图层，其它类型在面板里标「仅 2D」

![Cesium 视图模式下的三维球，左边还是那套图层面板](https://assets.geolibre.app/images/earth-cesium-globe.webp)

一个值得注意的细节：**Cesium 的相机同步不是按 zoom 级别对齐的，而是按地面分辨率（米/像素）**，所以不同高度的分屏面板能保持同样的屏幕比例尺。

**计算引擎有五套**，都挂在同一套 UI 下：DuckDB-WASM Spatial（主力，跑在独立 Worker 里）、PGlite + PostGIS、Apache Sedona（sidecar 或浏览器 WASM 版）、Pyodide（浏览器里跑 GeoPandas/Shapely）、Whitebox WASM（700+ 工具）。

!["处理"菜单展开的样子：Whitebox、转换、水文、LiDAR、网络、投影、栅格、遥感、地形、矢量，右边是按字母排的工具清单](https://assets.geolibre.app/images/processing-tools-menu.webp)

**一个很聪明的做法：矢量算子的 Python 实现是一个「无框架」模块，sidecar 和浏览器 Pyodide 执行的是同一份代码**，所以两条路径结果完全一致，不会出现「本地算和服务器算不一样」。

---

## 十二、性能：几个真实的数字

也简单说几个，都是源码里能查到的实数，不是估算的。

**大矢量的处理方式。** **超过 5 万要素，就不再走 MapLibre 原生 GeoJSON 源，而是在客户端现场切成矢量瓦片**——geojson-vt 生成瓦片（点图层用 Supercluster 聚合），vt-pbf 编码成 MVT，再通过一个自定义协议喂给 MapLibre。最大 16 级，4096 extent。

两个细节能看出功力：瓦片索引对象**故意不放进 store**（太大、不可序列化，不能写进工程文件）；编码前会检查中止信号，因为 MapLibre 会取消滚出屏幕的瓦片请求。

**其它保护阈值**（这些数字本身就是很好的参考）：

| 阈值 | 值 |
|---|---|
| 切片渲染触发 | 50,000 要素 |
| DuckDB 结果物化确认提示 | 500,000 行 |
| 浏览器端 Sedona 上限 | 50,000 要素 |
| OSM PBF 提醒 / 超时 | 50 MB / 5 分钟 |
| 远程矢量文件上限 | 2 GiB（DuckDB-WASM 用 32 位存远程文件大小） |
| 本地 COG 上限 | 2 GiB |
| 撤销历史软预算 | 500,000 要素 |

**属性表是虚拟化的**，但排序、筛选、选择是在完整数据模型上跑的，虚拟化只管渲染。

**撤销历史有内存上限。** 因为每个快照都持有图层的完整 GeoJSON，反复编辑会把好几份副本钉在内存里。做法是设一个要素数软预算，超了就丢最老的快照，但**永远保留最新一个**，保证大编辑至少能撤销一步。滑块拖动会在 400ms 内合并成一次撤销记录。

**体积是通过 CDN 分发来控制的。** 三个重量级 WASM 引擎（PGlite+PostGIS 约 25MB、CereusDB 约 40MB、gdal3.js 约 28MB+12MB）都不打进包，运行时按版本号从 CDN 拉，首次用过之后 Service Worker 会缓存下来离线可用。源码注释里留了两处历史记录：**把 PGlite 打进包会让二进制从 42MB 涨到 63MB，CereusDB 会让安装包从 27MB 涨到 36MB**——这就是安装包保持在 30MB 的原因。

**一个诚实的性能问题。** 文档里有一整节 Linux/WebKitGTK 的排查记录：空白地图稳定 60 FPS，但只要有瓦片图层，**加载瓦片期间帧率掉到个位数**，加载完立刻回到 60。根因是 WebKitGTK 在主线程处理每张新瓦片的纹理上传，**一个瓦片集成周期约 125 毫秒，而 Chromium 只要几毫秒**。作者排除了软件渲染、GPU 饱和、Tauri IPC、JSON.parse、合成器延迟等一堆可能。缓解措施（加大瓦片缓存、512px 栅格瓦片、关掉淡入）文档里写了，但**还没实现**。macOS/Windows 的 WebView 未测试。

> **编者注：** 能把这种负面结果写进架构文档的项目不多。这一做法值得肯定。

---

## 十三、它的边界

说完优势，来谈谈局限性。

!!! warning "它不是 QGIS 的替代品"
    这是多篇评测的共识，作者自己也没这么宣称。

**一、功能范围是故意收窄的。** 它聚焦在浏览器工作流、本地处理、云原生格式、空间 SQL、现代可视化和可移植性。复杂的专业流程该用 QGIS 还得用 QGIS。

**二、迭代速度是双刃剑。** 两个多月从 0 到 2.4.0，2.0.0 到 2.1.0 只隔了大概 19 小时。拿它做生产环境的长期依赖，得想清楚这个 churn 风险。

**三、几个明确的格式缺口。** glTF/GLB 没有本地文件选择器（只能填 URL）、`.obj` 完全不支持、Excel 不支持、HDF4 不支持、原始 `.osm` XML 不支持。

**四、平台能力不对等。** 见第十节那张表。别拿浏览器版的体验去代表全部。

**五、Cesium 3D 球要 Ion token。** 免费额度够个人玩，团队用要算账。

**六、国内环境。** 底图、地形、Photorealistic 3D Tiles 这些默认源都在墙外；坐标系走标准 WGS84，**GCJ-02 偏移得自己处理**。想认真用得先解决这两件事。这部分暂无可靠的实测信息，留给实际使用者补充。

---

## 写在最后

拿到一个混装了 shp、tif、gpkg、tileset.json 的压缩包，以前要开三四个软件；现在的答案是：**打开一个 30MB 的应用（或者干脆一个网页），全拖进去。**

GeoLibre 真正的价值在于——不在于它比 QGIS 强（它不强），而在于它把**「看一眼数据」这件事的成本降低到了接近零**。这个位置以前是空的。

对做 Cesium / 三维 GIS 开发的人，它还有一层参考价值：**引擎无关的 store 设计**。把状态存成普通的图层记录和视图状态，而不是绑死在某个渲染引擎的对象上，第二个渲染器就能平滑插进来。这个思路值得借鉴。

使用路径按场景分：

1. **只想看看** —— 直接开 `web.geolibre.app`，不用装不用注册
2. **要真干活** —— GitHub Releases 下桌面版，或走微软商店 / Homebrew / winget，两分钟的事
3. **Python 用户** —— `pip install geolibre`，要 GeoPandas 支持就 `pip install "geolibre[all]"`，需要 Python 3.10+
4. **内网 / 离线环境** —— `VITE_PYODIDE_INDEX_URL` 和 `VITE_DUCKDB_SPATIAL_EXTENSION_PATH` 可以把 Pyodide 和 DuckDB 空间扩展指到内部镜像，**不用重新构建**；官方也有 Docker 镜像 `ghcr.io/opengeos/geolibre:latest`
5. **二次开发** —— npm workspaces 单体仓库，所以要用 **npm**（仓库跟踪 `package-lock.json`）配 **Node 22+**；主应用在 `apps/geolibre-desktop`，MIT 许可

最后还是那句：拿它做数据预览和探索，推荐；用于生产环境，再等等，至少等版本迭代节奏趋于稳定。
