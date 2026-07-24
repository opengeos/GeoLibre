# Maritime and Satellite Data Source Catalog

This document tracks candidate data providers for the maritime and satellite integration described in [Maritime and Satellite Data Integration Vision](maritime-satellite-vision.md).

**Last reviewed:** 2026-07-24

Pricing, quotas, licenses, availability, and API contracts can change. Reverify each provider before implementation or deployment.

## Cost and access labels

| Label | Meaning |
| --- | --- |
| Free | No provider subscription fee for the documented access path |
| Free account | No subscription fee, but registration or an API key is required |
| Free quota | No subscription fee within documented usage limits |
| Conditional | No fee only when participation, eligibility, or another condition is met |
| Infrastructure cost | The data may be free, but proxying, storage, transfer, or processing may cost money |

“Free” does not automatically mean unrestricted redistribution, unlimited requests, anonymous access, or suitability for commercial use.

## Summary

There are currently **nine relevant no-fee or conditionally free provider families** and **eight paid/commercial AIS-feed candidates** in this catalog:

- Four AIS or AIS-derived providers
- Five satellite imagery and Earth observation providers
- Six requested commercial AIS providers
- Two additional commercial AIS-feed providers

AISHub is conditional on contributing a qualifying AIS receiver feed. Excluding it leaves **eight practical no-fee provider integrations**. Only one of the current candidates, AISStream.io, provides a straightforward no-cost live global AIS stream without requiring us to contribute our own receiver data.

## Commercial-use and licensing matrix

This matrix answers a narrower question than whether access is free: **may the source be used as an input to analysis that a customer pays for?** It also tracks whether raw data or imagery may be redistributed, which is a separate right.

These entries are a technical licensing screen, not legal advice. “Candidate” means the published terms appear compatible, but the exact collection, product, attribution, and current terms must still be checked before release. “Permission required” means the integration must not be enabled for paid work until the provider grants suitable rights in writing.

| Provider | Paid analysis | Raw-data redistribution | Current assessment | Required action |
| --- | --- | --- | --- | --- |
| AISStream.io | Unverified | Unverified | **Permission required** | Obtain written commercial-use, retention, derived-product, and redistribution terms; the public site documents free technical access but does not establish these rights |
| Global Fishing Watch | No under the standard API terms | No under the standard API terms | **Not commercially cleared** | Request a custom commercial license; standard APIs are expressly non-commercial, including works for hire and internal uses supporting a commercial service |
| NOAA/BOEM Marine Cadastre AIS | Likely, subject to dataset-level review | Likely, subject to dataset-level review | **Candidate** | Confirm the terms and source metadata attached to the exact annual/bulk AIS files before commercial deployment |
| AISHub | Unverified | Unverified | **Permission required** | Membership grants access but the public participation/API pages do not clearly grant commercial, retention, derived-product, or redistribution rights |
| Copernicus Sentinel data | Yes | Yes, subject to the Sentinel legal notice and attribution | **Commercial candidate** | Limit this conclusion to Sentinel data; other CDSE portal content is marked non-commercial and must not be treated as equivalent |
| NASA-led Earthdata missions | Generally yes | Generally yes | **Commercial candidate** | Prefer NASA-led datasets marked CC0 or without restrictions; check collection metadata because third-party and commercial datasets retain their own licenses |
| USGS Landsat | Yes | Yes | **Commercial candidate** | Attribute USGS as requested; Landsat data are public domain and USGS states they may be used or redistributed as desired |
| NOAA CoastWatch ERDDAP | Likely for qualifying US-government datasets | Dataset-dependent | **Collection-level review required** | Inspect each ERDDAP dataset's institution, source, disclaimer, and license metadata; do not assume every hosted third-party product is public domain |
| EUMETSAT Core products | Yes | Yes under CC BY 4.0 | **Commercial candidate** | Verify the collection is classified Core and provide the prescribed attribution |
| EUMETSAT Recommended/licensed products | License-dependent; fees may apply | Restricted by license | **Not automatically free for paid work** | Check each collection; some commercial end-user or value-added-service uses require paid licenses and restrict original numerical-data redistribution |

### What counts as paid or commercial use

For this project, treat all of the following as commercial unless a provider's terms clearly say otherwise:

- A report, alert, assessment, or visualization sold to a customer
- Work performed under a paid consulting or research contract
- Internal analysis supporting a commercial product or service
- A paid SaaS feature, even if customers cannot download the source data
- Training or operating a commercial model using provider data
- Providing transformed tiles, extracts, or derived products to paying users

