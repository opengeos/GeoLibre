# Privacy policy — Open data in GeoLibre

Last updated: August 15, 2026

Open data in GeoLibre does not collect, retain, sell, or transmit personal
information, browsing history, page contents, or usage analytics.

The extension uses Chrome's `activeTab` permission to inspect links and
structured metadata on the current page only after the user clicks the
extension's toolbar icon. Inspection happens locally in the browser. Results
are held in memory only while the popup is open.

When the user chooses **Open in GeoLibre**, the selected public dataset and
style URLs are placed in the query string of a new `https://web.geolibre.app/`
tab. The extension does not fetch or upload the datasets itself. GeoLibre then
requests the selected URLs directly from their original servers, subject to
those servers' privacy policies and CORS configuration.

The extension uses no remote code, advertising, analytics, tracking pixels,
cookies, accounts, or extension storage.

Questions may be submitted through the GeoLibre repository:
<https://github.com/opengeos/GeoLibre/issues>.
