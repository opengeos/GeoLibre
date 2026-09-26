import type { ArcGisHubCatalog, ArcGisHubCatalogSet } from "./maplibre-arcgis-hub";

type PortalEntry = Omit<ArcGisHubCatalog, "id">;

/**
 * Build one state's catalog set, deriving stable catalog ids from its code.
 *
 * Args:
 *   code: The state's two-letter postal code, lowercased.
 *   name: The state's name.
 *   portals: Its portals, the statewide one first.
 *
 * Returns:
 *   The state's catalog set.
 */
function state(code: string, name: string, portals: PortalEntry[]): ArcGisHubCatalogSet {
  return {
    id: code,
    name,
    catalogs: portals.map((portal, index) => ({ id: `${code}-${index + 1}`, ...portal })),
  };
}

/**
 * The public GIS data portals of each US state and the District of Columbia,
 * as ArcGIS catalogs the US State GIS panel can search. The state list follows
 * https://opensourcegisdata.com/state/, narrowed to the portals built on
 * ArcGIS Hub (most statewide portals are), since those share one search API.
 *
 * A portal with a `siteId` is searched through its Hub site's catalog groups,
 * read live so catalog edits on the state's side show up without a release;
 * its `orgId` is the fallback when the site item cannot be read. A portal with
 * only an `orgId` has no usable site catalog and searches everything its
 * organization publishes. Snapshot of September 2026.
 */
