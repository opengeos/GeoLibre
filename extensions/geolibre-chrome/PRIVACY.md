# Privacy policy — Open data in GeoLibre

Last updated: August 16, 2026

Open data in GeoLibre does not independently collect, retain, or sell personal
information, page contents, or usage analytics. It does forward the complete
dataset, service, and style URLs that the user explicitly selects,
as described below.

The extension uses Chrome's `activeTab` permission to inspect links and
structured metadata on the current page only after the user clicks the
extension's toolbar icon. The extension also observes completed HTTP(S)
requests locally to identify geospatial services used by interactive maps. It
does not inspect response bodies. Detected service URLs are held in Chrome's
in-memory session storage and removed when their tab closes.

When the user chooses **Open in GeoLibre**, the complete selected HTTP(S)
dataset and style URLs are placed in the query string of a new
`https://web.geolibre.app/` tab. These URLs are forwarded verbatim and may
contain signed query parameters, access tokens, user identifiers, or other
personal data. Do not select a URL containing information you do not want to
send to GeoLibre.

The navigation request exposes its URL and the user's IP address to GeoLibre's
web-hosting infrastructure, where standard service logs may retain them. The
navigation may also appear in browser history. See the current
[GeoLibre privacy policy](https://geolibre.app/privacy/) for the service's data
practices. The extension itself does not persist URLs beyond the browser tab's
session.

The extension does not fetch or upload the datasets. GeoLibre requests them
directly from their original servers, subject to those servers' privacy
policies and CORS configuration. Cookies and other browser-session credentials
from the source page are not forwarded, although credentials embedded directly
in a selected URL are part of the URL and are forwarded.

The extension uses no remote code, advertising, analytics, tracking pixels,
cookies, accounts, or persistent extension storage.

Questions may be submitted through the GeoLibre repository:
<https://github.com/opengeos/GeoLibre/issues>.
