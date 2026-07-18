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

// The Jupyter server's base URL, read from the page config that JupyterLab and
// Notebook 7 inject. Used to build the same-origin remote app URLs. Defaults to
// "/".
function jupyterBaseUrl() {
  try {
    const el = document.getElementById("jupyter-config-data");
    if (el && el.textContent) {
      const base = JSON.parse(el.textContent).baseUrl;
      if (base) return base.endsWith("/") ? base : `${base}/`;
    }
  } catch (error) {
    console.warn("[GeoLibre] Could not read jupyter-config-data", error);
  }
  return "/";
}

// Base URL of the app served by the GeoLibre Jupyter Server extension
// (_extension.py), which mounts the bundle at {base_url}geolibre/app/. Available
// only after the Jupyter Server has loaded the extension (i.e. after a restart).
function extensionBase() {
  return new URL(`${jupyterBaseUrl()}geolibre/app/`, window.location.href).href;
}

// Base URL of the kernel-side localhost bundle as seen through
// jupyter-server-proxy, which serves kernel ports at {base_url}proxy/{port}/.
// Available without a server restart wherever jupyter-server-proxy is installed.
function proxyBase(port) {
  return new URL(`${jupyterBaseUrl()}proxy/${port}/`, window.location.href).href;
}

// Ordered same-origin candidates to try under "remote" mode. Both serve the
// identical bundle from the notebook's own origin; the front-end uses whichever
// is live, so a host needs only ONE of them (the extension, or
// jupyter-server-proxy) for the widget to work.
//
// Proxy first: it reaches the bundle in the RUNNING server with no restart and
// is the common working case (including the "just installed, no restart" one),
// so trying it first avoids waiting on a failed extension probe -- the extension
// only registers after the Jupyter Server restarts. The extension is the
// fallback for locked-down hubs that lack jupyter-server-proxy.
function remoteCandidates(model) {
  const candidates = [];
  const port = model.get("_app_port");
  if (port) candidates.push(proxyBase(port));
  candidates.push(extensionBase());
  return candidates;
}

// Resolve the base URL of the app. The kernel serves it on localhost, which the
// browser reaches directly in local Jupyter / VS Code. On hosts where the
// browser cannot reach the kernel's localhost, the app comes from elsewhere:
// Google Colab's port proxy, or (JupyterHub / remote servers, "remote" mode) one
// of two same-origin routes served from the notebook's own origin. In remote
// mode each candidate is HEAD-probed and the first reachable one is used, so a
// host needs only the server extension OR jupyter-server-proxy, not both. Returns
// null in remote mode when no candidate is reachable.
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
  if (model.get("_remote_mode") === "remote") {
    // One shared budget across all candidate probes, so the worst-case wait when
    // no route is reachable stays at 15s total (not 15s per candidate) while
    // still giving a cold/loaded hub the full window to answer. render() awaits
    // this before the iframe exists, so an unbounded stall would otherwise hang
    // widget rendering; the caller shows a placeholder while it runs.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      for (const base of remoteCandidates(model)) {
        if (await appReachable(base, controller.signal)) return base;
      }
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
  return model.get("_app_url");
}

// Verify the bundle is actually reachable before pointing the iframe at it, so a
// missing/disabled route surfaces an actionable message instead of a bare 404
// page inside the iframe. The abort `signal` (and its overall deadline) is owned
// by the caller so a single budget bounds a whole sequence of candidate probes.
//
// Base URLs confirmed reachable this session. render() can run again on every
// re-display, so caching the (stable) positive result skips a redundant HEAD
// round-trip each time. Only successes are cached: a negative result is left
// uncached so re-running the cell after enabling the extension re-probes and
// recovers, matching the "then re-run this cell" hint shown on failure.
const _reachable = new Set();

async function appReachable(base, signal) {
  if (_reachable.has(base)) return true;
  try {
    const res = await fetch(`${base}index.html`, {
      method: "HEAD",
      credentials: "same-origin",
      signal,
    });
    if (res.ok) _reachable.add(base);
    return res.ok;
  } catch (error) {
    console.warn("[GeoLibre] App reachability check failed", error);
    return false;
  }
}

