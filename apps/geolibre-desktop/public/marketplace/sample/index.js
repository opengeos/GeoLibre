// Minimal GeoLibre external plugin used as the marketplace's bundled sample.
// It is a self-contained ES module that exports a `plugin` implementing the
// GeoLibrePlugin contract, the same shape any external plugin must provide.
// It ships style.css so its control is theme-aware in light and dark mode.

const STAR_SVG =
  '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true">' +
  '<path d="M12 2.5l2.9 5.88 6.49.94-4.7 4.58 1.11 6.46L12 17.9l-5.8 3.05 1.1-6.46-4.69-4.58 6.49-.94L12 2.5z"/>' +
  "</svg>";

const control = {
  _container: null,
  onAdd() {
    const container = document.createElement("div");
    container.className =
      "maplibregl-ctrl maplibregl-ctrl-group geolibre-sample-plugin-control";
    const button = document.createElement("button");
    button.type = "button";
    button.title = "GeoLibre Sample Plugin";
    button.setAttribute("aria-label", "GeoLibre Sample Plugin");
    button.innerHTML = STAR_SVG;
    button.addEventListener("click", () => {
      // Non-blocking feedback for the template. A real plugin would act on the
      // map here, e.g. app.addGeoJsonLayer(...) captured from activate(app).
      button.classList.toggle("is-active");
      console.info("GeoLibre Sample Plugin button clicked.");
    });
    container.appendChild(button);
    this._container = container;
    return container;
  },
  onRemove() {
    this._container?.remove();
    this._container = null;
  },
};

export const plugin = {
  id: "geolibre-sample-plugin",
  name: "Sample Plugin",
  version: "1.0.0",
  activate(app) {
    app.addMapControl(control, "top-right");
  },
  deactivate(app) {
    app.removeMapControl(control);
  },
};

export default plugin;
