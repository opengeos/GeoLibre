import "./lib/symbol-dispose-polyfill";
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "@geoman-io/maplibre-geoman-free/dist/maplibre-geoman.css";
import "maplibre-gl-3d-tiles/style.css";
import "maplibre-gl-basemap-control/style.css";
import "maplibre-gl-components/style.css";
import "maplibre-gl-duckdb/style.css";
import "maplibre-gl-esri-wayback/style.css";
import "maplibre-gl-geo-editor/style.css";
import "maplibre-gl-geoagent/style.css";
import "maplibre-gl-geoparquet/style.css";
import "maplibre-gl-streetview/style.css";
import "maplibre-gl-swipe/style.css";
import "mapillary-js/dist/mapillary.css";
import "./index.css";
import "./lib/geoagent-style";
import "./lib/lidar-style";
import "./lib/swipe-style";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
