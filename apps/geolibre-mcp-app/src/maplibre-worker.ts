import { setWorkerUrl } from "maplibre-gl";
import workerSource from "../build/maplibre-worker.js?raw";

setWorkerUrl(URL.createObjectURL(new Blob([workerSource], { type: "text/javascript" })));
