# Maritime and Satellite Data Integration Vision

## Purpose

This initiative will extend GeoLibre with maritime and satellite data sources that can be explored together in space and time. The goal is to make it straightforward to discover, load, compare, and analyze observations from multiple providers without turning the work into a permanent fork of GeoLibre.

The result should feel native to GeoLibre while remaining independently maintainable and resilient to upstream GeoLibre updates.

## Vision

Users should be able to select an area and time range, discover relevant maritime and satellite observations, add them to a GeoLibre project, and move through time using one synchronized temporal control.

A synchronized view may combine, for example:

- Vessel positions, tracks, identities, and events
- Maritime boundaries, ports, routes, and operational zones
- Optical, radar, thermal, weather, and ocean imagery
- Derived detections, alerts, classifications, and other analytical products

All sources should share a consistent user experience even when their upstream APIs, authentication systems, formats, update rates, and temporal semantics differ.

The platform should not be tied to one permanent AIS or imagery provider. It should act as a source-selection and coverage-planning layer across as many compatible providers as practical, using the area, time range, analytical purpose, licensing requirements, and budget to decide which sources are suitable.

## Core product workflow

The primary workflow is **free-first discovery followed by evidence-based escalation**:

```text
Draw AOI + select time range + describe the job
                         |
                         v
              Discover eligible sources
                         |
                         v
               Query free sources first
                         |
                         v
       Display observations, coverage, and gaps
                         |
                         v
          Is the available evidence sufficient?
                    /             \
                  yes              no
                   |                |
                   v                v
          Begin analysis     Compare paid sources
                                    |
                                    v
                         Acquire additional data
```

The user should be able to draw an area of interest, choose a time interval, and see all relevant free observations that can be accessed under the applicable terms. The platform should display those results before recommending paid data.

The resulting workspace should show:

- Available free AIS observations
- Available satellite imagery acquisitions
- Source, timestamp, and provenance for every observation
- Spatial footprints and known geographic coverage
- Timeline coverage, sampling, and latency
- Terrestrial, shipborne, satellite, estimated, or otherwise derived AIS provenance
- Optical, SAR, thermal, weather, and ocean-imagery modalities
- Cloud cover and other acquisition-quality metadata where available
- Known gaps, uncertain coverage, and failed queries
- Licensing and paid-analysis status
- Estimated provider cost where pricing is public
- Providers that require a custom quote or manual data order

## Job-aware source selection

The platform should understand the job being performed because data sufficiency depends on the analytical objective.

| Job | Preferred source characteristics |
| --- | --- |
| Port traffic analysis | High-frequency terrestrial historical AIS, port calls, and relevant optical imagery |
| Open-ocean vessel tracking | Confirmed satellite AIS with documented latency and coverage |
| Dark-vessel investigation | SAR imagery combined with satellite AIS and clear gap/provenance reporting |
| Incident reconstruction | High-frequency historical AIS, weather/ocean conditions, and contemporaneous imagery |
| Fishing activity analysis | AIS history, Sentinel-1 SAR, and appropriately licensed fishing-activity data |
| Coastal environmental analysis | AIS, Sentinel-2, NOAA CoastWatch, and weather/ocean products |
| Vessel-specific due diligence | Vessel tracks, identities, ownership, port calls, inspections, and sanctions data |
| General situational awareness | Live AIS, recent imagery, and environmental layers |

Job definitions should be configurable rather than hard-coded assumptions. Each definition can express minimum temporal resolution, acceptable latency, required sensor modalities, geographic scope, licensing needs, and evidentiary standards.

## Source planner

A provider-neutral source planner should sit between the user's request and the individual adapters. Its input should include:

- AOI geometry
- Start and end times
- Job or analytical objective
- Live, historical, or mixed mode
- Required source modalities
- Minimum acceptable temporal and spatial resolution
- Commercial-use and redistribution requirements
- Budget ceiling
- Existing credentials and subscriptions

The planner should:

1. Identify adapters capable of serving the requested geography, interval, and job.
2. Exclude sources whose licenses are incompatible with the intended use.
3. Query eligible free sources first.
4. Normalize and display returned observations.
5. Assess remaining spatial, temporal, modality, and provenance gaps.
6. Rank paid sources by expected contribution, cost visibility, and licensing fit.
7. Generate tiled or chunked requests where provider limits require them.
8. Request explicit approval before incurring provider charges.