export const US_STATE_GIS_CATALOGS: readonly ArcGisHubCatalogSet[] = [
  state("al", "Alabama", [
    {
      name: "Alabama GeoHub",
      url: "https://data-algeohub.opendata.arcgis.com",
      siteId: "01ed721f8ff54258885462f2d67b6d12",
      orgId: "jF2q3LPxL7PETdYk",
    },
  ]),
  state("ak", "Alaska", [
    {
      name: "Alaska Geoportal",
      url: "https://akgeoportal.alaska.gov",
      siteId: "7dd7c86dd0cc40f6a516eb77001977c1",
      orgId: "7HDiw78fcUiM2BWn",
    },
    {
      name: "Alaska DOT&PF Open Data",
      url: "https://data-soa-akdot.opendata.arcgis.com",
      siteId: "a135226f45964bce9e40684931bd451a",
      orgId: "r4A0V7UzH9fcLVvv",
    },
  ]),
  state("az", "Arizona", [
    {
      name: "AZGeo Data Hub",
      url: "https://azgeo-data-hub-agic.hub.arcgis.com",
      siteId: "7b373aac2d1f449886c3c5f25154bd14",
      orgId: "MrgGZS7oC7drh1E8",
    },
  ]),
  state("ar", "Arkansas", [
    {
      name: "Arkansas GIS Hub",
      url: "https://geodata.gis.arkansas.gov",
      siteId: "34a99801c7f9458b9cf268759e38b8e3",
      orgId: "PwY9ZuZRDiI5nXUB",
    },
  ]),
  state("ca", "California", [
    {
      name: "California State Geoportal",
      url: "https://gis.data.ca.gov",
      siteId: "cf412a17daaa47bca93c6d6b7e77aff0",
      orgId: "uknczv4rpevve42E",
    },
  ]),
  state("co", "Colorado", [
    {
      name: "Colorado Geospatial Portal",
      url: "https://geodata.colorado.gov",
      siteId: "ad44998e71504069b225d1a34174616f",
      orgId: "DgjqnJA1rgO92Soi",
    },
    {
      name: "CDOT Open Data",
      url: "https://data-cdot.opendata.arcgis.com",
      siteId: "8dc5e19e1be5444f82b730a630fc49e2",
      orgId: "yzB9WM8W0BO3Ql7d",
    },
  ]),
  state("ct", "Connecticut", [
    {
      name: "CT Geospatial Data Portal",
      url: "https://geodata.ct.gov",
      siteId: "326277d68c5942c09cd9435eafb0aad4",
      orgId: "3FL1kr7L4LvwA2Kb",
    },
    {
      name: "CT DEEP GIS Open Data",
      url: "https://ct-deep-gis-open-data-website-ctdeep.hub.arcgis.com",
      siteId: "034830942319469580596f12caf0284b",
      orgId: "FjPcSmEFuDYlIdKC",
    },
  ]),
  state("de", "Delaware", [
    {
      name: "Delaware FirstMap",
      url: "https://de-firstmap-delaware.hub.arcgis.com",
      siteId: "31b1cca8e69f4dcdad1e5325a98a180b",
      orgId: "bFDgLqS5IyUBQLAd",
    },
  ]),
  state("dc", "District of Columbia", [
    {
      name: "Open Data DC",
      url: "https://opendata.dc.gov",
      siteId: "b907a83b8d3947bb8e318a7b93abadf8",
      orgId: "neT9SoYxizqTHZPH",
    },
  ]),
  state("fl", "Florida", [
    {
      name: "Florida Geospatial Open Data Portal",
      url: "https://geodata.floridagio.gov",
      siteId: "7386e1cfa2994976a9b91f3c1cd0f044",
      orgId: "Gh9awoU677aKree0",
    },
    {
      name: "Florida DEP Geospatial Open Data",
      url: "https://geodata.dep.state.fl.us",
      siteId: "841cd28db0ff4c81a364cdb1d4319cf5",
      orgId: "nRHtyn3uE1kyzoYc",
    },
    {
      name: "FDOT Open Data",
      url: "https://gis-fdot.opendata.arcgis.com",
      siteId: "af8f7d9ac0584685a6cd835d84e0ec7d",
      orgId: "O1JpcwDW8sjYuddV",
    },
  ]),
  state("ga", "Georgia", [
    { name: "Georgia GIO", url: "https://data-hub.gio.georgia.gov", orgId: "Za9Nk6CPIPbvR1t7" },
    {
      name: "Georgia DCA",
      url: "https://data-georgia-dca.opendata.arcgis.com",
      siteId: "f0287e619f584bc5bcdb7621ead061f8",
      orgId: "Gqyymy5JISeLzyNM",
    },
  ]),
  state("hi", "Hawaii", [
    {
      name: "Hawaii Statewide GIS Program",
      url: "https://geoportal.hawaii.gov",
      siteId: "4c589a11a46d4514b9b6b081c5220b4a",
      orgId: "HQ0xoN0EzDPBOEci",
    },
  ]),
  state("id", "Idaho", [
    {
      name: "State of Idaho GIS",
      url: "https://gis-idaho.hub.arcgis.com",
      siteId: "fa79cf3d606942148117507a3a421ba4",
      orgId: "CNPdEkvnGl65jCX8",
    },
  ]),
  state("il", "Illinois", [
    {
      name: "IDOT Open Data",
      url: "https://gis-idot.opendata.arcgis.com",
      siteId: "be6d60db78c642cc9d43e72f2fe83af8",
      orgId: "aIrBD8yn1TDTEXoz",
    },
  ]),
  state("in", "Indiana", [
    {
      name: "IndianaMap",
      url: "https://www.indianamap.org",
      siteId: "c470d38a730b4a5d839602174ed97d5c",
      orgId: "fAJUAyCk5qmGxuxo",
    },
  ]),
  state("ia", "Iowa", [
    {
      name: "Iowa Geospatial Data",
      url: "https://geodata.iowa.gov",
      siteId: "463693b7d3bc449eb44d427c68db1c87",
      orgId: "vPD5PVLI6sfkZ5E4",
    },
    {
      name: "Iowa DOT Open Data",
      url: "https://data.iowadot.gov",
      siteId: "167854bb9ecb40e191c8e5919dd143de",
      orgId: "8lRhdTsQyJpO52F1",
    },
  ]),
  state("ks", "Kansas", [
    {
      name: "Kansas Geoportal",
      url: "https://hub.kansasgis.org",
      siteId: "1dfeade4e1e046dd8fa683d39dc3aa75",
      orgId: "q2CglofYX6ACNEeu",
    },
  ]),
  state("ky", "Kentucky", [
    {
      name: "KyGovMaps Open Data",
      url: "https://opengisdata.ky.gov",
      siteId: "31ace50dd2204932b8b11c48f24f6e76",
      orgId: "ghsX9CKghMvyYjBU",
    },
    {
      name: "KyFromAbove",
      url: "https://kyfromabove.ky.gov",
      siteId: "c8be0e1e0cbc44dd8201198cf92dcad6",
      orgId: "ghsX9CKghMvyYjBU",
    },
  ]),
  state("la", "Louisiana", [
    {
      name: "Louisiana DOTD",
      url: "https://release-ladotd.hub.arcgis.com",
      orgId: "PLiuXYMBpMK5h36e",
    },
    {
      name: "Atlas: The Louisiana Statewide GIS",
      url: "https://atlas-lsuga.opendata.arcgis.com",
      orgId: "SDQDNhpG8jikA0D1",
    },
  ]),
  state("me", "Maine", [
    {
      name: "Maine GeoLibrary",
      url: "https://mainegeolibrary-maine.hub.arcgis.com",
      siteId: "c0525bd8d13b4637a352684867faf162",
      orgId: "RbMX0mRVOFNTdLzd",
    },
  ]),
  state("md", "Maryland", [
    {
      name: "Maryland GIS Data Catalog",
      url: "https://data.imap.maryland.gov",
      siteId: "27d04aff6b9b426ab3c68eee68c23589",
      orgId: "njFNhDsUCentVYJW",
    },
  ]),
  state("ma", "Massachusetts", [
    {
      name: "MassGIS Data Hub",
      url: "https://gis.data.mass.gov",
      siteId: "d36b7fc5ca494d2dac2cf03659b7647f",
      orgId: "hGdibHYSPO59RG1h",
    },
    {
      name: "MassDOT Open Data",
      url: "https://geo-massdot.opendata.arcgis.com",
      siteId: "a302d9368ea648979a2df877a5a595b1",
      orgId: "ceiitspzDAHrdGO1",
    },
  ]),
  state("mi", "Michigan", [
    {
      name: "State of Michigan Open Data",
      url: "https://gis-michigan.opendata.arcgis.com",
      siteId: "c486626179134b8093f21043f7d689c3",
      orgId: "dxRQUfTDNtfqZ301",
    },
  ]),
  state("mn", "Minnesota", [
    {
      name: "Minnesota Geospatial Commons",
      url: "https://gis.data.mn.gov",
      siteId: "a5be19f6b69c46a3b4ae3669db4679c3",
      orgId: "9OIuDHbyhmH91RfZ",
    },
  ]),
  state("ms", "Mississippi", [
    {
      name: "Mississippi Geospatial Data Catalog",
      url: "https://opendata.gis.ms.gov",
      siteId: "b5bc97fd399b4d0e9364335bec6c816d",
      orgId: "XSDoE9o9b2LpxKKd",
    },
  ]),
  state("mo", "Missouri", [
    {
      name: "MSDIS",
      url: "https://data-msdis.opendata.arcgis.com",
      siteId: "466c4ea412064d2a95997c79b4580529",
      orgId: "kNS2ppBA4rwAQQZy",
    },
  ]),
  state("mt", "Montana", [
    {
      name: "Montana Geographic Information",
      url: "https://montana-state-library-2022-floods-gis-data-hub-montana.hub.arcgis.com",
      orgId: "qnjIrwR8z5Izc0ij",
    },
    {
      name: "Montana FWP",
      url: "https://gis-mtfwp.hub.arcgis.com",
      siteId: "9e84bea7a01448dda660470fd1bb792e",
      orgId: "Cdxz8r11hT0MGzg1",
    },
  ]),
  state("ne", "Nebraska", [
    {
      name: "NebraskaMAP",
      url: "https://www.nebraskamap.gov",
      siteId: "fe5b9beb17674749ba5769f368ef60af",
      orgId: "Sj9eBhzWwOMzQCfI",
    },
  ]),
  state("nv", "Nevada", [
    {
      name: "Nevada Department of Wildlife",
      url: "https://nevada-department-of-wildlife-data-hub-ndow.hub.arcgis.com",
      orgId: "RyxlXSfFi87rAosq",
    },
  ]),
  state("nh", "New Hampshire", [
    {
      name: "NH GRANIT",
      url: "https://www.nhgeodata.unh.edu",
      siteId: "9077b6cdf1d94589b79cc66d8f919da2",
      orgId: "wnvDDrXX8EouLkZP",
    },
    {
      name: "NHDES Open Data",
      url: "https://nh-department-of-environmental-services-open-data-nhdes.hub.arcgis.com",
      siteId: "064f2977deae40479c35e7714e5ad911",
      orgId: "MAcUimSes4gPY4sM",
    },
  ]),
  state("nj", "New Jersey", [
    {
      name: "NJ Office of GIS",
      url: "https://njogis-newjersey.opendata.arcgis.com",
      siteId: "2156642a93584c6b8eec0498fdd73e76",
      orgId: "XVOqAjTOJ5P6ngMu",
    },
    {
      name: "NJDEP Open Data",
      url: "https://gisdata-njdep.opendata.arcgis.com",
      siteId: "98aeb9942e774894adeb9a29f62482af",
      orgId: "QWdNfRs7lkPq4g4Q",
    },
  ]),
  state("nm", "New Mexico", [
    {
      name: "New Mexico Environment Department",
      url: "https://data-nmenv.opendata.arcgis.com",
      orgId: "sqciGhV7WvGQn4ky",
    },
    {
      name: "NM Office of the State Engineer",
      url: "https://geospatialdata-ose.opendata.arcgis.com",
      siteId: "a9eb3957cd6a44cf9e1f8900476c8db6",
      orgId: "qXZbWTdPDbTjl7Dy",
    },
  ]),
  state("ny", "New York", [
    {
      name: "NYS GIS Clearinghouse",
      url: "https://data.gis.ny.gov",
      siteId: "ddc8b98612774f8ea9c8b718ddd576bc",
      orgId: "EbVsqZ18sv1kVJ3k",
    },
  ]),
  state("nc", "North Carolina", [
    {
      name: "NC OneMap",
      url: "https://www.nconemap.gov",
      siteId: "33650305fdf24a1bb46465e4bc598e93",
      orgId: "mSDBiLWaIfH92NqI",
    },
  ]),
  state("nd", "North Dakota", [
    {
      name: "North Dakota GIS Hub",
      url: "https://gishubdata-ndgov.hub.arcgis.com",
      siteId: "c505dcbdc54d429a86c81d859393fc4b",
      orgId: "GOcSXpzwBHyk2nog",
    },
  ]),
  state("oh", "Ohio", [
    {
      name: "Ohio OGRIP",
      url: "https://ogriphome-geohio.hub.arcgis.com",
      orgId: "MlJ0G8iWUyC7jAmu",
    },
    { name: "Ohio DNR", url: "https://gis-odnr.opendata.arcgis.com", orgId: "ajRlmtxbNBjZggOT" },
  ]),
  state("ok", "Oklahoma", [
    {
      name: "Oklahoma Open Data",
      url: "https://oklahoma-open-data-oklahoma.hub.arcgis.com",
      orgId: "AFMO17kGL5gMkuoK",
    },
  ]),
  state("or", "Oregon", [
    {
      name: "Oregon GEOHub",
      url: "https://geohub.oregon.gov",
      siteId: "fefc7dd6e26f481b8892d3b7dd58636c",
      orgId: "8PAo5HGmvRMlF2eU",
    },
  ]),
  state("pa", "Pennsylvania", [
    {
      name: "PennShare",
      url: "https://data-pennshare.opendata.arcgis.com",
      orgId: "jOy9iZUXBy03ojXb",
    },
    {
      name: "PA DCNR",
      url: "https://newdata-dcnr.opendata.arcgis.com",
      siteId: "a32a6666b76f4b1eb55fc21a8a9854e8",
      orgId: "CPq7UDkBXVRqtgLR",
    },
  ]),
  state("ri", "Rhode Island", [
    {
      name: "RIGIS",
      url: "https://www.rigis.org",
      siteId: "603e02ff72e346959946d4e2103e3257",
      orgId: "S8zZg9pg23JUEexQ",
    },
  ]),
  state("sc", "South Carolina", [
    {
      name: "SC Department of Natural Resources",
      url: "https://data-scdnr.opendata.arcgis.com",
      orgId: "acgZYxoN5Oj8pDLa",
    },
  ]),
  state("sd", "South Dakota", [
    {
      name: "State of South Dakota",
      url: "https://gis-south-dakota-open-data-hub-sdbit.hub.arcgis.com",
      orgId: "PwrabBhZHUggYYSp",
    },
  ]),
  state("tn", "Tennessee", [
    {
      name: "Tennessee Downloadable GIS Data",
      url: "https://geodata.tn.gov",
      siteId: "4649b629c9b647a8822b052cadc89072",
      orgId: "YuVBSS7Y1of2Qud1",
    },
  ]),
  state("tx", "Texas", [
    {
      name: "TxDOT Open Data",
      url: "https://gis-txdot.opendata.arcgis.com",
      orgId: "KTcxiTD9dsQw4r7Z",
    },
  ]),
  state("ut", "Utah", [
    {
      name: "Utah SGID Open Data",
      url: "https://opendata.gis.utah.gov",
      siteId: "84e1fcc2b93041348ef4329f532ab846",
      orgId: "99lidPhWCzftIe9K",
    },
  ]),
  state("vt", "Vermont", [
    {
      name: "Vermont Open Geodata Portal",
      url: "https://geodata.vermont.gov",
      siteId: "0ce1e35a117849fdb89822c80ebff64f",
      orgId: "BkFxaEFNwHqX3tAw",
    },
  ]),
  state("va", "Virginia", [
    {
      name: "VGIN Clearinghouse",
      url: "https://vgin.vdem.virginia.gov",
      siteId: "ab1346979ba544c99dae2ec54ba7e1cd",
      orgId: "WNJF1HhUVAm3jccO",
    },
  ]),
  state("wa", "Washington", [
    {
      name: "Washington Geospatial Open Data",
      url: "https://geo.wa.gov",
      siteId: "6a33438d424a4009bc5526a1eb9d3a37",
      orgId: "jsIt88o09Q0r1j8h",
    },
    {
      name: "WSDOT Open Data",
      url: "https://gisdata-wsdot.opendata.arcgis.com",
      siteId: "9a2bfc0592d442258c299b98b1991d27",
      orgId: "IYrj3otxNjPsrTRD",
    },
  ]),
  state("wv", "West Virginia", [
    {
      name: "WV GTI Map & Data Portal",
      url: "https://data-wvdot.opendata.arcgis.com",
      orgId: "xLpB90lOmCXYDAWo",
    },
  ]),
  state("wi", "Wisconsin", [
    {
      name: "Wisconsin DNR Open Data",
      url: "https://data-wi-dnr.opendata.arcgis.com",
      siteId: "c59132cd84314f3a9e50a2958e6b6b01",
      orgId: "Ul9AyFFeFTjf08DW",
    },
  ]),
  state("wy", "Wyoming", [
    {
      name: "Wyoming GeoHub",
      url: "https://data.geospatialhub.org",
      siteId: "4e3957a8ddbd45ccb7149d150ffec3fe",
      orgId: "HVjI8GKrRtjcQ4Ry",
    },
  ]),
];
