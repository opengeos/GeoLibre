import type { ArcGisHubItem } from "./arcgis-hub-api";
import type { ArcGisHubCatalog, ArcGisHubCatalogSet } from "./maplibre-arcgis-hub";

type PortalEntry = Omit<ArcGisHubCatalog, "id">;
type Extent = [[number, number], [number, number]];

const DATAMEET_MUNICIPAL =
  "https://raw.githubusercontent.com/datameet/Municipal_Spatial_Data/master/";
const GADM_INDIA_DISTRICTS =
  "https://raw.githubusercontent.com/geohacker/india/master/district/india_district.geojson";
// media.githubusercontent.com serves Git LFS files (raw.githubusercontent.com
// returns the LFS pointer) and, unlike github.com's redirect, allows CORS.
const GEOBOUNDARIES_INDIA =
  "https://media.githubusercontent.com/media/wmgeolab/geoBoundaries/9469f09592ced973a3448cf66b6100b741b64c0d/releaseData/gbOpen/IND/";

function geoJsonItem(
  id: string,
  title: string,
  owner: string,
  dataUrl: string,
  pageUrl: string,
  snippet: string,
  extent: Extent,
): ArcGisHubItem {
  return {
    id,
    title,
    owner,
    type: "GeoJson",
    snippet,
    description: snippet,
    dataUrl,
    pageUrl,
    extent,
  };
}

/**
 * Build a card for a file of DataMeet's Municipal Spatial Data, a community
 * repository of city ward and boundary maps. Its license asks that every
 * dataset credit DataMeet and link to the file, so the card does both.
 *
 * Args:
 *   id: The card's unique id.
 *   title: The card's title.
 *   path: The file's path in the repository (`<City>/<file>.geojson`).
 *   snippet: What the file maps.
 *   extent: The file's bounds.
 *
 * Returns:
 *   The catalog item.
 */
function datameetItem(
  id: string,
  title: string,
  path: string,
  snippet: string,
  extent: Extent,
): ArcGisHubItem {
  return geoJsonItem(
    id,
    title,
    "DataMeet community",
    `${DATAMEET_MUNICIPAL}${path}`,
    `https://github.com/datameet/Municipal_Spatial_Data/blob/master/${path}`,
    `${snippet} Community dataset from DataMeet's Municipal Spatial Data.`,
    extent,
  );
}

/**
 * Build a card for some states' districts, cut from the all-India GADM
 * district file by its `NAME_1` (state) property when the card is added.
 *
 * Args:
 *   id: The card's unique id.
 *   title: The card's title.
 *   states: The `NAME_1` values to keep (GADM's spelling, such as "Orissa").
 *   snippet: What the card maps.
 *   extent: The kept districts' bounds.
 *
 * Returns:
 *   The catalog item.
 */
function gadmDistricts(
  id: string,
  title: string,
  states: readonly string[],
  snippet: string,
  extent: Extent,
): ArcGisHubItem {
  return {
    ...geoJsonItem(
      id,
      title,
      "GADM (via geohacker/india)",
      GADM_INDIA_DISTRICTS,
      "https://github.com/geohacker/india",
      snippet,
      extent,
    ),
    featureFilter: { property: "NAME_1", values: states },
  };
}

/**
 * Build one Indian region/state catalog set.
 *
 * Args:
 *   code: The region's short code (e.g., 'national', 'dl', 'ka', 'mh').
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
 * Open GIS data for India, grouped by region. The national boundaries link to
 * their publishers; a state or city portal links to that government's own
 * site, while its datasets come from the community or global sources each
 * card names (no Indian government portal here offers a searchable catalog).
 */
