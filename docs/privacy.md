# Privacy Policy

_Last updated: August 23, 2026_

GeoLibre Desktop ("GeoLibre", "the app") is an open-source desktop GIS
application developed by the OpenGeos community. This policy explains how the app
handles your data, and how our websites (geolibre.app and web.geolibre.app)
handle yours.

## Summary

GeoLibre runs locally on your device. It does not require an account, and the
app itself does not collect analytics, telemetry, or usage data. Your geospatial
data and projects stay on your device unless you choose to share or export them.

Our websites are separate from the app: geolibre.app and web.geolibre.app measure
page visits with Google Analytics, as described under
[Website analytics](#website-analytics) below.

Your use of the app is also governed by our [Terms of Service](terms.md).

## Data processed locally

The files and projects you open, create, and analyze in GeoLibre (vector and
raster datasets, project files, and similar) are processed locally on your
computer. GeoLibre does not upload them to the developer or to any server. An
optional helper process (a Python component running on your own machine at
127.0.0.1) performs some geoprocessing entirely on-device.

## Data sent to third-party services (optional features)

When you use certain optional features, GeoLibre sends requests directly to the
relevant third-party service. Those services receive your device's IP address and
the request you make, and are governed by their own privacy policies:

- **Basemaps / map tiles**: the current map view is used to request tiles from
  basemap providers (for example OpenFreeMap and CARTO).
- **Search / geocoding**: the place names or addresses you search are sent to
  the configured geocoding provider.
- **AI assistant**: if you use it, the prompts you enter, together with metadata
  about the layers currently loaded in your project (layer names and attribute
  field names), are sent to the configured AI/LLM provider.
- **Cloud data catalogs**: if you connect to services such as the Microsoft
  Planetary Computer or Google Earth Engine, your queries are sent to them.
- **Real-time collaboration**: if you join a shared session, your project data
  (including any GeoJSON from locally-loaded files) is routed through a relay
  server operated by the OpenGeos project (currently hosted on Cloudflare) and
  shared with the other participants. The relay holds the latest project snapshot
  so that later joiners can load the session, and discards it when the session ends.

GeoLibre does not control these third-party services; please review their privacy
policies for how they handle data.

## Website analytics

This section covers our websites, not the installed app.

The documentation site (<https://geolibre.app>) and the hosted browser app
(<https://web.geolibre.app>, and the demo at <https://geolibre.app/demo/>) use
Google Analytics 4 to count page visits and see which pages are used. Google
receives your IP address, the page you are on, the referring page, and general
device/browser information, and sets its own cookies or similar identifiers in
your browser. It is governed by [Google's privacy policy](https://policies.google.com/privacy).

What analytics never sees is the geospatial data you work with: layers, files,
project contents, queries, and coordinates are processed in your browser and are
not sent to Google. The page address we report is trimmed to the site and path
(for example `https://web.geolibre.app/`), with the query string removed, because
a GeoLibre link can carry a project URL, an inline dataset, or a collaboration
session identifier in its parameters.

You can opt out by blocking `www.googletagmanager.com` with a content blocker or
your browser's tracking protection; GeoLibre Web works normally with analytics
blocked.

Analytics run only on the sites we host. The desktop app, the Jupyter widget, and
the Docker image never load or run them: the measurement ID is supplied at build
time and is absent from those builds, so nothing is requested from Google and
nothing is reported. A copy you build and host yourself is the same unless you
deliberately supply a measurement ID of your own at build time, in which case the
analytics are yours, not ours (see [Self-Hosting](self-hosting.md)).

## Personal information

GeoLibre does not ask you to create an account and does not collect names, email
addresses, or similar identifying information. Network requests for the optional
features above necessarily include your device's IP address, which the receiving
service may log.

## Children

GeoLibre is a professional GIS tool intended for users aged 16 and over. It is
not directed at children, and we do not knowingly collect personal data from
children.

## Your choices

Because GeoLibre stores your data locally, you control it and can delete your
projects and files at any time. To avoid sending data to third-party services, do
not use the optional online features listed above.

## Changes to this policy

We may update this policy from time to time. The current version is always
available at <https://geolibre.app/privacy/>.

## Contact

Questions can be directed to the project at
<https://github.com/opengeos/GeoLibre/issues>.