The planner should never query every configured paid provider by default. It should produce an explainable query plan and respect cost, rate, credential, and licensing constraints.

## Provider capability manifests

Each adapter should publish a machine-readable capability manifest. A conceptual example is:

```yaml
provider: example-provider
capabilities:
  live_area: true
  historical_area: true
  historical_vessel: true
  confirmed_satellite_ais: false
limits:
  historical_area_radius_nm: 50
  historical_area_days: 7
pricing:
  model: credits
  historical_area_credits_per_day: 2
licensing:
  commercial_analysis_allowed: true
  raw_redistribution_allowed: false
provenance:
  source_labels: [terrestrial, estimated]
```

The common manifest should track at least:

- Supported live and historical query types
- AOI geometry restrictions
- Date-range, lookback, pagination, and record limits
- Terrestrial, shipborne, satellite, inferred, and unknown provenance
- Geographic coverage and known gaps
- Latency, sampling, and update behavior
- Available history depth
- Authentication and credential requirements
- API, stream, bulk, file, and cloud-delivery mechanisms
- Public pricing, credit formulas, or quote-only status
- Commercial-analysis, derived-product, retention, display, and redistribution rights
- Attribution requirements
- Adapter and provider API versions
- Last verification date

Capabilities must distinguish confirmed observations from estimated or inferred positions. A product name containing “satellite” is not enough to classify a record as raw satellite AIS.

## Coverage and sufficiency assessment

The evidence workspace should distinguish these states explicitly:

- Confirmed observation
- Covered interval with no returned observations
- Known provider coverage gap
- Unknown or undocumented coverage
- Query not attempted
- Authentication or licensing prevented access
- Query failed or provider was unavailable
- Estimated, interpolated, or otherwise derived position

“No observations returned” must never be presented as proof that no vessels were present.

Sufficiency should be evaluated against the job definition rather than reduced to one universal score. The assessment may consider:

- Portion of the AOI covered by relevant sources
- Portion of the requested timeline covered
- Largest temporal gaps
- Position density and sampling consistency
- Terrestrial versus satellite provenance
- Imagery acquisition count and usable cloud-free coverage
- Availability of SAR for cloud, darkness, or dark-vessel work
- Identity resolution and vessel metadata completeness
- License compatibility with the intended deliverable
- Whether independent sources corroborate important observations

The interface should explain why evidence is considered sufficient or insufficient and allow an analyst to override the recommendation with an audit note.

## Free-first discovery

For a given AOI and interval, the initial query plan should consider:

1. Marine Cadastre historical AIS where the AOI and dates fall within its supported US coverage.
2. Configured community, organizational, or locally held AIS archives.
3. Free live AIS sources when the requested interval includes the present.
4. Copernicus Sentinel catalogs, especially Sentinel-1 SAR and Sentinel-2 optical imagery.
5. NASA Earthdata, USGS Landsat, NOAA CoastWatch, and eligible EUMETSAT collections.
6. Any additional source that is free, commercially compatible, and enabled by the deployment.

Free sources should remain subject to licensing, attribution, quota, and commercial-use checks. Free access must not be treated as permission for every downstream use.

## Paid-source escalation

When free evidence is insufficient, the source planner should show paid options with:

- The specific gap each provider may fill
- Confirmed versus claimed source provenance
- Expected geographic and temporal contribution
- Public estimated price or “quote required” status
- Minimum commitment where known
- Commercial-analysis and customer-delivery rights
- Whether raw export, caching, or retention is allowed
- Credentials, approval, or manual procurement required

Quote opacity is itself a provider-selection factor. A technically strong provider with unknown pricing cannot be treated as the default dependency of an early-stage analysis business.

For exceptional investigations, third-party data acquisition may be quoted separately from the analytical work. A bounded historical extract for one AOI and interval may be preferable to purchasing a continuous global feed.

The platform should support combining providers, for example using an affordable historical AOI source to discover candidate vessels and a second source to obtain satellite-enhanced positions or vessel particulars. The workspace must preserve provenance so combined records do not appear to be one homogeneous dataset.

