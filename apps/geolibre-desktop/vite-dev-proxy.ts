// Dev-server proxy middleware for the web build: WMS/WFS/CSW/GPX/coverage, live feeds, CCTV frames, Overpass and raster tiles.

import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";
import {
  proxyAircraftRequestGuarded,
  proxyAdsbdbAircraftRequestGuarded,
  proxyBinaryRequestGuarded,
  proxyAustinCctvFrameRequestGuarded,
  proxyCalgaryCctvFrameRequestGuarded,
  proxyCaltransCctvFrameRequestGuarded,
  proxyCctvCatalogRequestGuarded,
  proxyCelestrakRequestGuarded,
  proxyLaunchLibraryRequestGuarded,
  proxyOverpassRequestGuarded,
  proxyFirmsRequestGuarded,
  proxyTransitRequestGuarded,
  proxyOntarioCctvFrameRequestGuarded,
  proxyNswCctvFrameRequestGuarded,
} from "./vite-proxy-guard";
import { proxyOgcProcessRequest } from "./vite-ogc-process-proxy";
import { OGC_PROCESS_PROXY_PATH } from "./src/lib/ogc-process-limits";
import { MAX_COVERAGE_DOWNLOAD_BYTES } from "./src/lib/ogc-coverage-limits";

const WMS_PROXY_PATH = "/__geolibre_wms_proxy";

const WFS_PROXY_PATH = "/__geolibre_wfs_proxy";

const CSW_PROXY_PATH = "/__geolibre_csw_proxy";

const GPX_PROXY_PATH = "/__geolibre_gpx_proxy";

const OGC_COVERAGE_PROXY_PATH = "/__geolibre_coverage_proxy";

const CELESTRAK_PROXY_PATH = "/__geolibre_celestrak";

const LAUNCH_LIBRARY_PROXY_PATH = "/launch-library/recent";

const OPEN_SKY_PROXY_PATH = "/opensky/states";

const ADSB_LOL_MILITARY_PROXY_PATH = "/adsb-lol/military";

const ADSBDB_AIRCRAFT_PROXY_PATH = "/adsbdb/aircraft";

const TRANSIT_PROXY_PATH = "/transit/vehicles";

const FIRMS_PROXY_PATH = "/firms/viirs";

const AUSTIN_CCTV_FRAME_PROXY_PATH = "/cctv/austin";

const CALGARY_CCTV_FRAME_PROXY_PATH = "/cctv/calgary";

const CCTV_CATALOG_PROXY_PATH = "/cctv/catalog";

const ONTARIO_CCTV_FRAME_PROXY_PATH = "/cctv/ontario";

const NSW_CCTV_FRAME_PROXY_PATH = "/cctv/nsw";

const CALTRANS_CCTV_FRAME_PROXY_PATH = "/cctv/caltrans";

const OVERPASS_PROXY_PATH = "/overpass";

const RASTER_PROXY_PATH = "/__geolibre_raster_proxy";

