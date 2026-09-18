/* Dash front end for geolibre.DashMap. It uses GeoLibre's existing iframe
 * embed protocol, keeping the Jupyter and Dash map implementations aligned. */
(function () {
  "use strict";
  function DashMap(props) {
    var React = window.React;
    var dash = window.dash_component_api;
    var iframeRef = React.useRef(null);
    // The app posts "geolibre:ready" once per load, so a project change on an
    // already-mounted iframe (same src) has to push the new project itself.
    // Mirrors the anywidget front end's ready flag + onProjectChange push.
    var readyRef = React.useRef(false);
    var seqRef = React.useRef(0);
    // Latest props for the async message handler; refreshed after every render
    // (this effect is declared first, so the effects below see fresh props).
    var propsRef = React.useRef(props);
    React.useEffect(function () { propsRef.current = props; });
    var sendProject = React.useCallback(function () {
      var iframe = iframeRef.current;
      if (!iframe || !iframe.contentWindow) return;
      seqRef.current += 1;
      iframe.contentWindow.postMessage({
        type: "geolibre:load-project", project: propsRef.current.project,
        trustedWidget: false, seq: seqRef.current
      }, new URL(propsRef.current.appUrl).origin);
    }, []);
    React.useEffect(function () {
      var iframe = iframeRef.current;
      if (!iframe) return undefined;
      var origin = new URL(props.appUrl).origin;
      // A changed src reloads the iframe, so readiness starts over.
      readyRef.current = false;
      var onMessage = function (event) {
        if (event.source !== iframe.contentWindow || event.origin !== origin) return;
        var data = event.data || {};
        if (data.type === "geolibre:ready") {
          readyRef.current = true;
          sendProject();
        } else if (data.type === "geolibre:event") {
          var payload = data.payload;
          if (data.event === "click" && payload && Array.isArray(payload.lngLat)) {
            payload = Object.assign({}, payload, {
              lngLat: { lng: payload.lngLat[0], lat: payload.lngLat[1] }
            });
          }
          var property = data.event === "click" ? "clickData" :
            data.event === "selection-change" ? "selectionData" : null;
          var setProps = propsRef.current.setProps ||
            (dash && (dash.set_props || dash.setProps));
          if (property && setProps) setProps({ [property]: payload });
        }
      };
      window.addEventListener("message", onMessage);
      return function () {
        window.removeEventListener("message", onMessage);
        readyRef.current = false;
      };
    }, [props.appUrl, sendProject]);
    // Push a project that changed after the iframe already signalled ready;
    // before that, the ready handler sends the current project.
    React.useEffect(function () {
      if (readyRef.current) sendProject();
    }, [props.project, sendProject]);
    var query = "?embed=1&theme=" + encodeURIComponent(props.theme || "light");
    if (props.layout === "maponly") query += "&maponly=1";
    else if (props.layout !== "full") query += "&layout=embed";
    return React.createElement("iframe", {
      ref: iframeRef, src: props.appUrl + "index.html" + query,
      title: "GeoLibre map", allow: "fullscreen; geolocation", allowFullScreen: true,
      style: Object.assign({ width: "100%", height: props.height || "800px", border: 0, display: "block" }, props.style || {})
    });
  }
  window.geolibre = window.geolibre || {};
  window.geolibre.DashMap = DashMap;
}());
