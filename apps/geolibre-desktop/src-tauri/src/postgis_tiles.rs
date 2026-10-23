//! In-process PostGIS vector tiles (`ST_AsMVT`) for the platforms that cannot
//! run the Martin tile server (Android/iOS have no Martin build and cannot spawn
//! helper processes, GeoLibre#2091).
//!
//! The webview never talks to PostgreSQL itself: a MapLibre custom protocol
//! (`geolibre-pgtiles://`, see `src/lib/postgis-tiles.ts`) forwards each tile
//! request to [`postgis_tiles_tile`], which renders it in the database with
//! `ST_AsMVT` and hands the protobuf bytes back over IPC. No local HTTP server
//! is bound, so nothing here needs a listening socket.
//!
//! Connection pools are keyed by the connection string and kept until the
//! frontend releases them (its last layer on that database is gone) or they
//! are evicted; the frontend sends the string with every call, so a saved
//! project's layers resolve again after a restart without any server state.

use std::collections::HashMap;
use std::str::FromStr;
use std::sync::Arc;
use std::time::{Duration, Instant};

use deadpool_postgres::{Hook, HookError, Manager, ManagerConfig, Pool, RecyclingMethod};
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::client::WebPkiServerVerifier;
use rustls::crypto::{verify_tls12_signature, verify_tls13_signature, CryptoProvider};
use rustls::pki_types::pem::PemObject;
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{
    CertificateError, ClientConfig, DigitallySignedStruct, RootCertStore, SignatureScheme,
};
use serde::{Deserialize, Serialize};
use tokio::sync::{Mutex, OnceCell};
use tokio_postgres::config::SslMode;
use tokio_postgres::NoTls;
use tokio_postgres_rustls::MakeRustlsConnect;

/// Pools kept open at once. Each is small, but a phone should not accumulate
/// sockets for every connection string the user ever tried.
const MAX_POOLS: usize = 4;
/// Connections per pool. MapLibre requests several tiles in parallel, and one
/// PostgreSQL connection runs its queries one after another. The frontend's
/// `MAX_TILES_IN_FLIGHT` (`postgis-tiles-url.ts`) must match; a test checks.
const POOL_SIZE: usize = 4;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
/// Server-side cap on a single query (set per session after connecting unless
/// the connection string's `options` sets its own), so a huge unindexed table
/// cannot tie up a pooled connection indefinitely.
const TILE_STATEMENT_TIMEOUT_MS: u32 = 30_000;
/// How long a tile plan built without its extent clip (the extent query
/// failed) is used before the extent is tried again. The wait doubles after
/// each failed retry, up to [`MAX_UNCLIPPED_PLAN_RETRY`], so a scan that
/// always times out does not run every minute.
const UNCLIPPED_PLAN_RETRY: Duration = Duration::from_secs(60);
const MAX_UNCLIPPED_PLAN_RETRY: Duration = Duration::from_secs(60 * 60);
const MVT_EXTENT: u32 = 4096;
const MVT_BUFFER: u32 = 64;
/// Web Mercator world width in metres (EPSG:3857).
const WEB_MERCATOR_WORLD: f64 = 40_075_016.685_578_49;
const WEB_MERCATOR_HALF: f64 = WEB_MERCATOR_WORLD / 2.0;
const MAX_ZOOM: u32 = 30;

#[derive(Default)]
pub struct PostgisTilesState {
    /// One slot per connection string. The map lock is only held to find or
    /// insert a slot; connecting happens in the slot's `OnceCell`, so a slow
    /// or unreachable host never stalls tiles from other databases, and the
    /// parallel first tiles of one database share a single connect.
    pools: Mutex<HashMap<String, Arc<PoolSlot>>>,
}

struct PoolSlot {
    entry: OnceCell<Arc<PoolEntry>>,
    /// For the least-recently-used eviction in [`pool_for`].
    last_used: std::sync::Mutex<Instant>,
}

impl PoolSlot {
    fn new() -> Self {
        Self {
            entry: OnceCell::new(),
            last_used: std::sync::Mutex::new(Instant::now()),
        }
    }

    fn touch(&self) {
        if let Ok(mut last_used) = self.last_used.lock() {
            *last_used = Instant::now();
        }
    }

    fn last_used(&self) -> Instant {
        self.last_used
            .lock()
            .map(|last_used| *last_used)
            .unwrap_or_else(|_| Instant::now())
    }
}

/// A pool is never closed explicitly: removing its slot from the map (an
/// eviction or a disconnect) drops the map's reference, and the connections
/// close once the last in-flight request holding the entry finishes. That
/// keeps tiles already being rendered from failing, and also covers a slot
/// removed while it was still connecting.
struct PoolEntry {
    pool: Pool,
    /// Tile SQL per source, built once: concurrent first tiles wait on the
    /// same cell instead of each running the (possibly full-scan) build.
    plans: Mutex<HashMap<SourceKey, Arc<OnceCell<Arc<TilePlan>>>>>,
}

/// One source as the frontend names it, shared by the per-source commands.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PostgisTileSourceRequest {
    connection: String,
    default_srid: Option<String>,
    schema: String,
    table: String,
    geometry_column: String,
}

impl PostgisTileSourceRequest {
    fn into_key(self) -> Result<(String, SourceKey), String> {
        let default_srid = parse_default_srid(self.default_srid.as_deref())?;
        Ok((
            self.connection,
            SourceKey {
                schema: self.schema,
                table: self.table,
                geometry_column: self.geometry_column,
                default_srid,
            },
        ))
    }
}

#[derive(Clone, Debug, Hash, PartialEq, Eq)]
struct SourceKey {
    schema: String,
    table: String,
    geometry_column: String,
    /// The SRID assumed for a geometry column registered with SRID 0. Part of
    /// the plan key (not the pool's), so layers that share a database but not
    /// a default SRID share one pool.
    default_srid: Option<i32>,
}

struct TilePlan {
    sql: String,
    /// The table's padded Web Mercator extent, or None for an empty table or
    /// a failed extent query.
    extent: Option<[f64; 4]>,
    fields: Vec<ColumnInfo>,
    /// Set when the extent query failed: the plan keeps serving tiles while
    /// a background rebuild tries the extent again.
    retry: Option<PlanRetry>,
}

struct PlanRetry {
    state: std::sync::Mutex<RetryState>,
    delay: Duration,
}

struct RetryState {
    /// When the next rebuild may start. Starting one pushes this back by
    /// `delay`, so a failed rebuild is not retried at once.
    next: Instant,
    /// A rebuild is in flight. It can outlast `delay` (several queries, each
    /// up to the statement timeout), so the deadline alone cannot keep a
    /// second one from starting.
    running: bool,
}

