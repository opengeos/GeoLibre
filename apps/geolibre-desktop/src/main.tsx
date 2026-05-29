import "./lib/symbol-dispose-polyfill";
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "@geoman-io/maplibre-geoman-free/dist/maplibre-geoman.css";
import "maplibre-gl-basemap-control/style.css";
import "maplibre-gl-geo-editor/style.css";
import "maplibre-gl-geoagent/style.css";
import "maplibre-gl-streetview/style.css";
import "maplibre-gl-swipe/style.css";
import "mapillary-js/dist/mapillary.css";
import "./index.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
