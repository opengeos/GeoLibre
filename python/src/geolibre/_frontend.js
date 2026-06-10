// anywidget front-end for the GeoLibre Jupyter widget.
//
// Renders the bundled GeoLibre app in an <iframe> and bridges it with the
// Python model over window.postMessage. The single synced payload is a
// `.geolibre.json` project object.
//
// Loop prevention: a project the app reports back (geolibre:state) is written
// into the `project` trait but NOT pushed back into the iframe. onProjectChange
// compares the current value against the last object received from the app
// (`lastRemoteProject`) and only pushes Python-initiated changes.

// Resolve the base URL of the app server. The kernel serves it on localhost,
// which the browser reaches directly in local Jupyter / VS Code. On hosts where
// the browser cannot reach the kernel's localhost (e.g. Google Colab), route
// through the host's port proxy instead.
async function resolveBase(model) {
  const port = model.get("_app_port");
  const colab =
    typeof window !== "undefined" &&
    window.google &&
    window.google.colab &&
    window.google.colab.kernel;
  if (port && colab && typeof colab.proxyPort === "function") {
    try {
      const url = await colab.proxyPort(port, { cache: true });
      if (url) return url.endsWith("/") ? url : `${url}/`;
    } catch (error) {
      console.warn("[GeoLibre] Colab proxyPort failed; using direct URL", error);
    }
  }
  return model.get("_app_url");
}

async function render({ model, el }) {
  const iframe = document.createElement("iframe");
  iframe.style.width = "100%";
  iframe.style.height = model.get("height") || "800px";
  iframe.style.border = "0";
  iframe.style.display = "block";
  iframe.allow = "fullscreen; clipboard-read; clipboard-write; geolocation";
  iframe.allowFullscreen = true;

  const base = await resolveBase(model);
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
  // The last project object received from the app. onProjectChange compares the
  // current trait value against it by reference to decide whether a change came
  // from the app (skip) or from Python (push). Reference identity avoids any
  // dependency on whether anywidget fires change:project synchronously.
  let lastRemoteProject = null;

  // Restrict delivery to the app server's own origin (localhost, or the host
  // proxy origin on Colab), so a future misconfiguration cannot leak the project
  // to a third party.
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
    // Defense in depth alongside the source check: reject messages that did not
    // originate from the app's own origin.
    if (event.origin !== iframeOrigin) return;
    const data = event.data;
    if (!data || typeof data !== "object") return;
    if (data.type === "geolibre:ready") {
      ready = true;
      pushProject();
    } else if (data.type === "geolibre:state") {
      // Record the project object that came from the app, then write it back to
      // Python. onProjectChange skips pushing whatever value is still identical
      // to this reference, so the app's own state is never echoed back.
      lastRemoteProject = data.project;
      model.set("project", data.project);
      model.save_changes();
    } else if (data.type === "geolibre:error") {
      model.set("error", String(data.message || ""));
      model.save_changes();
    }
  };

  window.addEventListener("message", onMessage);

  const onProjectChange = () => {
    // A project that originated from the app is still the identical object on
    // the trait; do not echo it back. A Python-initiated change deserializes
    // into a fresh object, so identity differs and it is pushed. The kernel does
    // not re-broadcast the value we just sent (traitlets.Dict change detection
    // is value-based), so the identity check is not defeated by the save round
    // trip.
    if (model.get("project") === lastRemoteProject) return;
    lastRemoteProject = null;
    pushProject();
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