impl PlanRetry {
    fn new(delay: Duration) -> Self {
        Self {
            state: std::sync::Mutex::new(RetryState {
                next: Instant::now() + delay,
                running: false,
            }),
            delay,
        }
    }

    /// Whether a rebuild is due and none is running; if so, claims it. The
    /// claim lasts until [`PlanRetry::finish`].
    fn claim(&self) -> bool {
        let Ok(mut state) = self.state.lock() else {
            return false;
        };
        let now = Instant::now();
        if state.running || now < state.next {
            return false;
        }
        state.running = true;
        state.next = now + self.delay;
        true
    }

    fn finish(&self) {
        if let Ok(mut state) = self.state.lock() {
            state.running = false;
        }
    }

    /// The wait after the rebuild this retry starts, if it fails again.
    fn next_delay(&self) -> Duration {
        (self.delay * 2).min(MAX_UNCLIPPED_PLAN_RETRY)
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PostgisTileSource {
    schema: String,
    table: String,
    geometry_column: String,
    geometry_type: String,
    srid: i32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PostgisTileSourceInfo {
    /// The vector-tile layer name: the table name, as Martin names it.
    layer: String,
    /// West, south, east, north in WGS84, or None for an empty table.
    bounds: Option<[f64; 4]>,
    /// Attribute name -> PostgreSQL type name.
    fields: HashMap<String, String>,
}

/// Connect (or reuse the pool for) a database and list its spatial tables.
#[tauri::command]
pub async fn postgis_tiles_list_sources(
    state: tauri::State<'_, PostgisTilesState>,
    connection: String,
    default_srid: Option<String>,
) -> Result<Vec<PostgisTileSource>, String> {
    // Not needed to list, but a malformed value should fail the connect.
    parse_default_srid(default_srid.as_deref())?;
    let entry = pool_for(&state, &connection).await?;
    let client = entry.pool.get().await.map_err(pool_error)?;
    // geometry_columns covers tables, views and materialized views. Only list
    // what this role may read, so a table the user cannot open never shows up
    // as a source whose every tile then fails.
    let rows = client
        .query(
            "SELECT f_table_schema::text, f_table_name::text, f_geometry_column::text, \
                    type::text, srid \
             FROM geometry_columns \
             WHERE has_table_privilege(format('%I.%I', f_table_schema, f_table_name), 'SELECT') \
             ORDER BY f_table_schema, f_table_name, f_geometry_column",
            &[],
        )
        .await
        .map_err(|error| query_error("list spatial tables", &error))?;
    Ok(rows
        .iter()
        .map(|row| PostgisTileSource {
            schema: row.get(0),
            table: row.get(1),
            geometry_column: row.get(2),
            geometry_type: row.get(3),
            srid: row.get(4),
        })
        .collect())
}

/// Bounds and attribute fields for one source, for the layer's TileJSON-like
/// metadata (fit-to-layer, styling by attribute).
#[tauri::command]
pub async fn postgis_tiles_source_info(
    state: tauri::State<'_, PostgisTilesState>,
    source: PostgisTileSourceRequest,
) -> Result<PostgisTileSourceInfo, String> {
    let (connection, key) = source.into_key()?;
    let entry = pool_for(&state, &connection).await?;
    // The plan holds everything the metadata needs, and building it here
    // warms the cache for the layer's first tiles. A failed extent leaves
    // `bounds` empty (no fit-to-layer) rather than failing the add.
    let plan = tile_plan(&entry, &key).await?;
    let bounds = plan.extent.map(|[west, south, east, north]| {
        let (west, south) = mercator_to_lon_lat(west, south);
        let (east, north) = mercator_to_lon_lat(east, north);
        [west, south, east, north]
    });

    Ok(PostgisTileSourceInfo {
        layer: key.table,
        bounds,
        fields: plan
            .fields
            .iter()
            .map(|column| (column.name.clone(), column.type_name.clone()))
            .collect(),
    })
}

/// Render one vector tile. Returns raw protobuf bytes (empty for an empty
/// tile) without JSON-encoding them through the IPC layer.
#[tauri::command]
pub async fn postgis_tiles_tile(
    state: tauri::State<'_, PostgisTilesState>,
    source: PostgisTileSourceRequest,
    z: u32,
    x: u32,
    y: u32,
) -> Result<tauri::ipc::Response, String> {
    validate_tile(z, x, y)?;
    let (connection, key) = source.into_key()?;
    let entry = pool_for(&state, &connection).await?;
    let plan = tile_plan(&entry, &key).await?;
    let client = entry.pool.get().await.map_err(pool_error)?;
    let margin =
        WEB_MERCATOR_WORLD / f64::from(1_u32 << z) * f64::from(MVT_BUFFER) / f64::from(MVT_EXTENT);
    let row = client
        .query_one(&plan.sql, &[&(z as i32), &(x as i32), &(y as i32), &margin])
        .await
        .map_err(|error| query_error("render the tile", &error))?;
    let bytes: Option<Vec<u8>> = row.get(0);
    Ok(tauri::ipc::Response::new(bytes.unwrap_or_default()))
}

/// Release a connection's pool (or every pool) once no layer uses it. See
/// [`PoolEntry`] for why in-flight requests still finish.
#[tauri::command]
pub async fn postgis_tiles_disconnect(
    state: tauri::State<'_, PostgisTilesState>,
    connection: Option<String>,
) -> Result<(), String> {
    let mut pools = state.pools.lock().await;
    match connection {
        Some(connection) => {
            pools.remove(connection.trim());
        }
        None => pools.clear(),
    }
    Ok(())
}

async fn pool_for(state: &PostgisTilesState, connection: &str) -> Result<Arc<PoolEntry>, String> {
    let connection = connection.trim();
    if connection.is_empty() {
        return Err("Enter a PostgreSQL connection string.".to_string());
    }
    let slot = {
        let mut pools = state.pools.lock().await;
        let slot = pools
            .entry(connection.to_string())
            .or_insert_with(|| Arc::new(PoolSlot::new()));
        Arc::clone(slot)
    };
    slot.touch();
    let connected_now = !slot.entry.initialized();
    match slot.entry.get_or_try_init(|| connect(connection)).await {
        Ok(entry) => {
            // Evict only once the new connection works, so a mistyped string
            // never costs a pool that live layers are using.
            if connected_now {
                evict_idle_pools(&mut *state.pools.lock().await, &slot);
            }
            Ok(Arc::clone(entry))
        }
        Err(error) => {
            // Drop the failed slot so the next call tries again, unless a
            // disconnect or another connect already replaced it.
            let mut pools = state.pools.lock().await;
            if pools
                .get(connection)
                .is_some_and(|current| Arc::ptr_eq(current, &slot))
            {
                pools.remove(connection);
            }
            Err(error)
        }
    }
}

/// Drop the least recently used connected pools beyond [`MAX_POOLS`], never
/// `keep` (the one just connected). Slots still connecting do not count.
fn evict_idle_pools(pools: &mut HashMap<String, Arc<PoolSlot>>, keep: &Arc<PoolSlot>) {
    loop {
        let connected = pools
            .values()
            .filter(|slot| slot.entry.initialized())
            .count();
        if connected <= MAX_POOLS {
            return;
        }
        let idle = pools
            .iter()
            .filter(|(_, slot)| slot.entry.initialized() && !Arc::ptr_eq(slot, keep))
            .min_by_key(|(_, slot)| slot.last_used())
            .map(|(key, _)| key.clone());
        match idle {
            Some(key) => {
                pools.remove(&key);
            }
            None => return,
        }
    }
}

async fn connect(connection: &str) -> Result<Arc<PoolEntry>, String> {
    let entry = build_pool(connection)?;
    // Fail the connect here with a clear message rather than on the first tile.
    let client = entry.pool.get().await.map_err(pool_error)?;
    client
        .query_one("SELECT postgis_lib_version()", &[])
        .await
        .map_err(|_| "This database does not have the PostGIS extension enabled.".to_string())?;
    drop(client);
    Ok(Arc::new(entry))
}

fn build_pool(connection: &str) -> Result<PoolEntry, String> {
    let tls = TlsRequirement::from_connection_string(connection)?;
    let mut config = tokio_postgres::Config::from_str(&tls.normalized_connection)
        .map_err(|error| format!("Could not parse the PostgreSQL connection string: {error}"))?;
    config.ssl_mode(tls.ssl_mode);
    if config.get_connect_timeout().is_none() {
        config.connect_timeout(CONNECT_TIMEOUT);
    }
    // The timeout is SET after connecting rather than sent as the `options`
    // startup parameter, which PgBouncer and hosted poolers (Neon, Supabase)
    // reject. A connection string that sets its own timeout keeps it.
    let set_timeout = !config
        .get_options()
        .is_some_and(|options| options.contains("statement_timeout"));
    if config.get_application_name().is_none() {
        config.application_name("GeoLibre");
    }
    let manager_config = ManagerConfig {
        recycling_method: RecyclingMethod::Fast,
    };
    let manager = if config.get_ssl_mode() == SslMode::Disable {
        Manager::from_config(config, NoTls, manager_config)
    } else {
        Manager::from_config(config, tls.connector()?, manager_config)
    };
    let mut builder = Pool::builder(manager).max_size(POOL_SIZE);
    if set_timeout {
        builder = builder.post_create(Hook::async_fn(|client, _| {
            Box::pin(async move {
                client
                    .batch_execute(&format!(
                        "SET statement_timeout = {TILE_STATEMENT_TIMEOUT_MS}"
                    ))
                    .await
                    .map_err(HookError::Backend)
            })
        }));
    }
    let pool = builder
        .build()
        .map_err(|error| format!("Could not create the PostgreSQL connection pool: {error}"))?;
    Ok(PoolEntry {
        pool,
        plans: Mutex::new(HashMap::new()),
    })
}

async fn tile_plan(entry: &Arc<PoolEntry>, key: &SourceKey) -> Result<Arc<TilePlan>, String> {
    let cell = Arc::clone(entry.plans.lock().await.entry(key.clone()).or_default());
    let plan = cell
        .get_or_try_init(|| build_tile_plan(entry, key, UNCLIPPED_PLAN_RETRY))
        .await
        .map(Arc::clone)?;
    // An unclipped plan stays in use while the extent is retried in the
    // background: rebuilding inline would stall every tile of the layer for
    // as long as the (possibly full-scan) extent query runs.
    if let Some(retry) = plan.retry.as_ref().filter(|retry| retry.claim()) {
        let claim = RebuildClaim(Arc::clone(&plan));
        let entry = Arc::clone(entry);
        let key = key.clone();
        let delay = retry.next_delay();
        tauri::async_runtime::spawn(async move {
            let _claim = claim;
            let Ok(rebuilt) = build_tile_plan(&entry, &key, delay).await else {
                return;
            };
            let mut plans = entry.plans.lock().await;
            // Only replace the cell this plan came from.
            if let Some(current) = plans
                .get_mut(&key)
                .filter(|current| Arc::ptr_eq(current, &cell))
            {
                *current = Arc::new(OnceCell::new_with(Some(rebuilt)));
            }
        });
    }
    Ok(plan)
}

/// Releases a plan's claimed rebuild however the rebuild task ends.
struct RebuildClaim(Arc<TilePlan>);

impl Drop for RebuildClaim {
    fn drop(&mut self) {
        if let Some(retry) = &self.0.retry {
            retry.finish();
        }
    }
}

/// `retry_delay` is how long an unclipped result waits before its own retry.
async fn build_tile_plan(
    entry: &PoolEntry,
    key: &SourceKey,
    retry_delay: Duration,
) -> Result<Arc<TilePlan>, String> {
    let client = entry.pool.get().await.map_err(pool_error)?;
    let columns = read_columns(&client, &key.schema, &key.table, &key.geometry_column).await?;
    let srid = resolve_srid(&client, key).await?;
    let id_column = read_integer_primary_key(&client, &key.schema, &key.table).await?;
    // A failed extent (e.g. a CRS whose transform rejects the padded box)
    // only costs the clip: fall back to filtering by the raw tile envelope,
    // and try the extent again later in case the failure was transient.
    let (extent, retry) = match mercator_extent(&client, key, srid).await {
        Ok(extent) => (extent, None),
        Err(error) => {
            eprintln!(
                "PostGIS tiles: no extent clip for {}.{} ({error}).",
                key.schema, key.table
            );
            (None, Some(PlanRetry::new(retry_delay)))
        }
    };
    Ok(Arc::new(TilePlan {
        sql: build_tile_sql(key, srid, &columns, id_column.as_deref(), extent),
        extent,
        fields: columns,
        retry,
    }))
}

/// The tile query. $1..$3 are z/x/y, $4 the buffer margin in metres.
///
/// The bbox filter transforms the (buffered) tile envelope into the column's
/// SRID rather than transforming every row, so the column's spatial index is
/// used. `ST_TileEnvelope` needs PostGIS 3.0+.
///
/// A low-zoom tile envelope spans far more of the world than a projected CRS
/// can represent (a z0 tile transformed to UTM is garbage, so the filter
/// matched nothing and the tile came back empty). With `clip` (the table's
/// padded Web Mercator extent) the envelope is first cut down to the data,
/// then densified so its transformed bounding box still covers the curved
/// edges.
fn build_tile_sql(
    key: &SourceKey,
    srid: ColumnSrid,
    columns: &[ColumnInfo],
    id_column: Option<&str>,
    clip: Option<[f64; 4]>,
) -> String {
    // Every name this query introduces is prefixed so no table column can
    // collide with it.
    let source = "__geolibre_src";
    let geometry = format!("{source}.{}", quote_ident(&key.geometry_column));
    let qualified = format!("{}.{}", quote_ident(&key.schema), quote_ident(&key.table));
    // ST_AsMVT's feature_id_name must name an integer column; leave it out
    // otherwise rather than passing NULL.
    let feature_id = match id_column {
        Some(id) if columns.iter().any(|column| column.name == id) => {
            format!(", {}", quote_literal(id))
        }
        _ => String::new(),
    };
    let tile_envelope = "ST_Expand(ST_TileEnvelope($1, $2, $3), $4)";
    // An SRID 0 column is tagged with the user's default SRID for the
    // transform, while the bbox filter compares in SRID 0 (mixing SRIDs in
    // `&&` is an error).
    let to_column_srid = |envelope: &str| match srid {
        ColumnSrid::Declared(3857) => envelope.to_string(),
        ColumnSrid::Declared(srid) => format!("ST_Transform({envelope}, {srid})"),
        ColumnSrid::Assumed(srid) => format!("ST_SetSRID(ST_Transform({envelope}, {srid}), 0)"),
    };
    let source_geometry = match srid {
        ColumnSrid::Declared(_) => format!("{geometry}::geometry"),
        ColumnSrid::Assumed(srid) => format!("ST_SetSRID({geometry}::geometry, {srid})"),
    };
    let from_where = match clip {
        Some([west, south, east, north]) if srid != ColumnSrid::Declared(3857) => {
            let densified = to_column_srid(
                "ST_Segmentize(c, GREATEST(ST_XMax(c) - ST_XMin(c), ST_YMax(c) - ST_YMin(c)) / 16 + 1)",
            );
            format!(
                "{qualified} AS {source}, \
                 (SELECT {densified} AS f FROM (SELECT ST_Intersection({tile_envelope}, \
                 ST_MakeEnvelope({west}, {south}, {east}, {north}, 3857)) AS c) AS __geolibre_clip \
                 WHERE NOT ST_IsEmpty(c)) AS __geolibre_filter \
                 WHERE {geometry} && __geolibre_filter.f"
            )
        }
        _ => format!(
            "{qualified} AS {source} WHERE {geometry} && {}",
            to_column_srid(tile_envelope)
        ),
    };
    let mvt_geometry = "__geolibre_mvt_geom";
    let mut select_list: Vec<String> = columns
        .iter()
        .map(|column| format!("{source}.{}", quote_ident(&column.name)))
        .collect();
    select_list.push(format!(
        "ST_AsMVTGeom(ST_Transform(ST_CurveToLine({source_geometry}), 3857), \
         ST_TileEnvelope($1, $2, $3), {MVT_EXTENT}, {MVT_BUFFER}, true) AS {mvt_geometry}"
    ));
    format!(
        "SELECT ST_AsMVT(tile, {layer}, {MVT_EXTENT}, '{mvt_geometry}'{feature_id}) \
         FROM (SELECT {select} FROM {from_where}) AS tile \
         WHERE {mvt_geometry} IS NOT NULL",
        layer = quote_literal(&key.table),
        select = select_list.join(", "),
    )
}

/// The table's extent in Web Mercator metres (west, south, east, north),
/// padded so features on the edge stay inside, or None for an empty table.
///
/// `ST_EstimatedExtent` reads planner statistics (instant, but NULL until the
/// table was ANALYZEd, and an error for a view), so it is tried on its own and
/// a real `ST_Extent` scan is the fallback. The box is densified before the
/// transform so a projected CRS's curved edges are covered.
async fn mercator_extent(
    client: &deadpool_postgres::Client,
    key: &SourceKey,
    srid: ColumnSrid,
) -> Result<Option<[f64; 4]>, String> {
    let estimated = client
        .query_one(
            "SELECT ST_EstimatedExtent($1, $2, $3) IS NOT NULL",
            &[&key.schema, &key.table, &key.geometry_column],
        )
        .await
        .map(|row| row.get::<_, bool>(0))
        .unwrap_or(false);
    let extent = if estimated {
        format!(
            "ST_EstimatedExtent({}, {}, {})::geometry",
            quote_literal(&key.schema),
            quote_literal(&key.table),
            quote_literal(&key.geometry_column),
        )
    } else {
        format!(
            "(SELECT ST_Extent({}::geometry) FROM {}.{})::geometry",
            quote_ident(&key.geometry_column),
            quote_ident(&key.schema),
            quote_ident(&key.table),
        )
    };
    // Geographic coordinates are clamped to the Web Mercator latitude range
    // after padding, where ST_Transform would otherwise reject them.
    let clamp_geographic = if srid.value() == 4326 {
        "ST_Intersection(e, ST_MakeEnvelope(-180, -85.06, 180, 85.06, 4326))"
    } else {
        "e"
    };
    let sql = format!(
        "SELECT ST_XMin(b), ST_YMin(b), ST_XMax(b), ST_YMax(b) FROM ( \
           SELECT ST_Transform(ST_Segmentize(g, \
             GREATEST(ST_XMax(g) - ST_XMin(g), ST_YMax(g) - ST_YMin(g)) / 32 + 1e-9), 3857) AS b \
           FROM (SELECT {clamp_geographic} AS g FROM ( \
             SELECT ST_SetSRID(ST_Expand(x, \
               GREATEST(ST_XMax(x) - ST_XMin(x), ST_YMax(x) - ST_YMin(x)) * 0.05), $1) AS e \
             FROM (SELECT {extent} AS x) AS raw WHERE x IS NOT NULL \
           ) AS padded) AS clamped WHERE NOT ST_IsEmpty(g) \
         ) AS mercator"
    );
    let row = client
        .query_opt(&sql, &[&srid.value()])
        .await
        .map_err(|error| query_error("compute the table extent", &error))?;
    Ok(row.map(|row| {
        let [west, south, east, north] = [0, 1, 2, 3].map(|index| row.get::<_, f64>(index));
        // A point table has a zero-size extent; give it a few metres so the
        // clipped tile envelope is never degenerate.
        let pad = ((east - west).max(north - south) * 0.01).max(10.0);
        [
            (west - pad).clamp(-WEB_MERCATOR_HALF, WEB_MERCATOR_HALF),
            (south - pad).clamp(-WEB_MERCATOR_HALF, WEB_MERCATOR_HALF),
            (east + pad).clamp(-WEB_MERCATOR_HALF, WEB_MERCATOR_HALF),
            (north + pad).clamp(-WEB_MERCATOR_HALF, WEB_MERCATOR_HALF),
        ]
    }))
}

/// Web Mercator metres to WGS84 longitude/latitude degrees.
fn mercator_to_lon_lat(x: f64, y: f64) -> (f64, f64) {
    const EARTH_RADIUS: f64 = 6_378_137.0;
    let lon = (x / EARTH_RADIUS).to_degrees();
    let lat = (y / EARTH_RADIUS).sinh().atan().to_degrees();
    (lon.clamp(-180.0, 180.0), lat.clamp(-85.051_129, 85.051_129))
}

/// A geometry column's SRID: as registered, or the user's default SRID for a
/// column registered with SRID 0.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ColumnSrid {
    Declared(i32),
    Assumed(i32),
}

impl ColumnSrid {
    fn value(self) -> i32 {
        match self {
            ColumnSrid::Declared(srid) | ColumnSrid::Assumed(srid) => srid,
        }
    }
}

struct ColumnInfo {
    name: String,
    type_name: String,
}

/// The table's attribute columns that make sense as MVT properties: every
/// column except geometry/geography/raster/binary ones (ST_AsMVT would encode
/// those as huge text blobs).
async fn read_columns(
    client: &deadpool_postgres::Client,
    schema: &str,
    table: &str,
    geometry_column: &str,
) -> Result<Vec<ColumnInfo>, String> {
    let rows = client
        .query(
            "SELECT a.attname::text, format_type(a.atttypid, a.atttypmod) \
             FROM pg_attribute a \
             JOIN pg_class c ON c.oid = a.attrelid \
             JOIN pg_namespace n ON n.oid = c.relnamespace \
             JOIN pg_type t ON t.oid = a.atttypid \
             WHERE n.nspname = $1 AND c.relname = $2 \
               AND a.attnum > 0 AND NOT a.attisdropped AND a.attname <> $3 \
               AND t.typname NOT IN ('geometry', 'geography', 'raster', 'bytea', 'box2d', 'box3d') \
             ORDER BY a.attnum",
            &[&schema, &table, &geometry_column],
        )
        .await
        .map_err(|error| query_error("read the table columns", &error))?;
    if rows.is_empty() {
        // Either a table of only geometry, or it does not exist; tell them apart.
        let exists = client
            .query_opt(
                "SELECT 1 FROM geometry_columns \
                 WHERE f_table_schema = $1 AND f_table_name = $2 AND f_geometry_column = $3",
                &[&schema, &table, &geometry_column],
            )
            .await
            .map_err(|error| query_error("read the table columns", &error))?;
        if exists.is_none() {
            return Err(format!(
                "The spatial table {schema}.{table} ({geometry_column}) was not found."
            ));
        }
    }
    Ok(rows
        .iter()
        .map(|row| ColumnInfo {
            name: row.get(0),
            type_name: row.get(1),
        })
        .collect())
}

/// The column's SRID from geometry_columns, or the default SRID for SRID 0.
async fn resolve_srid(
    client: &deadpool_postgres::Client,
    key: &SourceKey,
) -> Result<ColumnSrid, String> {
    let SourceKey {
        schema,
        table,
        geometry_column,
        default_srid,
    } = key;
    let row = client
        .query_opt(
            "SELECT srid FROM geometry_columns \
             WHERE f_table_schema = $1 AND f_table_name = $2 AND f_geometry_column = $3",
            &[&schema, &table, &geometry_column],
        )
        .await
        .map_err(|error| query_error("read the geometry SRID", &error))?
        .ok_or_else(|| {
            format!("The spatial table {schema}.{table} ({geometry_column}) was not found.")
        })?;
    let srid: i32 = row.get(0);
    if srid > 0 {
        return Ok(ColumnSrid::Declared(srid));
    }
    // A plain `geometry` column (no typmod) registers as SRID 0 even when
    // every row carries one, which is common for tables loaded by GIS tools.
    // Sample a row: if it has an SRID, the rows are tagged and need no default.
    let sql = format!(
        "SELECT ST_SRID({column}::geometry) FROM {schema_ident}.{table_ident} \
         WHERE {column} IS NOT NULL LIMIT 1",
        column = quote_ident(geometry_column),
        schema_ident = quote_ident(schema),
        table_ident = quote_ident(table),
    );
    let sampled: Option<i32> = client
        .query_opt(&sql, &[])
        .await
        .map_err(|error| query_error("read the geometry SRID", &error))?
        .map(|row| row.get(0));
    if let Some(sampled) = sampled.filter(|srid| *srid > 0) {
        return Ok(ColumnSrid::Declared(sampled));
    }
    default_srid.map(ColumnSrid::Assumed).ok_or_else(|| {
        format!(
            "{schema}.{table} has no SRID. Enter a default SRID (for example 4326) and connect again."
        )
    })
}

/// A single-column integer primary key, used as the MVT feature id so the map
/// can address features (hover/selection state) across tiles.
async fn read_integer_primary_key(
    client: &deadpool_postgres::Client,
    schema: &str,
    table: &str,
) -> Result<Option<String>, String> {
    let rows = client
        .query(
            "SELECT a.attname::text, t.typname::text \
             FROM pg_index i \
             JOIN pg_class c ON c.oid = i.indrelid \
             JOIN pg_namespace n ON n.oid = c.relnamespace \
             JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = ANY(i.indkey) \
             JOIN pg_type t ON t.oid = a.atttypid \
             WHERE i.indisprimary AND n.nspname = $1 AND c.relname = $2",
            &[&schema, &table],
        )
        .await
        .map_err(|error| query_error("read the primary key", &error))?;
    if rows.len() != 1 {
        return Ok(None);
    }
    let type_name: String = rows[0].get(1);
    Ok(matches!(type_name.as_str(), "int2" | "int4" | "int8").then(|| rows[0].get(0)))
}

/// How the connection string's `sslmode`/`sslrootcert` map onto rustls.
///
/// tokio-postgres only parses `disable`/`prefer`/`require`, rejects
/// `sslrootcert`, and with a rustls connector it would always verify the
/// certificate. libpq semantics differ: `prefer`/`require` encrypt without
/// verifying, `verify-ca` checks the chain and `verify-full` also the host
/// name. That matters in practice: hosted PostgreSQL often serves a private-CA
/// certificate with `sslmode=require`. Both parameters are therefore taken
/// out of the string (parsed as libpq does, so a value elsewhere that merely
/// contains `sslmode=` is left alone) and applied here.
#[derive(Debug)]
struct TlsRequirement {
    normalized_connection: String,
    ssl_mode: SslMode,
    verify: TlsVerify,
    /// `sslrootcert`: a PEM file of trusted roots, or None for the bundled
    /// public roots (also libpq's `sslrootcert=system`).
    root_cert: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum TlsVerify {
    None,
    Chain,
    ChainAndHost,
}

impl TlsRequirement {
    fn from_connection_string(connection: &str) -> Result<Self, String> {
        let (normalized_connection, taken) =
            take_connection_params(connection, &["sslmode", "sslrootcert"]);
        let root_cert = taken
            .get("sslrootcert")
            .filter(|path| !path.is_empty() && path.as_str() != "system")
            .cloned();
        let (ssl_mode, verify) = match taken.get("sslmode").map(String::as_str) {
            Some("disable") => (SslMode::Disable, TlsVerify::None),
            Some("allow" | "prefer") => (SslMode::Prefer, TlsVerify::None),
            // libpq: with a root certificate configured, `require` (or no
            // sslmode at all) behaves like verify-ca.
            Some("require") if root_cert.is_some() => (SslMode::Require, TlsVerify::Chain),
            Some("require") => (SslMode::Require, TlsVerify::None),
            Some("verify-ca") => (SslMode::Require, TlsVerify::Chain),
            Some("verify-full") => (SslMode::Require, TlsVerify::ChainAndHost),
            None if root_cert.is_some() => (SslMode::Require, TlsVerify::Chain),
            None => (SslMode::Prefer, TlsVerify::None),
            Some(other) => return Err(format!("Unsupported sslmode \"{other}\".")),
        };
        Ok(Self {
            normalized_connection,
            ssl_mode,
            verify,
            root_cert,
        })
    }

    fn roots(&self) -> Result<RootCertStore, String> {
        let Some(path) = &self.root_cert else {
            return Ok(RootCertStore {
                roots: webpki_roots::TLS_SERVER_ROOTS.to_vec(),
            });
        };
        let unreadable =
            |error: &dyn std::fmt::Display| format!("Could not read sslrootcert {path}: {error}");
        let mut roots = RootCertStore::empty();
        for cert in CertificateDer::pem_file_iter(path).map_err(|error| unreadable(&error))? {
            roots
                .add(cert.map_err(|error| unreadable(&error))?)
                .map_err(|error| unreadable(&error))?;
        }
        if roots.is_empty() {
            return Err(unreadable(&"no certificates found"));
        }
        Ok(roots)
    }

    fn connector(&self) -> Result<MakeRustlsConnect, String> {
        let provider = Arc::new(rustls::crypto::ring::default_provider());
        let builder = ClientConfig::builder_with_provider(Arc::clone(&provider))
            .with_safe_default_protocol_versions()
            .map_err(|error| format!("Could not configure TLS: {error}"))?;
        let config = match self.verify {
            TlsVerify::ChainAndHost => builder
                .with_root_certificates(self.roots()?)
                .with_no_client_auth(),
            TlsVerify::Chain => {
                let inner = WebPkiServerVerifier::builder_with_provider(
                    Arc::new(self.roots()?),
                    Arc::clone(&provider),
                )
                .build()
                .map_err(|error| format!("Could not configure TLS: {error}"))?;
                builder
                    .dangerous()
                    .with_custom_certificate_verifier(Arc::new(ChainOnlyVerifier { inner }))
                    .with_no_client_auth()
            }
            TlsVerify::None => builder
                .dangerous()
                .with_custom_certificate_verifier(Arc::new(EncryptOnlyVerifier { provider }))
                .with_no_client_auth(),
        };
        Ok(MakeRustlsConnect::new(config))
    }
}

/// Remove the named parameters from a libpq connection string, in either the
/// URI form (`postgresql://…?sslmode=require`) or the key/value form
/// (`host=h sslmode='require'`), returning the rest and the removed values.
/// A string this cannot parse is returned unchanged, so tokio-postgres reports
/// the syntax error.
fn take_connection_params(connection: &str, names: &[&str]) -> (String, HashMap<String, String>) {
    let mut taken = HashMap::new();
    if connection.starts_with("postgres://") || connection.starts_with("postgresql://") {
        let Some((base, query)) = connection.split_once('?') else {
            return (connection.to_string(), taken);
        };
        let kept: Vec<&str> = query
            .split('&')
            .filter(|pair| {
                let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
                let key = percent_decode(key);
                if names.contains(&key.as_str()) {
                    taken.insert(key, percent_decode(value));
                    false
                } else {
                    true
                }
            })
            .collect();
        let normalized = if kept.is_empty() {
            base.to_string()
        } else {
            format!("{base}?{}", kept.join("&"))
        };
        return (normalized, taken);
    }
    let Some(pairs) = parse_key_value_pairs(connection) else {
        return (connection.to_string(), taken);
    };
    let mut kept = Vec::new();
    for (key, value, span) in pairs {
        if names.contains(&key.as_str()) {
            taken.insert(key, value);
        } else {
            kept.push(&connection[span]);
        }
    }
    (kept.join(" "), taken)
}

/// libpq key/value pairs with each pair's byte span in the input: values may
/// be single-quoted, and a backslash escapes the next character.
fn parse_key_value_pairs(input: &str) -> Option<Vec<(String, String, std::ops::Range<usize>)>> {
    let mut pairs = Vec::new();
    let mut chars = input.char_indices().peekable();
    let skip_whitespace = |chars: &mut std::iter::Peekable<std::str::CharIndices<'_>>| {
        while chars.next_if(|(_, c)| c.is_whitespace()).is_some() {}
    };
    loop {
        skip_whitespace(&mut chars);
        let Some(&(start, _)) = chars.peek() else {
            return Some(pairs);
        };
        let mut key = String::new();
        while let Some((_, c)) = chars.next_if(|(_, c)| *c != '=' && !c.is_whitespace()) {
            key.push(c);
        }
        skip_whitespace(&mut chars);
        chars.next_if(|(_, c)| *c == '=')?;
        skip_whitespace(&mut chars);
        let mut value = String::new();
        let quoted = chars.next_if(|(_, c)| *c == '\'').is_some();
        let end = loop {
            let Some((index, c)) = chars.next() else {
                if quoted {
                    return None;
                }
                break input.len();
            };
            match c {
                '\\' => value.push(chars.next()?.1),
                '\'' if quoted => break index + 1,
                c if !quoted && c.is_whitespace() => break index,
                c => value.push(c),
            }
        };
        if key.is_empty() {
            return None;
        }
        pairs.push((key, value, start..end));
    }
}

fn percent_decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        let hex = bytes
            .get(index + 1..index + 3)
            .and_then(|hex| std::str::from_utf8(hex).ok())
            .and_then(|hex| u8::from_str_radix(hex, 16).ok());
        match (bytes[index], hex) {
            (b'%', Some(byte)) => {
                decoded.push(byte);
                index += 3;
            }
            (byte, _) => {
                decoded.push(byte);
                index += 1;
            }
        }
    }
    String::from_utf8_lossy(&decoded).into_owned()
}