export const INDIA_GIS_CATALOGS: readonly ArcGisHubCatalogSet[] = [
  region("national", "National boundaries", [
    {
      name: "DataMeet India Maps",
      url: "https://projects.datameet.org",
      items: [
        geoJsonItem(
          "datameet-india-composite",
          "India Composite Boundary",
          "DataMeet India community",
          "https://raw.githubusercontent.com/datameet/maps/master/Country/india-composite.geojson",
          "https://github.com/datameet/maps/blob/master/Country/india-composite.geojson",
          "India's national outline, following the boundary the Government of India recognizes (CC BY 4.0, 11 MB).",
          [
            [68.16, 6.75],
            [97.4, 37.1],
          ],
        ),
      ],
    },
    {
      name: "GADM India (geohacker/india)",
      url: "https://gadm.org",
      items: [
        geoJsonItem(
          "gadm-india-states",
          "India State & Union Territory Boundaries",
          "GADM (via geohacker/india)",
          "https://raw.githubusercontent.com/geohacker/india/master/state/india_state.geojson",
          "https://github.com/geohacker/india",
          "35 state and union territory polygons from GADM, drawn before Telangana (2014) and Ladakh (2019) were formed (23 MB).",
          [
            [68.18, 6.75],
            [97.42, 35.51],
          ],
        ),
        geoJsonItem(
          "gadm-india-districts",
          "India District Boundaries",
          "GADM (via geohacker/india)",
          "https://raw.githubusercontent.com/geohacker/india/master/district/india_district.geojson",
          "https://github.com/geohacker/india",
          "594 district polygons from GADM, with older boundaries: districts created since are missing (35 MB).",
          [
            [68.18, 6.75],
            [97.42, 35.51],
          ],
        ),
        geoJsonItem(
          "gadm-india-taluks",
          "India Taluk & Tehsil Sub-District Boundaries",
          "GADM (via geohacker/india)",
          "https://raw.githubusercontent.com/geohacker/india/master/taluk/india_taluk.geojson",
          "https://github.com/geohacker/india",
          "2,299 sub-district polygons (tehsils, taluks, mandals and blocks) from GADM (46 MB).",
          [
            [68.18, 6.75],
            [97.42, 35.51],
          ],
        ),
      ],
    },
    {
      name: "geoBoundaries India",
      url: "https://www.geoboundaries.org",
      items: [
        geoJsonItem(
          "geoboundaries-ind-adm1",
          "geoBoundaries India States & UTs (ADM1)",
          "geoBoundaries",
          `${GEOBOUNDARIES_INDIA}ADM1/geoBoundaries-IND-ADM1_simplified.geojson`,
          "https://www.geoboundaries.org",
          "36 simplified state and union territory polygons. Source: DataMeet India community and the Election Commission of India (CC BY 2.5 IN).",
          [
            [68.09, 6.75],
            [97.42, 37.08],
          ],
        ),
        geoJsonItem(
          "geoboundaries-ind-adm2",
          "geoBoundaries India Districts (ADM2)",
          "geoBoundaries",
          `${GEOBOUNDARIES_INDIA}ADM2/geoBoundaries-IND-ADM2_simplified.geojson`,
          "https://www.geoboundaries.org",
          "735 simplified district polygons. Source: Pathways Data and the Local Government Directory, lgdirectory.gov.in (ODbL 1.0).",
          [
            [68.17, 6.75],
            [97.4, 37.08],
          ],
        ),
      ],
    },
  ]),
  region("dl", "Delhi (NCR)", [
    {
      name: "Geospatial Delhi Limited (GSDL)",
      url: "https://gsdl.delhi.gov.in",
      items: [
        datameetItem(
          "delhi-state-boundary",
          "Delhi State Boundary",
          "Delhi/Delhi_Boundary.geojson",
          "Boundary of the National Capital Territory (NCT) of Delhi.",
          [
            [76.83, 28.4],
            [77.35, 28.89],
          ],
        ),
        datameetItem(
          "delhi-mcd-wards",
          "Delhi Municipal Corporation (MCD) Wards",
          "Delhi/Delhi_Wards.geojson",
          "290 municipal wards of Delhi.",
          [
            [76.83, 28.4],
            [77.35, 28.89],
          ],
        ),
      ],
    },
    {
      name: "Municipal Corporation Faridabad",
      url: "https://mcfaridabad.org",
      items: [
        datameetItem(
          "faridabad-ncr-wards",
          "Faridabad Municipal Corporation Wards",
          "Faridabad/Faridabad_Wards.geojson",
          "40 municipal wards of Faridabad, Haryana (NCR).",
          [
            [77.21, 28.29],
            [77.37, 28.52],
          ],
        ),
        datameetItem(
          "faridabad-ncr-boundary",
          "Faridabad Municipal Corporation Boundary",
          "Faridabad/Faridabad_Boundary.geojson",
          "Municipal corporation limit of Faridabad, Haryana (NCR).",
          [
            [77.21, 28.29],
            [77.37, 28.52],
          ],
        ),
      ],
    },
  ]),
  region("ka", "Karnataka", [
    {
      name: "Bruhat Bengaluru Mahanagara Palike (BBMP)",
      url: "https://bbmp.gov.in",
      items: [
        datameetItem(
          "bbmp-wards",
          "Bengaluru BBMP Municipal Wards",
          "Bangalore/BBMP.geojson",
          "243 municipal wards of Bengaluru.",
          [
            [77.45, 12.83],
            [77.79, 13.15],
          ],
        ),
        datameetItem(
          "bbmp-old-wards",
          "Bengaluru BBMP Previous Wards",
          "Bangalore/BBMP_oldWards.geojson",
          "The earlier 198-ward division of Bengaluru.",
          [
            [77.46, 12.83],
            [77.79, 13.15],
          ],
        ),
      ],
    },
    {
      name: "Karnataka Geographic Information System (K-GIS)",
      url: "https://kgis.ksrsac.in",
      items: [
        gadmDistricts(
          "karnataka-districts",
          "Karnataka District Boundaries",
          ["Karnataka"],
          "The 27 districts of Karnataka, as mapped by GADM (older boundaries: districts created since are missing). Loads only Karnataka's districts from the all-India file, which Download saves.",
          [
            [74.05, 11.57],
            [78.58, 18.46],
          ],
        ),
      ],
    },
  ]),
  region("tn", "Tamil Nadu", [
    {
      name: "Greater Chennai Corporation (GCC)",
      url: "https://chennaicorporation.gov.in",
      items: [
        datameetItem(
          "chennai-gcc-wards",
          "Greater Chennai Corporation (GCC) Wards",
          "Chennai/Wards.geojson",
          "201 municipal wards of Chennai.",
          [
            [80.14, 12.85],
            [80.34, 13.24],
          ],
        ),
        datameetItem(
          "chennai-cma-boundary",
          "Chennai Metropolitan Area (CMA) Boundary",
          "Chennai/CMA.geojson",
          "Boundary of the Chennai Metropolitan Area planning region.",
          [
            [80.0, 12.85],
            [80.35, 13.3],
          ],
        ),
        datameetItem(
          "chennai-zones",
          "Greater Chennai Corporation Zones",
          "Chennai/Zones.geojson",
          "16 administrative zones of Greater Chennai Corporation.",
          [
            [80.14, 12.85],
            [80.34, 13.24],
          ],
        ),
      ],
    },
    {
      name: "Tamil Nadu GIS (TNGIS)",
      url: "https://tngis.tn.gov.in",
      items: [
        gadmDistricts(
          "tamil-nadu-districts",
          "Tamil Nadu District Boundaries",
          ["Tamil Nadu"],
          "The 30 districts of Tamil Nadu, as mapped by GADM (older boundaries: districts created since are missing). Loads only Tamil Nadu's districts from the all-India file, which Download saves.",
          [
            [76.22, 8.07],
            [80.35, 13.54],
          ],
        ),
      ],
    },
  ]),
  region("ts", "Telangana & Andhra Pradesh", [
    {
      name: "Greater Hyderabad Municipal Corporation (GHMC)",
      url: "https://ghmc.gov.in",
      items: [
        datameetItem(
          "ghmc-area",
          "Greater Hyderabad Municipal Corporation (GHMC) Boundary",
          "Hyderabad/ghmc-area.geojson",
          "Outline of the Greater Hyderabad Municipal Corporation.",
          [
            [78.23, 17.29],
            [78.63, 17.57],
          ],
        ),
        datameetItem(
          "ghmc-wards",
          "Hyderabad GHMC Wards",
          "Hyderabad/ghmc-wards.geojson",
          "145 wards of Greater Hyderabad.",
          [
            [78.27, 17.29],
            [78.63, 17.57],
          ],
        ),
        datameetItem(
          "ghmc-zones",
          "Hyderabad GHMC Zones",
          "Hyderabad/ghmc-zones.geojson",
          "5 administrative zones of Greater Hyderabad.",
          [
            [78.23, 17.29],
            [78.63, 17.57],
          ],
        ),
      ],
    },
    {
      name: "Andhra Pradesh GIS Portal",
      url: "https://core.ap.gov.in",
      items: [
        datameetItem(
          "vijayawada-wards",
          "Vijayawada Municipal Corporation (VMC) Wards",
          "Vijayawada/Vijayawada_Wards.geojson",
          "77 municipal wards of Vijayawada.",
          [
            [80.58, 16.47],
            [80.69, 16.59],
          ],
        ),
        datameetItem(
          "vijayawada-boundary",
          "Vijayawada City Boundary",
          "Vijayawada/Vijayawada_Boundary.geojson",
          "Municipal corporation limit of Vijayawada.",
          [
            [80.58, 16.47],
            [80.69, 16.59],
          ],
        ),
      ],
    },
  ]),
  region("mh", "Maharashtra", [
    {
      name: "Brihanmumbai Municipal Corporation (BMC)",
      url: "https://portal.mcgm.gov.in",
      items: [
        datameetItem(
          "bmc-wards",
          "Mumbai Municipal Corporation (BMC/MCGM) Wards",
          "Mumbai/BMC_Wards.geojson",
          "24 administrative wards of Mumbai.",
          [
            [72.77, 18.89],
            [72.98, 19.28],
          ],
        ),
        datameetItem(
          "mumbai-slum-clusters",
          "Mumbai Slum Clusters",
          "Mumbai/slumClusters.geojson",
          "2,542 mapped slum clusters in Mumbai.",
          [
            [72.78, 18.9],
            [72.98, 19.27],
          ],
        ),
      ],
    },
    {
      name: "Maharashtra Remote Sensing Application Centre (MRSAC)",
      url: "https://mrsac.gov.in",
      items: [
        gadmDistricts(
          "maharashtra-districts",
          "Maharashtra District Boundaries",
          ["Maharashtra"],
          "The 34 districts of Maharashtra, as mapped by GADM (older boundaries: districts created since are missing). Loads only Maharashtra's districts from the all-India file, which Download saves.",
          [
            [72.65, 15.6],
            [80.9, 22.04],
          ],
        ),
      ],
    },
  ]),
  region("gj", "Gujarat", [
    {
      name: "Ahmedabad Municipal Corporation (AMC)",
      url: "https://ahmedabadcity.gov.in",
      items: [
        datameetItem(
          "amc-wards",
          "Ahmedabad Municipal Corporation (AMC) Wards",
          "Ahmedabad/Wards.geojson",
          "48 municipal wards of Ahmedabad.",
          [
            [72.44, 22.91],
            [72.71, 23.15],
          ],
        ),
      ],
    },
    {
      name: "Gujarat State Portal (BISAG-N)",
      url: "https://bisag-n.gov.in",
      items: [
        gadmDistricts(
          "gujarat-districts",
          "Gujarat District Boundaries",
          ["Gujarat"],
          "The 25 districts of Gujarat, as mapped by GADM (older boundaries: districts created since are missing). Loads only Gujarat's districts from the all-India file, which Download saves.",
          [
            [68.18, 20.12],
            [74.48, 24.71],
          ],
        ),
      ],
    },
  ]),
  region("mp", "Madhya Pradesh", [
    {
      name: "Bhopal Municipal Corporation (BMC MP)",
      url: "https://bhopalbmc.mp.gov.in",
      items: [
        datameetItem(
          "bhopal-wards",
          "Bhopal Municipal Corporation Wards",
          "Bhopal/Bhopal_wards.geojson",
          "86 municipal wards of Bhopal.",
          [
            [77.26, 23.11],
            [77.54, 23.34],
          ],
        ),
        datameetItem(
          "bhopal-zones",
          "Bhopal Municipal Corporation Zones",
          "Bhopal/Zone_Boundary.geojson",
          "19 administrative zones of Bhopal.",
          [
            [77.26, 23.11],
            [77.54, 23.34],
          ],
        ),
      ],
    },
    {
      name: "MP Council of Science and Technology (MPCOST)",
      url: "https://mpcost.gov.in",
      items: [
        gadmDistricts(
          "madhya-pradesh-districts",
          "Madhya Pradesh District Boundaries",
          ["Madhya Pradesh"],
          "The 48 districts of Madhya Pradesh, as mapped by GADM (older boundaries: districts created since are missing). Loads only Madhya Pradesh's districts from the all-India file, which Download saves.",
          [
            [74.03, 21.07],
            [82.81, 26.88],
          ],
        ),
      ],
    },
  ]),
  region("pb", "Punjab, Haryana & Chandigarh", [
    {
      name: "Chandigarh Smart City & Municipal Corporation",
      url: "https://mcchandigarh.gov.in",
      items: [
        datameetItem(
          "chandigarh-sectors",
          "Chandigarh Sector Boundaries",
          "Chandigarh/Chandigarh_Sectors.geojson",
          "63 sectors of Chandigarh.",
          [
            [76.71, 30.68],
            [76.85, 30.78],
          ],
        ),
        datameetItem(
          "chandigarh-boundary",
          "Chandigarh Union Territory Boundary",
          "Chandigarh/Chandigarh_Boundary.geojson",
          "Outline of the Union Territory of Chandigarh.",
          [
            [76.7, 30.66],
            [76.85, 30.8],
          ],
        ),
        datameetItem(
          "chandigarh-wards",
          "Chandigarh Municipal Corporation Wards",
          "Chandigarh/Chandigarh_Wards.geojson",
          "28 municipal wards of Chandigarh.",
          [
            [76.7, 30.66],
            [76.85, 30.8],
          ],
        ),
      ],
    },
    {
      name: "Punjab Remote Sensing Centre (PRSC)",
      url: "https://prsc.gov.in",
      items: [
        gadmDistricts(
          "punjab-haryana-districts",
          "Punjab & Haryana District Boundaries",
          ["Punjab", "Haryana"],
          "The 36 districts of Punjab and Haryana, as mapped by GADM (older boundaries: districts created since are missing). Loads only Punjab and Haryana's districts from the all-India file, which Download saves.",
          [
            [73.87, 27.65],
            [77.6, 32.58],
          ],
        ),
      ],
    },
  ]),
  region("wb", "West Bengal", [
    {
      name: "Kolkata Municipal Corporation (KMC)",
      url: "https://kmcgov.in",
      items: [
        datameetItem(
          "kolkata-wards",
          "Kolkata Municipal Corporation (KMC) Wards",
          "Kolkata/kolkata.geojson",
          "141 municipal wards of Kolkata.",
          [
            [88.24, 22.45],
            [88.46, 22.64],
          ],
        ),
      ],
    },
    {
      name: "West Bengal Spatial Data Infrastructure (WBSDI)",
      url: "https://wbsdi.gov.in",
      items: [
        gadmDistricts(
          "west-bengal-districts",
          "West Bengal District Boundaries",
          ["West Bengal"],
          "The 19 districts of West Bengal, as mapped by GADM (older boundaries: districts created since are missing). Loads only West Bengal's districts from the all-India file, which Download saves.",
          [
            [85.82, 21.53],
            [89.88, 27.23],
          ],
        ),
      ],
    },
  ]),
  region("or", "Odisha", [
    {
      name: "Bhubaneswar Smart City Limited (BSCL)",
      url: "https://smartcitybhubaneswar.gov.in",
      items: [
        datameetItem(
          "bhubaneswar-jurisdiction",
          "Bhubaneswar Police Jurisdictions",
          "Bhubaneswar/Police_Jurisdiction.geojson",
          "17 police station jurisdictions of Bhubaneswar.",
          [
            [85.62, 20.06],
            [86.09, 20.44],
          ],
        ),
      ],
    },
    {
      name: "Odisha State Spatial Data Infrastructure (OSSDI)",
      url: "https://spatialodisha.gov.in",
      items: [
        gadmDistricts(
          "odisha-districts",
          "Odisha District Boundaries",
          ["Orissa"],
          "The 30 districts of Odisha, as mapped by GADM (older boundaries: districts created since are missing). Loads only Odisha's districts from the all-India file, which Download saves.",
          [
            [81.38, 17.8],
            [87.49, 22.57],
          ],
        ),
      ],
    },
  ]),
  region("br", "Bihar & Jharkhand", [
    {
      name: "Bodh Gaya Nagar Panchayat",
      url: "https://bodhgayacity.bihar.gov.in",
      items: [
        datameetItem(
          "bodh-gaya-wards",
          "Bodh Gaya Municipal Wards",
          "Bodh_Gaya/Bodh_Gaya_Wards.geojson",
          "19 municipal wards of Bodh Gaya.",
          [
            [84.95, 24.67],
            [85.02, 24.74],
          ],
        ),
        datameetItem(
          "bodh-gaya-boundary",
          "Bodh Gaya Civic Boundary",
          "Bodh_Gaya/Bodh_Gaya_Boundary.geojson",
          "Town boundary of Bodh Gaya.",
          [
            [84.95, 24.67],
            [85.02, 24.74],
          ],
        ),
        datameetItem(
          "katihar-wards",
          "Katihar Municipal Corporation Wards",
          "Katihar/Katihar_Wards.geojson",
          "45 municipal wards of Katihar, Bihar.",
          [
            [87.54, 25.5],
            [87.6, 25.6],
          ],
        ),
        datameetItem(
          "purnia-wards",
          "Purnia Municipal Corporation Wards",
          "Purnia/Purnia_Wards.geojson",
          "43 municipal wards of Purnia, Bihar.",
          [
            [87.43, 25.75],
            [87.55, 25.85],
          ],
        ),
      ],
    },
    {
      name: "Bihar Remote Sensing Application Centre (BIRSAC)",
      url: "https://disastermgmt.bihar.gov.in",
      items: [
        gadmDistricts(
          "bihar-jharkhand-districts",
          "Bihar & Jharkhand District Boundaries",
          ["Bihar", "Jharkhand"],
          "The 59 districts of Bihar and Jharkhand, as mapped by GADM (older boundaries: districts created since are missing). Loads only Bihar and Jharkhand's districts from the all-India file, which Download saves.",
          [
            [83.31, 21.96],
            [88.3, 27.86],
          ],
        ),
      ],
    },
  ]),
  region("rj", "Rajasthan", [
    {
      name: "Jaipur Smart City Limited",
      url: "https://jaipurmc.org",
      items: [
        datameetItem(
          "jaipur-wards",
          "Jaipur Municipal Corporation Wards",
          "Jaipur/Jaipur_Wards.geojson",
          "77 municipal wards of Jaipur.",
          [
            [75.68, 26.77],
            [75.92, 27.03],
          ],
        ),
        datameetItem(
          "jaipur-boundary",
          "Jaipur Municipal Boundary",
          "Jaipur/Jaipur_Boundary.geojson",
          "Municipal corporation boundary of Jaipur.",
          [
            [75.68, 26.77],
            [75.92, 27.03],
          ],
        ),
        datameetItem(
          "jaipur-zones",
          "Jaipur Municipal Zones",
          "Jaipur/Jaipur_Zones.geojson",
          "10 administrative zones of Jaipur.",
          [
            [75.68, 26.77],
            [75.92, 27.03],
          ],
        ),
        datameetItem(
          "kishangarh-wards",
          "Kishangarh Municipal Wards",
          "Kishangarh/Kishangarh_Wards.geojson",
          "45 municipal wards of Kishangarh, Rajasthan.",
          [
            [74.79, 26.54],
            [74.9, 26.64],
          ],
        ),
      ],
    },
    {
      name: "Rajasthan GIS (Raj-GIS / RISL)",
      url: "https://gis.rajasthan.gov.in",
      items: [
        gadmDistricts(
          "rajasthan-districts",
          "Rajasthan District Boundaries",
          ["Rajasthan"],
          "The 32 districts of Rajasthan, as mapped by GADM (older boundaries: districts created since are missing). Loads only Rajasthan's districts from the all-India file, which Download saves.",
          [
            [69.48, 23.06],
            [78.27, 30.2],
          ],
        ),
      ],
    },
  ]),
  region("kl", "Kerala", [
    {
      name: "Kerala Spatial Data Infrastructure (KSDI)",
      url: "https://ksdi.kerala.gov.in",
      items: [
        gadmDistricts(
          "kerala-districts",
          "Kerala District Boundaries",
          ["Kerala"],
          "The 14 districts of Kerala, as mapped by GADM (older boundaries: districts created since are missing). Loads only Kerala's districts from the all-India file, which Download saves.",
          [
            [74.86, 8.29],
            [77.4, 12.8],
          ],
        ),
      ],
    },
  ]),
  region("up", "Uttar Pradesh", [
    {
      name: "Lucknow Municipal Corporation",
      url: "https://lmc.up.nic.in",
      items: [
        datameetItem(
          "lucknow-wards",
          "Lucknow Municipal Corporation Wards",
          "Lucknow/Lucknow_ward_boundary.geojson",
          "112 municipal wards of Lucknow.",
          [
            [80.83, 26.74],
            [81.07, 26.94],
          ],
        ),
        datameetItem(
          "lucknow-boundary",
          "Lucknow City Boundary",
          "Lucknow/Lucknow_city_boundary.geojson",
          "Municipal corporation boundary of Lucknow.",
          [
            [80.83, 26.74],
            [81.07, 26.94],
          ],
        ),
        datameetItem(
          "kanpur-boundary",
          "Kanpur City Boundary",
          "Kanpur/Kanpur_city_boundaries.geojson",
          "Municipal boundary of Kanpur.",
          [
            [80.19, 26.33],
            [80.48, 26.54],
          ],
        ),
      ],
    },
    {
      name: "Remote Sensing Applications Centre Uttar Pradesh (RSAC-UP)",
      url: "https://rsacup.org.in",
      items: [
        gadmDistricts(
          "uttar-pradesh-districts",
          "Uttar Pradesh District Boundaries",
          ["Uttar Pradesh"],
          "The 70 districts of Uttar Pradesh, as mapped by GADM (older boundaries: districts created since are missing). Loads only Uttar Pradesh's districts from the all-India file, which Download saves.",
          [
            [77.08, 23.87],
            [84.64, 30.42],
          ],
        ),
      ],
    },
  ]),
  region("ct", "Chhattisgarh", [
    {
      name: "Chhattisgarh State Centre (CG-Spatial)",
      url: "https://chhattisgarh.gov.in",
      items: [
        gadmDistricts(
          "chhattisgarh-districts",
          "Chhattisgarh District Boundaries",
          ["Chhattisgarh"],
          "The 16 districts of Chhattisgarh, as mapped by GADM (older boundaries: districts created since are missing). Loads only Chhattisgarh's districts from the all-India file, which Download saves.",
          [
            [80.23, 17.78],
            [84.39, 24.11],
          ],
        ),
      ],
    },
  ]),
  region("ga", "Goa", [
    {
      name: "Goa State Spatial Data Infrastructure",
      url: "https://goa.gov.in",
      items: [
        gadmDistricts(
          "goa-districts",
          "Goa District Boundaries",
          ["Goa"],
          "The 2 districts of Goa, as mapped by GADM (older boundaries: districts created since are missing). Loads only Goa's districts from the all-India file, which Download saves.",
          [
            [73.67, 14.89],
            [74.35, 15.8],
          ],
        ),
      ],
    },
  ]),
  region("as", "Assam & North East", [
    {
      name: "Assam Remote Sensing Application Centre (ARSAC)",
      url: "https://arsac.assam.gov.in",
      items: [
        gadmDistricts(
          "assam-north-east-districts",
          "Assam & North Eastern Region District Boundaries",
          [
            "Assam",
            "Arunachal Pradesh",
            "Manipur",
            "Meghalaya",
            "Mizoram",
            "Nagaland",
            "Sikkim",
            "Tripura",
          ],
          "The 78 districts of Assam and the other North Eastern states, as mapped by GADM (older boundaries: districts created since are missing). Loads only Assam and the other North Eastern states's districts from the all-India file, which Download saves.",
          [
            [88.01, 21.94],
            [97.42, 29.47],
          ],
        ),
      ],
    },
  ]),
];