Charging for expertise rather than charging for the raw data does **not** automatically avoid a non-commercial restriction. Global Fishing Watch explicitly includes works for hire and private internal uses supporting commercial products in the uses not covered by its standard terms.

### Derived products versus source redistribution

A license may permit analysis while prohibiting redistribution of original data. Each adapter therefore needs separate flags for:

- `commercialAnalysisAllowed`
- `derivedProductsAllowed`
- `rawRedistributionAllowed`
- `attributionRequired`
- `shareAlikeRequired`
- `retentionAllowed`
- `licenseVerificationDate`
- `licenseUrl`

The application should be capable of disabling export, caching, public sharing, or commercial workflows per collection. Provider-level labels are insufficient where a catalog mixes open, third-party, and specially licensed datasets.

### Licensing references

- [Global Fishing Watch commercial-use FAQ](https://globalfishingwatch.org/faqs/can-i-use-global-fishing-watch-apis-for-commercial-purposes/)
- [Global Fishing Watch API documentation](https://globalfishingwatch.org/our-apis/documentation)
- [Copernicus Data Space terms and conditions](https://dataspace.copernicus.eu/terms-and-conditions)
- [NASA Earthdata data-use and citation guidance](https://www.earthdata.nasa.gov/engage/open-data-services-software/data-use-policy)
- [USGS Landsat use and redistribution FAQ](https://www.usgs.gov/faqs/are-there-any-restrictions-use-or-redistribution-landsat-data)
- [EUMETSAT data registration and licensing](https://user.eumetsat.int/resources/user-guides/data-registration-and-licensing)

## AIS and vessel activity

### AISStream.io

| Field | Details |
| --- | --- |
| Cost | Free account/API key |
| Primary offering | Live AIS messages over WebSocket |
| Geographic scope | Global network coverage; actual coverage depends on receiving stations |
| Temporal character | Real-time stream |
| Useful content | Vessel positions, voyage and vessel properties, safety messages, search-and-rescue aircraft positions, and other AIS message types |
| Interface | Secure WebSocket API |
| Authentication | API key |
| GeoLibre fit | Live GeoJSON vessel layer, tracks, alerts, and temporal playback after optional local retention |
| Important constraint | Direct browser CORS connections are not supported; the provider recommends consuming the stream on a backend and relaying appropriate data to clients |
| Data caveat | A live feed does not inherently provide historical replay; retaining history would be our responsibility and may have policy implications |
| Commercial-use status | Unverified; free API access does not itself grant commercial, retention, or redistribution rights |

Official references:

- [AISStream.io](https://aisstream.io/)
- [AISStream.io documentation](https://aisstream.io/documentation.html)

### Global Fishing Watch

| Field | Details |
| --- | --- |
| Cost | Free account/API key |
| Primary offering | AIS-derived vessel presence, fishing activity, vessel identity and vessel events; also SAR vessel detections and other ocean activity datasets |
| Geographic scope | Global |
| Temporal character | Historical and near-real-time derived products, not a raw live AIS stream |
| Vessel-presence coverage | Published as hourly standardized vessel positions from 2012 to approximately 96 hours before the present |
| Interfaces | Global Fishing Watch APIs, including 4Wings visualization/reporting; official client packages are also available |
| GeoLibre fit | Temporal vector/raster activity layers, vessel research, fishing-effort visualization, event overlays, and correlation with radar detections |
| Important constraint | Vessel-presence products describe activity patterns and standardized hourly presence; they are not equivalent to unfiltered individual live AIS messages |
| Governance note | API applicants are asked to describe their intended impact/use |
| Commercial-use status | Standard API access is non-commercial only; paid analysis, works for hire, and internal use supporting commercial products require a custom license |

Official references:

- [Global Fishing Watch APIs](https://globalfishingwatch.org/our-apis/)
- [Global AIS Vessel Presence dataset](https://globalfishingwatch.org/platform-update/global-ais-vessel-presence-dataset/)
- [Global Fishing Watch Python package announcement](https://globalfishingwatch.org/platform-update/2025-april-python-package-release-a-new-way-to-work-with-gfw-apis/)

### NOAA and BOEM Marine Cadastre AIS

| Field | Details |
| --- | --- |
| Cost | Free |
| Primary offering | Historical US vessel-traffic AIS data |
| Geographic scope | United States waters and supported coastal areas |
| Temporal character | Historical bulk data rather than a global live feed |
| Interface | Bulk downloads; AccessAIS has provided area/date ordering workflows |
| GeoLibre fit | Historical traffic analysis, track reconstruction, density products, and temporal comparison with imagery |
| Current limitation | The AccessAIS ordering page currently reports that its ordering service is unavailable, while bulk downloads remain available |
| Integration implication | Treat this as a bulk-ingestion adapter rather than depending on the ordering service as an operational API |
| Commercial-use status | Likely compatible for US-government data, but exact bulk-file terms and source metadata must be verified before commercial deployment |

Official reference:

- [Marine Cadastre AccessAIS](https://marinecadastre.gov/accessais/)

### AISHub

| Field | Details |
| --- | --- |
| Cost | Conditional: free to qualifying AIS data contributors |
| Primary offering | Aggregated live AIS data from participating receiver stations |
| Geographic scope | Multi-country receiver network; coverage varies |
| Temporal character | Current/recent AIS observations |
| Interfaces | JSON, XML, or CSV web service |
| Authentication | Member username issued after a contributed feed qualifies |
| Contribution requirements | Operational AIS station/feed, average coverage of at least 10 vessels, at least 90% uptime, maximum 60-second downsampling, and maximum 10-second delay, according to the current participation terms |
| Rate constraint | The web service documentation says not to access it more frequently than once per minute |
| GeoLibre fit | Live/recent vessel layer where we operate a qualifying receiving station |
| Important constraint | This is not a generally available free API; applications without an operational AIS feed are not approved |
| Commercial-use status | Unverified; contributor access does not by itself establish commercial-use or redistribution rights |

Official references:

- [AISHub participation terms](https://www.aishub.net/join-us)
- [AISHub API documentation](https://www.aishub.net/api)

## Paid AIS feed providers

Paid access normally licenses a particular use; it does not transfer ownership of the underlying AIS data. Unless a provider contract explicitly says otherwise, assume that internal analysis is allowed but raw redistribution, public display, customer-facing embedding, model training, long-term retention, and derived-data resale require separate contractual rights.

### Commercial-provider comparison

| Provider | Live AIS | Satellite AIS | History | Enrichment/intelligence | Public pricing | Delivery |
| --- | --- | --- | --- | --- | --- | --- |
| Datalastic | Yes | Optional SAT-E add-on | Vessel and area history | Vessel/port data, ownership, inspections, casualties, weather, routes | Yes | REST/JSON |
| Data Docked | Yes | Yes, plan-dependent | Yes | Vessel particulars, ports, inspections, route planning | Yes | REST/JSON and bulk tools |
| VesselFinder | Yes | Yes, credit-dependent | Port calls; track-history availability should be confirmed | Voyage, master vessel data, ports, expected arrivals, routes | Yes for credits; subscriptions quoted | REST, JSON/XML |
| Kpler AIS / MarineTraffic / former Spire Maritime | Yes | Yes | Yes, contract-dependent | Ports, schedules, voyage and trade intelligence, predictive products | No API price list; sales quote | REST APIs and enterprise feeds |
| Lloyd's List Intelligence AIS SeaOrbis | Yes | Yes | Yes, contract-dependent | Curated vessel intelligence, continuity, ports/places, risk context | No; sales quote | API, TCP, SFTP, Snowflake, platform |
| S&P Global Maritime Intelligence | Yes | Premium tier | Yes | Verified IMO/vessel/company/port data, risk, trade and ownership intelligence | No; subscription/sales quote | Platform, API and data services |
| ORBCOMM | Yes | Yes; primary satellite operator/data source | Contract-dependent | Global satellite AIS and terrestrial augmentation | No; sales quote | Enterprise data service/feed |
| Pole Star Global | Yes | Available through multi-source products | Yes | Vessel/voyage/port/fleet insights, compliance and AIS-gap intelligence | No; sales quote | REST APIs, asynchronous data products, alerts |

### Datalastic

| Field | Details |
| --- | --- |
| Cost | Paid monthly subscription after a short discounted trial |
| Published pricing | Current page lists Starter at EUR 199/month after a 14-day EUR 9 trial with 20,000 monthly credits, and Experimenter at EUR 569/month after a EUR 19 trial with 80,000 monthly credits; verify remaining tiers and annual pricing at purchase |
| Primary offering | Real-time and historical vessel tracking plus maritime reference and operational data |
| Coverage | Global vessel database assembled from Datalastic receivers and additional sources; the SAT-E add-on estimates positions beyond the last known AIS report and should not be treated as confirmed raw satellite AIS |
| Temporal character | Latest positions, vessel history, and historical area scans |
| Historical AOI limits | Historical area scans use a center/radius query capped at 50 nautical miles and seven days per report; larger or longer investigations must be divided into spatial and temporal tiles |
| Interfaces | REST API with JSON responses; API-key authentication |
| Rate/usage model | Credits vary by endpoint and returned volume; documentation currently lists up to 600 requests per minute |
| Useful enrichment | Ports, vessel specifications, ownership, companies, engines, inspections/detentions, casualties, sales/demolitions, dry-dock dates, weather, and sea routes |
| GeoLibre fit | Strong developer-oriented candidate for live layers, track history, area searches, vessel profiles, and port overlays |
| Commercial-use status | Published terms permit commercial use internally or alongside end-user access to the customer's product/service |
| Redistribution status | Raw/as-is public display, resale, sublicensing, publishing, and redistribution are prohibited without written consent |
| Required contract check | Confirm historical source composition and offshore completeness, whether our proposed map display is sufficiently transformed, what customers may see/export, retention duration, caching, derived analytics, and model-training rights |

Official references:

- [Datalastic API documentation](https://docs.datalastic.com/)
- [Datalastic pricing](https://datalastic.com/pricing/)
- [Datalastic terms of service](https://datalastic.com/terms-of-services/)

### Data Docked

| Field | Details |
| --- | --- |
| Cost | Paid subscription or pay-per-credit; limited free signup credits are for evaluation |
| Published pricing | Public pricing page describes subscription and credit purchasing and a choice of terrestrial or satellite AIS; current exact plan totals should be captured from the live checkout before procurement |
| Primary offering | Real-time and historical terrestrial/satellite AIS plus vessel and port data |
| Coverage | Advertised global satellite coverage and high-frequency terrestrial coverage in coastal/port areas |
| Temporal character | Latest vessel locations and historical vessel data |
| Interfaces | REST API with API key and JSON; bulk CSV processing/export tooling is also advertised |
| Useful enrichment | Vessel particulars and engine data, port calls/analytics, inspections, compliance/risk fields, ETA and route planning |
| GeoLibre fit | Accessible candidate for prototyping global vessel positions, area searches, history, port intelligence, and vessel detail panels |
| Commercial-use status | Product is marketed to commercial fleets, insurers, logistics, compliance, and software teams; exact licensed use remains contract-dependent |
| Redistribution status | Not established by the reviewed public product pages |
| Required contract check | Obtain the governing API terms and confirm SaaS embedding, customer-facing visualization, export, caching, retention, derivatives, audit rights, and upstream satellite-data restrictions |

Official references:

- [Data Docked](https://datadocked.com/)
- [Data Docked pricing](https://www.datadocked.com/pricing)
- [Data Docked API reference](https://docs.datadocked.com/api-reference/introduction)

### VesselFinder

| Field | Details |
| --- | --- |
| Cost | Credit-based pay-per-use and fixed-fee subscriptions |
| Published pricing | 10,000 credits for EUR 330, 20,000 for EUR 625, and 50,000 for EUR 1,470, excluding VAT; credits currently expire after 12 months |
| Primary offering | Latest vessel positions, fleet/area live data, voyage data, master vessel particulars, port calls, expected arrivals, and sea routes |
| Coverage | Terrestrial AIS network worldwide; satellite positions are charged differently when available |
| Satellite data provenance | VesselFinder's reviewed public documentation does not identify the satellite operator or upstream satellite-AIS supplier; API records expose only `SRC=SAT` versus `SRC=TER` |
| Temporal character | Current positions and port-call history; the reviewed public API documents a predefined-area `LiveData` subscription but does not document a self-service historical AOI position endpoint |
| Interfaces | REST API; JSON by default with optional XML; API-key authentication |
| Usage model | Current documentation charges one credit for a terrestrial AIS position and ten for a satellite AIS position; other datasets have separate per-result costs |
| GeoLibre fit | Straightforward integration for individual vessels, managed fleets, defined live areas, port calls, profiles, and GeoJSON sea routes |
| Commercial-use status | Paid API/data-feed services support business use, but the exact permitted purpose follows the purchased tier and agreement |
| Redistribution status | Free web access expressly excludes commercial resale, redistribution, and systematic collection; never infer broader rights from the web product. API redistribution/customer display must be expressly licensed |
| Required contract check | Identify the upstream satellite supplier(s), then confirm public display, derived products, caching/history, customer exports, maximum refresh rate, satellite rights, and whether analysis outputs may be delivered to paying customers |

Official references:

- [VesselFinder API overview and pricing](https://api.vesselfinder.com/docs/)
- [VesselFinder terms of use](https://www.vesselfinder.com/terms)
- [VesselFinder fleet positions API](https://www.vesselfinder.com/fleet-positions-api)

### Kpler AIS, MarineTraffic, and former Spire Maritime

| Field | Details |
| --- | --- |
| Cost | Paid subscription/enterprise agreement; API pricing is sales-assisted |
| Product identity | Treat MarineTraffic and the former Spire Maritime AIS business as part of the current Kpler AIS procurement/integration family rather than independent parallel vendors |
| Primary offering | Combined terrestrial, satellite, and Dynamic AIS vessel tracking, with broader port, schedule, cargo, and trade intelligence available across Kpler products |
| Coverage | Global coastal and open-ocean coverage; contract and product tier determine sources and service level |
| Temporal character | Near-real-time positions and historical movement products; exact latency, sampling, and archive depth are contractual |
| Interfaces | API-key REST services plus enterprise products/feeds; individual service outputs include JSON and, for some products, CSV |
| Useful enrichment | Vessel/voyage data, port calls, terminals, predictive schedules, ETA/ETD forecasts, risk and trade intelligence |
| GeoLibre fit | Enterprise candidate for a consolidated global live/historical AIS layer and port/logistics analytics |
| Commercial-use status | Intended for commercial and enterprise use under negotiated subscription/data-license terms |
| Redistribution status | Proprietary Kpler data; customer-facing display, onward distribution, derived products, storage, and use outside the named organization must be included explicitly in the agreement |
| Required contract check | Data-source composition, terrestrial versus satellite entitlements, latency/SLA, archive depth, geographic/ship limits, API volume, cache/retention, derived analytics, customer-facing embedding, model training, and post-termination deletion |

Official references:

- [Kpler/MarineTraffic AIS API documentation](https://servicedocs.marinetraffic.com/)
- [Kpler AIS documentation](https://servicedocs-sm.kpler.com/)
- [MarineTraffic plans](https://support.marinetraffic.com/en/articles/9552658-marinetraffic-online-plans)

### Lloyd's List Intelligence AIS SeaOrbis

| Field | Details |
| --- | --- |
| Cost | Enterprise sales quote |
| Primary offering | Unified terrestrial, shipborne, satellite, curated, and continuity-enhanced AIS intelligence |
| Coverage | Advertised global coverage, including open ocean, coastal waters, congested regions, commercial fleet, ports, terminals, and berths |
| Temporal character | Near-real-time live tracking with historical/continuity intelligence available according to contract |
| Interfaces | API, TCP stream, SFTP file delivery, Snowflake/cloud delivery, and platform access |
| Useful enrichment | Normalized vessel movements, curated inputs, tracking continuity through gaps, ports/places, risk and voyage context from the wider Lloyd's List Intelligence portfolio |
| GeoLibre fit | High-end data layer for operational tracking, compliance, investigations, and customer-facing maritime platforms |
| Commercial-use status | Product is explicitly offered for internal analytics and customer-facing platforms under enterprise license |
| Redistribution status | Contract-dependent; the public product page does not grant general redistribution rights |
| Required contract check | Customer-facing scope, named users/tenants, raw versus derived delivery, historical retention, caching, Snowflake export, downstream reports, model training, audit provisions, and post-contract deletion |

Official references:

- [Lloyd's List Intelligence AIS SeaOrbis](https://www.lloydslistintelligence.com/solutions/ais-seaorbis)
- [Lloyd's List Intelligence FAQ](https://www.lloydslistintelligence.com/faq)

### S&P Global Maritime Intelligence

| Field | Details |
| --- | --- |
| Cost | Paid subscriptions and enterprise data/API agreements; pricing is not publicly listed |
| Primary offering | AISLive and broader Maritime Intelligence products combining vessel tracking with verified ship, company, port, trade, ownership, and risk data |
| Coverage | Worldwide terrestrial AIS; satellite movements are included in AISLive Premium; the current product page describes 130,000+ tracked vessels and 16,000+ ports/terminals |
| Temporal character | Updates advertised as frequently as every 60 seconds, with historical tracking and movement analysis in broader products |
| Interfaces | Analyst platforms plus API/data services; exact APIs and bulk delivery are entitlement-dependent |
| Useful enrichment | IMO-validated vessel/company identities, ownership/management, technical characteristics, port intelligence, risk events, sanctions/compliance, trade and cargo context |
| GeoLibre fit | Strong enterprise candidate when verified identity, ownership, trade, risk, and AIS correlation matter more than low-cost raw positions |
| Commercial-use status | Intended for commercial/government workflows under an S&P enterprise license |
| Redistribution status | Proprietary; customer-facing display, exports, derived products, and redistribution require express licensed rights |
| Required contract check | Whether the license covers APIs rather than UI only, satellite tier, user/tenant scope, derived reports, public or customer-facing maps, caching/history, model training, and combination with other licensed sources |

Official references:

- [S&P Global AISLive](https://www.spglobal.com/market-intelligence/en/solutions/products/ais-live-ship-tracker)
- [S&P Global Maritime Intelligence](https://www.spglobal.com/market-intelligence/en/solutions/products/ais-platinum)
- [S&P Maritime Intelligence Risk Suite](https://www.spglobal.com/market-intelligence/en/solutions/products/maritime-intelligence-risk-suite)

### ORBCOMM Satellite AIS

| Field | Details |
| --- | --- |
| Cost | Enterprise sales quote |
| Primary offering | Satellite AIS collected through an operated satellite network, often combined with terrestrial AIS |
| Coverage | Global/open-ocean satellite coverage; actual detection rate and latency vary with satellite passes, vessel density, message collision, and service tier |
| Temporal character | Near-real-time satellite observations with history subject to product/contract |
| Interfaces | Enterprise data service/feed; current public material does not expose a self-service developer API or price list |
| Useful enrichment | Primarily a source-grade satellite AIS feed rather than a broad self-service maritime application stack |
| GeoLibre fit | Potential upstream source when primary satellite collection, provenance, and enterprise SLAs are more important than turnkey UI |
| Commercial-use status | Intended for licensed commercial and government customers |
| Redistribution status | Proprietary and contract-dependent |
| Required contract check | Direct availability in our jurisdiction, delivery protocol, minimum commitment, latency/detection SLA, historical access, vessel/area scope, derived-product and customer-facing rights, and whether procurement occurs through an affiliated/reseller product |

Official reference:

- [ORBCOMM Satellite AIS overview](https://www.orbcomm.co.kr/pdf/brochure/Satellite-AIS.pdf)

### Pole Star Global

| Field | Details |
| --- | --- |
| Cost | Enterprise sales quote |
| Primary offering | Vessel, voyage, port, trade, fleet, compliance, tracking, and AIS-position intelligence |
| Coverage | Global multi-source maritime intelligence; exact terrestrial/satellite composition is product- and contract-dependent |
| Temporal character | Real-time tracking, history, asynchronous date-range datasets, events, and notifications |
| Interfaces | REST developer APIs, asynchronous packaged-data queries, alerts/notifications, and platform access |
| Useful enrichment | Vessel/voyage insights, zone/port insights, fleet management, AIS gaps/non-reporting patterns, compliance and sanctions workflows |
| GeoLibre fit | Good enterprise candidate for API-first monitoring, compliance layers, geofenced events, and historical investigations |
| Commercial-use status | Commercial product; permitted internal and downstream use is defined by the subscription/API agreement |
| Redistribution status | Contract-dependent and not granted generally by the public developer portal |
| Required contract check | API dataset entitlements, source provenance, customer display/export, cache/retention, derived analytics, alert redistribution, model training, and user/tenant limits |

Official references:

- [Pole Star developer portal](https://developers.polestarglobal.com/)
- [Pole Star Insights Data](https://www.polestarglobal.com/insights-data/)
- [Pole Star commercial API documentation](https://api.polestarglobal.com/api/doc/)

### Vendor consolidation and overlap

- Do not evaluate MarineTraffic, FleetMon, Spire Maritime, and Kpler AIS as four fully independent sources without checking current ownership, platform consolidation, and upstream-feed overlap.
- Do not assume a reseller or analytics platform operates its own satellite constellation. Ask which terrestrial and satellite sources are included and whether source identifiers/provenance are preserved.
- Lloyd's List Intelligence, S&P Global, and Pole Star add materially different levels of enrichment around their AIS delivery. Their value cannot be compared only by cost per AIS position.
- ORBCOMM is most relevant as a source-grade satellite AIS option; some downstream products may already incorporate its data.

### Commercial AIS procurement questions

Every paid-provider evaluation should request written answers for:

- Terrestrial, shipborne, and satellite source composition
- Geographic coverage maps and measured gaps
- Median and percentile latency by coastal/open-ocean region
- Position sampling/downsampling and duplicate handling
- History start date, archive granularity, and retrieval limits
- Identity resolution when MMSI/IMO/name changes or spoofing occurs
- SLA, support, outage credits, versioning, and deprecation notice
- API, stream, bulk, and cloud-delivery options
- Price basis: requests, credits, vessels, areas, messages, seats, or data volume
- Rights for internal paid analysis and works for hire
- Rights for customer-facing maps, dashboards, alerts, and reports
- Raw and transformed exports, redistribution, and sublicensing
- Retention, caching, backup, disaster recovery, and post-termination deletion
- Derived products, aggregated statistics, and model-training rights
- Attribution, audit, security, privacy, and data-residency obligations
- Whether licenses from upstream AIS suppliers flow through to our intended use

## Satellite imagery and Earth observation

### Copernicus Data Space Ecosystem

| Field | Details |
| --- | --- |
| Cost | Free quota/free account, depending on interface |
| Primary offering | Copernicus Sentinel and related Earth observation data, catalog access, visualization, downloading, and processing |
| Particularly relevant missions | Sentinel-1 SAR, Sentinel-2 optical, Sentinel-3 ocean/land, Sentinel-5P atmospheric products, and other available collections |
| Temporal character | Historical archive plus newly acquired products; latency varies by mission and product level |
| Interfaces | STAC, OData, S3, openEO, Sentinel Hub APIs, direct COG access, and other documented services |
| GeoLibre fit | STAC catalog search, Sentinel-1/2 acquisition footprints, COG imagery, processed visualization layers, and raster time series |
| Current general-user quotas | The current quota page lists 10,000 Sentinel Hub requests and 10,000 processing units per month, 50,000 direct COG requests per month, and separate transfer/concurrency limits for other interfaces |
| Important constraint | Quotas vary by interface and account class; some APIs, such as certain batch-processing capabilities, are unavailable to general users |
| Commercial-use status | Sentinel data are available on a free, full, and open basis under the Sentinel legal notice; do not extend that conclusion to other CDSE portal content, which is marked non-commercial |

Official references:

- [Copernicus Data Space APIs](https://dataspace.copernicus.eu/analyse/apis)
- [Copernicus API documentation](https://documentation.dataspace.copernicus.eu/APIs.html)
- [Current quotas and limitations](https://documentation.dataspace.copernicus.eu/Quotas.html)

### NASA Earthdata

| Field | Details |
| --- | --- |
| Cost | Free; some downloads/services require a free Earthdata Login |
| Primary offering | Large catalog of NASA Earth science and remote-sensing datasets |
| Particularly relevant content | MODIS, VIIRS, ocean color, sea-surface temperature, atmospheric, weather, fire, and other imagery or geophysical products |
| Temporal character | Mission-dependent historical and ongoing observations |
| Interfaces | CMR Search, CMR-STAC, CMR GraphQL, GIBS imagery services, OPeNDAP, and collection-specific services |
| GeoLibre fit | Catalog discovery, time-aware imagery layers, browse imagery, raster downloads, and marine environmental context |
| Authentication | Discovery may be public; protected downloads and some services use Earthdata Login tokens |
| Important constraint | Earthdata is an ecosystem rather than one uniform imagery endpoint; asset formats, authentication, and access methods differ by collection |
| Commercial-use status | NASA-led mission data are generally CC0 unless marked otherwise; non-NASA and commercial collections retain collection-specific restrictions |

Official references:

- [NASA CMR-STAC](https://cmr.earthdata.nasa.gov/stac/docs/index.html)
- [NASA CMR Search API](https://cmr.earthdata.nasa.gov/search/site/docs/search/api.html)
- [NASA CMR GraphQL](https://graphql.earthdata.nasa.gov/)
- [NASA Open APIs notice](https://api.nasa.gov/)

The older NASA Earth API has been archived; new work should use Earthdata/GIBS and the relevant Earth science catalog services instead.

### USGS Landsat

| Field | Details |
| --- | --- |
| Cost | Free |
| Primary offering | Landsat catalog and imagery archive |
| Geographic scope | Global land and coastal coverage |
| Temporal character | Long historical record with ongoing acquisitions |
| Interface | LandsatLook STAC API and USGS download/access services |
| GeoLibre fit | Spatial/temporal scene discovery, footprints, browse imagery, and loading supported raster assets |
| Strength | Stable, standards-based STAC search and a uniquely long observation history |
| Limitation | Landsat is primarily a land-observation program; resolution and revisit frequency may not suit live vessel detection |
| Commercial-use status | Cleared candidate: USGS states Landsat is public domain and may be used or redistributed as desired; attribution is requested |

Official references:

- [USGS Landsat STAC overview](https://www.usgs.gov/landsat-missions/spatiotemporal-asset-catalog-stac)
- [LandsatLook STAC API](https://landsatlook.usgs.gov/stac-server/api.html)
- [Landsat data access](https://www.usgs.gov/landsat-missions/landsat-data-access)

### NOAA CoastWatch ERDDAP

| Field | Details |
| --- | --- |
| Cost | Free |
| Primary offering | Ocean satellite and environmental data exposed through consistent subsetting services |
| Particularly relevant content | Sea-surface temperature, ocean color, winds, and other marine environmental datasets, depending on active catalog holdings |
| Temporal character | Dataset-dependent historical and operational time series |
| Interfaces | ERDDAP `griddap`, `tabledap`, OPeNDAP, WMS where supported, and output formats including JSON, CSV, NetCDF, and generated images |
| GeoLibre fit | Marine raster layers, time-series extraction, map imagery, and environmental context alongside vessel observations |
| Strength | Spatial and temporal server-side subsetting avoids downloading entire scientific products |
| Important constraint | Dataset identifiers and variables differ; the adapter should discover metadata instead of hard-coding assumptions globally |
| Commercial-use status | Must be evaluated per dataset because ERDDAP can expose both US-government and third-party products; experimental-use disclaimers also affect fitness for operational decisions |

Official references:

- [NOAA CoastWatch ERDDAP](https://coastwatch.noaa.gov/erddap)
- [ERDDAP RESTful web services](https://coastwatch.noaa.gov/erddap/rest.html)

### EUMETSAT Data Store

| Field | Details |
| --- | --- |
| Cost | Free registration for documented datasets; licenses vary by collection |
| Primary offering | Near-real-time and historical meteorological and ocean-observing satellite data |
| Particularly relevant missions | Meteosat, Metop, Jason-3, Sentinel-3, and Sentinel-6 products available through the service |
| Temporal character | Historical and near-real-time products |
| Interfaces | Browse REST API, Download REST API, OpenSearch/navigation services, official EUMDAC client, and EUMETView WMS visualization |
| Authentication | Browsing/discovery can be open; downloading requires an account and temporary API token |
| GeoLibre fit | Weather/ocean imagery, product footprints, time-aware WMS layers, and downloaded raster products |
| Important constraint | Some collections require accepting or requesting a license even where no fee is charged |
| Commercial-use status | Core products use CC BY 4.0 and permit commercial reuse with attribution; Recommended/licensed products can restrict redistribution and impose commercial-use fees |

Official references:

- [EUMETSAT data registration and licensing](https://user.eumetsat.int/resources/user-guides/data-registration-and-licensing)
- [EUMETSAT Data Store detailed guide](https://user.eumetsat.int/resources/user-guides/data-store-detailed-guide)
- [EUMETSAT data access](https://user.eumetsat.int/data-access)

## Recommended first integration wave

The first wave should validate complementary temporal behaviors rather than maximize provider count.

| Priority | Provider | Purpose |
| --- | --- | --- |
| 1 | AISStream.io | Live vessel positions and messages |
| 2 | Global Fishing Watch | Historical/derived vessel activity, identities, events, and SAR detections |
| 3 | Copernicus Data Space | Sentinel-1 SAR and Sentinel-2 optical imagery |
| 4 | NOAA CoastWatch ERDDAP | Ocean conditions such as temperature and ocean color |

Together these sources provide live vessels, historical maritime activity, cloud/daylight-independent radar imagery, optical imagery, and marine environmental context.

## Expected non-provider costs

Even when provider access is free, an operational deployment may incur costs for:

- A relay service for WebSocket AIS feeds
- Secret storage and token exchange
- Cached catalog metadata and historical AIS retention
- Raster transformation, tiling, and reprojection
- Object storage and data egress
- Scheduled ingestion and refresh jobs
- Monitoring, logging, retries, and rate-limit coordination

The first prototype can remain inexpensive by limiting the area of interest, retention window, refresh rate, and imagery processing volume.

## Integration requirements to track per provider

Before implementing an adapter, record:

- API base URL and version
- Account and approval process
- Authentication/token lifecycle
- License and redistribution terms
- Commercial-use restrictions, if any
- Request, processing, and transfer quotas
- Spatial coverage and known gaps
- Temporal coverage, latency, and update cadence
- Timestamp semantics and timezone
- Pagination and maximum query extent
- Supported output formats and coordinate systems
- Browser CORS and GeoLibre Desktop CSP compatibility
- Whether a backend proxy is required
- Attribution requirements
- Expected deprecation/versioning policy
- Representative response fixtures for tests

## Catalog maintenance policy

- Review provider terms and quotas before each adapter release.
- Record the verification date whenever a provider entry changes.
- Link to official documentation rather than copying volatile pricing text without context.
- Separate provider subscription cost from our own infrastructure cost.
- Do not label trials or promotional credits as permanently free.
- Distinguish raw AIS observations from sampled, aggregated, inferred, or delayed vessel products.
- Preserve acquisition time, publication time, and retrieval time as separate fields where the provider exposes them.