/// libpq `sslmode=verify-ca`: the chain must lead to a trusted root, but the
/// host name is not checked (common for servers reached by IP address).
#[derive(Debug)]
struct ChainOnlyVerifier {
    inner: Arc<WebPkiServerVerifier>,
}

impl ServerCertVerifier for ChainOnlyVerifier {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        intermediates: &[CertificateDer<'_>],
        server_name: &ServerName<'_>,
        ocsp_response: &[u8],
        now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        match self.inner.verify_server_cert(
            end_entity,
            intermediates,
            server_name,
            ocsp_response,
            now,
        ) {
            Err(rustls::Error::InvalidCertificate(
                CertificateError::NotValidForName | CertificateError::NotValidForNameContext { .. },
            )) => Ok(ServerCertVerified::assertion()),
            result => result,
        }
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        self.inner.verify_tls12_signature(message, cert, dss)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        self.inner.verify_tls13_signature(message, cert, dss)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.inner.supported_verify_schemes()
    }
}

/// libpq `sslmode=require`: the channel is encrypted and the handshake
/// signatures are checked, but the certificate chain and host name are not.
#[derive(Debug)]
struct EncryptOnlyVerifier {
    provider: Arc<CryptoProvider>,
}

impl ServerCertVerifier for EncryptOnlyVerifier {
    fn verify_server_cert(
        &self,
        _end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        Ok(ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        verify_tls12_signature(
            message,
            cert,
            dss,
            &self.provider.signature_verification_algorithms,
        )
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        verify_tls13_signature(
            message,
            cert,
            dss,
            &self.provider.signature_verification_algorithms,
        )
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.provider
            .signature_verification_algorithms
            .supported_schemes()
    }
}

fn parse_default_srid(value: Option<&str>) -> Result<Option<i32>, String> {
    match value.map(str::trim).filter(|value| !value.is_empty()) {
        None => Ok(None),
        Some(value) => value
            .parse::<i32>()
            .ok()
            .filter(|srid| *srid > 0)
            .map(Some)
            .ok_or_else(|| "The default SRID must be a positive integer.".to_string()),
    }
}

fn validate_tile(z: u32, x: u32, y: u32) -> Result<(), String> {
    if z > MAX_ZOOM {
        return Err(format!("Tile zoom {z} is out of range."));
    }
    let tiles = 1_u64 << z;
    if u64::from(x) >= tiles || u64::from(y) >= tiles {
        return Err(format!("Tile {z}/{x}/{y} is out of range."));
    }
    Ok(())
}

/// Double-quote an SQL identifier (PostgreSQL `quote_ident` semantics).
fn quote_ident(identifier: &str) -> String {
    format!("\"{}\"", identifier.replace('"', "\"\""))
}

/// Single-quote an SQL string literal.
fn quote_literal(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

fn pool_error(error: deadpool_postgres::PoolError) -> String {
    match error {
        deadpool_postgres::PoolError::Backend(error) => connect_error(&error),
        deadpool_postgres::PoolError::Timeout(_) => {
            "Timed out waiting for a PostgreSQL connection.".to_string()
        }
        other => format!("Could not get a PostgreSQL connection: {other}"),
    }
}

fn connect_error(error: &tokio_postgres::Error) -> String {
    match error.as_db_error() {
        Some(db) => format!("Could not connect to PostgreSQL: {}", db.message()),
        None => format!("Could not connect to PostgreSQL: {error}"),
    }
}

fn query_error(action: &str, error: &tokio_postgres::Error) -> String {
    match error.as_db_error() {
        Some(db) => format!("Could not {action}: {}", db.message()),
        None => format!("Could not {action}: {error}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quotes_identifiers_and_literals() {
        assert_eq!(quote_ident("roads"), "\"roads\"");
        assert_eq!(quote_ident("we\"ird"), "\"we\"\"ird\"");
        assert_eq!(quote_literal("o'brien"), "'o''brien'");
    }

    #[test]
    fn maps_libpq_sslmodes() {
        let tls = |connection| TlsRequirement::from_connection_string(connection).unwrap();
        let require = tls("postgres://h/db?sslmode=require");
        assert_eq!(require.verify, TlsVerify::None);
        assert_eq!(require.ssl_mode, SslMode::Require);
        assert_eq!(require.normalized_connection, "postgres://h/db");

        let full = tls("host=h sslmode=verify-full");
        assert_eq!(full.verify, TlsVerify::ChainAndHost);
        assert_eq!(full.normalized_connection, "host=h");

        let ca = tls("postgres://h/db?application_name=x&sslmode=verify-ca");
        assert_eq!(ca.verify, TlsVerify::Chain);
        assert_eq!(
            ca.normalized_connection,
            "postgres://h/db?application_name=x"
        );
        assert!(tokio_postgres::Config::from_str(&ca.normalized_connection).is_ok());

        let default = tls("host=h dbname=gis");
        assert_eq!(default.ssl_mode, SslMode::Prefer);
        assert_eq!(default.verify, TlsVerify::None);

        assert!(TlsRequirement::from_connection_string("host=h sslmode=bogus").is_err());
    }

    #[test]
    fn parses_ssl_params_like_libpq() {
        // Quoted, spaced and escaped forms are found ...
        let tls = TlsRequirement::from_connection_string(
            "host=h sslmode = 'verify-full' password='it\\'s' sslrootcert='/certs/my ca.pem'",
        )
        .unwrap();
        assert_eq!(tls.verify, TlsVerify::ChainAndHost);
        assert_eq!(tls.root_cert.as_deref(), Some("/certs/my ca.pem"));
        assert_eq!(tls.normalized_connection, "host=h password='it\\'s'");

        // ... and text inside another value that only looks like one is not.
        let decoy = TlsRequirement::from_connection_string(
            "host=h password='sslmode=verify-full' sslmode=require",
        )
        .unwrap();
        assert_eq!(decoy.verify, TlsVerify::None);
        assert_eq!(
            decoy.normalized_connection,
            "host=h password='sslmode=verify-full'"
        );

        let uri = TlsRequirement::from_connection_string(
            "postgresql://u:p@h/db?password=sslmode%3Dverify-full&sslrootcert=%2Fca.pem",
        )
        .unwrap();
        // A root certificate without an sslmode verifies the chain, as libpq does.
        assert_eq!(uri.verify, TlsVerify::Chain);
        assert_eq!(uri.root_cert.as_deref(), Some("/ca.pem"));
        assert_eq!(
            uri.normalized_connection,
            "postgresql://u:p@h/db?password=sslmode%3Dverify-full"
        );

        let system = TlsRequirement::from_connection_string("host=h sslrootcert=system").unwrap();
        assert_eq!(system.root_cert, None);
    }

    fn key() -> SourceKey {
        SourceKey {
            schema: "public".into(),
            table: "roads".into(),
            geometry_column: "geom".into(),
            default_srid: None,
        }
    }

    fn columns(names: &[&str]) -> Vec<ColumnInfo> {
        names
            .iter()
            .map(|name| ColumnInfo {
                name: (*name).into(),
                type_name: "text".into(),
            })
            .collect()
    }

    #[test]
    fn builds_tile_sql_for_each_srid_kind() {
        let sql = build_tile_sql(
            &key(),
            ColumnSrid::Declared(4326),
            &columns(&["id", "name"]),
            Some("id"),
            None,
        );
        assert!(sql.contains("ST_AsMVT(tile, 'roads', 4096, '__geolibre_mvt_geom', 'id')"));
        assert!(sql.contains("__geolibre_src.\"id\", __geolibre_src.\"name\", ST_AsMVTGeom("));
        assert!(sql.contains(
            "FROM \"public\".\"roads\" AS __geolibre_src WHERE __geolibre_src.\"geom\" && ST_Transform("
        ));
        assert!(!sql.contains("  "), "continuation whitespace leaked: {sql}");

        let mercator = build_tile_sql(
            &key(),
            ColumnSrid::Declared(3857),
            &[],
            None,
            Some([0.0; 4]),
        );
        assert!(mercator.contains("'__geolibre_mvt_geom')"));
        // No clip for a Web Mercator column: the envelope needs no transform.
        assert!(mercator.contains("&& ST_Expand(ST_TileEnvelope($1, $2, $3), $4)"));
        assert!(!mercator.contains("ST_MakeEnvelope"));

        let assumed = build_tile_sql(
            &key(),
            ColumnSrid::Assumed(4326),
            &[],
            Some("missing"),
            None,
        );
        assert!(assumed.contains("ST_SetSRID(__geolibre_src.\"geom\"::geometry, 4326)"));
        assert!(assumed.contains("ST_SetSRID(ST_Transform("));
        assert!(!assumed.contains("'missing'"));
    }

    #[test]
    fn clips_projected_envelopes_to_the_data() {
        let sql = build_tile_sql(
            &key(),
            ColumnSrid::Declared(32748),
            &[],
            None,
            Some([1.5, -2.0, 3.0, 4.0]),
        );
        assert!(sql.contains("ST_MakeEnvelope(1.5, -2, 3, 4, 3857)"));
        assert!(sql.contains("ST_Transform(ST_Segmentize(c, "));
        assert!(sql.contains("WHERE __geolibre_src.\"geom\" && __geolibre_filter.f"));
        assert!(!sql.contains("  "), "continuation whitespace leaked: {sql}");
    }

    #[test]
    fn converts_mercator_to_lon_lat() {
        let (lon, lat) = mercator_to_lon_lat(0.0, 0.0);
        assert!(lon.abs() < 1e-9 && lat.abs() < 1e-9);
        let (lon, lat) = mercator_to_lon_lat(WEB_MERCATOR_HALF, WEB_MERCATOR_HALF);
        assert!((lon - 180.0).abs() < 1e-6);
        assert!((lat - 85.051_129).abs() < 1e-4);
    }

    #[test]
    fn validates_tile_coordinates() {
        assert!(validate_tile(0, 0, 0).is_ok());
        assert!(validate_tile(0, 1, 0).is_err());
        assert!(validate_tile(3, 7, 7).is_ok());
        assert!(validate_tile(3, 8, 0).is_err());
        assert!(validate_tile(31, 0, 0).is_err());
    }

    fn slot(connected: bool, age_secs: u64) -> Arc<PoolSlot> {
        let slot = PoolSlot::new();
        if let Ok(mut last_used) = slot.last_used.lock() {
            *last_used = Instant::now() - Duration::from_secs(age_secs);
        }
        if connected {
            // Building a pool does not connect, so no database is needed.
            let entry = build_pool("host=localhost dbname=gis sslmode=disable").unwrap();
            assert!(slot.entry.set(Arc::new(entry)).is_ok());
        }
        Arc::new(slot)
    }

    #[test]
    fn evicts_the_least_recently_used_connected_pool() {
        let newest = slot(true, 0);
        let mut pools: HashMap<String, Arc<PoolSlot>> = HashMap::from([
            ("a".to_string(), slot(true, 50)),
            ("b".to_string(), slot(true, 40)),
            ("c".to_string(), slot(true, 30)),
            ("d".to_string(), slot(true, 20)),
            // Still connecting, and oldest: neither counted nor evicted.
            ("pending".to_string(), slot(false, 99)),
            ("new".to_string(), Arc::clone(&newest)),
        ]);
        evict_idle_pools(&mut pools, &newest);
        let mut left: Vec<_> = pools.keys().cloned().collect();
        left.sort();
        assert_eq!(left, ["b", "c", "d", "new", "pending"]);

        // At the limit nothing goes, and the pool just connected never does.
        let only = slot(true, 1_000);
        let mut pools = HashMap::from([("only".to_string(), Arc::clone(&only))]);
        evict_idle_pools(&mut pools, &only);
        assert_eq!(pools.len(), 1);
    }

    #[test]
    fn plan_retry_claims_once_and_backs_off() {
        let retry = PlanRetry::new(Duration::ZERO);
        assert!(retry.claim());
        let retry = PlanRetry::new(UNCLIPPED_PLAN_RETRY);
        let make_due = || {
            if let Ok(mut state) = retry.state.lock() {
                state.next = Instant::now() - Duration::from_secs(1);
            }
        };
        assert!(!retry.claim(), "not due before its delay");
        make_due();
        assert!(retry.claim());
        assert!(!retry.claim(), "a running rebuild is not claimed twice");
        make_due();
        assert!(
            !retry.claim(),
            "a rebuild that outlasts its delay is still not claimed twice"
        );
        retry.finish();
        assert!(retry.claim(), "claimable again once the rebuild ends");
        assert_eq!(retry.next_delay(), UNCLIPPED_PLAN_RETRY * 2);
        assert_eq!(
            PlanRetry::new(MAX_UNCLIPPED_PLAN_RETRY).next_delay(),
            MAX_UNCLIPPED_PLAN_RETRY
        );
    }

    #[test]
    fn parses_default_srid() {
        assert_eq!(parse_default_srid(None), Ok(None));
        assert_eq!(parse_default_srid(Some(" ")), Ok(None));
        assert_eq!(parse_default_srid(Some("4326")), Ok(Some(4326)));
        assert!(parse_default_srid(Some("0")).is_err());
        assert!(parse_default_srid(Some("abc")).is_err());
    }
}
