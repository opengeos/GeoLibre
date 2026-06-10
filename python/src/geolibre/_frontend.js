// anywidget front-end for the GeoLibre Jupyter widget.
//
// Renders the bundled GeoLibre app in an <iframe> and bridges it with the
// Python model over window.postMessage. The single synced payload is a
// `.geolibre.json` project object.
//
// Loop prevention: a project the app reports back (geolibre:state) is written
// into the `project` trait but NOT pushed back into the iframe, guarded by
// `applyingRemoteState`. Only Python-initiated project changes are pushed.

function render({ model, el }) {
  const iframe = document.createElement("iframe");
  iframe.style.width = "100%";
  iframe.style.height = model.get("height") || "800px";
  iframe.style.border = "0";
  iframe.style.display = "block";
  iframe.allow = "fullscreen; clipboard-read; clipboard-write; geolocation";
  iframe.allowFullscreen = true;

  const base = model.get("_app_url");
  if (!base) {
    el.textContent =
      "GeoLibre: the local app server is not running. Re-create the Map().";
    return;
  }

  const layout = model.get("layout") || "embed";
  const params = new URLSearchParams({ embed: "1", theme: model.get("theme") || "light" });
  if (layout === "maponly") {
    params.set("maponly", "1");
  } else if (layout !== "full") {
    params.set("layout", "embed");
  }
  iframe.src = `${base}index.html?${params.toString()}`;
  el.appendChild(iframe);

  let ready = false;
  let applyingRemoteState = false;

  // Restrict delivery to the app's own origin (the localhost app server), so a
  // future misconfiguration of `_app_url` cannot leak the project to a third
  // party.
  const iframeOrigin = new URL(base).origin;
  const post = (message) => {
    const win = iframe.contentWindow;
    if (win) win.postMessage(message, iframeOrigin);
  };

  const pushProject = () => {
    if (!ready) return;
    post({
      type: "geolibre:load-project",
      seq: model.get("_seq"),
      project: model.get("project"),
    });
  };

  const onMessage = (event) => {
    if (event.source !== iframe.contentWindow) return;
    const data = event.data;
    if (!data || typeof data !== "object") return;
    if (data.type === "geolibre:ready") {
      ready = true;
      pushProject();
    } else if (data.type === "geolibre:state") {
      // Set the flag before model.set() and clear it after: anywidget fires
      // change:project synchronously inside set(), and the flag must be true
      // during that callback or onProjectChange would echo the app's own state
      // back into the iframe as a new load. If a future anywidget defers
      // change events, this guard must be revisited.
      applyingRemoteState = true;
      model.set("project", data.project);
      model.save_changes();
      applyingRemoteState = false;
    } else if (data.type === "geolibre:error") {
      model.set("error", String(data.message || ""));
      model.save_changes();
    }
  };

  window.addEventListener("message", onMessage);

  const onProjectChange = () => {
    if (!applyingRemoteState) pushProject();
  };
  const onHeight = () => {
    iframe.style.height = model.get("height") || "800px";
  };
  model.on("change:project", onProjectChange);
  model.on("change:height", onHeight);

  return () => {
    window.removeEventListener("message", onMessage);
    model.off("change:project", onProjectChange);
    model.off("change:height", onHeight);
  };
}

export default { render };