## Provider-neutral query model

Analytical workflows should depend on common requests rather than provider-specific endpoints. A conceptual historical request is:

```text
HistoricalAreaQuery
  geometry
  start_time
  end_time
  required_provenance
  vessel_filters
  sampling_interval
  commercial_use
  maximum_cost
```

Adapters should translate this request into provider-specific calls, including spatial tiling and temporal chunking where necessary. Returned data should retain provider identifiers, original timestamps, retrieval time, source classification, license reference, and transformation history.

This boundary allows providers to be added, removed, or replaced without rewriting the analytical workflows.

## Guiding principles

### Extend GeoLibre instead of forking it

Provider integrations should be delivered as external GeoLibre plugins maintained outside the main GeoLibre repository. Changes to GeoLibre itself should be limited to small, provider-neutral improvements to its public plugin API.

### Depend on stable public contracts

Plugins should use documented GeoLibre APIs for adding layers, registering panels and menus, saving project state, and interacting with the map. They should not directly depend on private React components, internal Zustand state, or undocumented MapLibre layer conventions.

### Normalize at the boundary

Each provider adapter should translate its source into a common internal model. Provider-specific behavior belongs in the adapter; temporal controls and GeoLibre integration should operate on normalized records.

### Treat time as a first-class dimension

Every observation should retain its temporal meaning, including whether it represents an instant, an interval, an acquisition window, a forecast time, or a continuously updated feed. Missing or uncertain timestamps must be represented explicitly rather than guessed.

### Keep credentials and large workloads out of the client when appropriate

Public, browser-safe APIs may be called directly. Secret-bearing requests, request signing, rate limiting, large downloads, caching, and expensive transformations should use a controlled proxy or service.

### Degrade gracefully

A failed or unavailable provider should not break the rest of the workspace. Plugins should communicate stale data, partial results, authentication problems, unsupported formats, and rate limits clearly.

## Proposed architecture

```text
Maritime APIs  -----\
                     >-- Provider adapters -- Normalized catalog/results
Satellite APIs -----/                              |
                                                    v
                                        GeoLibre plugin services
                                          |       |       |
                                          v       v       v
                                       Layers   Panels   Project state
                                          |
                                          v
                                  Shared temporal controller
```

The initial implementation should favor one plugin suite with shared infrastructure and modular provider adapters. It may later be split into independently released plugins if provider groups develop different release cycles or deployment requirements.

### Provider adapters

Each adapter is responsible for:

- Provider authentication and configuration
- Spatial, temporal, and provider-specific queries
- Pagination, retries, throttling, and error translation
- Converting catalog results into normalized records
- Resolving data into GeoLibre-supported layers
- Reporting attribution, licensing, provenance, and freshness

### Normalized observation model

The shared model should capture at least:

- Stable provider and observation identifiers
- Human-readable title and description
- Geometry or spatial extent
- Observation start and end times
- Publication or update time, when distinct
- Asset type and access information
- Coordinate reference system and resolution, when applicable
- Attribution, license, and provenance
- Provider-specific metadata in a namespaced extension field

The model must distinguish an observation's acquisition time from the time at which its metadata was published or retrieved.

### GeoLibre layer integration

Adapters should prefer GeoLibre's public helpers for native layer types, including:

- GeoJSON for vessel positions, tracks, detections, footprints, and events
- COG for analysis-ready raster imagery
- WMS and WMTS for provider-hosted map services
- XYZ tiles for tiled imagery products

Layers added by a plugin should appear in GeoLibre's Layers panel, participate in project persistence, and preserve enough source metadata to be reconstructed later.

Short-lived signed URLs should not be treated as durable project state. Projects should save a stable provider reference and query or asset identifier, then resolve a fresh URL when reopened.

## Temporal synchronization

One shared clock should coordinate all participating sources while respecting their different temporal behavior.

The temporal model should support:

- Instant observations, such as an AIS position
- Interval observations, such as a satellite acquisition window
- Discrete raster frames or mosaics
- Vector filtering around the current time
- Live or periodically refreshed feeds
- Independent visibility windows before and after the selected instant
- Mixed temporal resolutions, from seconds to years

