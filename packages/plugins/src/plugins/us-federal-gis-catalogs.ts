import type { ArcGisHubCatalog, ArcGisHubCatalogSet } from "./maplibre-arcgis-hub";

type PortalEntry = Omit<ArcGisHubCatalog, "id">;

/**
 * Describe an agency portal built on ArcGIS Hub.
 *
 * Args:
 *   name: The name shown in the picker.
 *   host: The portal's hostname, which is also its home page.
 *   siteId: The Hub site item id, whose catalog groups scope the search.
 *   orgId: The owning ArcGIS organization, the fallback scope.
 *
 * Returns:
 *   The portal entry.
 */
function hub(name: string, host: string, siteId: string, orgId: string): PortalEntry {
  return { name, url: `https://${host}`, siteId, orgId };
}

/**
 * Describe an agency that publishes through an ArcGIS Online organization
 * without a Hub catalog worth scoping to, so everything the organization
 * shares publicly is searched.
 *
 * Args:
 *   name: The name shown in the picker.
 *   urlKey: The organization's ArcGIS Online URL key, whose home page Open
 *     portal opens.
 *   orgId: The organization id, the search scope.
 *
 * Returns:
 *   The portal entry.
 */
function org(name: string, urlKey: string, orgId: string): PortalEntry {
  return { name, url: `https://${urlKey}.maps.arcgis.com`, orgId };
}

/**
 * Build one department's catalog set. A portal's id is derived from its name
 * rather than its position, so adding or dropping a portal later does not
 * change which one a user's remembered choice points at.
 *
 * Args:
 *   id: The set's stable id.
 *   name: The department or group name.
 *   portals: Its agency portals, alphabetically.
 *
 * Returns:
 *   The department's catalog set.
 */
function department(id: string, name: string, portals: PortalEntry[]): ArcGisHubCatalogSet {
  return {
    id,
    name,
    catalogs: portals.map((portal) => ({
      id: `${id}-${portal.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")}`,
      ...portal,
    })),
  };
}

/**
 * The public GIS portals of US federal agencies, grouped by department, as
 * catalogs the US Federal GIS panel can search. Each is an ArcGIS Hub site
 * (searched through its catalog groups) or an ArcGIS Online organization
 * (searched whole). Between them they hold the national layers people ask for
 * most: Census boundaries, NOAA radar and weather warnings, USGS land cover,
 * LANDFIRE and PAD-US, NRCS soils, FWS wetlands, and transportation networks.
 *
 * Every entry was checked live to return datasets; `npm run check:gis-portals`
 * repeats that check. HIFLD Open is not listed: its Hub site no longer exists.
 * Snapshot of September 2026.
 */
