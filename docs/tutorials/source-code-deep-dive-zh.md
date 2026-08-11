# GeoLibre 源码深度拆解：值得 WebGIS 开发者复用的核心技术

> **摘要**：本文深度剖析 GeoLibre 源码架构，包含依赖选型、DuckDB‑WASM Spatial 核心引擎、Web 端性能优化、状态管理、离线 PWA 缓存及云原生地理空间数据方案。文中全部标注源码文件路径，方便开发者查阅复用。
>
> **原文来源**：微信公众号"GIS开发手记"，原文链接：<https://mp.weixin.qq.com/s/482yiH-VsKP7OmBw9UWG6g>
>
> **本文使用简体中文撰写。**

## 前言

本文对照 GeoLibre 仓库源码逐层拆解项目架构，梳理项目依赖选型、DuckDB-WASM 空间计算内核、前端性能优化策略、状态管理设计、离线缓存三层策略与云原生地理数据整套方案，文中标注全部对应源码文件路径，所有技术方案均可直接复用至 WebGIS 项目。


## 一、它的工具箱：值得单独拿出来看的开源库

仓库是 npm workspaces 单体仓库，7 个包 + 桌面应用。依赖按用途归类如下，以下标注的为值得重点关注的库。

### 1.1 格式解析：轻量优先，重武器备用

| 库 | 版本 | 负责 | 为什么是它 |
|---|---|---|---|
| **`@duckdb/duckdb-wasm`** | 1.33.1 | GeoParquet、FlatGeobuf、GML、DXF、TAB，以及空间 SQL | 一个库同时当**格式驱动**和**计算引擎** |
| **`shpjs`** | 6.2 | Shapefile | 纯 JS 几十 KB；`.prj` 定投影、`.cpg` 定编码（**中文属性乱码可以得到正确处理**） |
| **`fflate`** | 0.8 | zip / kmz / aprx 解压 | 极小极快 |
| **`sql.js`** | 1.14 | GeoPackage 读**和写** | **GPKG 本质就是 SQLite**，轻量高效 |
| **`exifr`** | 7.1 | 照片 EXIF GPS → 点图层 | 无人机场景实用 |
| **`gdal3.js`** | 2.8 | 只用于地理配准的 GeoTIFF/COG 导出 | wasm ~28MB + data ~12MB，只从 CDN 拉，从不打包 |
| **`geotiff`** | 3.0 | GeoTIFF 解码 | — |
| **`h5wasm` / `netcdfjs`** | — | HDF5 / NetCDF-3 | 分工明确，各管一种 |
| **`@osmix/pbf` `@osmix/core`** | — | OSM PBF | 跑在 Web Worker 里 |
| **`pmtiles`** `proj4` `fast-xml-parser` | — | 瓦片包 / 投影 / XML | 基础件 |

**这里最值得借鉴的是「按格式选最轻的路径」。** 源码里 `packages/plugins/package.json` 有 60 多个依赖，但没有一个「大一统读取层」——每种格式各走各的最短路。

