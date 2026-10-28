import type { ArcGisHubCatalog, ArcGisHubCatalogSet } from "./maplibre-arcgis-hub";

type PortalEntry = Omit<ArcGisHubCatalog, "id">;

/**
 * Build one Indian region/state catalog set.
 *
 * Args:
 *   code: The region's short code (e.g., 'national', 'ka', 'mh').
 *   name: The region's display name.
 *   portals: Its open data and GIS portals.
 *
 * Returns:
 *   The region's catalog set.
 */
function region(code: string, name: string, portals: PortalEntry[]): ArcGisHubCatalogSet {
  return {
    id: code,
    name,
    catalogs: portals.map((portal) => ({
      id: `${code}-${portal.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")}`,
      ...portal,
    })),
  };
}

/**
 * Public GIS and open geospatial data portals across India (National, State, and Smart Cities).
 */
export const INDIA_GIS_CATALOGS: readonly ArcGisHubCatalogSet[] = [
  region("national", "National Portals (India)", [
    {
      name: "Smart Cities Mission Geospatial Data Hub",
      url: "https://geospatial.data.gov.in",
      orgId: "IndiaSmartCities",
    },
    {
      name: "Open Government Data (OGD) Platform India",
      url: "https://data.gov.in",
      orgId: "OGDIndiaHub",
    },
    {
      name: "National Disaster Management Authority (NDMA) GIS",
      url: "https://ndma.gov.in",
      orgId: "NDMAGovInPortal",
    },
  ]),
  region("ap_ts", "Andhra Pradesh & Telangana", [
    {
      name: "Telangana Remote Sensing Applications Centre (TRAC)",
      url: "https://trac.telangana.gov.in",
      orgId: "TelanganaSpatial",
    },
    {
      name: "Andhra Pradesh Space Applications Centre (APSAC)",
      url: "https://apsac.ap.gov.in",
      orgId: "AndhraPradeshGIS",
    },
  ]),
  region("dl", "Delhi (NCR)", [
    {
      name: "Delhi Development Authority (DDA) Geoportal",
      url: "https://dda.gov.in",
      orgId: "DDAGovInPortal",
    },
    {
      name: "Geospatial Delhi Limited (GSDL)",
      url: "https://gsdl.org.in",
      orgId: "GSDLDelhiSpatial",
    },
  ]),
  region("gj", "Gujarat", [
    {
      name: "Surat Smart City Open Data Portal",
      url: "https://suratsmartcity.com",
      orgId: "SuratSmartCity",
    },
    {
      name: "BISAG-N Gujarat State Spatial Infrastructure",
      url: "https://bisag-n.gov.in",
      orgId: "BISAGGujaratGIS",
    },
  ]),
  region("ka", "Karnataka", [
    {
      name: "Karnataka State Remote Sensing Applications Centre (KSRSAC)",
      url: "https://ksrsac.karnataka.gov.in",
      orgId: "KSRSACGISPortal",
    },
    {
      name: "Bruhat Bengaluru Mahanagara Palike (BBMP) GIS",
      url: "https://bbmp.gov.in",
      orgId: "BBMPBengaluruGIS",
    },
  ]),
  region("mh", "Maharashtra", [
    {
      name: "Pune Smart City Open Geoportal",
      url: "https://punesmartcity.in",
      orgId: "PuneSmartCityHub",
    },
    {
      name: "Mumbai Metropolitan Region (MMRDA) GIS",
      url: "https://mmrda.maharashtra.gov.in",
      orgId: "MMRDAMumbaiGIS",
    },
  ]),
  region("or", "Odisha", [
    {
      name: "Odisha Space Applications Centre (ORSAC) Geoportal",
      url: "https://orsac.odisha.gov.in",
      orgId: "ORSACGISPortal",
    },
  ]),
  region("rj", "Rajasthan", [
    {
      name: "Rajasthan State Remote Sensing Application Centre (RSRSAC)",
      url: "https://rsrsac.rajasthan.gov.in",
      orgId: "RSRSACGISPortal",
    },
  ]),
  region("tn", "Tamil Nadu", [
    {
      name: "Tamil Nadu Spatial Data Infrastructure (TNGIS)",
      url: "https://tngis.tn.gov.in",
      orgId: "TNGISOpenPortal",
    },
    {
      name: "Greater Chennai Corporation (GCC) Geoportal",
      url: "https://chennaicorporation.gov.in",
      orgId: "GCCChennaiGIS",
    },
  ]),
  region("wb", "West Bengal", [
    {
      name: "West Bengal State Remote Sensing Centre (WBSRSC)",
      url: "https://wbsrsc.gov.in",
      orgId: "WBSRSCGISPortal",
    },
  ]),
];