export const US_FEDERAL_GIS_CATALOGS: readonly ArcGisHubCatalogSet[] = [
  department("usda", "Department of Agriculture", [
    hub(
      "Aerial Photography Field Office (NAIP)",
      "apfo-usdaonline.opendata.arcgis.com",
      "f77cc8e92add4eb4b76b1aadfde7e12d",
      "LLVEmB8Lsae3Um4s",
    ),
    hub(
      "Forest Service",
      "data-usfs.hub.arcgis.com",
      "4f29e28b4c0b4a52a512e7106dd1245e",
      "gGHDlz6USftL5Pau",
    ),
    org("Natural Resources Conservation Service", "nrcs", "SXbDpmb7xQkk44JV"),
    hub(
      "USDA Geospatial Hub",
      "gisforagriculture-usdaocio.hub.arcgis.com",
      "841d7b85b009467e92362a936a3da9d9",
      "5vMtpwj1mnc06Rmi",
    ),
  ]),
  department("doc", "Department of Commerce", [
    org("Census Bureau", "uscensus", "DlJzJLOZpPXmMpWi"),
    org("NOAA GeoPlatform", "noaa", "C8EMgrsFcRFL6LrL"),
    hub(
      "NOAA Marine Cadastre",
      "hub.marinecadastre.gov",
      "7483257320154fb9b1e3d5ee14209e9d",
      "C8EMgrsFcRFL6LrL",
    ),
  ]),
  department("dod", "Department of Defense", [
    hub(
      "Army Corps of Engineers",
      "geospatial-usace.opendata.arcgis.com",
      "b3ac9c3c3e0744f2a3d17f69124c5726",
      "n1YM8pTrFmm7L4hs",
    ),
    org("National Geospatial-Intelligence Agency", "nga", "cc7nIINtrZ67dyVJ"),
  ]),
  department("doe", "Department of Energy", [
    hub(
      "EIA U.S. Energy Atlas",
      "atlas.eia.gov",
      "a0dfa553e2b04b6bbf1ab9cf5dfb0353",
      "FGr1D95XCGALKXqM",
    ),
  ]),
  department("dhs", "Department of Homeland Security", [
    hub("FEMA", "gis-fema.hub.arcgis.com", "459129cb5e734aa984441f431f440613", "XG15cJAlne2vxtgt"),
  ]),
  department("hud", "Department of Housing and Urban Development", [
    hub(
      "HUD Open Data",
      "hudgis-hud.opendata.arcgis.com",
      "0763b052200247aabeafe1abfbfb5afa",
      "VTyQ9soqVukalItT",
    ),
  ]),
  department("doi", "Department of the Interior", [
    hub(
      "Bureau of Land Management",
      "gbp-blm-egis.hub.arcgis.com",
      "1f7469023a92437a8a7e2dd7d8ba808a",
      "KbxwQRRfWyEYLgp4",
    ),
    hub(
      "Bureau of Ocean Energy Management",
      "boem-metaport-boem.hub.arcgis.com",
      "8279102fae2d40e283f8e0759e6adcc8",
      "G5Ma95RzqJRPKsWL",
    ),
    hub(
      "Fish and Wildlife Service",
      "gis-fws.opendata.arcgis.com",
      "a8358715b5214164a6db8024e838febd",
      "QVENGdaPbd4LUkLV",
    ),
    hub(
      "National Interagency Fire Center",
      "data-nifc.opendata.arcgis.com",
      "3b52b3585ac341a69a92a366db96e7ef",
      "T4QMspbfLg3qTGWY",
    ),
    hub(
      "National Park Service",
      "public-nps.opendata.arcgis.com",
      "a8c34bbc96934f528e38fbb45093cdb6",
      "fBc8EJBxQRMcHlei",
    ),
    org("U.S. Geological Survey", "usgs", "v01gqwM5QqNysAAi"),
  ]),
  department("dot", "Department of Transportation", [
    hub(
      "BTS Geospatial (NTAD)",
      "geodata.bts.gov",
      "7b0390bcff3942e9956a4ad837c86a04",
      "xOi1kZaI0eWDREZv",
    ),
    hub(
      "FAA Aeronautical Data",
      "adds-faa.opendata.arcgis.com",
      "96a460b685d2408892b61bb2a45c166c",
      "ssFJjBXIUyZDrSYZ",
    ),
  ]),
  department("epa", "Environmental Protection Agency", [
    org("U.S. EPA", "epa", "cJ9YHowT8TU7DUyn"),
  ]),
  department("multi", "Multi-agency", [
    // Esri maintains these national layers (TIGER boundaries such as tracts,
    // counties, and congressional districts among them) from authoritative
    // federal sources; the Census Bureau's own organization publishes mostly
    // statistics rather than its boundary files.
    org("Esri U.S. Federal Datasets", "fedmaps", "FiaPA4ga0iQKduv3"),
    // The federal GeoPlatform, home of the National Geospatial Data Assets.
    org("GeoPlatform (NGDA)", "geoplatform", "Hp6G80Pky0om7QvQ"),
  ]),
  department("nasa", "NASA", [org("NASA ArcGIS Online", "nasa", "WSiUmUhlFx4CtMBB")]),
];
