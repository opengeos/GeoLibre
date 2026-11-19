/**
 * The host's file handler for dropped PDFs (GH #3523): a PDF dropped on the
 * map (web or desktop), loaded with `?data=` or sent through the embed
 * `addData` command opens the Add Data dialog's GeoPDF form with the file
 * chosen, where the user picks its page and layers before anything is added.
 */
import type { GeoLibreFileHandler } from "@geolibre/plugins";
import { openAddData } from "../../components/layout/add-data/open-add-data";
import { handOffDroppedPdfs, isPdfFileName } from "./pending";

/** The GeoPDF file handler. */
export const GEOPDF_FILE_HANDLER: GeoLibreFileHandler = {
  id: "geolibre.geopdf",
  name: "GeoPDF",
  extensions: [".pdf"],
  dataTypes: ["geopdf"],
  claim: (files) => files.filter((file) => isPdfFileName(file.name)),
  open: async (files) => {
    await handOffDroppedPdfs(
      files,
      (file) => file.name,
      async (file) => new Uint8Array(await file.arrayBuffer()),
      () => openAddData("geopdf"),
    );
  },
};