GeoLibre's existing Time Slider provides much of the required behavior for timestamped vectors and raster sequences. A provider-neutral public plugin contract should be added upstream if necessary so external plugins can register, update, and remove temporal sources without relying on private implementation details.

A prospective public contract could expose operations conceptually equivalent to:

- Register a temporal source and its extent
- Supply discrete frames or a time-aware URL resolver
- Bind a vector layer to a timestamp property
- Subscribe to the shared clock
- Update or unregister a source

The final contract should be designed with GeoLibre maintainers and remain independent of any maritime or satellite provider.

## Upgrade and compatibility strategy

The integration should survive normal GeoLibre upgrades through the following practices:

- Keep plugin source and releases separate from GeoLibre
- Use only documented public plugin APIs
- Declare the minimum supported GeoLibre version in each plugin manifest
- Version plugin-owned project state and provide migrations
- Test against the oldest and newest supported GeoLibre versions
- Package releases as installable ZIPs and/or HTTPS manifests
- Pin and routinely update plugin dependencies
- Detect optional host capabilities before using them
- Contribute generally useful API additions upstream rather than carrying patches

Compatibility is a maintained property, not a one-time guarantee. Automated contract and smoke tests should verify plugin loading, layer creation, project round-tripping, and temporal synchronization whenever either GeoLibre or the plugin changes.

## Security, privacy, and governance

The design must account for the sensitivity of maritime activity and commercial imagery.

- Do not store secrets in shared GeoLibre project files
- Prefer short-lived credentials and server-side token exchange
- Make network destinations and data sharing visible to users
- Preserve provider attribution and licensing requirements
- Record dataset provenance and retrieval time
- Avoid implying that delayed, incomplete, or inferred vessel data is real-time truth
- Provide retention and cache-clearing controls where local data is stored
- Treat installed plugins as trusted code and distribute them through controlled channels

Desktop Content Security Policy and browser CORS restrictions must be considered for every provider. A controlled proxy may provide a more durable integration boundary than adding many provider hosts directly to the desktop allowlist.

## Scope direction

### Initial scope

- Establish the normalized observation and temporal models
- Build the shared plugin shell and provider-adapter interface
- Integrate one representative maritime provider
- Integrate one representative satellite imagery provider
- Add both source types to a synchronized timeline
- Persist and reopen a project containing those sources
- Document deployment, credentials, and compatibility expectations

### Later scope

- Additional maritime and imagery providers
- Cross-source search and saved queries
- Live refresh and alerting
- Vessel-to-imagery correlation workflows
- Derived detections and analytical products
- Offline catalogs and controlled caching
- Collaborative sharing of reproducible queries and projects

### Out of scope until explicitly prioritized

- Replacing GeoLibre's core layer or project architecture
- Maintaining a long-lived custom GeoLibre fork
- Promising uniform capabilities that upstream providers do not offer
- Embedding permanent API secrets in browser or plugin bundles
- Treating all timestamps as interchangeable without preserving their semantics

## Measures of success

The work is successful when:

- A user can discover maritime and satellite observations for the same place and period
- Both can be loaded and controlled from one coherent temporal experience
- Saved projects can restore their provider references and temporal configuration
- Individual provider outages do not destabilize GeoLibre
- Updating GeoLibre does not require manually reapplying integration patches
- Compatibility failures are detected automatically before release
- Adding another provider mainly requires a new adapter rather than a new user experience

## Open decisions

The following decisions should be made during discovery and prototyping:

- Which maritime and satellite providers should establish the initial contracts
- Whether deployments require an existing backend or a new lightweight proxy
- Required refresh rates, geographic scale, and expected data volumes
- Authentication, licensing, and redistribution constraints for each provider
- Whether temporal synchronization needs only discrete playback or also near-real-time streaming
- How much source data should be cached locally and for how long
- Which provider-neutral temporal capabilities should be proposed upstream to GeoLibre

## Near-term direction

The next step is a short provider and workflow discovery phase. It should produce a prioritized API inventory, representative response samples, authentication requirements, temporal semantics, expected data volumes, and a thin end-to-end prototype using one maritime source and one imagery source.

That prototype should validate the architecture before the provider catalog expands.
