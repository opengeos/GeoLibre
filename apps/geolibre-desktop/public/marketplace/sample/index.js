// Minimal GeoLibre external plugin used as the marketplace's bundled sample.
// It is a self-contained ES module that exports a `plugin` implementing the
// GeoLibrePlugin contract, the same shape any external plugin must provide.

const control = {
  _container: null,
  onAdd() {
    const container = document.createElement("div");
    container.className = "maplibregl-ctrl maplibregl-ctrl-group";
    const button = document.createElement("button");
    button.type = "button";
    button.title = "GeoLibre Sample Plugin";
    button.setAttribute("aria-label", "GeoLibre Sample Plugin");
    button.textContent = "★"; // ★
    button.addEventListener("click", () => {
      window.alert("Hello from the GeoLibre Sample Plugin!");
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