export function wmsProxyPlugin(): Plugin {
  return {
    name: "geolibre-wms-proxy",
    configureServer(server) {
      server.middlewares.use(WMS_PROXY_PATH, async (req, res) => {
        try {
          await proxyWmsRequest(req, res);
        } catch (error) {
          const message = error instanceof Error ? error.message : "WMS proxy request failed";
          res.statusCode = 502;
          res.setHeader("content-type", "text/plain");
          res.end(message);
        }
      });
      server.middlewares.use(WFS_PROXY_PATH, async (req, res) => {
        try {
          await proxyBinaryRequestGuarded(req, res, WFS_PROXY_PATH);
        } catch (error) {
          const message = error instanceof Error ? error.message : "WFS proxy request failed";
          res.statusCode = 502;
          res.setHeader("content-type", "text/plain");
          res.end(message);
        }
      });
      server.middlewares.use(CSW_PROXY_PATH, async (req, res) => {
        try {
          await proxyBinaryRequestGuarded(req, res, CSW_PROXY_PATH);
        } catch (error) {
          const message = error instanceof Error ? error.message : "CSW proxy request failed";
          res.statusCode = 502;
          res.setHeader("content-type", "text/plain");
          res.end(message);
        }
      });
      server.middlewares.use(OGC_PROCESS_PROXY_PATH, proxyOgcProcessRequest);
      server.middlewares.use(GPX_PROXY_PATH, async (req, res) => {
        try {
          await proxyBinaryRequestGuarded(req, res, GPX_PROXY_PATH);
        } catch (error) {
          const message = error instanceof Error ? error.message : "GPX proxy request failed";
          res.statusCode = 502;
          res.setHeader("content-type", "text/plain");
          res.end(message);
        }
      });
      server.middlewares.use(OGC_COVERAGE_PROXY_PATH, async (req, res) => {
        try {
          await proxyBinaryRequestGuarded(req, res, OGC_COVERAGE_PROXY_PATH, {
            forwardAccept: true,
            discardErrorBody: true,
            maxBodyBytes: MAX_COVERAGE_DOWNLOAD_BYTES,
          });
        } catch {
          res.statusCode = 502;
          res.setHeader("content-type", "text/plain");
          res.end("Coverage proxy request failed");
        }
      });
      server.middlewares.use(CELESTRAK_PROXY_PATH, async (req, res) => {
        try {
          await proxyCelestrakRequestGuarded(req, res, CELESTRAK_PROXY_PATH);
        } catch {
          res.statusCode = 502;
          res.setHeader("content-type", "text/plain");
          res.end("CelesTrak proxy request failed");
        }
      });
      server.middlewares.use(LAUNCH_LIBRARY_PROXY_PATH, async (_req, res) => {
        try {
          await proxyLaunchLibraryRequestGuarded(res);
        } catch {
          res.statusCode = 502;
          res.setHeader("content-type", "text/plain");
          res.end("Launch Library 2 proxy request failed");
        }
      });
      server.middlewares.use(OPEN_SKY_PROXY_PATH, async (_req, res) => {
        try {
          await proxyAircraftRequestGuarded("opensky", res);
        } catch {
          res.statusCode = 502;
          res.setHeader("content-type", "text/plain");
          res.end("OpenSky proxy request failed");
        }
      });
      server.middlewares.use(ADSB_LOL_MILITARY_PROXY_PATH, async (_req, res) => {
        try {
          await proxyAircraftRequestGuarded("military", res);
        } catch {
          res.statusCode = 502;
          res.setHeader("content-type", "text/plain");
          res.end("adsb.lol proxy request failed");
        }
      });
      server.middlewares.use(ADSBDB_AIRCRAFT_PROXY_PATH, async (req, res) => {
        try {
          const requestUrl = new URL(
            req.url ?? "",
            `http://localhost${ADSBDB_AIRCRAFT_PROXY_PATH}`,
          );
          const icao = decodeURIComponent(requestUrl.pathname.replace(/^\//, ""));
          await proxyAdsbdbAircraftRequestGuarded(icao, res);
        } catch {
          res.statusCode = 502;
          res.setHeader("content-type", "text/plain");
          res.end("ADSBDB proxy request failed");
        }
      });
      server.middlewares.use(TRANSIT_PROXY_PATH, async (req, res) => {
        try {
          const requestUrl = new URL(req.url ?? "", `http://localhost${TRANSIT_PROXY_PATH}`);
          const feedId = decodeURIComponent(requestUrl.pathname.replace(/^\//, ""));
          await proxyTransitRequestGuarded(feedId, res);
        } catch {
          res.statusCode = 502;
          res.setHeader("content-type", "text/plain");
          res.end("Transit proxy request failed");
        }
      });
      server.middlewares.use(FIRMS_PROXY_PATH, async (req, res) => {
        try {
          const requestUrl = new URL(req.url ?? "", `http://localhost${FIRMS_PROXY_PATH}`);
          const satellite = decodeURIComponent(requestUrl.pathname.replace(/^\//, ""));
          await proxyFirmsRequestGuarded(satellite, res);
        } catch {
          res.statusCode = 502;
          res.setHeader("content-type", "text/plain");
          res.end("NASA FIRMS proxy request failed");
        }
      });
      server.middlewares.use(CALGARY_CCTV_FRAME_PROXY_PATH, async (req, res) => {
        try {
          const requestUrl = new URL(
            req.url ?? "",
            `http://localhost${CALGARY_CCTV_FRAME_PROXY_PATH}`,
          );
          const frameId = decodeURIComponent(requestUrl.pathname).match(/^\/(\d{1,4})\.jpg$/)?.[1];
          await proxyCalgaryCctvFrameRequestGuarded(frameId ?? "", res);
        } catch {
          res.statusCode = 502;
          res.setHeader("content-type", "text/plain");
          res.end("Calgary CCTV frame request failed");
        }
      });
      server.middlewares.use(AUSTIN_CCTV_FRAME_PROXY_PATH, async (req, res) => {
        try {
          const requestUrl = new URL(
            req.url ?? "",
            `http://localhost${AUSTIN_CCTV_FRAME_PROXY_PATH}`,
          );
          const frameId = decodeURIComponent(requestUrl.pathname).match(/^\/(\d{1,4})\.jpg$/)?.[1];
          await proxyAustinCctvFrameRequestGuarded(frameId ?? "", res);
        } catch {
          res.statusCode = 502;
          res.setHeader("content-type", "text/plain");
          res.end("Austin CCTV frame request failed");
        }
      });
      server.middlewares.use(CCTV_CATALOG_PROXY_PATH, async (req, res) => {
        try {
          const requestUrl = new URL(req.url ?? "", `http://localhost${CCTV_CATALOG_PROXY_PATH}`);
          const provider = decodeURIComponent(requestUrl.pathname).match(
            /^\/(ontario|drivebc|nsw|caltrans-(?:3|4|7|11))\.json$/,
          )?.[1];
          await proxyCctvCatalogRequestGuarded(provider ?? "", res);
        } catch {
          res.statusCode = 502;
          res.setHeader("content-type", "text/plain");
          res.end("CCTV catalog request failed");
        }
      });
      server.middlewares.use(ONTARIO_CCTV_FRAME_PROXY_PATH, async (req, res) => {
        try {
          const requestUrl = new URL(
            req.url ?? "",
            `http://localhost${ONTARIO_CCTV_FRAME_PROXY_PATH}`,
          );
          const frameId = decodeURIComponent(requestUrl.pathname).match(
            /^\/([A-Za-z0-9_.-]{1,64})$/,
          )?.[1];
          await proxyOntarioCctvFrameRequestGuarded(frameId ?? "", res);
        } catch {
          res.statusCode = 502;
          res.setHeader("content-type", "text/plain");
          res.end("Ontario CCTV frame request failed");
        }
      });
      server.middlewares.use(NSW_CCTV_FRAME_PROXY_PATH, async (req, res) => {
        try {
          const requestUrl = new URL(req.url ?? "", `http://localhost${NSW_CCTV_FRAME_PROXY_PATH}`);
          const frameId = decodeURIComponent(requestUrl.pathname).match(
            /^\/([a-z0-9_.&-]{1,100}\.(?:jpe?g))$/i,
          )?.[1];
          await proxyNswCctvFrameRequestGuarded(frameId ?? "", res);
        } catch {
          res.statusCode = 502;
          res.setHeader("content-type", "text/plain");
          res.end("NSW CCTV frame request failed");
        }
      });
      server.middlewares.use(CALTRANS_CCTV_FRAME_PROXY_PATH, async (req, res) => {
        try {
          const requestUrl = new URL(
            req.url ?? "",
            `http://localhost${CALTRANS_CCTV_FRAME_PROXY_PATH}`,
          );
          const match = decodeURIComponent(requestUrl.pathname).match(
            /^\/(3|4|7|11)\/([a-z0-9-]{1,100})\.jpg$/i,
          );
          await proxyCaltransCctvFrameRequestGuarded(match?.[1] ?? "", match?.[2] ?? "", res);
        } catch {
          res.statusCode = 502;
          res.setHeader("content-type", "text/plain");
          res.end("Caltrans CCTV frame request failed");
        }
      });
      server.middlewares.use(OVERPASS_PROXY_PATH, async (req, res) => {
        try {
          await proxyOverpassRequestGuarded(req, res);
        } catch {
          res.statusCode = 502;
          res.setHeader("content-type", "text/plain");
          res.end("Overpass proxy request failed");
        }
      });
      server.middlewares.use(RASTER_PROXY_PATH, async (req, res) => {
        try {
          await proxyBinaryRequestGuarded(req, res, RASTER_PROXY_PATH);
        } catch (error) {
          const message = error instanceof Error ? error.message : "Raster proxy request failed";
          res.statusCode = 502;
          res.setHeader("content-type", "text/plain");
          res.end(message);
        }
      });
    },
  };
}

async function proxyWmsRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  await proxyBinaryRequestGuarded(req, res, WMS_PROXY_PATH);
}