![支持格式](https://assets.geolibre.app/images/add-data-formats.webp)

KML 那条尤其能说明取舍。`docs/architecture.md:61` 写得很直白：KML 由**自研解析器**读取，为的是**保留内嵌符号化**，输出 simplestyle-spec 属性（`fill`、`stroke`、`stroke-width`），这样带样式的 KML 在 GeoLibre 里和在 Google Earth 里长得一样；解析器读不了的才退回 DuckDB Spatial，**代价是丢掉样式**。

> **关键启发：** 通用库为了统一数据模型，一定会丢掉格式特有的信息。而那些信息往往正是用户最在意的部分。

同样的模式在 Shapefile 上再现一次：**先用 shpjs，读不了才试 DuckDB Spatial**。**快路径 + 慢而全的兜底，是格式解析的通用套路。**

### 1.2 空间计算：四层引擎，默认最轻

这块的分工很容易看混，按源码捋一遍（依据 `docs/architecture.md:75-79`）：

| 引擎 | 在哪跑 | 定位 |
|---|---|---|
| **Turf.js**（`@turf/*` 二十来个子包） | 浏览器纯 JS | **矢量工具的默认引擎**，零依赖零后端 |
| **GeoPandas / Shapely** | Python sidecar | 需要**投影感知**结果时的升级项 |
| **GeoPandas / Shapely** | 浏览器 Pyodide | **同一份代码**，Web 版也能用 |
| **DuckDB / PGlite+PostGIS / SedonaDB** | 浏览器 或 sidecar | SQL Workspace 的三个引擎 |

注意 Turf 是**按需引入子包**的（`@turf/buffer`、`@turf/intersect`……），不是整包 import。这个习惯很重要——Turf 全量引入是很大一坨，按子包引才有意义。

那条「一份代码两处运行」的设计写在 `docs/architecture.md:77`：几何逻辑是一个**无框架模块** `backend/geolibre_server/geolibre_server/vector_ops.py`，一个 Vite 插件（`vite-plugins/copy-vector-ops.ts`）把它复制进前端包，浏览器侧用一个经典 Web Worker 加载 Pyodide、装 `geopandas`、通过 JSON 字符串边界调 `run_vector_tool`。

> **实际教训：** 做过 GIS 的都知道这个坑——前端 turf 算缓冲区，后端 PostGIS 算缓冲区，面积差 0.3%，追两天发现是分段数默认值不同。

### 1.3 渲染与图层：MapLibre 插件生态

| 库 | 负责 |
|---|---|
| **`maplibre-gl`** 5.24 | 主地图 |
| **`deck.gl`** 9.3（core/layers/geo-layers/mesh-layers/aggregation-layers/mapbox） | COG、3D Tiles、I3S、可视化图层，交织进 MapLibre 画布 |
| **`maplibre-gl-3d-tiles` / `-lidar` / `-splat` / `-raster` / `-vector`** | **不换引擎，MapLibre 上直接加 3D Tiles、点云、高斯泼溅** |
| **`@developmentseed/deck.gl-geotiff` / `-raster`** | COG 渲染 |
| **`@carbonplan/zarr-layer`** | Zarr 科学数据 |
| **`@loaders.gl/i3s`** / **`@esri/maplibre-arcgis`** | Esri 生态接入 |
| **`@geoman-io/maplibre-geoman-free`** | 绘制与编辑 |
| **`maplibre-gl-time-slider` / `-swipe` / `-layer-control` / `-basemap-control`** | 交互控件 |
| **`@tanstack/react-virtual`** | 属性表虚拟化 |
| **`cesium`** 1.143 | 可选的三维球分屏，**懒加载 ~4.8MB 独立 chunk** |

![3D Tiles、矢量、glTF、高斯泼溅混排在同一个图层列表](https://assets.geolibre.app/images/3dtiles.webp)

**`maplibre-gl-*` 这一串是很多人不知道的：3D Tiles、COPC 点云、高斯泼溅，全都能在 MapLibre 画布里加载，不需要引入 Cesium。** 如果项目只是「想看看 3D Tiles」，这条路比上一整套三维引擎轻得多。

### 借鉴要点

- **一、按格式选最轻的路径。** 前端库体积差异是数量级的（shpjs 几十 KB vs gdal3.js 40MB），选型体积的代价是用户在承担首屏加载时间。
- **二、快路径 + 兜底链：** 90% 的正常数据走轻量解析，10% 的怪数据退回重武器。
- **三、保真度优先于通用性。** 为「保留 KML 符号化」自研一个解析器是值得的。
- **四、Turf 按子包引入**，不要整包 import。

---

## 二、DuckDB-WASM Spatial：一个库同时当格式驱动和计算引擎

这一节是这篇的重点。**如果只看一件事，看这个。**

先把 WebAssembly 这件事一句话说完：GeoLibre 仓库里带 `wasm` 的标识符有 315 处命中，**数据库、语言运行时、原生工具链、编解码、机器学习**五类能力全部由 WASM 引擎承担——DuckDB、sql.js（SQLite）、PGlite + PostGIS、CereusDB（SedonaDB）、Pyodide、`geolibre-wasm`（Whitebox 的 WASI 构建）、gdal3.js、`cog-tiler-wasm`、h5wasm、onnxruntime-web。**原生语言连起来看就明白了：C、C++、Rust。WASM 在这里不是给 JS 加速，是把 GIS 领域几十年积累的原生生态整体搬进浏览器。**

![数据处理菜单：背后是一排 WASM 引擎](https://assets.geolibre.app/images/processing-tools-menu.webp)

这十来个引擎里，**有一个值得当下就该去试的**：`@duckdb/duckdb-wasm` 加上它的 spatial 扩展。原因很简单——其他引擎解决的是「某一类活儿」，而它同时是**格式驱动**和**计算引擎**，一个库就能把「读数据」和「算数据」两件事一起接管。

### 2.1 先把三层关系讲清楚

这三个名字经常被混着说，其实是套娃：

| 层 | 是什么 | 关系 |
|---|---|---|
| **WebAssembly** | 浏览器里的二进制指令格式 | 只是一种「运行原生代码的能力」，本身不做任何 GIS 的事 |
| **DuckDB-WASM** | DuckDB（C++ 写的分析型数据库）编译成 WASM 的产物 | **它是「用 WASM 实现的 DuckDB」，不是 WASM 本身** |
| **Spatial 扩展** | DuckDB 的空间扩展，同样是一份独立 `.wasm` | 需要**单独 `INSTALL` / `LOAD`**，不加载就没有任何空间函数 |

> **最容易踩的认知误区：** 以为装了 duckdb-wasm 就有空间能力。没有。`ST_Read`、`ST_Transform`、`ST_AsWKB` 这些全在 spatial 扩展里，它是运行时从 CDN 拉下来再加载的第二份 WASM。

而 spatial 扩展的 `ST_Read` 背后，是 **GDAL 的一个子集**。这句话的含义是：在浏览器里发一条 SQL，就能读这个子集覆盖的那些矢量格式。注意它用的是扩展自带的 GDAL，不是机器上装的那份，所以具体能读哪些取决于当前加载的构建——用 `SELECT * FROM ST_Drivers()` 可以列出来。

### 2.2 GeoLibre 拿它干了什么

源码中 DuckDB 的调用点归类如下：

| 用途 | 走的接口 | 备注 |
|---|---|---|
| GeoParquet | `read_parquet` | **本地和远程都走它**，远程按 HTTP Range 拉 |
| FlatGeobuf / GML / DXF / TAB 等 | `ST_Read` | GDAL 后端，能读多少看扩展装载情况 |
| Shapefile（zip） | 先 `shpjs`，读不了再交给 Spatial | 轻量优先，重武器兜底 |
| KML | 先自研解析器（保符号化），失败再交给 Spatial | Spatial 只能拿到几何，样式会丢 |
| CSV 里的 WKT 几何列 | DuckDB SQL | 直接把文本几何转成图层 |
| 坐标系转换 | `ST_Transform` | 老式 `crs` 字段的 GeoJSON 靠它重投影 |
| **SQL 工作区** | 完整 DuckDB SQL | **已加载的图层被注册成表，可以直接 JOIN** |

> **关键洞察：** 注意最后一行。这是一个很容易被低估的设计：地图上的图层同时是 SQL 里的表，用户可以对着两个图层写 `JOIN`、写 `ST_Intersects`，结果再直接变成新图层。**「地图」和「数据库」在这里是同一份东西的两个视图。**

![矢量数据处理](https://assets.geolibre.app/demos/vector-data-demo.gif)

SQL 工作区里还有三处「帮用户把话说全」的改写，做 SQL 控制台的可以直接照这个思路来：

- **`FROM` / `JOIN` 后面裸写一个 URL 或本地路径就行**，源码会按扩展名自动套上对应 reader（`read_parquet`、`read_csv_auto`、`ST_Read`……），用户不用记哪种格式配哪个函数
- `s3://`、`gs://`、`az://` 会被翻译成对应的公开 HTTPS 地址，走同一条 HTTP Range 通道
- **reader 参数里的 HTTP URL 会被改注册成 DuckDB 文件句柄**，由 JS 侧发 Range 请求，而不是走 WASM 内置的 httpfs——因为后者在很多服务器上直接报错

> **实现细节：** 这三处改写都只作用于**真正的 reader 调用参数**，字符串字面量和注释里长得像 URL 的东西会被跳过（源码里专门做了一遍 SQL 字面量遮罩）。**做 SQL 改写千万别拿正则直接怼原文。**

### 2.3 接进项目时，源码里这四个细节值得借鉴

**第一，bundle 要按浏览器能力选。** duckdb-wasm 发了多个 WASM 构建（mvp / eh 等），能力不同、体积不同。`duckdb-wasm-bundles.ts` 里只做了一件事：把 mvp 和 eh 两份产物用 Vite 的 `?url` 拿到地址，交给 `duckdb.selectBundle()` 在运行时挑：

```ts
const MANUAL_BUNDLES: duckdb.DuckDBBundles = {
  mvp: { mainModule: duckdbWasmMvp, mainWorker: mvpWorker },
  eh: { mainModule: duckdbWasmEh, mainWorker: ehWorker },
};
export function selectDuckDbBundle() {
  return duckdb.selectBundle(MANUAL_BUNDLES);
}
```

**手动列 bundle 而不是用默认 CDN 解析，是为了让 Vite 把 wasm 和 worker 打成带哈希的本地产物**——这样才能被 Service Worker 的 CacheFirst 安全缓存（见第五节）。

**第二，扩展加载必须做成「按实例只跑一次」。** `INSTALL spatial` 会走网络，`LOAD` 有状态，并发调用会互相打架。GeoLibre 的做法很值得借鉴：

```ts
// 按实例记忆化：共享库和 SQL 工作区各有自己的 DB，各记各的
const spatialExtensionByDb = new WeakMap<duckdb.AsyncDuckDB, Promise<void>>();

export async function ensureSpatialExtension(db, connection, beforeLoad?) {
  let promise = spatialExtensionByDb.get(db);
  if (!promise) {
    promise = (async () => { /* …INSTALL / LOAD… */ })();
    spatialExtensionByDb.set(db, promise);
  }
  try {
    await promise;
  } catch (error) {
    // 只在记忆项仍指向这次失败时才清除，否则下次永远重试不了
    if (spatialExtensionByDb.get(db) === promise) spatialExtensionByDb.delete(db);
    throw error;
  }
}
```

这段小代码里有三个决定。缓存的是 Promise 不是布尔值——并发调用共享同一次加载。用 `WeakMap` 按实例存——不是模块级单例，实例被重建后自动失效。失败要清除记忆，但清除前先校验身份——避免清掉别人刚写进去的新加载。**三条缺一条，就会在生产环境上遇到「偶发的空间函数不存在」。**

**第三，留一个「不联网也能加载扩展」的口子。** `INSTALL spatial` 默认从 DuckDB 的扩展仓库下载。GeoLibre 加了一个环境变量 `VITE_DUCKDB_SPATIAL_EXTENSION_PATH`：配了就直接 `LOAD '<本地路径>'`，跳过 `INSTALL`。

做内网、政务、离线桌面端的，这一行配置就是能不能用的分界线。同样的模式还复用给了 h3 社区扩展（`INSTALL h3 FROM community`）——DuckDB 的扩展生态在浏览器里是能用的，这点很多人不知道。

**第四，Worker 和生命周期要自己管。** DuckDB 跑在独立 Worker 里，**WASM 堆是跟着 Worker 走的，只有 `terminate()` 才真正还给系统**。GeoLibre 给 SQL 工作区的实例做了引用计数：还有查询在跑就先标记「空闲时销毁」，等最后一个查询释放再关。**这在需要重建实例的场景里是刚需——直接 terminate 会把正在跑的查询打断。**

### 2.4 一个真实的坑，比任何教程都值钱

源码注释中有一条值得关注的记录，**它比上面所有内容都更能说明「在浏览器里跑数据库」是什么体验**：

> duckdb-wasm 1.33.1-dev45 会**永久破坏**一个实例的远程 `read_parquet`——只要这个实例在**完成第一次远程读取之前**执行了 `LOAD spatial`。之后所有远程 Parquet 读取都报 `stoi: no conversion`，而且**无法在原地恢复**。

GeoLibre 的应对是两手：

**一是预热。** `ensureSpatialExtension` 那个 `beforeLoad` 钩子就是干这个的——在 `LOAD spatial` 之前，先拿这条查询自己的远程 reader 跑一次 `SELECT 1 FROM read_parquet(…) LIMIT 0`。**`LIMIT 0` 只会取 Parquet 的 footer，几乎不产生额外流量。**如果这条查询本身没有远程 Parquet，就退回读一个公开的小样本文件兜底。

**二是重建。** 万一还是中招了（比如上一次预热失败），`runSqlQuery` 会捕获 `stoi: no conversion`、调 `resetSqlDatabase(poisoned)` 把那个实例整个换掉、然后**重试一次**。重建时会重新走一遍预热，所以第二次是干净的。

这里还有两个防御细节：重试只在语句里**确实有远程 reader 调用**时才触发（字符串字面量里出现的 URL 不算），并且 `resetSqlDatabase` 会先确认「要换掉的实例仍是当前实例」再动手。

!!! warning "三条能带走的经验"

    - **WASM 扩展的加载顺序是有副作用的。** 不要假设「什么时候 LOAD 都一样」，尤其是涉及网络子系统的扩展。
    - **把「预热」和「重建」当一等公民，而不是补丁。** 遇到这类不可逆的坏状态，能优雅恢复的前提是实例本来就是可替换的。
    - **给上游 bug 留退路，但把范围收窄到症状。** 匹配具体错误消息 + 具体条件 + 只重试一次，而不是无脑 catch 全部重试。

### 2.5 它的边界在哪

关于 DuckDB-WASM 的赞誉文章很多，这一节专门整理源码中揭示的实际限制。了解这些限制之后，反而更清楚其适用边界——知道约束所在，比在不知边界的情况下使用更稳妥。

| 限制 | 数值 | 原因 |
|---|---|---|
| 远程文件大小 | **2 GiB** | DuckDB-WASM 的 HTTP 文件系统用 32 位存远程文件大小 |
| 单标签页内存 | ~4 GiB | WASM 的地址空间上限 |
| 要素数确认阈值 | 500,000 | 超过要用户确认才物化 |
| 线程 | 单线程 | 超大数据该回服务端就回服务端 |

2 GiB 那条有个细节很有参考价值：这个门禁是**在开始摄取之前**就判掉的（`_registerSource` 跑在流式分支前面，所以「流式读取」也绕不过去）。GeoLibre 的做法是在文件浏览面板上直接把话说清楚，而不是让用户点了 Add 之后等一个必然失败的结果。**能提前判定的失败，就不要留到运行时。**

还有一条关于**拷贝 vs 流式**的取舍：只有 GeoParquet 真正支持「原地查询不拷贝」，其他格式即使给了 stream 选项也会悄悄回落成拷贝——所以 GeoLibre 干脆只在 GeoParquet 上显示这个按钮。**一个点了没区别的按钮，比没有这个按钮更糟。**而拷贝模式的内存占用大致跟**解压后**的数据量走，是 Parquet 磁盘体积的好几倍，超过 100 MB 就会提示改用流式。

最后一个有意思的对照：GeoLibre 桌面端留了个 `native-duckdb` 编译开关，可以换成原生 DuckDB。但 Rust 侧写着一条硬约束——

```rust
compile_error!("the `mas` (Mac App Store) build must not enable `native-duckdb`: \
  DuckDB loads its spatial extension as unsigned native code at runtime, \
  which App Sandbox and App Store guideline 2.5.2 forbid.");
```

原生版更快，但它运行时加载未签名的原生扩展，直接违反 Mac App Store 的规则。反过来说，**WASM 版本因为跑在沙箱里，反而是那个「哪都能上架」的选择**。这是选型时很少有人算到的一笔账。

### 2.6 借鉴要点

- **一、先试 DuckDB-WASM Spatial，再考虑别的。** 一个库同时解决「读格式」和「算空间」，是目前 Web 端投入产出比最高的一步。远程 GeoParquet + `read_parquet`，十几行代码，不需要任何后端。
- **二、扩展加载做成「按实例记忆化的 Promise + 失败带身份校验地清除」。** 这个模式对所有「异步一次性初始化」都成立，不止 DuckDB。
- **三、必须留本地扩展路径的口子。** 内网 / 离线 / 桌面端，全靠这一行配置。
- **四、WASM 引擎一律：懒加载 + 独立 chunk + Worker 执行 + 版本锁死 + 生命周期可重建。** 别让它上主线程，别让它进首屏。
- **五、把硬限制写成常量并前置校验。** 2 GiB、50 万要素、~4 GiB 堆——能提前告诉用户的失败，不要留到运行时。

---

## 三、Web 端性能：五条优化，加一个负面结果

这一节所有数字均定位到了具体文件行号。

### 3.1 阈值化：定好数字，过线换实现

核心思路一句话：**不追求一套方案通吃，而是在明确的阈值上切换实现。**

源码里的阈值常量（都是可查的）：

| 常量 | 值 | 位置 | 保护什么 |
|---|---|---|---|
| `LARGE_VECTOR_FEATURE_THRESHOLD` | **50,000** | `core/src/types.ts:670` | 主线程 GeoJSON 解析 |
| `maxHistoryFeatureCount` | 500,000 | `core/src/history.ts:29` | 撤销栈内存 |
| `DUCKDB_VECTOR_FEATURE_WARN_COUNT` | 100,000 | `core/src/types.ts:1838` | 结果物化内存 |
| `MAX_CEREUS_FEATURES` | 50,000 | `lib/sedona-workspace.ts:25` | WASM 堆 |
| `MAX_DERIVED_FEATURES` | 50,000 | `map/src/derived-geometry.ts:37` | 派生几何计算 |
| `historyCoalesceMs` | 400 ms | `core/src/history.ts:6` | 撤销记录爆炸 |
| 远程文件 | 2 GiB | `plugins/remote-file-formats.ts` | DuckDB-WASM 32 位 |

**注意这些阈值全是命名常量、全带文档注释、而且 `historyCoalesceMs` 和 `maxHistoryFeatureCount` 都有 setter 可运行时改（测试里设成 0）。** 这比散落在代码里的 magic number 高一个段位。

> **启发：每个阈值都要说得出「它保护什么」。** 说不清保护目标的阈值缺乏可靠依据，难以长期维护。

### 3.2 客户端切片：超过 5 万要素就现场切瓦片

完整流水线在 `packages/map/src/geojson-vt-protocol.ts`，一步步是这样的：

- 索引用 **`@maplibre/geojson-vt`**（注意是 MapLibre 的 fork，**Supercluster 也在这个包里**，注释说它就是「the same engine MapLibre uses internally」）
- 点图层用 `Supercluster` 索引，其它用 `GeoJSONVT`
- 编码用 `@maplibre/vt-pbf` 的 `fromGeojsonVt`
- 通过自定义协议 `geolibre-gjvt` 喂给 MapLibre
- `TILE_EXTENT = 4096`，`TILE_MAX_ZOOM = 16`（超过就让 MapLibre over-zoom）

![大数据量矢量加载](https://assets.geolibre.app/demos/vector-data-demo.gif)

两个细节值得单独说。

**第一，瓦片索引放模块级 Map，不进 store。** 源码注释是这么写的：

> Keyed by layer id. Module-level rather than on the Zustand record because **tile indexes are large, non-serializable objects that must not enter app state or be written to `.geolibre.json`**.

**这给了一个特别好用的判据：什么该进全局状态？——能写进工程文件的才进。** 派生产物（瓦片索引、空间索引、WebGL buffer、解码位图）一律放模块级缓存或引擎侧。

**第二，编码前先看中止信号。** 就一行：

```ts
// packages/map/src/geojson-vt-protocol.ts:150
if (abortController?.signal.aborted) return { data: new ArrayBuffer(0) };
```

因为 MapLibre 会取消滚出屏幕的瓦片请求，结果反正会被丢掉，那就别算。

**一般化：凡是「按需生产」的异步管线，都必须支持取消。** 对应到实际项目里：快速拖动地图时还在给离屏瓦片做投影转换、属性表快速翻页时前几页查询还在跑、图层快速切换时上一个的解析结果晚到覆盖了新图层（**经典竞态**）。

!!! warning "`AbortController` 不只是给 fetch 用的"
    任何超过一帧的循环，都该在循环体里检查 `signal.aborted` 并早退。

### 3.3 撤销栈：三个精细到值得借鉴的处理

`packages/core/src/history.ts` 这个文件值得直接打开看，一百多行，密度很高。用的是 `zundo`（Zustand 的时间旅行中间件）。

问题：**每个快照都持有图层的完整 GeoJSON**，反复编辑会把好几份副本钉在内存里（注释里点了 issue #341）。

**处理一，软预算按要素数算。** 注释解释了为什么不算字节：「Feature count is a cheap proxy for payload size; it avoids serializing geometry on every edit」——**为了度量内存而序列化几何，本身就是性能问题。**

**处理二，永远保留最新一个快照：**

```ts
// trimHistoryBySize：从新往旧走，累计装不下就停
// The newest snapshot is always retained, even if it alone exceeds the budget.
let total = distinctFeatureCount(pastStates[lastIndex], seen);
```

**「内存不够就清空撤销栈」是很多项目的做法，但那意味着用户在最需要撤销的那一刻——刚做完一次大编辑——恰好没有撤销可用。**

**处理三，按对象引用去重。** `distinctFeatureCount` 用一个 `Set<object>` 记住见过的 payload：没改动的图层在多个快照间共享同一个引用，只算一次。**所以「保留很多个小图层的快照」几乎没有额外内存开销。**

还有一个容易忽略的细节：那个 400ms 不是普通防抖，是**前沿防抖（leading-edge debounce）**，作为 zundo 的 `handleSet`：

> firing only on the leading edge records the pre-burst state once

差别很关键——**要记录的是「这串连续操作之前」的状态**，所以必须在第一次触发时就记，而不是等安静下来再记。**拖滑块前的值才是想撤销回去的值。** 如果用普通的尾部防抖，存下来的是拖拽过程中的某个中间值。

### 3.4 虚拟化只管渲染

属性表用 `@tanstack/react-virtual` 虚拟化，但**排序、筛选、选择跑在完整数据模型上**。

这句话平淡，却是个高频错误：很多虚拟列表实现是「只对已渲染的行排序」，结果排序结果随滚动位置变化、全选只选中可见行。**而且这类 bug 在小数据量测试时根本复现不出来。**

### 3.5 体积：懒加载做到什么程度

`apps/geolibre-desktop/vite.config.ts` 里的 `manualChunks` 是这套东西的核心。举个最有代表性的例子——Cesium：

> CesiumJS (~4.8 MB) for the 3D-globe view. Lazily imported only when a pane switches to the globe……kept in its own build chunk and **off the 2D boot path**.

**「off the boot path」是关键词。** 对 Web 端 GIS 来说，最容易获得的性能提升就是这个：真正需要三维的用户可能只有 20%，没理由让 100% 的人为它承担首屏加载开销。

源码注释中有一份详细的体积分析，整理如下：

| 重资源 | 体积 | 处理方式 |
|---|---|---|
| CesiumJS | ~4.8 MB | 独立 chunk，切到球面视图才 `import()` |
| PGlite + PostGIS | ~25 MB（打进桌面端会多 **~22 MB 几乎不可压缩的体积**） | 默认走 jsDelivr CDN，不进构建 |
| gdal3.js | wasm ~28 MB + data ~12 MB | **从不打包**，只从 CDN 取；关掉 CDN 就是关掉这个功能 |
| Pyodide / CereusDB | 各数十 MB | CDN 加载，PGlite 和 CereusDB 可用构建开关改成内置 |

**所以那个「安装包只有 30MB」的数字，是用「几乎所有重引擎都不打包」换来的。**这个思路值得借鉴：重引擎的默认位置应该是「用户第一次点它的时候才下载」，不是「装在包里以防万一」。

配套还有一条：**所有外部资源地址都做成运行时可配置。** `VITE_PYODIDE_INDEX_URL`、`VITE_DUCKDB_SPATIAL_EXTENSION_PATH`、`VITE_CESIUM_TOKEN` 都能在运行时指到内部镜像，**不用重新构建**。

这条对国内内网/离线交付是保命设计。CDN 地址硬编码进 bundle，等着的就是现场断网时重新打包。

还有一条容易忘的：`packages/processing/src/ort.ts` 里注明，onnxruntime-web 的 WASM 产物从 CDN 拉，**CDN 上的版本必须和 npm 里 pin 的版本严格一致**，否则是运行时崩。**凡是「JS 胶水在包里、WASM 产物在 CDN」的库都有这个坑，做法是把版本号写成一个常量，两边都从它取。**

说到底：CDN 地址、WASM 版本、镜像路径——三样东西任何一样写死在代码里，等着的就是某个周五晚上的紧急打包。

### 3.6 一个诚实的负面结果

`docs/architecture.md` 最后一节标题就叫「Performance: map rendering on Linux (WebKitGTK)」，里面的细节值得完整看一遍：

- 空白地图任意缩放级别稳定 60 FPS
- 一旦有瓦片图层（矢量**或**栅格 XYZ），**加载瓦片期间 FPS 掉到个位数**，加载停止立刻回到 60
- 根因：WebKitGTK 在主线程做每张新瓦片的 GPU 上传（栅格是纹理，矢量是顶点缓冲），走同步 WebGL 调用，加上随后的淡入重绘
- **单次瓦片集成渲染周期实测 ~125 ms，Chromium 只要几 ms**
- **明确排除**：矢量瓦片解析和 bucket 构建跑在 MapLibre 的 Worker 里，不是瓶颈

排除清单写得极细：软件渲染（确认在用 Intel i915 GPU）、GPU 饱和（渲染引擎还有 ~20% 空闲）、Tauri IPC 文件读取（22MB GeoJSON 约 126ms）、`JSON.parse`（约 36ms）、KWin 合成器延迟、`renderWorldCopies`、球面 vs 墨卡托投影、`preserveDrawingBuffer`。

文档里甚至给了复现用的一行 FPS 计数器，和三条**尚未实现**的缓解措施（加大 `maxTileCacheSize`、512px 栅格瓦片、`fadeDuration: 0`，并且注明要按 WebKitGTK 门控，别拖累 Chromium 构建）。

两个教训：

- **跨 WebView 的性能不可外推。** Chrome 上测的 60 FPS，在 Electron 的旧 Chromium、国产浏览器内核、WKWebView 上都可能不成立。**有客户端交付需求的必须在目标 WebView 上实测。**
- **把排查过程连同「已排除项」写进文档，比只写结论有价值。** 那份 8 项排除清单能给下一个人省两天。

> **编者注：** 能把这种负面结果写进架构文档，还附上复现方法和未实现的待办，这个项目的工程素养是够的。

---

## 四、状态管理：三个可直接复用的小模式

这节讲的是纯 Web 工程，跟 GIS 关系不大，但迁移成本最低。

`@geolibre/core` 的依赖只有四个：`zustand`、`zundo`、`uuid`、`@maplibre/maplibre-gl-style-spec`。**注意它不依赖 `maplibre-gl` 本体**（那个 style-spec 包只是用来求值样式表达式的），所以状态层和渲染层是真的分开的。

![图层面板：所有参数改的都是 store](https://assets.geolibre.app/images/raster-style-panel.webp)

**模式一，常量数组当单一来源。** `packages/core/src/types.ts:62` 那 20 个图层类型：

```ts
export const LAYER_TYPES = [
  "geojson", "raster", "wms", "wmts", "xyz", "vector-tiles", "arcgis",
  "pmtiles", "mbtiles", "zarr", "lidar", "gaussian-splat", "3d-tiles",
  "cog", "flatgeobuf", "geoparquet", "duckdb-query", "deckgl-viz",
  "video", "image",
] as const;
export type LayerType = (typeof LAYER_TYPES)[number];
```

注释说明了为什么要这么写：**「as a runtime list so untrusted input (an imported Layer Library bundle, a hand-edited project) can be validated against it」，而且 `LayerType` 由数组派生，「so the two cannot drift」**。

> **启发：一份定义同时得到运行时校验数据和编译期类型，还杜绝了两者漂移。** TS 项目里凡是「有限枚举 + 需要校验外部输入」的场景都该这么写。

**模式二，状态是扁平记录 + 极小的视图状态。** `MapViewState` 就五个字段：

```ts
export interface MapViewState {
  center: [number, number];
  zoom: number; bearing: number; pitch: number;
  bbox?: [number, number, number, number];
}
```

这个「小」是刻意的。状态越小，能序列化进工程文件的把握越大，能接第二个消费者（第二个地图面板、第二个渲染器、一个导出器）的成本越低。

**模式三，跨语言边界用 `SYNC:` 标记。** 这是翻阅源码过程中最意外的收获。

那 17 个矢量扩展名，在 TS 里是 `VECTOR_FILE_DIALOG_EXTENSIONS`（`lib/tauri-io.ts:154`），在 Rust 里是 `RESTORABLE_VECTOR_EXTENSIONS: [&str; 17]`（`src-tauri/src/lib.rs:418`）——**两份，因为跨语言没法共享常量**。他们的处理是在两边都写注释，下面这段原样引自 `lib/tauri-io.ts:150-153`：

> SYNC: RESTORABLE_VECTOR_EXTENSIONS in src-tauri/src/lib.rs must list the same extensions, or a format added here would be rejected by the Rust restore guard on every project reopen (**the bug this PR fixes**). Grep "SYNC:" to find the partner list.

注意括号里那句「the bug this PR fixes」——它指的是当初加上这条注释的那个 PR，对后来的读者已经没什么指向性了，但它记录的故障是真的：在 TS 里加了新格式，Rust 侧的守卫没加，于是每次重开工程都被拒。

> **启发：能合并成一份就合并；合并不了（跨语言、跨进程、跨仓库）就用一个统一的可 grep 标记把它们钉在一起，并在注释里写清楚「不同步会出什么事」。** 这比「大家注意保持一致」有用得多。

---

## 五、离线能力：Workbox 三层缓存策略

这节单独拎出来，因为国内做内网、离线、政务项目的人特别需要，而 `docs/architecture.md:83-100` 把这套写得非常完整。

Web 构建是一个可安装的 PWA，用 `vite-plugin-pwa` + Workbox。缓存**刻意分成三层**：

| 层 | 策略 | 内容 | 为什么这么分 |
|---|---|---|---|
| **预缓存** | Precache | HTML + 启动地图必需的 JS/CSS chunk | **首访之后无网也能开壳**；重型 chunk **排除在外**，避免首屏巨量下载 |
| **同源运行时缓存** | CacheFirst | `/assets/` 下的内容哈希产物：MapLibre、**DuckDB-WASM 及其 spatial 扩展**、各插件 chunk | 哈希文件名让 CacheFirst 安全——重新部署会生成新 URL，旧条目不会被当成新的 |
| **CDN 引擎缓存** | CacheFirst（独立规则 `geolibre-cdn-engines`） | jsDelivr 上的 Pyodide、PGlite/PostGIS、CereusDB、gdal3.js | URL 里嵌了精确版本号，同样不会供旧版；jsDelivr 的 CORS 头让它们是可正常校验和淘汰的 200，不是 opaque 响应 |

**所以这些 CDN 引擎的准确表述是：在 Web PWA 里，首次「成功」取回需要网络——CacheFirst 只有在真的存下了一份响应之后才会走缓存——此后才离线可用。** 桌面端根本不注册 Service Worker，这条对它不成立，见下面的要点。

那为什么不直接全打包进来？往下看这几个细节就明白了。

几个特别实在的细节：

- 想去掉「首次也要联网」，可以用 `GEOLIBRE_PGLITE_CDN=0`、`GEOLIBRE_CEREUS_CDN=0` 把它们塞回 `/assets/`——**代价是 PGlite 一个就给 Tauri 二进制加回 ~22 MB**
- **Pyodide 和 gdal3.js 没有这个开关。** Pyodide 永远走 CDN（`VITE_PYODIDE_INDEX_URL` 能改镜像，但**那个镜像不在两条 CacheFirst 规则的匹配范围内**，除非把它放到 `/assets/` 下，否则只能退回普通 HTTP 缓存）；gdal3.js 从不 vendor，`GEOLIBRE_GDAL_CDN=0` 的效果是**关掉那个导出功能**，不是打包它
- **桌面构建不装 Service Worker**（Tauri 自带资源已离线），所以桌面版每次安装都会重新拉一次 CDN 引擎
- 底图只缓存 CORS 友好的默认源（OpenFreeMap、CARTO），其它远程瓦片和 WMS/WFS **按设计就是离线不可用**
- 新部署用 `registerType: "autoUpdate"` + `skipWaiting`，但**故意压掉了 Workbox 默认的「激活时强制刷新」**——因为在 `/demo/` 这种相对 base 的子路径下会误触发，把用户正在编辑的地图状态冲掉。页面恢复交给 `installStaleChunkReload`，**只在孤儿 lazy chunk 404 时才重载**，还带冷却保护

!!! tip "最值钱的一条"
    最后这条是整节最有价值的——「只有经历过实际生产问题才会写出来」的代码。自动更新导致用户丢失未保存工作，是 PWA 最容易犯又最伤人的错误。

### 借鉴要点

- **一、缓存按「壳 / 同源重资源 / CDN 引擎」分三层，** 别用一条规则打天下。
- **二、内容哈希或版本号是 CacheFirst 能安全使用的前提。** 没有它，CacheFirst 就是「永久供应旧版本」。
- **三、明确写下「哪些东西离线一定不可用」**（远程服务、非白名单底图），别让用户去猜。
- **四、自动更新不要强制刷新页面。** 只在检测到孤儿 chunk 时重载，并加冷却。

---

## 六、云原生格式：它换掉的不是前端库，是整个分发架构

前面五节讲的都是代码，这一节讲的东西影响的是**架构和成本**。

传统链路：**数据入库 → GeoServer / ArcGIS Server 发布 → 切瓦片 → 前端请求服务**。需要维护一台服务器、一套发布流程、一份切片缓存，还要为它做监控、备份和扩容。

云原生链路：**数据转成 COG / GeoParquet / PMTiles / FlatGeobuf → 放到任何能响应 Range 请求的静态存储 → 前端按需取字节区间**。服务器这一环整个消失了，剩下的只是对象存储的流量费。

> **关键词是 HTTP Range。** 这些格式的共同点不是「压缩得更好」，而是**每个文件都把自己的布局元数据带在身上——头部或尾部、瓦片目录、R 树索引、金字塔概视、行组统计**——客户端先读几 KB 这样的元数据，算出自己要的是哪几段字节，再发一个 `Range` 请求取回来。所以静态存储就够了，不需要任何「服务」。

### 6.1 它到底好在哪：五条实打实的收益

**收益一，下载量按「要看什么」收敛，而不是按「文件有多大」。**

这是最根本的一条。传统格式（GeoJSON、Shapefile、条带式 GeoTIFF）**没法按字节区间局部读取——即便有索引也在旁挂的独立文件里，客户端仍然只能把数据整份拿下来**。云原生格式把索引放进数据文件自身，于是有了三个维度的裁剪：

| 裁剪维度 | 靠什么实现 | 效果 |
|---|---|---|
| **空间** | FlatGeobuf 的 R 树索引、PMTiles 的瓦片编排 | **只取视口内的要素/瓦片** |
| **分辨率** | COG 的金字塔（overviews）、PMTiles 的缩放层级 | 看全国就取最粗那一层，不解一亿像素 |
| **属性列** | GeoParquet 的**列式存储** | 只要 3 个字段就只读 3 列的字节，其余列一个字节都不碰 |

**第三条是 GeoParquet 最容易被低估的地方。列式存储 + 行组统计信息（min/max）意味着 `WHERE` 条件能被下推**——DuckDB 先看统计信息就知道整个行组都不满足条件，直接跳过，连那段字节都不用下载。

**收益二，解析成本从「几十毫秒的主线程阻塞」降到接近零。**

文本格式的隐性代价是 `JSON.parse`。这篇第三节 3.6 那份排查清单里有两个实测数字：**一份 22MB 的 GeoJSON，读文件约 126ms，`JSON.parse` 再花约 36ms**——而且都在主线程上。

二进制列式格式不存在这个环节：字节布局本身就是内存布局，DuckDB 读进来是向量化的列，不需要逐字符解析、不需要构造几十万个 JS 对象。**要素多的时候，真正卡住页面的往往不是渲染，是解析和 GC。**

**收益三，缓存变得几乎免费。**

云原生格式是**静态文件**，所以它天然吃得下整条现成的 HTTP 缓存链路：**CDN 边缘缓存、浏览器缓存、Service Worker、`ETag` / 不可变 URL**，一条都不用自己实现。

对比一下动态瓦片服务：切片缓存要自己建、失效策略要自己写、缓存命中率要自己盯。**而 Range 请求命中的是同一个不可变文件的同一段字节，CDN 层面就是一次普通的缓存命中。这篇第五节那套 Workbox 三层缓存策略，之所以能生效，前提就是资源是静态且带内容哈希的。**

**收益四，并发瓶颈从你的服务器上挪走了。**

瓦片服务的容量瓶颈在服务端 CPU：同时来 100 个用户就是 100 份渲染开销。**静态存储 + CDN 的扩容曲线是另一回事**——没有按用户计的渲染要扩，多来的量主要体现在流量费上，而且边缘缓存会把绝大部分请求截在离用户最近的节点。但容量规划并不会因此消失：缓存未命中仍会打到源站，对象存储也有自己的按前缀请求速率上限和出网流量账单。

这条对做政务大屏、公共服务门户这类「平时没人、开会时全省一起看」的场景特别关键：这种流量形状用瓦片服务扛，要么长期为峰值付费，要么峰值时挂掉。

**收益五，链路短了一整段，运维成本跟着塌下来。**

**没有发布流程，没有服务进程，没有数据库连接池，没有要打补丁的中间件。**数据更新就是覆盖一个文件。GeoLibre 整套「浏览器里直读远程 GeoParquet / COG / PMTiles」的能力就是这条路走通的证明，它接的那些在线目录（STAC、Source Cooperative、Overture Maps、Planetary Computer）全是这个模式。

**但也得说清代价，这四条是真的：**

- **小数据反而更慢。** 读头部、读索引、再取数据，是好几个网络往返；几百 KB 的 GeoJSON 一次请求就完事了，套云原生格式并不划算。**阈值大概在「一次请求下不完」的量级。**
- **Range 请求数量会明显变多。** HTTP/1.1 同样支持 `Range`，但在这个请求量级下强烈建议用 HTTP/2 或 HTTP/3，否则连接开销会把优势吃掉。
- **服务端必须支持 `Range` 和 CORS**（还要 `Access-Control-Expose-Headers`），这一点比预想中更容易出问题，下一小节专门讲。
- **算力从服务端挪到了客户端。** 原来服务器干的解码、过滤、拼接，现在在用户的浏览器里跑，受 ~4 GiB 内存和单线程约束（见第二节 2.5）。**不是「变快了」，是「换了个地方算」——只有当那个地方算得更划算时才成立。**

> **所以云原生格式的适用面是有边界的：大体量、静态、多用户读、按视口取用——四条都满足时收益最大。** 反过来，高频写入的动态业务数据不适合它，这也是为什么下面第 6.7 节那份清单里明确写着「PostGIS 那条不要动」。

### 6.2 GeoLibre 直读这些格式时走的路

| 格式 | 读取路径 | 关键点 |
|---|---|---|
| **PMTiles** | MapLibre 自定义协议（`pmtiles` 包） | 一个文件顶替整个瓦片服务，前端只多注册一个 protocol |
| **COG** | **`cog-tiler-wasm`（默认）** / deck.gl GPU / TiTiler | 三种引擎可切，前两种完全在客户端 |
| **GeoParquet** | DuckDB-WASM `read_parquet` | 可选「原地流式查询」，不必整份拷进内存 |
| **FlatGeobuf** | DuckDB Spatial `ST_Read` | 自带空间索引，天然适合 range 读取 |
| **MosaicJSON / STAC 清单** | 栅格控件读清单，**读时拼接场景** | 清单本身不含数据，只有一串资产地址 |
| **云优化 NetCDF/HDF5** | kerchunk 引用清单 → Zarr 渲染管线 | 见 6.5 |

### 6.3 真正的门槛不是格式转换，是 CORS

**格式转换是一次性的活儿，CORS 是每天都会撞的墙。**源码里对 Source Cooperative 的描述很精确：数据端 `data.source.coop` 发 `Access-Control-Allow-Origin: *` **并且**支持字节范围请求，所以 **PMTiles 协议、DuckDB-WASM、COG 读取器都能直连，不需要任何代理**；但它的**元数据 API 一个 CORS 头都不发**。那浏览器怎么办？桌面端走 Tauri 原生 HTTP（服务端到服务端，没有 CORS 这回事），Web 端过一个自建 Cloudflare Worker 把 JSON 重发一遍、补上 CORS 头。

**「数据能直连、元数据要代理」这个判断，是接入任何云原生数据源时最先要下的。**

同一个 Worker 里还有一段更有意思的注释，讲行星底图为什么必须代理：

> MapLibre 用 `fetch()` 取栅格瓦片，会走 CORS 检查，所以地图渲染成一片黑。而 openplanetarymap.org 自己没事，是因为 Leaflet 用 `<img>` 标签加载瓦片，**而 `<img>` 不做 CORS 检查**。

!!! danger "关键陷阱"
    同一个瓦片地址，Leaflet 能显示、MapLibre 显示不出来，根因可能既不是代码也不是瓦片本身，而是两个库取图的方式不同。

这条链路上有三个做法值得借鉴：**服务端取数据再补 CORS 头**（避免浏览器直接发起跨域请求）、**结果放边缘缓存**（重复请求不回源）、**严格白名单绝不做开放代理**（源码原话是「keyed to a tight allowlist so it is never an open proxy」）。第三条是安全底线：能转发任意 URL 的公开代理，容易被恶意利用，后果需要自行承担。

还有个细节值得记：Source Cooperative 的未知 API 路径不返回 404，而是落到页面兜底路由，**返回 HTML、状态码 200**。所以源码每次读取都校验解析后的结构。**`response.ok` 只说明网络层没出错，不代表拿到的是想要的东西。**

### 6.4 「转成 COG」不是把后缀改成 `.tif`

COG 能被 range 直读，靠的是**文件内部有瓦片切分和金字塔（overviews）**。条带式 GeoTIFF 严格说也能 range 读——条带的偏移和字节数就写在头里——但一个条带横跨整幅影像的宽度，取一小块地图范围要连带拉回远超所需的字节，而且没有 overviews 就没有可供缩小时使用的粗级别。后缀叫不叫 `.tif` 都改变不了这一点，况且 GeoLibre 的客户端读取器直接要求文件内部有瓦片。

GeoLibre 的处理值得借鉴：面板**先用一个 Range 请求把文件头读回来**，判断有没有内部瓦片；没有就提示走客户端转换（gdal3.js 那条路）再加载。**用几 KB 的头部换一个明确判断，而不是让用户等一次必然很慢的加载。**

三个栅格引擎的取舍源码里也写清楚了：`cog-tiler-wasm`（默认，浏览器 WASM，**代价是只能用内置色带**，自定义分级失效）、`maplibre-gl-raster`（GPU，符号化完整）、`titiler`（服务端）。**默认值选的是最稳的那个，不是功能最全的。**

### 6.5 数据不是云原生格式怎么办：把索引外置

NetCDF / HDF5 是科学数据的事实标准，却不是为 HTTP 设计的。GeoLibre 的做法是 **kerchunk 引用清单**：清单把 Zarr 的 key 映射到 **`[url, offset, length]`**（原始文件里的一段字节区间），再实现成一个**最小的 zarrita `Readable`（只要一个 `get(key)`）**，直接交给项目里已有的 Zarr 渲染管线——源码注释那句「with no rewrite」是重点，**渲染代码一行没改**。

> **思路可以推广：不改数据、不改渲染，只在中间加一层「key → 字节区间」的映射。** 手里那些不适合流式读取的历史格式，只要能算出偏移量，就能变成按需读取的。

### 6.6 目录浏览器只该做一件事：产出 URL

GeoLibre 接了 STAC、Source Cooperative、Overture Maps、Planetary Computer、Hugging Face 一大堆在线数据源，靠一条原则不失控：**添加图层时刻意委托给已经懂每种格式的那些控件**——PMTiles 给 `addPMTilesLayerFromUrl`，GeoParquet 给 `addVectorLayerFromUrl`，COG 给 `app.addCogLayer`。于是目录里点进来的数据和手动 Add Data 的**完全同权**：一样进图层面板、一样能改样式、一样能存进工程。

> **一个数据源接入 = 一个「怎么找到 URL」的适配器，读取和渲染永远只有一份实现。这是接入 N 个数据源还不失控的唯一办法。**

### 6.7 切入顺序与借鉴要点

**切入顺序**（投入从低到高）：

1. 把**对外展示的静态数据**转成 PMTiles，省掉一整个瓦片服务
2. 栅格成果转成**真正的** COG（记得验内部瓦片和金字塔），前端直读或配 titiler
3. 大矢量表转 GeoParquet，用 DuckDB 直接查
4. 动不了的历史格式，考虑外置索引（kerchunk 那个思路）
5. **动态业务数据仍然走 PostGIS，这条不要动**

- **一、本质是「索引在文件里 + HTTP Range」，所以它换掉的是服务端，不是前端库。**
- **二、先分清「数据能直连」和「元数据要代理」。代理必须白名单 + 边缘缓存，永远不做开放代理。**
- **三、对着外部 API 编程，校验解析后的结构，不要信 `response.ok`。**
- **四、多数据源接入要收敛到同一套格式读取实现，目录面板只负责产出 URL。**

> **第 1 条投入产出比最高：一个 PMTiles 文件 + 一个静态服务器，替掉一整套瓦片发布流程，许多项目在短时间内即可完成改造。**

---

## 写在最后：按投入排序的采纳清单

### 一天内能验证的

1. 试一次 **DuckDB-WASM Spatial**，直接读一个远程 GeoParquet，感受一下「不用后端」是什么体验
2. 把项目里的重引擎改成**按需懒加载 + 独立 chunk**，尤其是三维引擎，让它离开首屏路径
3. 把 CDN / 资源地址全部改成运行时可配置

### 这个迭代能做的

<ol start="4" markdown>

- 给大数据量图层定一个明确阈值，过线换客户端切片（`@maplibre/geojson-vt` + `@maplibre/vt-pbf`）
- 给所有异步管线接 `AbortController`，包括非网络的长循环
- 检查撤销栈有没有内存预算、有没有永远保留最新快照；检查虚拟列表的排序是不是走完整数据模型
- 用 `as const` 数组重写枚举，让运行时校验和类型定义同源
- 把跨语言/跨进程的重复常量用统一的 `SYNC:` 标记钉起来

</ol>

### 值得立项评估的

<ol start="9" markdown>

- 把 DuckDB-WASM Spatial **从「读格式的工具」升级成「查询层」**：让图层同时是 SQL 表，用户能对着两个图层写 `JOIN` 和 `ST_Intersects`
- 把算子层去框架化，让浏览器和服务端跑同一份代码，从此不用再对账
- 把静态数据线换成云原生格式，先从 PMTiles 开始；顺手确认存储支持 `Range` 和 CORS，并想清楚哪些元数据必须走代理
- 如果做 Web 应用，按三层策略把 Service Worker 缓存重做一遍

</ol>

> 这份清单里没有一条需要引入 GeoLibre 的代码。它最大的贡献不是又一个地图应用，而是把「一个跑在浏览器里的空间数据库，足以替代过去必须放在服务端的那些工作」这件事，用一个能跑、能装、能查源码的完整项目证明了一遍。