async function render({ model, el }) {
  const iframe = document.createElement("iframe");
  iframe.style.width = "100%";
  iframe.style.height = model.get("height") || "800px";
  iframe.style.border = "0";
  iframe.style.display = "block";
  iframe.allow = "fullscreen; clipboard-read; clipboard-write; geolocation";
  iframe.allowFullscreen = true;

  const remote = model.get("_remote_mode") === "remote";
  if (remote) {
    // resolveBase HEAD-probes each candidate route before the iframe exists, so
    // a missing/disabled route surfaces an actionable message instead of a bare
    // 404 in the iframe. Show a placeholder while the probe runs so the cell is
    // not blank on a slow hub.
    el.textContent = "GeoLibre: connecting to the Jupyter server…";
  }

  const base = await resolveBase(model);
  if (!base) {
    el.textContent = remote
      ? "GeoLibre: the bundled app could not be loaded from the Jupyter server. " +
        "Enable the server extension and restart your Jupyter server (run " +
        "`jupyter server extension enable geolibre`, then restart), or install " +
        "jupyter-server-proxy, then re-run this cell."
      : "GeoLibre: the local app server is not running. Re-create the Map().";
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
  // replaceChildren clears any placeholder text set above before mounting.
  el.replaceChildren(iframe);

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

  // Commands (geolibre:command) issued from Python before the iframe app has
  // signalled readiness are held here and flushed once geolibre:ready arrives,
  // mirroring how the first project push waits for ready.
  const pendingCommands = [];
  const flushCommands = () => {
    if (!ready) return;
    while (pendingCommands.length) post(pendingCommands.shift());
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
      flushCommands();
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
    } else if (data.type === "geolibre:result" || data.type === "geolibre:event") {
      // Pure passthrough of the scripting RPC reply / event back to Python over
      // the anywidget custom-message channel; the requestId stays opaque here.
      model.send(data);
    }
  };

  window.addEventListener("message", onMessage);

  // Relay scripting commands from Python (widget.send) into the iframe app.
  // Queue until the app is ready so a command issued right after construction
  // is not dropped.
  const onCustom = (msg) => {
    if (!msg || typeof msg !== "object") return;
    if (msg.type !== "geolibre:command") return;
    // Once ready, post straight through; only buffer before the app signals
    // ready (the queue is flushed on geolibre:ready). Defensive cap so a caller
    // that bypasses the blocking request() can't grow the queue without limit.
    if (ready) {
      post(msg);
    } else if (pendingCommands.length < 500) {
      pendingCommands.push(msg);
    } else {
      // Warn so a full queue is diagnosable; otherwise the dropped command only
      // surfaces as a confusing TimeoutError on the Python side.
      console.warn(`[GeoLibre] command queue full (500); dropping "${msg.method}"`);
    }
  };
  model.on("msg:custom", onCustom);

  const onProjectChange = () => {
    // Loop guard. The PRIMARY protection is on the Python side: traitlets.Dict
    // change detection is value-based, so the kernel never re-broadcasts the
    // value we just sent back to the front end. This identity check is the
    // SECONDARY fast-path guard that avoids the round-trip entirely: a project
    // that originated from the app is still the identical object on the trait,
    // so don't echo it back; a Python-initiated change deserializes into a fresh
    // object, so identity differs and it is pushed.
    //
    // Invariant: this relies on anywidget/backbone returning from model.get()
    // the same JS object reference passed to model.set() on this side (no
    // serialization round-trip on the front end). If a future anywidget release
    // ever deep-clones or JSON-normalizes the Dict trait on set, the reference
    // check would always fail and every app snapshot would be echoed back —
    // replace this with the primitive `_seq` counter comparison instead.
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
    model.off("msg:custom", onCustom);
    model.off("change:project", onProjectChange);
    model.off("change:height", onHeight);
  };
}

export default { render };
