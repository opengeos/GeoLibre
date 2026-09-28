# Demos

A visual tour of what GeoLibre looks like in use. **Click any screenshot to open
it at full resolution, or any animation to play the full-quality video.** For the
complete capability list, see [Features](features.md); for hands-on
walkthroughs, see the [Tutorials](tutorials/index.md).

## 3D Tiles

Photogrammetry and mesh datasets stream in as [3D Tiles](user-guide/adding-data.md)
and render on deck.gl over the MapLibre map, including authenticated tilesets via
custom request headers.

[![GeoLibre showing 3D Tiles rendered on a MapLibre map](https://assets.geolibre.app/images/GeoLibre-demo.webp)](https://assets.geolibre.app/images/GeoLibre-demo.webp)

[Open the live project](https://share.geolibre.app/giswqs/3d-tiles){ .md-button .md-button--primary }

## NYC buildings and subways

Manhattan building footprints extruded in 3D and colored by construction era,
with the MTA subway lines and stations on top. The legend is
[generated automatically](user-guide/styling.md) from the layers' symbology.

[![Manhattan buildings extruded in 3D and colored by construction era, with MTA subway lines and stations and an auto-generated legend](https://assets.geolibre.app/images/nyc-buildings.webp)](https://assets.geolibre.app/images/nyc-buildings.webp)

The animation below runs the [Time Slider](features.md#plugins) along the
buildings' construction year, from 1850 to 2025, so Manhattan fills in era by
era — the camera stays put and the data moves. Click it to play the
full-quality video.

[![Animation of Manhattan buildings appearing by construction year as the Time Slider advances from 1850 to 2025](https://assets.geolibre.app/demos/nyc-buildings-gif.gif)](https://assets.geolibre.app/demos/nyc-buildings.webm)

[Open the live project](https://share.geolibre.app/giswqs/manhattan-buildings-through-time){ .md-button .md-button--primary }

## Planetary basemaps

GeoLibre is not limited to Earth. Planetary basemaps from
[OpenPlanetaryMap](https://openplanetary.org/) and
[USGS Astrogeology](https://astrogeology.usgs.gov/) cover the Moon, Mars,
Mercury, Venus, the Galilean moons (Io, Europa, Ganymede, Callisto), Titan,
Pluto, and Charon. The USGS bodies are reprojected to Web Mercator by the tiles
Worker, and each project carries its own ellipsoid, so distance, area, and scale
measurements match the body you are mapping. Switch bodies from the planet
switcher in the Layers panel.

The deep-space starfield behind each globe comes from the
[Atmosphere Effects plugin](features.md#plugins).

<table>
  <tr>
    <td width="33%"><a href="https://assets.geolibre.app/images/earth.webp"><img src="https://assets.geolibre.app/images/earth.webp" alt="GeoLibre globe view of Earth over a starfield backdrop"></a></td>
    <td width="33%"><a href="https://assets.geolibre.app/images/moon.webp"><img src="https://assets.geolibre.app/images/moon.webp" alt="GeoLibre globe view of the Moon over a starfield backdrop"></a></td>
    <td width="33%"><a href="https://assets.geolibre.app/images/mars.webp"><img src="https://assets.geolibre.app/images/mars.webp" alt="GeoLibre globe view of Mars over a starfield backdrop"></a></td>
  </tr>
  <tr>
    <td align="center"><b>Earth</b><br>Street, satellite, and cloudless imagery</td>
    <td align="center"><b>Moon</b><br>Hillshaded Albedo (NASA / LOLA / USGS)</td>
    <td align="center"><b>Mars</b><br>Colour MOLA Elevation (NASA / MOLA)</td>
  </tr>
  <tr>
    <td width="33%"><a href="https://assets.geolibre.app/images/mercury.webp"><img src="https://assets.geolibre.app/images/mercury.webp" alt="GeoLibre globe view of Mercury over a starfield backdrop"></a></td>
    <td width="33%"><a href="https://assets.geolibre.app/images/pluto.webp"><img src="https://assets.geolibre.app/images/pluto.webp" alt="GeoLibre globe view of Pluto over a starfield backdrop"></a></td>
    <td width="33%"><a href="https://assets.geolibre.app/images/venus.webp"><img src="https://assets.geolibre.app/images/venus.webp" alt="GeoLibre globe view of Venus over a starfield backdrop"></a></td>
  </tr>
  <tr>
    <td align="center"><b>Mercury</b><br>MESSENGER Colour Mosaic (NASA / JHU APL / CIW)</td>
    <td align="center"><b>Pluto</b><br>New Horizons Mosaic (NASA / JHU APL / SwRI)</td>
    <td align="center"><b>Venus</b><br>Magellan C3-MDIR Colour (NASA / JPL)</td>
  </tr>
  <tr>
    <td width="33%"><a href="https://assets.geolibre.app/images/europa.webp"><img src="https://assets.geolibre.app/images/europa.webp" alt="GeoLibre globe view of Europa over a starfield backdrop"></a></td>
    <td width="33%"><a href="https://assets.geolibre.app/images/callisto.webp"><img src="https://assets.geolibre.app/images/callisto.webp" alt="GeoLibre globe view of Callisto over a starfield backdrop"></a></td>
    <td width="33%"><a href="https://assets.geolibre.app/images/charon.webp"><img src="https://assets.geolibre.app/images/charon.webp" alt="GeoLibre globe view of Charon over a starfield backdrop"></a></td>
  </tr>
  <tr>
    <td align="center"><b>Europa</b><br>Galileo / Voyager (NASA / JPL)</td>
    <td align="center"><b>Callisto</b><br>Galileo / Voyager (NASA / JPL)</td>
    <td align="center"><b>Charon</b><br>New Horizons Mosaic (NASA / JHU APL / SwRI)</td>
  </tr>
</table>

## Open data showcase

100 projects built from public open data, grouped by theme below. Each is a
single `.geolibre.json` file authored with the [Python package](python.md):
choropleths, heatmaps, clusters, great-circle flows, 3D extrusions,
before-and-after swipes, and time sliders, with click popups, hover tooltips,
and a legend derived from each layer's symbology. **Click any map to open the
live project.** On share.geolibre.app every project is tagged with its theme,
its features (`time-slider`, `swipe`, `3d`, `heatmap`, `clusters`, `imagery`),
and [`open-data`](https://share.geolibre.app/explore?tag=open-data), so you can
filter the gallery by tag.

[Browse the Official Demos collection](https://share.geolibre.app/giswqs/collections/official-demos){ .md-button .md-button--primary }

Jump to a theme: [Health](#health) · [Natural hazards](#natural-hazards) · [Climate](#climate) · [Oceans and water](#oceans-and-water) · [Nature and land](#nature-and-land) · [Transport and mobility](#transport-and-mobility) · [Cities and infrastructure](#cities-and-infrastructure) · [Energy](#energy) · [Space and Earth observation](#space-and-earth-observation) · [History and culture](#history-and-culture) · [Society and economy](#society-and-economy) · [Food and agriculture](#food-and-agriculture)

### Health

7 projects · [Filter by the `health` tag](https://share.geolibre.app/explore?tag=health)

<table>
  <tr>
    <td width="50%"><a href="https://share.geolibre.app/giswqs/us-adult-asthma-copd-by-county"><img src="https://assets.geolibre.app/images/us-adult-asthma-copd-by-county.webp" alt="GeoLibre map: US adult asthma &amp; COPD"></a></td>
    <td width="50%"><a href="https://share.geolibre.app/giswqs/ground-level-no2-1997-vs-2011"><img src="https://assets.geolibre.app/images/ground-level-no2-1997-vs-2011.webp" alt="GeoLibre map: Ground-level NO₂, 1997 vs 2011"></a></td>
  </tr>
  <tr>
    <td align="center"><b><a href="https://share.geolibre.app/giswqs/us-adult-asthma-copd-by-county">US adult asthma &amp; COPD</a></b><br>Environmental health · County choropleth of age-adjusted adult asthma, with COPD one toggle away<br><small>Data: CDC PLACES</small></td>
    <td align="center"><b><a href="https://share.geolibre.app/giswqs/ground-level-no2-1997-vs-2011">Ground-level NO₂, 1997 vs 2011</a></b><br>Air pollution · Swipe between two periods of satellite-derived surface NO₂<br><small>Data: NASA SEDAC via GIBS</small></td>
  </tr>
  <tr>
    <td width="50%"><a href="https://share.geolibre.app/giswqs/dengue-incidence-1990-2024"><img src="https://assets.geolibre.app/images/dengue-incidence-1990-2024.webp" alt="GeoLibre map: Dengue incidence, 1990–2024"></a></td>
    <td width="50%"><a href="https://share.geolibre.app/giswqs/life-expectancy-1953-2023"><img src="https://assets.geolibre.app/images/life-expectancy-1953-2023.webp" alt="GeoLibre map: Life expectancy, 1953–2023"></a></td>
  </tr>
  <tr>
    <td align="center"><b><a href="https://share.geolibre.app/giswqs/dengue-incidence-1990-2024">Dengue incidence, 1990–2024</a></b><br>Environmental health · Time-slider 3D choropleth of reported dengue per 100k people<br><small>Data: OpenDengue</small></td>
    <td align="center"><b><a href="https://share.geolibre.app/giswqs/life-expectancy-1953-2023">Life expectancy, 1953–2023</a></b><br>Health · Time-slider choropleth of life expectancy at birth in five-year steps<br><small>Data: Our World in Data</small></td>
  </tr>
  <tr>
    <td width="50%"><a href="https://share.geolibre.app/giswqs/us-drug-overdose-deaths-by-state"><img src="https://assets.geolibre.app/images/us-drug-overdose-deaths-by-state.webp" alt="GeoLibre map: US drug overdose deaths by state"></a></td>
    <td width="50%"><a href="https://share.geolibre.app/giswqs/malaria-incidence"><img src="https://assets.geolibre.app/images/malaria-incidence.webp" alt="GeoLibre map: Malaria incidence"></a></td>
  </tr>
  <tr>
    <td align="center"><b><a href="https://share.geolibre.app/giswqs/us-drug-overdose-deaths-by-state">US drug overdose deaths by state</a></b><br>Health · Overdose deaths per 100,000 by state, 2015–2025, on a time slider<br><small>Data: CDC VSRR</small></td>
    <td align="center"><b><a href="https://share.geolibre.app/giswqs/malaria-incidence">Malaria incidence</a></b><br>Health · Malaria cases per 1,000 people at risk in 102 countries<br><small>Data: WHO Global Health Observatory</small></td>
  </tr>
  <tr>
    <td width="50%"><a href="https://share.geolibre.app/giswqs/road-traffic-deaths-2000-vs-2019"><img src="https://assets.geolibre.app/images/road-traffic-deaths-2000-vs-2019.webp" alt="GeoLibre map: Road traffic deaths, 2000 vs 2019"></a></td>
    <td width="50%"></td>
  </tr>
  <tr>
    <td align="center"><b><a href="https://share.geolibre.app/giswqs/road-traffic-deaths-2000-vs-2019">Road traffic deaths, 2000 vs 2019</a></b><br>Road safety · Road deaths per 100,000: swipe 2000 against 2019<br><small>Data: World Bank (WHO)</small></td>
    <td></td>
  </tr>
</table>

### Natural hazards

11 projects · [Filter by the `natural-hazards` tag](https://share.geolibre.app/explore?tag=natural-hazards)

<table>
  <tr>
    <td width="50%"><a href="https://share.geolibre.app/giswqs/global-wildfires-last-7-days"><img src="https://assets.geolibre.app/images/global-wildfires-last-7-days.webp" alt="GeoLibre map: Global wildfires, last 7 days"></a></td>
    <td width="50%"><a href="https://share.geolibre.app/giswqs/tropical-cyclones-ocean-heat"><img src="https://assets.geolibre.app/images/tropical-cyclones-ocean-heat.webp" alt="GeoLibre map: Tropical cyclones &amp; ocean heat"></a></td>
  </tr>
  <tr>
    <td align="center"><b><a href="https://share.geolibre.app/giswqs/global-wildfires-last-7-days">Global wildfires, last 7 days</a></b><br>Wildfires · Fire-radiative-power heatmap that resolves into 0.1° fire cells<br><small>Data: NASA FIRMS (VIIRS)</small></td>
    <td align="center"><b><a href="https://share.geolibre.app/giswqs/tropical-cyclones-ocean-heat">Tropical cyclones &amp; ocean heat</a></b><br>Climate hazards · Three seasons of storm tracks by category over SST anomalies<br><small>Data: NOAA IBTrACS, NASA GHRSST</small></td>
  </tr>
  <tr>
    <td width="50%"><a href="https://share.geolibre.app/giswqs/earthquakes-last-30-days"><img src="https://assets.geolibre.app/images/earthquakes-last-30-days.webp" alt="GeoLibre map: Earthquakes, last 30 days"></a></td>
    <td width="50%"><a href="https://share.geolibre.app/giswqs/us-drought-conditions"><img src="https://assets.geolibre.app/images/us-drought-conditions.webp" alt="GeoLibre map: US drought conditions"></a></td>
  </tr>
  <tr>
    <td align="center"><b><a href="https://share.geolibre.app/giswqs/earthquakes-last-30-days">Earthquakes, last 30 days</a></b><br>Natural hazards · Every M2.5+ quake sized by magnitude and colored by depth, over plate boundaries<br><small>Data: USGS, PB2002</small></td>
    <td align="center"><b><a href="https://share.geolibre.app/giswqs/us-drought-conditions">US drought conditions</a></b><br>Environmental change · This week's drought categories, from abnormally dry to exceptional<br><small>Data: U.S. Drought Monitor</small></td>
  </tr>
  <tr>
    <td width="50%"><a href="https://share.geolibre.app/giswqs/us-tornado-tracks-1950-2024"><img src="https://assets.geolibre.app/images/us-tornado-tracks-1950-2024.webp" alt="GeoLibre map: US tornado tracks, 1950–2024"></a></td>
    <td width="50%"><a href="https://share.geolibre.app/giswqs/volcanoes-of-the-world"><img src="https://assets.geolibre.app/images/volcanoes-of-the-world.webp" alt="GeoLibre map: Volcanoes of the world"></a></td>
  </tr>
  <tr>
    <td align="center"><b><a href="https://share.geolibre.app/giswqs/us-tornado-tracks-1950-2024">US tornado tracks, 1950–2024</a></b><br>Natural hazards · (E)F1+ tracks by rating on a time slider that accumulates year by year<br><small>Data: NOAA Storm Prediction Center</small></td>
    <td align="center"><b><a href="https://share.geolibre.app/giswqs/volcanoes-of-the-world">Volcanoes of the world</a></b><br>Natural hazards · Holocene volcanoes colored by last known eruption, labeled from zoom 5<br><small>Data: NOAA NCEI</small></td>
  </tr>
  <tr>
    <td width="50%"><a href="https://share.geolibre.app/giswqs/global-tsunami-events"><img src="https://assets.geolibre.app/images/global-tsunami-events.webp" alt="GeoLibre map: Global tsunami events"></a></td>
    <td width="50%"><a href="https://share.geolibre.app/giswqs/nasa-global-landslide-catalog"><img src="https://assets.geolibre.app/images/nasa-global-landslide-catalog.webp" alt="GeoLibre map: NASA Global Landslide Catalog"></a></td>
  </tr>
  <tr>
    <td align="center"><b><a href="https://share.geolibre.app/giswqs/global-tsunami-events">Global tsunami events</a></b><br>Natural hazards · 1,582 historical tsunamis sized by wave height and colored by deaths<br><small>Data: NOAA NCEI</small></td>
    <td align="center"><b><a href="https://share.geolibre.app/giswqs/nasa-global-landslide-catalog">NASA Global Landslide Catalog</a></b><br>Natural hazards · 11,033 landslides from 2007 to 2016, colored by trigger and sized by fatalities<br><small>Data: NASA</small></td>
  </tr>
  <tr>
    <td width="50%"><a href="https://share.geolibre.app/giswqs/us-wildfire-perimeters-2025"><img src="https://assets.geolibre.app/images/us-wildfire-perimeters-2025.webp" alt="GeoLibre map: US wildfire perimeters 2025"></a></td>
    <td width="50%"><a href="https://share.geolibre.app/giswqs/major-earthquakes-since-1900"><img src="https://assets.geolibre.app/images/major-earthquakes-since-1900.webp" alt="GeoLibre map: Major earthquakes since 1900"></a></td>
  </tr>
  <tr>
    <td align="center"><b><a href="https://share.geolibre.app/giswqs/us-wildfire-perimeters-2025">US wildfire perimeters 2025</a></b><br>Wildfire · Fires of 1,000+ acres as circles by cause that become perimeters at zoom 6<br><small>Data: NIFC WFIGS</small></td>
    <td align="center"><b><a href="https://share.geolibre.app/giswqs/major-earthquakes-since-1900">Major earthquakes since 1900</a></b><br>Natural hazards · Every M6+ quake since 1900 as a heatmap that resolves into points<br><small>Data: USGS ComCat</small></td>
  </tr>
  <tr>
    <td width="50%"><a href="https://share.geolibre.app/giswqs/us-hail-reports-2025"><img src="https://assets.geolibre.app/images/us-hail-reports-2025.webp" alt="GeoLibre map: US hail reports 2025"></a></td>
    <td width="50%"></td>
  </tr>
  <tr>
    <td align="center"><b><a href="https://share.geolibre.app/giswqs/us-hail-reports-2025">US hail reports 2025</a></b><br>Weather · 9,205 hail reports weighted by hailstone size<br><small>Data: NOAA NCEI Storm Events</small></td>
    <td></td>
  </tr>
</table>

### Climate

8 projects · [Filter by the `climate` tag](https://share.geolibre.app/explore?tag=climate)

<table>
  <tr>
    <td width="50%"><a href="https://share.geolibre.app/giswqs/co2-emissions-per-person-3d"><img src="https://assets.geolibre.app/images/co2-emissions-per-person-3d.webp" alt="GeoLibre map: CO₂ emissions per person"></a></td>
    <td width="50%"><a href="https://share.geolibre.app/giswqs/arctic-sea-ice-march-vs-september"><img src="https://assets.geolibre.app/images/arctic-sea-ice-march-vs-september.webp" alt="GeoLibre map: Arctic sea ice, March vs September"></a></td>
  </tr>
  <tr>
    <td align="center"><b><a href="https://share.geolibre.app/giswqs/co2-emissions-per-person-3d">CO₂ emissions per person</a></b><br>Climate · Countries colored and extruded in 3D by per-capita emissions<br><small>Data: Our World in Data</small></td>
    <td align="center"><b><a href="https://share.geolibre.app/giswqs/arctic-sea-ice-march-vs-september">Arctic sea ice, March vs September</a></b><br>Climate change · Swipe between the winter peak and the summer low of sea ice concentration<br><small>Data: NASA GIBS (AMSR2)</small></td>
  </tr>
  <tr>
    <td width="50%"><a href="https://share.geolibre.app/giswqs/sea-level-trends-at-tide-gauges"><img src="https://assets.geolibre.app/images/sea-level-trends-at-tide-gauges.webp" alt="GeoLibre map: Sea level trends at tide gauges"></a></td>
    <td width="50%"><a href="https://share.geolibre.app/giswqs/temperature-anomaly-by-country-1940-2025"><img src="https://assets.geolibre.app/images/temperature-anomaly-by-country-1940-2025.webp" alt="GeoLibre map: Temperature anomaly by country, 1940–2025"></a></td>
  </tr>
  <tr>
    <td align="center"><b><a href="https://share.geolibre.app/giswqs/sea-level-trends-at-tide-gauges">Sea level trends at tide gauges</a></b><br>Climate change · Sea level rising or falling at 509 tide gauges, in mm per year<br><small>Data: NOAA CO-OPS</small></td>
    <td align="center"><b><a href="https://share.geolibre.app/giswqs/temperature-anomaly-by-country-1940-2025">Temperature anomaly by country, 1940–2025</a></b><br>Climate change · Each country's yearly temperature anomaly on a time slider<br><small>Data: Our World in Data, ERA5</small></td>
  </tr>
  <tr>
    <td width="50%"><a href="https://share.geolibre.app/giswqs/northern-snow-cover-summer-vs-winter"><img src="https://assets.geolibre.app/images/northern-snow-cover-summer-vs-winter.webp" alt="GeoLibre map: Northern snow cover, summer vs winter"></a></td>
    <td width="50%"><a href="https://share.geolibre.app/giswqs/carbon-monoxide-from-fires-september-2024"><img src="https://assets.geolibre.app/images/carbon-monoxide-from-fires-september-2024.webp" alt="GeoLibre map: Carbon monoxide from fires"></a></td>
  </tr>
  <tr>
    <td align="center"><b><a href="https://share.geolibre.app/giswqs/northern-snow-cover-summer-vs-winter">Northern snow cover, summer vs winter</a></b><br>Climate · Swipe between August and February snow cover across the Northern Hemisphere<br><small>Data: NASA GIBS (MODIS)</small></td>
    <td align="center"><b><a href="https://share.geolibre.app/giswqs/carbon-monoxide-from-fires-september-2024">Carbon monoxide from fires</a></b><br>Air quality · Smoke plumes from Amazon and African fires, September 2024<br><small>Data: NASA GIBS (Terra MOPITT)</small></td>
  </tr>
  <tr>
    <td width="50%"><a href="https://share.geolibre.app/giswqs/glacier-mass-balance-since-2015"><img src="https://assets.geolibre.app/images/glacier-mass-balance-since-2015.webp" alt="GeoLibre map: Glacier mass balance since 2015"></a></td>
    <td width="50%"><a href="https://share.geolibre.app/giswqs/largest-source-of-fossil-co2"><img src="https://assets.geolibre.app/images/largest-source-of-fossil-co2.webp" alt="GeoLibre map: Largest source of fossil CO2"></a></td>
  </tr>
  <tr>
    <td align="center"><b><a href="https://share.geolibre.app/giswqs/glacier-mass-balance-since-2015">Glacier mass balance since 2015</a></b><br>Climate change · 186 measured glaciers and their average yearly ice loss<br><small>Data: WGMS</small></td>
    <td align="center"><b><a href="https://share.geolibre.app/giswqs/largest-source-of-fossil-co2">Largest source of fossil CO2</a></b><br>Climate · The fuel behind most of each country's fossil CO2 emissions<br><small>Data: Global Carbon Budget via Our World in Data</small></td>
  </tr>
</table>

### Oceans and water

9 projects · [Filter by the `oceans-water` tag](https://share.geolibre.app/explore?tag=oceans-water)

<table>
  <tr>
    <td width="50%"><a href="https://share.geolibre.app/giswqs/the-vanishing-aral-sea"><img src="https://assets.geolibre.app/images/the-vanishing-aral-sea.webp" alt="GeoLibre map: The vanishing Aral Sea"></a></td>
    <td width="50%"><a href="https://share.geolibre.app/giswqs/ocean-chlorophyll-from-space"><img src="https://assets.geolibre.app/images/ocean-chlorophyll-from-space.webp" alt="GeoLibre map: Ocean chlorophyll from space"></a></td>
  </tr>
  <tr>
    <td align="center"><b><a href="https://share.geolibre.app/giswqs/the-vanishing-aral-sea">The vanishing Aral Sea</a></b><br>Environmental change · Swipe between water occurrence and 1984–2021 transitions<br><small>Data: EC JRC Global Surface Water</small></td>
    <td align="center"><b><a href="https://share.geolibre.app/giswqs/ocean-chlorophyll-from-space">Ocean chlorophyll from space</a></b><br>Oceans · Phytoplankton from a three-day NOAA-20/21 chlorophyll composite<br><small>Data: NASA GIBS (VIIRS)</small></td>
  </tr>
  <tr>
    <td width="50%"><a href="https://share.geolibre.app/giswqs/noaa-ocean-buoys-and-stations"><img src="https://assets.geolibre.app/images/noaa-ocean-buoys-and-stations.webp" alt="GeoLibre map: NOAA ocean buoys and stations"></a></td>
    <td width="50%"><a href="https://share.geolibre.app/giswqs/us-streamflow-right-now"><img src="https://assets.geolibre.app/images/us-streamflow-right-now.webp" alt="GeoLibre map: US streamflow right now"></a></td>
  </tr>
  <tr>
    <td align="center"><b><a href="https://share.geolibre.app/giswqs/noaa-ocean-buoys-and-stations">NOAA ocean buoys and stations</a></b><br>Oceans · 1,354 active buoys and stations by platform type<br><small>Data: NOAA NDBC</small></td>
    <td align="center"><b><a href="https://share.geolibre.app/giswqs/us-streamflow-right-now">US streamflow right now</a></b><br>Water · Latest discharge at about 8,600 USGS streamgages, clustered<br><small>Data: USGS Water Data</small></td>
  </tr>
  <tr>
    <td width="50%"><a href="https://share.geolibre.app/giswqs/rivers-and-lakes-of-the-world"><img src="https://assets.geolibre.app/images/rivers-and-lakes-of-the-world.webp" alt="GeoLibre map: Rivers and lakes of the world"></a></td>
    <td width="50%"><a href="https://share.geolibre.app/giswqs/sea-surface-temperature-march-vs-september"><img src="https://assets.geolibre.app/images/sea-surface-temperature-march-vs-september.webp" alt="GeoLibre map: Sea surface temperature, March vs September"></a></td>
  </tr>
  <tr>
    <td align="center"><b><a href="https://share.geolibre.app/giswqs/rivers-and-lakes-of-the-world">Rivers and lakes of the world</a></b><br>Water · Rivers sized by rank, with lakes and reservoirs, labeled as you zoom<br><small>Data: Natural Earth</small></td>
    <td align="center"><b><a href="https://share.geolibre.app/giswqs/sea-surface-temperature-march-vs-september">Sea surface temperature, March vs September</a></b><br>Oceans · Swipe between ocean temperatures in March and September<br><small>Data: NASA GIBS (GHRSST MUR)</small></td>
  </tr>
  <tr>
    <td width="50%"><a href="https://share.geolibre.app/giswqs/water-stress-by-country-3d"><img src="https://assets.geolibre.app/images/water-stress-by-country-3d.webp" alt="GeoLibre map: Water stress by country in 3D"></a></td>
    <td width="50%"><a href="https://share.geolibre.app/giswqs/drinking-water-access-2000-2024"><img src="https://assets.geolibre.app/images/drinking-water-access-2000-2024.webp" alt="GeoLibre map: Drinking water access, 2000–2024"></a></td>
  </tr>
  <tr>
    <td align="center"><b><a href="https://share.geolibre.app/giswqs/water-stress-by-country-3d">Water stress by country in 3D</a></b><br>Water · Freshwater withdrawals as a share of renewable supply, in 3D<br><small>Data: World Bank (FAO AQUASTAT)</small></td>
    <td align="center"><b><a href="https://share.geolibre.app/giswqs/drinking-water-access-2000-2024">Drinking water access, 2000–2024</a></b><br>Water · Share of people with basic drinking water on a time slider<br><small>Data: World Bank (WHO/UNICEF JMP)</small></td>
  </tr>
  <tr>
    <td width="50%"><a href="https://share.geolibre.app/giswqs/ocean-salinity-from-space"><img src="https://assets.geolibre.app/images/ocean-salinity-from-space.webp" alt="GeoLibre map: Ocean salinity from space"></a></td>
    <td width="50%"></td>
  </tr>
  <tr>
    <td align="center"><b><a href="https://share.geolibre.app/giswqs/ocean-salinity-from-space">Ocean salinity from space</a></b><br>Oceans · Sea surface salinity measured from orbit, on the globe<br><small>Data: NASA GIBS (SMAP)</small></td>
    <td></td>
  </tr>
</table>

### Nature and land

7 projects · [Filter by the `nature-land` tag](https://share.geolibre.app/explore?tag=nature-land)

<table>
  <tr>
    <td width="50%"><a href="https://share.geolibre.app/giswqs/amazon-deforestation-frontier-rondonia"><img src="https://assets.geolibre.app/images/amazon-deforestation-frontier-rondonia.webp" alt="GeoLibre map: Amazon deforestation frontier"></a></td>
    <td width="50%"><a href="https://share.geolibre.app/giswqs/global-land-cover-2024"><img src="https://assets.geolibre.app/images/global-land-cover-2024.webp" alt="GeoLibre map: Global land cover 2024"></a></td>
  </tr>
  <tr>
    <td align="center"><b><a href="https://share.geolibre.app/giswqs/amazon-deforestation-frontier-rondonia">Amazon deforestation frontier</a></b><br>Environmental change · Tree-cover loss by year, 2001–2024, over Rondônia<br><small>Data: Hansen / UMD Global Forest Change</small></td>
    <td align="center"><b><a href="https://share.geolibre.app/giswqs/global-land-cover-2024">Global land cover 2024</a></b><br>Land use · 10 m land use / land cover streamed from an ArcGIS ImageServer<br><small>Data: Esri, Impact Observatory</small></td>
  </tr>
  <tr>
    <td width="50%"><a href="https://share.geolibre.app/giswqs/seasonal-greenness-of-the-earth"><img src="https://assets.geolibre.app/images/seasonal-greenness-of-the-earth.webp" alt="GeoLibre map: Seasonal greenness of the Earth"></a></td>
    <td width="50%"><a href="https://share.geolibre.app/giswqs/manhattan-street-trees"><img src="https://assets.geolibre.app/images/manhattan-street-trees.webp" alt="GeoLibre map: Manhattan street trees"></a></td>
  </tr>
  <tr>
    <td align="center"><b><a href="https://share.geolibre.app/giswqs/seasonal-greenness-of-the-earth">Seasonal greenness of the Earth</a></b><br>Ecology · Swipe between January and July vegetation index<br><small>Data: NASA GIBS (MODIS NDVI)</small></td>
    <td align="center"><b><a href="https://share.geolibre.app/giswqs/manhattan-street-trees">Manhattan street trees</a></b><br>Cities · 62,427 street trees by species and trunk size, aligned to the street grid<br><small>Data: NYC Street Tree Census</small></td>
  </tr>
  <tr>
    <td width="50%"><a href="https://share.geolibre.app/giswqs/orca-sightings-on-inaturalist"><img src="https://assets.geolibre.app/images/orca-sightings-on-inaturalist.webp" alt="GeoLibre map: Orca sightings on iNaturalist"></a></td>
    <td width="50%"><a href="https://share.geolibre.app/giswqs/humpback-whales-by-month-2025"><img src="https://assets.geolibre.app/images/humpback-whales-by-month-2025.webp" alt="GeoLibre map: Humpback whales by month"></a></td>
  </tr>
  <tr>
    <td align="center"><b><a href="https://share.geolibre.app/giswqs/orca-sightings-on-inaturalist">Orca sightings on iNaturalist</a></b><br>Biodiversity · 8,527 research-grade orca sightings; click any dot for its photo<br><small>Data: iNaturalist</small></td>
    <td align="center"><b><a href="https://share.geolibre.app/giswqs/humpback-whales-by-month-2025">Humpback whales by month</a></b><br>Biodiversity · Humpback records month by month, from feeding grounds to breeding grounds<br><small>Data: GBIF.org</small></td>
  </tr>
  <tr>
    <td width="50%"><a href="https://share.geolibre.app/giswqs/biodiversity-records-by-country"><img src="https://assets.geolibre.app/images/biodiversity-records-by-country.webp" alt="GeoLibre map: Biodiversity records by country"></a></td>
    <td width="50%"></td>
  </tr>
  <tr>
    <td align="center"><b><a href="https://share.geolibre.app/giswqs/biodiversity-records-by-country">Biodiversity records by country</a></b><br>Biodiversity · Four billion records: circle area is records, color is records per km²<br><small>Data: GBIF, World Bank</small></td>
    <td></td>
  </tr>
</table>

### Transport and mobility

11 projects · [Filter by the `transport` tag](https://share.geolibre.app/explore?tag=transport)

<table>
  <tr>
    <td width="50%"><a href="https://share.geolibre.app/giswqs/the-global-flight-network"><img src="https://assets.geolibre.app/images/the-global-flight-network.webp" alt="GeoLibre map: The global flight network"></a></td>
    <td width="50%"><a href="https://share.geolibre.app/giswqs/nyc-citi-bike-live-availability"><img src="https://assets.geolibre.app/images/nyc-citi-bike-live-availability.webp" alt="GeoLibre map: NYC Citi Bike availability"></a></td>
  </tr>
  <tr>
    <td align="center"><b><a href="https://share.geolibre.app/giswqs/the-global-flight-network">The global flight network</a></b><br>Human mobility · The 4,000 busiest air corridors as great circles, hubs sized by routes<br><small>Data: OpenFlights</small></td>
    <td align="center"><b><a href="https://share.geolibre.app/giswqs/nyc-citi-bike-live-availability">NYC Citi Bike availability</a></b><br>Human mobility · Every station colored by fill level and sized by capacity<br><small>Data: Citi Bike GBFS feed</small></td>
  </tr>
  <tr>
    <td width="50%"><a href="https://share.geolibre.app/giswqs/nyc-traffic-crashes-2025"><img src="https://assets.geolibre.app/images/nyc-traffic-crashes-2025.webp" alt="GeoLibre map: NYC traffic crashes 2025"></a></td>
    <td width="50%"><a href="https://share.geolibre.app/giswqs/amtrak-routes-and-stations"><img src="https://assets.geolibre.app/images/amtrak-routes-and-stations.webp" alt="GeoLibre map: Amtrak routes and stations"></a></td>
  </tr>
  <tr>
    <td align="center"><b><a href="https://share.geolibre.app/giswqs/nyc-traffic-crashes-2025">NYC traffic crashes 2025</a></b><br>Road safety · Severity-weighted heatmap of injury crashes that resolves into points<br><small>Data: NYC Open Data</small></td>
    <td align="center"><b><a href="https://share.geolibre.app/giswqs/amtrak-routes-and-stations">Amtrak routes and stations</a></b><br>Mobility · 49 Amtrak routes in their own colors, with stations and Thruway stops<br><small>Data: US DOT BTS NTAD</small></td>
  </tr>
  <tr>
    <td width="50%"><a href="https://share.geolibre.app/giswqs/nyc-subway-ridership-2025"><img src="https://assets.geolibre.app/images/nyc-subway-ridership-2025.webp" alt="GeoLibre map: NYC subway ridership 2025"></a></td>
    <td width="50%"><a href="https://share.geolibre.app/giswqs/us-ev-charging-stations"><img src="https://assets.geolibre.app/images/us-ev-charging-stations.webp" alt="GeoLibre map: US EV charging stations"></a></td>
  </tr>
  <tr>
    <td align="center"><b><a href="https://share.geolibre.app/giswqs/nyc-subway-ridership-2025">NYC subway ridership 2025</a></b><br>Mobility · 2025 entries at 426 subway stations as 3D columns<br><small>Data: MTA via data.ny.gov</small></td>
    <td align="center"><b><a href="https://share.geolibre.app/giswqs/us-ev-charging-stations">US EV charging stations</a></b><br>Mobility · 87,644 EV chargers as a heatmap that resolves into stations by level<br><small>Data: DOE AFDC</small></td>
  </tr>
  <tr>
    <td width="50%"><a href="https://share.geolibre.app/giswqs/world-ports"><img src="https://assets.geolibre.app/images/world-ports.webp" alt="GeoLibre map: World ports"></a></td>
    <td width="50%"><a href="https://share.geolibre.app/giswqs/railways-of-the-world"><img src="https://assets.geolibre.app/images/railways-of-the-world.webp" alt="GeoLibre map: Railways of the world"></a></td>
  </tr>
  <tr>
    <td align="center"><b><a href="https://share.geolibre.app/giswqs/world-ports">World ports</a></b><br>Mobility · 2,945 world ports colored by harbor size<br><small>Data: NGA World Port Index</small></td>
    <td align="center"><b><a href="https://share.geolibre.app/giswqs/railways-of-the-world">Railways of the world</a></b><br>Transport · About 925,000 km of railways, colored by continent<br><small>Data: Natural Earth</small></td>
  </tr>
  <tr>
    <td width="50%"><a href="https://share.geolibre.app/giswqs/london-underground-lines-and-stations"><img src="https://assets.geolibre.app/images/london-underground-lines-and-stations.webp" alt="GeoLibre map: London Underground lines and stations"></a></td>
    <td width="50%"><a href="https://share.geolibre.app/giswqs/us-interstate-highways"><img src="https://assets.geolibre.app/images/us-interstate-highways.webp" alt="GeoLibre map: US Interstate highways"></a></td>
  </tr>
  <tr>
    <td align="center"><b><a href="https://share.geolibre.app/giswqs/london-underground-lines-and-stations">London Underground lines and stations</a></b><br>Transport · 11 tube lines in their official colors and 272 stations with fare zones<br><small>Data: TfL Unified API</small></td>
    <td align="center"><b><a href="https://share.geolibre.app/giswqs/us-interstate-highways">US Interstate highways</a></b><br>Transport · Interstates labeled along the line, colored by the numbering rule<br><small>Data: Natural Earth</small></td>
  </tr>
  <tr>
    <td width="50%"><a href="https://share.geolibre.app/giswqs/airports-of-the-world"><img src="https://assets.geolibre.app/images/airports-of-the-world.webp" alt="GeoLibre map: Airports of the world"></a></td>
    <td width="50%"></td>
  </tr>
  <tr>
    <td align="center"><b><a href="https://share.geolibre.app/giswqs/airports-of-the-world">Airports of the world</a></b><br>Transport · 48,027 airports and airfields in clusters, colored by size<br><small>Data: OurAirports</small></td>
    <td></td>
  </tr>
</table>

### Cities and infrastructure

8 projects · [Filter by the `cities-infrastructure` tag](https://share.geolibre.app/explore?tag=cities-infrastructure)

<table>
  <tr>
    <td width="50%"><a href="https://share.geolibre.app/giswqs/earth-at-night-2012-vs-2016"><img src="https://assets.geolibre.app/images/earth-at-night-2012-vs-2016.webp" alt="GeoLibre map: Earth at night, 2012 vs 2016"></a></td>
    <td width="50%"><a href="https://share.geolibre.app/giswqs/manhattan-buildings-through-time"><img src="https://assets.geolibre.app/images/manhattan-buildings-through-time.webp" alt="GeoLibre map: Manhattan buildings through time"></a></td>
  </tr>
  <tr>
    <td align="center"><b><a href="https://share.geolibre.app/giswqs/earth-at-night-2012-vs-2016">Earth at night, 2012 vs 2016</a></b><br>Human footprint · Swipe between two years of night lights<br><small>Data: NASA Black Marble</small></td>
    <td align="center"><b><a href="https://share.geolibre.app/giswqs/manhattan-buildings-through-time">Manhattan buildings through time</a></b><br>Urban growth · Buildings extruded at true height and replayed by construction year, 1850–2025, under the subway<br><small>Data: NYC Open Data, MTA</small></td>
  </tr>
  <tr>
    <td width="50%"><a href="https://share.geolibre.app/giswqs/world-cities-in-3d"><img src="https://assets.geolibre.app/images/world-cities-in-3d.webp" alt="GeoLibre map: World cities in 3D"></a></td>
    <td width="50%"><a href="https://share.geolibre.app/giswqs/submarine-internet-cables"><img src="https://assets.geolibre.app/images/submarine-internet-cables.webp" alt="GeoLibre map: Submarine internet cables"></a></td>
  </tr>
  <tr>
    <td align="center"><b><a href="https://share.geolibre.app/giswqs/world-cities-in-3d">World cities in 3D</a></b><br>Human footprint · Every metro of 1M+ people raised as a 3D spike in proportion to population<br><small>Data: Natural Earth</small></td>
    <td align="center"><b><a href="https://share.geolibre.app/giswqs/submarine-internet-cables">Submarine internet cables</a></b><br>Connectivity · 730 cables in their own colors, with 1,900+ landing stations<br><small>Data: TeleGeography</small></td>
  </tr>
  <tr>
    <td width="50%"><a href="https://share.geolibre.app/giswqs/global-population-density-2020"><img src="https://assets.geolibre.app/images/global-population-density-2020.webp" alt="GeoLibre map: Global population density 2020"></a></td>
    <td width="50%"><a href="https://share.geolibre.app/giswqs/urban-population-of-the-world"><img src="https://assets.geolibre.app/images/urban-population-of-the-world.webp" alt="GeoLibre map: Urban population of the world"></a></td>
  </tr>
  <tr>
    <td align="center"><b><a href="https://share.geolibre.app/giswqs/global-population-density-2020">Global population density 2020</a></b><br>Human footprint · People per km² on a gridded raster<br><small>Data: NASA SEDAC GPW v4</small></td>
    <td align="center"><b><a href="https://share.geolibre.app/giswqs/urban-population-of-the-world">Urban population of the world</a></b><br>Development · Circle area is urban population, color is the share of people in cities<br><small>Data: World Bank</small></td>
  </tr>
  <tr>
    <td width="50%"><a href="https://share.geolibre.app/giswqs/tallest-buildings-of-the-world-in-3d"><img src="https://assets.geolibre.app/images/tallest-buildings-of-the-world-in-3d.webp" alt="GeoLibre map: Tallest buildings of the world in 3D"></a></td>
    <td width="50%"><a href="https://share.geolibre.app/giswqs/longest-bridges-of-the-world"><img src="https://assets.geolibre.app/images/longest-bridges-of-the-world.webp" alt="GeoLibre map: Longest bridges of the world"></a></td>
  </tr>
  <tr>
    <td align="center"><b><a href="https://share.geolibre.app/giswqs/tallest-buildings-of-the-world-in-3d">Tallest buildings of the world in 3D</a></b><br>Infrastructure · 733 towers of 150 m or more at true height, rising year by year<br><small>Data: Wikidata</small></td>
    <td align="center"><b><a href="https://share.geolibre.app/giswqs/longest-bridges-of-the-world">Longest bridges of the world</a></b><br>Infrastructure · 224 bridges over 3 km sized by length, with photos<br><small>Data: Wikidata, Wikimedia Commons</small></td>
  </tr>
</table>

### Energy

5 projects · [Filter by the `energy` tag](https://share.geolibre.app/explore?tag=energy)

<table>
  <tr>
    <td width="50%"><a href="https://share.geolibre.app/giswqs/global-power-plants-by-fuel"><img src="https://assets.geolibre.app/images/global-power-plants-by-fuel.webp" alt="GeoLibre map: Global power plants by fuel"></a></td>
    <td width="50%"><a href="https://share.geolibre.app/giswqs/us-wind-turbines"><img src="https://assets.geolibre.app/images/us-wind-turbines.webp" alt="GeoLibre map: US wind turbines"></a></td>
  </tr>
  <tr>
    <td align="center"><b><a href="https://share.geolibre.app/giswqs/global-power-plants-by-fuel">Global power plants by fuel</a></b><br>Energy · 35,000 plants colored by primary fuel and sized by capacity<br><small>Data: WRI Global Power Plant Database</small></td>
    <td align="center"><b><a href="https://share.geolibre.app/giswqs/us-wind-turbines">US wind turbines</a></b><br>Energy · 76,000 turbines colored by year online and sized by capacity<br><small>Data: US Wind Turbine Database (USGS, LBNL, ACP)</small></td>
  </tr>
  <tr>
    <td width="50%"><a href="https://share.geolibre.app/giswqs/access-to-electricity"><img src="https://assets.geolibre.app/images/access-to-electricity.webp" alt="GeoLibre map: Access to electricity"></a></td>
    <td width="50%"><a href="https://share.geolibre.app/giswqs/renewable-electricity-2000-vs-2024"><img src="https://assets.geolibre.app/images/renewable-electricity-2000-vs-2024.webp" alt="GeoLibre map: Renewable electricity, 2000 vs 2024"></a></td>
  </tr>
  <tr>
    <td align="center"><b><a href="https://share.geolibre.app/giswqs/access-to-electricity">Access to electricity</a></b><br>Development · Share of each country's population with electricity, latest year<br><small>Data: World Bank WDI</small></td>
    <td align="center"><b><a href="https://share.geolibre.app/giswqs/renewable-electricity-2000-vs-2024">Renewable electricity, 2000 vs 2024</a></b><br>Energy · Share of power from renewables: swipe 2000 against 2024<br><small>Data: Our World in Data (Ember, EI)</small></td>
  </tr>
  <tr>
    <td width="50%"><a href="https://share.geolibre.app/giswqs/solar-power-growth-2000-2024"><img src="https://assets.geolibre.app/images/solar-power-growth-2000-2024.webp" alt="GeoLibre map: Solar power growth, 2000–2024"></a></td>
    <td width="50%"></td>
  </tr>
  <tr>
    <td align="center"><b><a href="https://share.geolibre.app/giswqs/solar-power-growth-2000-2024">Solar power growth, 2000–2024</a></b><br>Energy · Solar generation by country on a time slider: watch the circles grow<br><small>Data: Our World in Data</small></td>
    <td></td>
  </tr>
</table>

### Space and Earth observation

5 projects · [Filter by the `space` tag](https://share.geolibre.app/explore?tag=space)

<table>
  <tr>
    <td width="50%"><a href="https://share.geolibre.app/giswqs/earth-from-space-in-one-day"><img src="https://assets.geolibre.app/images/earth-from-space-in-one-day.webp" alt="GeoLibre map: Earth from space in one day"></a></td>
    <td width="50%"><a href="https://share.geolibre.app/giswqs/meteorite-landings"><img src="https://assets.geolibre.app/images/meteorite-landings.webp" alt="GeoLibre map: Meteorite landings"></a></td>
  </tr>
  <tr>
    <td align="center"><b><a href="https://share.geolibre.app/giswqs/earth-from-space-in-one-day">Earth from space in one day</a></b><br>Earth observation · The whole planet in true color from one day of NOAA-20 orbits<br><small>Data: NASA GIBS (VIIRS)</small></td>
    <td align="center"><b><a href="https://share.geolibre.app/giswqs/meteorite-landings">Meteorite landings</a></b><br>Space · 32,047 meteorites sized by mass and split into observed falls and finds<br><small>Data: NASA, Meteoritical Society</small></td>
  </tr>
  <tr>
    <td width="50%"><a href="https://share.geolibre.app/giswqs/orbital-launch-sites-1957-2025"><img src="https://assets.geolibre.app/images/orbital-launch-sites-1957-2025.webp" alt="GeoLibre map: Orbital launch sites, 1957–2025"></a></td>
    <td width="50%"><a href="https://share.geolibre.app/giswqs/astronomical-observatories"><img src="https://assets.geolibre.app/images/astronomical-observatories.webp" alt="GeoLibre map: Astronomical observatories"></a></td>
  </tr>
  <tr>
    <td align="center"><b><a href="https://share.geolibre.app/giswqs/orbital-launch-sites-1957-2025">Orbital launch sites, 1957–2025</a></b><br>Space · Orbital launches per site and year from Sputnik to 2025<br><small>Data: GCAT (J. McDowell)</small></td>
    <td align="center"><b><a href="https://share.geolibre.app/giswqs/astronomical-observatories">Astronomical observatories</a></b><br>Space · 2,693 observatories as a heatmap that resolves into sites by elevation<br><small>Data: IAU Minor Planet Center</small></td>
  </tr>
  <tr>
    <td width="50%"><a href="https://share.geolibre.app/giswqs/aurora-forecast"><img src="https://assets.geolibre.app/images/aurora-forecast.webp" alt="GeoLibre map: Aurora forecast"></a></td>
    <td width="50%"></td>
  </tr>
  <tr>
    <td align="center"><b><a href="https://share.geolibre.app/giswqs/aurora-forecast">Aurora forecast</a></b><br>Space weather · The chance of seeing an aurora, a snapshot of the OVATION model<br><small>Data: NOAA SWPC</small></td>
    <td></td>
  </tr>
</table>

### History and culture

12 projects · [Filter by the `history-culture` tag](https://share.geolibre.app/explore?tag=history-culture)

<table>
  <tr>
    <td width="50%"><a href="https://share.geolibre.app/giswqs/unesco-world-heritage-sites"><img src="https://assets.geolibre.app/images/unesco-world-heritage-sites.webp" alt="GeoLibre map: UNESCO World Heritage sites"></a></td>
    <td width="50%"><a href="https://share.geolibre.app/giswqs/lighthouses-of-the-world"><img src="https://assets.geolibre.app/images/lighthouses-of-the-world.webp" alt="GeoLibre map: Lighthouses of the world"></a></td>
  </tr>
  <tr>
    <td align="center"><b><a href="https://share.geolibre.app/giswqs/unesco-world-heritage-sites">UNESCO World Heritage sites</a></b><br>Culture · All inscribed properties by category, with photos in the popups<br><small>Data: UNESCO World Heritage Centre</small></td>
    <td align="center"><b><a href="https://share.geolibre.app/giswqs/lighthouses-of-the-world">Lighthouses of the world</a></b><br>Culture · 9,567 lighthouses in clusters that split into towers colored by year built<br><small>Data: Wikidata</small></td>
  </tr>
  <tr>
    <td width="50%"><a href="https://share.geolibre.app/giswqs/nobel-laureates-birthplaces"><img src="https://assets.geolibre.app/images/nobel-laureates-birthplaces.webp" alt="GeoLibre map: Nobel laureates birthplaces"></a></td>
    <td width="50%"><a href="https://share.geolibre.app/giswqs/languages-of-the-world"><img src="https://assets.geolibre.app/images/languages-of-the-world.webp" alt="GeoLibre map: Languages of the world"></a></td>
  </tr>
  <tr>
    <td align="center"><b><a href="https://share.geolibre.app/giswqs/nobel-laureates-birthplaces">Nobel laureates birthplaces</a></b><br>Culture · Birthplaces of 990 Nobel laureates, colored by prize<br><small>Data: Wikidata</small></td>
    <td align="center"><b><a href="https://share.geolibre.app/giswqs/languages-of-the-world">Languages of the world</a></b><br>Culture · 7,896 languages colored by family<br><small>Data: Glottolog</small></td>
  </tr>
  <tr>
    <td width="50%"><a href="https://share.geolibre.app/giswqs/castles-of-europe"><img src="https://assets.geolibre.app/images/castles-of-europe.webp" alt="GeoLibre map: Castles of Europe"></a></td>
    <td width="50%"><a href="https://share.geolibre.app/giswqs/places-of-the-ancient-world"><img src="https://assets.geolibre.app/images/places-of-the-ancient-world.webp" alt="GeoLibre map: Places of the ancient world"></a></td>
  </tr>
  <tr>
    <td align="center"><b><a href="https://share.geolibre.app/giswqs/castles-of-europe">Castles of Europe</a></b><br>History · 22,033 castles in clusters; click one for its photo<br><small>Data: Wikidata, Wikimedia Commons</small></td>
    <td align="center"><b><a href="https://share.geolibre.app/giswqs/places-of-the-ancient-world">Places of the ancient world</a></b><br>History · 31,314 ancient places colored by the period they are first attested<br><small>Data: Pleiades (ISAW, NYU)</small></td>
  </tr>
  <tr>
    <td width="50%"><a href="https://share.geolibre.app/giswqs/roads-of-the-roman-empire"><img src="https://assets.geolibre.app/images/roads-of-the-roman-empire.webp" alt="GeoLibre map: Roads of the Roman Empire"></a></td>
    <td width="50%"><a href="https://share.geolibre.app/giswqs/universities-by-founding-year"><img src="https://assets.geolibre.app/images/universities-by-founding-year.webp" alt="GeoLibre map: Universities by founding year"></a></td>
  </tr>
  <tr>
    <td align="center"><b><a href="https://share.geolibre.app/giswqs/roads-of-the-roman-empire">Roads of the Roman Empire</a></b><br>History · About 300,000 km of Roman roads by how certain the route is<br><small>Data: Itiner-e</small></td>
    <td align="center"><b><a href="https://share.geolibre.app/giswqs/universities-by-founding-year">Universities by founding year</a></b><br>Education · 8,674 universities build up from the Middle Ages to today<br><small>Data: Wikidata</small></td>
  </tr>
  <tr>
    <td width="50%"><a href="https://share.geolibre.app/giswqs/most-visited-museums"><img src="https://assets.geolibre.app/images/most-visited-museums.webp" alt="GeoLibre map: Most visited museums"></a></td>
    <td width="50%"><a href="https://share.geolibre.app/giswqs/great-cities-1000-1900"><img src="https://assets.geolibre.app/images/great-cities-1000-1900.webp" alt="GeoLibre map: Great cities, 1000–1900"></a></td>
  </tr>
  <tr>
    <td align="center"><b><a href="https://share.geolibre.app/giswqs/most-visited-museums">Most visited museums</a></b><br>Culture · 116 museums with at least 1 million visitors a year, with photos<br><small>Data: Wikidata</small></td>
    <td align="center"><b><a href="https://share.geolibre.app/giswqs/great-cities-1000-1900">Great cities, 1000–1900</a></b><br>History · City populations century by century on a time slider<br><small>Data: Chandler via Reba et al. 2016</small></td>
  </tr>
  <tr>
    <td width="50%"><a href="https://share.geolibre.app/giswqs/shipwrecks-of-us-waters"><img src="https://assets.geolibre.app/images/shipwrecks-of-us-waters.webp" alt="GeoLibre map: Shipwrecks of US waters"></a></td>
    <td width="50%"><a href="https://share.geolibre.app/giswqs/historical-battles-since-1000"><img src="https://assets.geolibre.app/images/historical-battles-since-1000.webp" alt="GeoLibre map: Historical battles since 1000"></a></td>
  </tr>
  <tr>
    <td align="center"><b><a href="https://share.geolibre.app/giswqs/shipwrecks-of-us-waters">Shipwrecks of US waters</a></b><br>History · 11,234 charted wrecks as a heatmap that resolves into points<br><small>Data: NOAA ENC Direct</small></td>
    <td align="center"><b><a href="https://share.geolibre.app/giswqs/historical-battles-since-1000">Historical battles since 1000</a></b><br>History · 7,254 battles, one quarter-century at a time<br><small>Data: Wikidata</small></td>
  </tr>
</table>

### Society and economy

13 projects · [Filter by the `society-economy` tag](https://share.geolibre.app/explore?tag=society-economy)

<table>
  <tr>
    <td width="50%"><a href="https://share.geolibre.app/giswqs/refugee-flows-2024"><img src="https://assets.geolibre.app/images/refugee-flows-2024.webp" alt="GeoLibre map: Refugee flows 2024"></a></td>
    <td width="50%"><a href="https://share.geolibre.app/giswqs/eu-regional-gdp-per-person"><img src="https://assets.geolibre.app/images/eu-regional-gdp-per-person.webp" alt="GeoLibre map: EU regional GDP per person"></a></td>
  </tr>
  <tr>
    <td align="center"><b><a href="https://share.geolibre.app/giswqs/refugee-flows-2024">Refugee flows 2024</a></b><br>Human mobility · The 400 largest origin-to-asylum flows as great circles, hosts sized by people hosted<br><small>Data: UNHCR Refugee Data Finder</small></td>
    <td align="center"><b><a href="https://share.geolibre.app/giswqs/eu-regional-gdp-per-person">EU regional GDP per person</a></b><br>Economy · GDP per inhabitant in PPS for 272 NUTS 2 regions, 2022<br><small>Data: Eurostat, GISCO</small></td>
  </tr>
  <tr>
    <td width="50%"><a href="https://share.geolibre.app/giswqs/us-presidential-election-2024-by-county"><img src="https://assets.geolibre.app/images/us-presidential-election-2024-by-county.webp" alt="GeoLibre map: US presidential election 2024 by county"></a></td>
    <td width="50%"><a href="https://share.geolibre.app/giswqs/sister-cities-of-major-world-cities"><img src="https://assets.geolibre.app/images/sister-cities-of-major-world-cities.webp" alt="GeoLibre map: Sister cities of major world cities"></a></td>
  </tr>
  <tr>
    <td align="center"><b><a href="https://share.geolibre.app/giswqs/us-presidential-election-2024-by-county">US presidential election 2024 by county</a></b><br>Society · Vote margin in 3,116 counties, in percentage points<br><small>Data: tonmcg county results, US Census</small></td>
    <td align="center"><b><a href="https://share.geolibre.app/giswqs/sister-cities-of-major-world-cities">Sister cities of major world cities</a></b><br>Society · 1,108 sister-city links as great circles, colored by distance<br><small>Data: Wikidata</small></td>
  </tr>
  <tr>
    <td width="50%"><a href="https://share.geolibre.app/giswqs/human-development-index-1990-2023"><img src="https://assets.geolibre.app/images/human-development-index-1990-2023.webp" alt="GeoLibre map: Human Development Index, 1990–2023"></a></td>
    <td width="50%"><a href="https://share.geolibre.app/giswqs/internet-users-3d"><img src="https://assets.geolibre.app/images/internet-users-3d.webp" alt="GeoLibre map: Internet users in 3D"></a></td>
  </tr>
  <tr>
    <td align="center"><b><a href="https://share.geolibre.app/giswqs/human-development-index-1990-2023">Human Development Index, 1990–2023</a></b><br>Development · Three decades of human development on a yearly time slider<br><small>Data: UNDP via Our World in Data</small></td>
    <td align="center"><b><a href="https://share.geolibre.app/giswqs/internet-users-3d">Internet users in 3D</a></b><br>Connectivity · Share of people online, extruded in 3D by country<br><small>Data: World Bank (ITU)</small></td>
  </tr>
  <tr>
    <td width="50%"><a href="https://share.geolibre.app/giswqs/fertility-rate-vs-replacement-level"><img src="https://assets.geolibre.app/images/fertility-rate-vs-replacement-level.webp" alt="GeoLibre map: Fertility rate vs replacement level"></a></td>
    <td width="50%"><a href="https://share.geolibre.app/giswqs/eu-regional-unemployment"><img src="https://assets.geolibre.app/images/eu-regional-unemployment.webp" alt="GeoLibre map: EU regional unemployment"></a></td>
  </tr>
  <tr>
    <td align="center"><b><a href="https://share.geolibre.app/giswqs/fertility-rate-vs-replacement-level">Fertility rate vs replacement level</a></b><br>Population · Births per woman, blue below and red above the replacement level of 2.1<br><small>Data: World Bank</small></td>
    <td align="center"><b><a href="https://share.geolibre.app/giswqs/eu-regional-unemployment">EU regional unemployment</a></b><br>Economy · Unemployment in 286 European regions, 2025<br><small>Data: Eurostat, GISCO</small></td>
  </tr>
  <tr>
    <td width="50%"><a href="https://share.geolibre.app/giswqs/military-expenditure"><img src="https://assets.geolibre.app/images/military-expenditure.webp" alt="GeoLibre map: Military expenditure"></a></td>
    <td width="50%"><a href="https://share.geolibre.app/giswqs/women-in-parliament-2000-vs-2025"><img src="https://assets.geolibre.app/images/women-in-parliament-2000-vs-2025.webp" alt="GeoLibre map: Women in parliament, 2000 vs 2025"></a></td>
  </tr>
  <tr>
    <td align="center"><b><a href="https://share.geolibre.app/giswqs/military-expenditure">Military expenditure</a></b><br>Economy · Circle area is spending in US dollars, color is the share of GDP<br><small>Data: World Bank (SIPRI)</small></td>
    <td align="center"><b><a href="https://share.geolibre.app/giswqs/women-in-parliament-2000-vs-2025">Women in parliament, 2000 vs 2025</a></b><br>Society · Share of parliament seats held by women: swipe 2000 against 2025<br><small>Data: World Bank (IPU)</small></td>
  </tr>
  <tr>
    <td width="50%"><a href="https://share.geolibre.app/giswqs/international-tourist-arrivals-3d"><img src="https://assets.geolibre.app/images/international-tourist-arrivals-3d.webp" alt="GeoLibre map: International tourist arrivals in 3D"></a></td>
    <td width="50%"><a href="https://share.geolibre.app/giswqs/international-migrant-corridors-2024"><img src="https://assets.geolibre.app/images/international-migrant-corridors-2024.webp" alt="GeoLibre map: International migrant corridors 2024"></a></td>
  </tr>
  <tr>
    <td align="center"><b><a href="https://share.geolibre.app/giswqs/international-tourist-arrivals-3d">International tourist arrivals in 3D</a></b><br>Economy · 2019 tourist arrivals extruded by total and colored per resident<br><small>Data: World Bank (UN Tourism)</small></td>
    <td align="center"><b><a href="https://share.geolibre.app/giswqs/international-migrant-corridors-2024">International migrant corridors 2024</a></b><br>Migration · The 250 largest country-to-country migrant corridors as great circles<br><small>Data: UN DESA</small></td>
  </tr>
  <tr>
    <td width="50%"><a href="https://share.geolibre.app/giswqs/inflation-2000-2025"><img src="https://assets.geolibre.app/images/inflation-2000-2025.webp" alt="GeoLibre map: Inflation, 2000–2025"></a></td>
    <td width="50%"></td>
  </tr>
  <tr>
    <td align="center"><b><a href="https://share.geolibre.app/giswqs/inflation-2000-2025">Inflation, 2000–2025</a></b><br>Economy · Consumer price inflation by country on a time slider<br><small>Data: World Bank (IMF)</small></td>
    <td></td>
  </tr>
</table>

### Food and agriculture

4 projects · [Filter by the `food-agriculture` tag](https://share.geolibre.app/explore?tag=food-agriculture)

<table>
  <tr>
    <td width="50%"><a href="https://share.geolibre.app/giswqs/cereal-yield-by-country"><img src="https://assets.geolibre.app/images/cereal-yield-by-country.webp" alt="GeoLibre map: Cereal yield by country"></a></td>
    <td width="50%"><a href="https://share.geolibre.app/giswqs/coffee-production-by-country"><img src="https://assets.geolibre.app/images/coffee-production-by-country.webp" alt="GeoLibre map: Coffee production by country"></a></td>
  </tr>
  <tr>
    <td align="center"><b><a href="https://share.geolibre.app/giswqs/cereal-yield-by-country">Cereal yield by country</a></b><br>Agriculture · Cereal yield in tonnes per hectare, each country labeled<br><small>Data: World Bank (FAO)</small></td>
    <td align="center"><b><a href="https://share.geolibre.app/giswqs/coffee-production-by-country">Coffee production by country</a></b><br>Food · Green coffee output in 2024 and its change since 2000<br><small>Data: FAO via Our World in Data</small></td>
  </tr>
  <tr>
    <td width="50%"><a href="https://share.geolibre.app/giswqs/prevalence-of-undernourishment"><img src="https://assets.geolibre.app/images/prevalence-of-undernourishment.webp" alt="GeoLibre map: Prevalence of undernourishment"></a></td>
    <td width="50%"><a href="https://share.geolibre.app/giswqs/rice-production-1961-2024"><img src="https://assets.geolibre.app/images/rice-production-1961-2024.webp" alt="GeoLibre map: Rice production, 1961–2024"></a></td>
  </tr>
  <tr>
    <td align="center"><b><a href="https://share.geolibre.app/giswqs/prevalence-of-undernourishment">Prevalence of undernourishment</a></b><br>Food security · Share of people who cannot meet their dietary energy needs<br><small>Data: World Bank (FAO)</small></td>
    <td align="center"><b><a href="https://share.geolibre.app/giswqs/rice-production-1961-2024">Rice production, 1961–2024</a></b><br>Food · Rice harvests by country on a time slider<br><small>Data: FAO via Our World in Data</small></td>
  </tr>
</table>

## SQL Workspace

Run DuckDB Spatial SQL against loaded layers, local files, and remote URLs
without leaving the map, then add the result as a layer or export it. PostGIS
(PGlite) and Apache Sedona engines are available from the same panel.

[![The SQL Workspace panel docked beside the map, running a spatial query](https://assets.geolibre.app/images/geolibre-sql-workspace.webp)](https://assets.geolibre.app/images/geolibre-sql-workspace.webp)

See [SQL Workspace](user-guide/sql-workspace.md) and the
[Spatial SQL tutorial](tutorials/spatial-sql.md).

## Chrome-free embeds

Any shared project can be embedded with `maponly` for a pure map with no
toolbar, panels, or status bar.

[![Chrome-free maponly embed of a 3D Tiles project](https://assets.geolibre.app/images/geolibre-embed-maponly.webp)](https://assets.geolibre.app/images/geolibre-embed-maponly.webp)

See [Embedding & Sharing](user-guide/embedding.md) for every URL parameter.

## Video tutorials

- [GeoLibre 1.0: A Free, Open-Source Cloud-Native GIS That Runs Anywhere (Browser, Desktop & Jupyter)](https://youtu.be/87Cm0QagtxI) — a tour of the browser, desktop, and Jupyter builds.
- [Geoprocessing in the Browser: 700+ Free GIS Tools in GeoLibre, Zero Install](https://youtu.be/W32bIQO_nG8) — the Whitebox toolbox running entirely on WebAssembly.
- [Access Free High-Resolution Disaster Satellite Imagery in Your Browser](https://youtu.be/QQ9i5CTNh84) — pre- and post-event imagery through the Vantor Open Data plugin.
- [Regularize Building Footprints in the Browser with GeoLibre](https://youtu.be/xjfPYxgEEEc) — squaring up AI-derived building polygons with the Rust engine.
- [GeoLibre + GeoLens: A Modern GIS Stack for Self-Hosting Geospatial Data](https://youtu.be/kQqgrxXGd4o) — pairing GeoLibre with GeoLens for a self-hosted geospatial data stack.
- [Create Reusable GIS Workflows with GeoLibre Model Builder and AI Assistant](https://youtu.be/dzjNKM6slgs) — graphical models, including ones the AI Assistant builds from a prompt.
- [Mapping the 2026 Nepal Floods with Free High-Resolution Satellite Imagery](https://youtu.be/UDO1BCwOAAc) — disaster imagery from Vantor, Planet, and OpenAerialMap in one before-and-after map.
- [Building Cloud-Native GIS Workflows with GeoLibre](https://youtu.be/RgNoKsvZ5Hk) — an hour-long webinar on the cloud-native stack behind GeoLibre.
- [Image Georeferencing Using GeoLibre in the Browser](https://youtu.be/lbioujkDSG0) — pinning a scanned campus map to the basemap with ground control points.

All of them, with chapters and summaries, are on
[Video Tutorials](tutorials/videos.md).

## Try it yourself

[Launch GeoLibre Web](https://web.geolibre.app/){ .md-button .md-button--primary }
[Download the app](downloads.md){ .md-button }
[Getting started](getting-started.md){ .md-button }
