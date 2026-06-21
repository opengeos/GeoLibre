# Privacy Policy

_Last updated: June 21, 2026_

GeoLibre Desktop ("GeoLibre", "the app") is an open-source desktop GIS
application developed by the OpenGeos community. This policy explains how the app
handles your data.

## Summary

GeoLibre runs locally on your device. It does not require an account, and it does
not collect analytics, telemetry, or usage data. Your geospatial data and
projects stay on your device unless you choose to share or export them.

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
