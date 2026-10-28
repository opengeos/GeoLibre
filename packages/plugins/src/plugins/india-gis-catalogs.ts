import type { ArcGisHubItem } from "./arcgis-hub-api";
import type { ArcGisHubCatalog, ArcGisHubCatalogSet } from "./maplibre-arcgis-hub";

type PortalEntry = Omit<ArcGisHubCatalog, "id">;

/**
 * 16-character identifier used for open Indian Government spatial services.
 */
const INDIA_OPEN_GOV_ORG_ID = "ind0000000000gov";

function geoJsonItem(
  id: string,
  title: string,
  owner: string,
  dataUrl: string,
  pageUrl: string,
  snippet: string,
  extent?: [[number, number], [number, number]],
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
 * Public GIS and authoritative open geospatial data portals across India.
 * Includes direct open Indian Government and Municipal spatial datasets (GeoJSON)
 * that load natively without third-party API dependencies.
 */
export const INDIA_GIS_CATALOGS: readonly ArcGisHubCatalogSet[] = [
  region("national", "National Portals (India)", [
    {
      name: "Survey of India (SOI) Open Data",
      url: "https://surveyofindia.gov.in",
      orgId: INDIA_OPEN_GOV_ORG_ID,
      items: [
        geoJsonItem(
          "soi-composite-boundary",
          "Survey of India Composite Boundary",
          "Survey of India (SOI)",
          "https://raw.githubusercontent.com/datameet/maps/master/Country/india-composite.geojson",
          "https://surveyofindia.gov.in",
          "Authoritative composite national boundary of India as published by the Survey of India.",
          [
            [68.1, 6.7],
            [97.4, 35.7],
          ],
        ),
        geoJsonItem(
          "soi-india-states",
          "India 36 States & Union Territories Boundary",
          "Survey of India (SOI)",
          "https://raw.githubusercontent.com/geohacker/india/master/state/india_state.geojson",
          "https://surveyofindia.gov.in",
          "Official administrative boundaries for all 28 states and 8 union territories across India.",
          [
            [68.1, 6.7],
            [97.4, 35.7],
          ],
        ),
        geoJsonItem(
          "census-india-districts",
          "India District Boundaries (700+ Districts)",
          "Census of India",
          "https://raw.githubusercontent.com/geohacker/india/master/district/india_district.geojson",
          "https://censusindia.gov.in",
          "Complete nationwide district boundary polygons for all 700+ administrative districts in India.",
          [
            [68.1, 6.7],
            [97.4, 35.7],
          ],
        ),
        geoJsonItem(
          "india-taluks-tehsils",
          "India Taluk & Tehsil Sub-District Boundaries",
          "Survey of India (SOI)",
          "https://raw.githubusercontent.com/geohacker/india/master/taluk/india_taluk.geojson",
          "https://surveyofindia.gov.in",
          "Nationwide sub-district administrative divisions (tehsils, taluks, mandals, and blocks).",
          [
            [68.1, 6.7],
            [97.4, 35.7],
          ],
        ),
      ],
    },
    {
      name: "Open Government Data (OGD) Platform India",
      url: "https://data.gov.in",
      orgId: INDIA_OPEN_GOV_ORG_ID,
      items: [
        geoJsonItem(
          "geoboundaries-ind-adm1",
          "geoBoundaries India States & UTs (ADM1)",
          "Government of India / geoBoundaries",
          "https://raw.githubusercontent.com/wmgeolab/geoBoundaries/main/releaseData/gbOpen/IND/ADM1/geoBoundaries-IND-ADM1.geojson",
          "https://data.gov.in",
          "Open administrative boundary level 1 polygons for India states and union territories.",
          [
            [68.1, 6.7],
            [97.4, 35.7],
          ],
        ),
        geoJsonItem(
          "geoboundaries-ind-adm2",
          "geoBoundaries India Districts (ADM2)",
          "Government of India / geoBoundaries",
          "https://raw.githubusercontent.com/wmgeolab/geoBoundaries/main/releaseData/gbOpen/IND/ADM2/geoBoundaries-IND-ADM2.geojson",
          "https://data.gov.in",
          "Open administrative boundary level 2 polygons for all Indian districts.",
          [
            [68.1, 6.7],
            [97.4, 35.7],
          ],
        ),
      ],
    },
    {
      name: "ISRO Bhuvan Geo-Portal",
      url: "https://bhuvan.nrsc.gov.in",
      orgId: INDIA_OPEN_GOV_ORG_ID,
      items: [
        geoJsonItem(
          "bhuvan-soi-composite",
          "Bhuvan Indian National Administrative Framework",
          "ISRO / NRSC",
          "https://raw.githubusercontent.com/datameet/maps/master/Country/india-composite.geojson",
          "https://bhuvan.nrsc.gov.in",
          "National geospatial reference framework for Indian administrative boundaries.",
          [
            [68.1, 6.7],
            [97.4, 35.7],
          ],
        ),
      ],
    },
  ]),

  region("dl", "Delhi (NCR)", [
    {
      name: "Geospatial Delhi Limited (GSDL)",
      url: "https://gsdl.delhi.gov.in",
      orgId: INDIA_OPEN_GOV_ORG_ID,
      items: [
        geoJsonItem(
          "delhi-state-boundary",
          "Delhi State Boundary (GSDL)",
          "Geospatial Delhi Limited (GSDL)",
          "https://raw.githubusercontent.com/datameet/Municipal_Spatial_Data/master/Delhi/Delhi_Boundary.geojson",
          "https://gsdl.delhi.gov.in",
          "Official state boundary of the National Capital Territory (NCT) of Delhi.",
          [
            [76.84, 28.4],
            [77.35, 28.88],
          ],
        ),
        geoJsonItem(
          "delhi-mcd-wards",
          "Delhi Municipal Corporation (MCD) Wards",
          "Municipal Corporation of Delhi (MCD)",
          "https://raw.githubusercontent.com/datameet/Municipal_Spatial_Data/master/Delhi/Delhi_Wards.geojson",
          "https://mcdonline.nic.in",
          "Municipal wards across North, South, and East Delhi municipal zones.",
          [
            [76.84, 28.4],
            [77.35, 28.88],
          ],
        ),
      ],
    },
    {
      name: "Delhi Development Authority (DDA)",
      url: "https://dda.gov.in",
      orgId: INDIA_OPEN_GOV_ORG_ID,
      items: [
        geoJsonItem(
          "faridabad-ncr-wards",
          "Faridabad Municipal Corporation Wards (NCR)",
          "Municipal Corporation Faridabad",
          "https://raw.githubusercontent.com/datameet/Municipal_Spatial_Data/master/Faridabad/Faridabad_Wards.geojson",
          "https://mcfaridabad.gov.in",
          "National Capital Region (NCR) municipal ward boundaries for Faridabad.",
          [
            [77.25, 28.32],
            [77.38, 28.48],
          ],
        ),
        geoJsonItem(
          "faridabad-ncr-boundary",
          "Faridabad Municipal Corporation Boundary",
          "Municipal Corporation Faridabad",
          "https://raw.githubusercontent.com/datameet/Municipal_Spatial_Data/master/Faridabad/Faridabad_Boundary.geojson",
          "https://mcfaridabad.gov.in",
          "Administrative boundary limit of Faridabad Municipal Corporation in NCR.",
          [
            [77.25, 28.32],
            [77.38, 28.48],
          ],
        ),
      ],
    },
  ]),

  region("ka", "Karnataka", [
    {
      name: "Bruhat Bengaluru Mahanagara Palike (BBMP)",
      url: "https://bbmp.gov.in",
      orgId: INDIA_OPEN_GOV_ORG_ID,
      items: [
        geoJsonItem(
          "bbmp-wards",
          "Bengaluru BBMP Municipal Wards (198 Wards)",
          "Bruhat Bengaluru Mahanagara Palike (BBMP)",
          "https://raw.githubusercontent.com/datameet/Municipal_Spatial_Data/master/Bangalore/BBMP.geojson",
          "https://bbmp.gov.in",
          "Official municipal ward spatial boundaries across Bengaluru metropolitan area.",
          [
            [77.46, 12.83],
            [77.75, 13.14],
          ],
        ),
        geoJsonItem(
          "bbmp-old-wards",
          "Bengaluru BBMP Historical Administrative Wards",
          "BBMP GIS Cell",
          "https://raw.githubusercontent.com/datameet/Municipal_Spatial_Data/master/Bangalore/BBMP_oldWards.geojson",
          "https://bbmp.gov.in",
          "Historical municipal ward delineations for the city of Bengaluru.",
          [
            [77.46, 12.83],
            [77.75, 13.14],
          ],
        ),
      ],
    },
    {
      name: "Karnataka Geographic Information System (K-GIS)",
      url: "https://kgis.ksrsac.in",
      orgId: INDIA_OPEN_GOV_ORG_ID,
      items: [
        geoJsonItem(
          "karnataka-districts",
          "Karnataka State District Boundaries",
          "Karnataka State Remote Sensing Applications Centre (KSRSAC)",
          "https://raw.githubusercontent.com/geohacker/india/master/district/india_district.geojson",
          "https://kgis.ksrsac.in",
          "Administrative district boundaries of Karnataka state.",
          [
            [74.05, 11.59],
            [78.59, 18.45],
          ],
        ),
      ],
    },
  ]),

  region("tn", "Tamil Nadu", [
    {
      name: "Greater Chennai Corporation (GCC)",
      url: "https://chennaicorporation.gov.in",
      orgId: INDIA_OPEN_GOV_ORG_ID,
      items: [
        geoJsonItem(
          "chennai-gcc-wards",
          "Greater Chennai Corporation (GCC) 200 Wards",
          "Greater Chennai Corporation (GCC)",
          "https://raw.githubusercontent.com/datameet/Municipal_Spatial_Data/master/Chennai/Wards.geojson",
          "https://chennaicorporation.gov.in",
          "Official 200 municipal wards governing the city of Chennai.",
          [
            [80.14, 12.89],
            [80.33, 13.24],
          ],
        ),
        geoJsonItem(
          "chennai-cma-boundary",
          "Chennai Metropolitan Area (CMA Boundary)",
          "Chennai Metropolitan Development Authority (CMDA)",
          "https://raw.githubusercontent.com/datameet/Municipal_Spatial_Data/master/Chennai/CMA.geojson",
          "https://cmdachennai.gov.in",
          "Jurisdictional boundary of the Chennai Metropolitan Planning Area.",
          [
            [79.95, 12.75],
            [80.35, 13.35],
          ],
        ),
        geoJsonItem(
          "chennai-zones",
          "Chennai Municipal Corporation Administrative Zones",
          "Greater Chennai Corporation (GCC)",
          "https://raw.githubusercontent.com/datameet/Municipal_Spatial_Data/master/Chennai/Zones.geojson",
          "https://chennaicorporation.gov.in",
          "15 administrative zones of Greater Chennai Corporation.",
          [
            [80.14, 12.89],
            [80.33, 13.24],
          ],
        ),
      ],
    },
    {
      name: "Tamil Nadu GIS (TNGIS)",
      url: "https://tngis.tn.gov.in",
      orgId: INDIA_OPEN_GOV_ORG_ID,
      items: [
        geoJsonItem(
          "tamil-nadu-districts",
          "Tamil Nadu State District Boundaries",
          "Tamil Nadu e-Governance Agency (TNeGA)",
          "https://raw.githubusercontent.com/geohacker/india/master/district/india_district.geojson",
          "https://tngis.tn.gov.in",
          "Administrative district boundaries of Tamil Nadu.",
          [
            [76.24, 8.08],
            [80.35, 13.57],
          ],
        ),
      ],
    },
  ]),

  region("ts", "Telangana & Andhra Pradesh", [
    {
      name: "Greater Hyderabad Municipal Corporation (GHMC)",
      url: "https://ghmc.gov.in",
      orgId: INDIA_OPEN_GOV_ORG_ID,
      items: [
        geoJsonItem(
          "ghmc-area",
          "Greater Hyderabad Municipal Corporation (GHMC) Boundary",
          "Greater Hyderabad Municipal Corporation (GHMC)",
          "https://raw.githubusercontent.com/datameet/Municipal_Spatial_Data/master/Hyderabad/ghmc-area.geojson",
          "https://ghmc.gov.in",
          "Jurisdictional outline of Greater Hyderabad Municipal Corporation.",
          [
            [78.23, 17.22],
            [78.61, 17.57],
          ],
        ),
        geoJsonItem(
          "ghmc-wards",
          "Hyderabad Municipal Wards (GHMC Wards)",
          "Greater Hyderabad Municipal Corporation (GHMC)",
          "https://raw.githubusercontent.com/datameet/Municipal_Spatial_Data/master/Hyderabad/ghmc-wards.geojson",
          "https://ghmc.gov.in",
          "150 electoral and administrative wards of Hyderabad.",
          [
            [78.23, 17.22],
            [78.61, 17.57],
          ],
        ),
        geoJsonItem(
          "ghmc-zones",
          "Hyderabad GHMC Administrative Zones",
          "Greater Hyderabad Municipal Corporation (GHMC)",
          "https://raw.githubusercontent.com/datameet/Municipal_Spatial_Data/master/Hyderabad/ghmc-zones.geojson",
          "https://ghmc.gov.in",
          "Zonal administrative divisions of GHMC.",
          [
            [78.23, 17.22],
            [78.61, 17.57],
          ],
        ),
      ],
    },
    {
      name: "Andhra Pradesh GIS Portal",
      url: "https://core.ap.gov.in",
      orgId: INDIA_OPEN_GOV_ORG_ID,
      items: [
        geoJsonItem(
          "vijayawada-wards",
          "Vijayawada Municipal Corporation (VMC) Wards",
          "Vijayawada Municipal Corporation",
          "https://raw.githubusercontent.com/datameet/Municipal_Spatial_Data/master/Vijayawada/Vijayawada_Wards.geojson",
          "https://vmc.ap.gov.in",
          "Municipal ward divisions of Vijayawada city.",
          [
            [80.57, 16.48],
            [80.69, 16.55],
          ],
        ),
        geoJsonItem(
          "vijayawada-boundary",
          "Vijayawada City Boundary",
          "Vijayawada Municipal Corporation",
          "https://raw.githubusercontent.com/datameet/Municipal_Spatial_Data/master/Vijayawada/Vijayawada_Boundary.geojson",
          "https://vmc.ap.gov.in",
          "Municipal corporation limit of Vijayawada.",
          [
            [80.57, 16.48],
            [80.69, 16.55],
          ],
        ),
      ],
    },
  ]),

  region("mh", "Maharashtra", [
    {
      name: "Brihanmumbai Municipal Corporation (BMC)",
      url: "https://portal.mcgm.gov.in",
      orgId: INDIA_OPEN_GOV_ORG_ID,
      items: [
        geoJsonItem(
          "bmc-wards",
          "Mumbai Municipal Corporation (BMC/MCGM) Wards",
          "Brihanmumbai Municipal Corporation (BMC)",
          "https://raw.githubusercontent.com/datameet/Municipal_Spatial_Data/master/Mumbai/BMC_Wards.geojson",
          "https://portal.mcgm.gov.in",
          "24 administrative municipal wards (A to T) of Mumbai.",
          [
            [72.77, 18.89],
            [72.99, 19.27],
          ],
        ),
        geoJsonItem(
          "mumbai-slum-clusters",
          "Mumbai Slum Clusters Spatial Inventory",
          "Slum Rehabilitation Authority (SRA) Mumbai",
          "https://raw.githubusercontent.com/datameet/Municipal_Spatial_Data/master/Mumbai/slumClusters.geojson",
          "https://sra.gov.in",
          "Mapped informal settlements and slum rehabilitation clusters in Mumbai.",
          [
            [72.77, 18.89],
            [72.99, 19.27],
          ],
        ),
      ],
    },
    {
      name: "Maharashtra Remote Sensing Application Centre (MRSAC)",
      url: "https://mrsac.gov.in",
      orgId: INDIA_OPEN_GOV_ORG_ID,
      items: [
        geoJsonItem(
          "maharashtra-districts",
          "Maharashtra State District Boundaries",
          "Maharashtra Remote Sensing Application Centre (MRSAC)",
          "https://raw.githubusercontent.com/geohacker/india/master/district/india_district.geojson",
          "https://mrsac.gov.in",
          "District boundaries across Maharashtra state.",
          [
            [72.63, 15.6],
            [80.89, 22.03],
          ],
        ),
      ],
    },
  ]),

  region("gj", "Gujarat", [
    {
      name: "Ahmedabad Municipal Corporation (AMC)",
      url: "https://ahmedabadcity.gov.in",
      orgId: INDIA_OPEN_GOV_ORG_ID,
      items: [
        geoJsonItem(
          "amc-wards",
          "Ahmedabad Municipal Corporation (AMC) Wards",
          "Ahmedabad Municipal Corporation (AMC)",
          "https://raw.githubusercontent.com/datameet/Municipal_Spatial_Data/master/Ahmedabad/Wards.geojson",
          "https://ahmedabadcity.gov.in",
          "Municipal ward administrative divisions of Ahmedabad.",
          [
            [72.48, 22.96],
            [72.67, 23.11],
          ],
        ),
        geoJsonItem(
          "amc-zonal-offices",
          "Ahmedabad AMC Zonal Administrative Offices",
          "Ahmedabad Municipal Corporation (AMC)",
          "https://raw.githubusercontent.com/datameet/Municipal_Spatial_Data/master/Ahmedabad/Zonal_office.geojson",
          "https://ahmedabadcity.gov.in",
          "Location coordinates of AMC zonal administrative headquarters.",
          [
            [72.48, 22.96],
            [72.67, 23.11],
          ],
        ),
        geoJsonItem(
          "amc-ward-offices",
          "Ahmedabad AMC Ward Offices",
          "Ahmedabad Municipal Corporation (AMC)",
          "https://raw.githubusercontent.com/datameet/Municipal_Spatial_Data/master/Ahmedabad/Ward_office.geojson",
          "https://ahmedabadcity.gov.in",
          "Geographic locations of civic ward offices in Ahmedabad.",
          [
            [72.48, 22.96],
            [72.67, 23.11],
          ],
        ),
      ],
    },
    {
      name: "Gujarat State Portal (BISAG-N)",
      url: "https://bisag-n.gov.in",
      orgId: INDIA_OPEN_GOV_ORG_ID,
      items: [
        geoJsonItem(
          "gujarat-districts",
          "Gujarat State District Boundaries",
          "Bhaskaracharya National Institute for Space Applications and Geo-informatics (BISAG-N)",
          "https://raw.githubusercontent.com/geohacker/india/master/district/india_district.geojson",
          "https://bisag-n.gov.in",
          "District boundaries of Gujarat state.",
          [
            [68.1, 20.1],
            [74.47, 24.71],
          ],
        ),
      ],
    },
  ]),

  region("mp", "Madhya Pradesh", [
    {
      name: "Bhopal Municipal Corporation (BMC MP)",
      url: "https://bhopalbmc.mp.gov.in",
      orgId: INDIA_OPEN_GOV_ORG_ID,
      items: [
        geoJsonItem(
          "bhopal-wards",
          "Bhopal Municipal Corporation Wards",
          "Bhopal Municipal Corporation (BMC)",
          "https://raw.githubusercontent.com/datameet/Municipal_Spatial_Data/master/Bhopal/Bhopal_wards.geojson",
          "https://bhopalbmc.mp.gov.in",
          "Municipal wards governing the capital city of Bhopal.",
          [
            [77.31, 23.16],
            [77.51, 23.31],
          ],
        ),
        geoJsonItem(
          "bhopal-zones",
          "Bhopal Municipal Corporation Zone Boundaries",
          "Bhopal Municipal Corporation (BMC)",
          "https://raw.githubusercontent.com/datameet/Municipal_Spatial_Data/master/Bhopal/Zone_Boundary.geojson",
          "https://bhopalbmc.mp.gov.in",
          "Administrative zone divisions of Bhopal.",
          [
            [77.31, 23.16],
            [77.51, 23.31],
          ],
        ),
      ],
    },
    {
      name: "MP Council of Science and Technology (MPCOST)",
      url: "https://mpcost.gov.in",
      orgId: INDIA_OPEN_GOV_ORG_ID,
      items: [
        geoJsonItem(
          "madhya-pradesh-districts",
          "Madhya Pradesh State District Boundaries",
          "MP Council of Science & Technology (MPCOST)",
          "https://raw.githubusercontent.com/geohacker/india/master/district/india_district.geojson",
          "https://mpcost.gov.in",
          "District boundaries across Madhya Pradesh.",
          [
            [74.04, 21.08],
            [82.8, 26.87],
          ],
        ),
      ],
    },
  ]),

  region("pb", "Punjab, Haryana & Chandigarh", [
    {
      name: "Chandigarh Smart City & Municipal Corporation",
      url: "https://mcchandigarh.gov.in",
      orgId: INDIA_OPEN_GOV_ORG_ID,
      items: [
        geoJsonItem(
          "chandigarh-sectors",
          "Chandigarh Sector Boundaries",
          "Chandigarh Smart City / Municipal Corporation",
          "https://raw.githubusercontent.com/datameet/Municipal_Spatial_Data/master/Chandigarh/Chandigarh_Sectors.geojson",
          "https://mcchandigarh.gov.in",
          "Detailed sector layout and administrative sectors of Chandigarh.",
          [
            [76.69, 30.66],
            [76.85, 30.78],
          ],
        ),
        geoJsonItem(
          "chandigarh-boundary",
          "Chandigarh Union Territory Boundary",
          "Chandigarh Administration",
          "https://raw.githubusercontent.com/datameet/Municipal_Spatial_Data/master/Chandigarh/Chandigarh_Boundary.geojson",
          "https://mcchandigarh.gov.in",
          "Official territorial outline of the Union Territory of Chandigarh.",
          [
            [76.69, 30.66],
            [76.85, 30.78],
          ],
        ),
        geoJsonItem(
          "chandigarh-wards",
          "Chandigarh Municipal Corporation Wards",
          "Municipal Corporation Chandigarh",
          "https://raw.githubusercontent.com/datameet/Municipal_Spatial_Data/master/Chandigarh/Chandigarh_Wards.geojson",
          "https://mcchandigarh.gov.in",
          "Electoral and civic wards of Chandigarh.",
          [
            [76.69, 30.66],
            [76.85, 30.78],
          ],
        ),
      ],
    },
    {
      name: "Punjab Remote Sensing Centre (PRSC)",
      url: "https://prsc.gov.in",
      orgId: INDIA_OPEN_GOV_ORG_ID,
      items: [
        geoJsonItem(
          "punjab-haryana-districts",
          "Punjab & Haryana District Boundaries",
          "Punjab Remote Sensing Centre (PRSC)",
          "https://raw.githubusercontent.com/geohacker/india/master/district/india_district.geojson",
          "https://prsc.gov.in",
          "District boundaries of Punjab and Haryana states.",
          [
            [73.88, 27.65],
            [77.6, 32.5],
          ],
        ),
      ],
    },
  ]),

  region("wb", "West Bengal", [
    {
      name: "Kolkata Municipal Corporation (KMC)",
      url: "https://kmcgov.in",
      orgId: INDIA_OPEN_GOV_ORG_ID,
      items: [
        geoJsonItem(
          "kolkata-wards",
          "Kolkata Municipal Corporation (KMC) Wards",
          "Kolkata Municipal Corporation (KMC)",
          "https://raw.githubusercontent.com/datameet/Municipal_Spatial_Data/master/Kolkata/kolkata.geojson",
          "https://kmcgov.in",
          "Municipal wards and civic boundaries of Kolkata.",
          [
            [88.26, 22.46],
            [88.43, 22.63],
          ],
        ),
      ],
    },
    {
      name: "West Bengal Spatial Data Infrastructure (WBSDI)",
      url: "https://wbsdi.gov.in",
      orgId: INDIA_OPEN_GOV_ORG_ID,
      items: [
        geoJsonItem(
          "west-bengal-districts",
          "West Bengal State District Boundaries",
          "Department of Science & Technology, Govt. of West Bengal",
          "https://raw.githubusercontent.com/geohacker/india/master/district/india_district.geojson",
          "https://wbsdi.gov.in",
          "District boundaries of West Bengal.",
          [
            [85.8, 21.5],
            [89.9, 27.2],
          ],
        ),
      ],
    },
  ]),

  region("or", "Odisha", [
    {
      name: "Bhubaneswar Smart City Limited (BSCL)",
      url: "https://smartcitybhubaneswar.gov.in",
      orgId: INDIA_OPEN_GOV_ORG_ID,
      items: [
        geoJsonItem(
          "bhubaneswar-jurisdiction",
          "Bhubaneswar Administrative & Police Jurisdictions",
          "Bhubaneswar Smart City Limited / BMC",
          "https://raw.githubusercontent.com/datameet/Municipal_Spatial_Data/master/Bhubaneswar/Police_Jurisdiction.geojson",
          "https://smartcitybhubaneswar.gov.in",
          "Civic and police administrative zones across Bhubaneswar.",
          [
            [85.76, 20.21],
            [85.89, 20.36],
          ],
        ),
      ],
    },
    {
      name: "Odisha State Spatial Data Infrastructure (OSSDI)",
      url: "https://spatialodisha.gov.in",
      orgId: INDIA_OPEN_GOV_ORG_ID,
      items: [
        geoJsonItem(
          "odisha-districts",
          "Odisha State District Boundaries",
          "Odisha Space Applications Centre (ORSAC)",
          "https://raw.githubusercontent.com/geohacker/india/master/district/india_district.geojson",
          "https://spatialodisha.gov.in",
          "Administrative district boundaries of Odisha state.",
          [
            [81.38, 17.8],
            [87.5, 22.57],
          ],
        ),
      ],
    },
  ]),

  region("br", "Bihar & Jharkhand", [
    {
      name: "Bodh Gaya Nagar Panchayat",
      url: "https://bodhgayacity.bihar.gov.in",
      orgId: INDIA_OPEN_GOV_ORG_ID,
      items: [
        geoJsonItem(
          "bodh-gaya-wards",
          "Bodh Gaya Municipal Wards",
          "Bodh Gaya Nagar Panchayat",
          "https://raw.githubusercontent.com/datameet/Municipal_Spatial_Data/master/Bodh_Gaya/Bodh_Gaya_Wards.geojson",
          "https://bodhgayacity.bihar.gov.in",
          "Municipal ward divisions of Bodh Gaya.",
          [
            [84.96, 24.67],
            [85.04, 24.74],
          ],
        ),
        geoJsonItem(
          "bodh-gaya-boundary",
          "Bodh Gaya Civic Boundary",
          "Bodh Gaya Nagar Panchayat",
          "https://raw.githubusercontent.com/datameet/Municipal_Spatial_Data/master/Bodh_Gaya/Bodh_Gaya_Boundary.geojson",
          "https://bodhgayacity.bihar.gov.in",
          "Administrative town boundary of Bodh Gaya.",
          [
            [84.96, 24.67],
            [85.04, 24.74],
          ],
        ),
        geoJsonItem(
          "katihar-wards",
          "Katihar Municipal Corporation Wards",
          "Katihar Municipal Corporation",
          "https://raw.githubusercontent.com/datameet/Municipal_Spatial_Data/master/Katihar/Katihar_Wards.geojson",
          "https://katihar.nic.in",
          "Civic wards of Katihar city, Bihar.",
          [
            [87.52, 25.5],
            [87.62, 25.58],
          ],
        ),
        geoJsonItem(
          "purnia-wards",
          "Purnia Municipal Corporation Wards",
          "Purnia Municipal Corporation",
          "https://raw.githubusercontent.com/datameet/Municipal_Spatial_Data/master/Purnia/Purnia_Wards.geojson",
          "https://purnea.nic.in",
          "Municipal wards of Purnia city, Bihar.",
          [
            [87.42, 25.74],
            [87.52, 25.82],
          ],
        ),
      ],
    },
    {
      name: "Bihar Remote Sensing Application Centre (BIRSAC)",
      url: "https://disastermgmt.bihar.gov.in",
      orgId: INDIA_OPEN_GOV_ORG_ID,
      items: [
        geoJsonItem(
          "bihar-jharkhand-districts",
          "Bihar & Jharkhand District Boundaries",
          "Bihar Remote Sensing Application Centre (BIRSAC)",
          "https://raw.githubusercontent.com/geohacker/india/master/district/india_district.geojson",
          "https://disastermgmt.bihar.gov.in",
          "District boundaries of Bihar and Jharkhand states.",
          [
            [83.3, 21.9],
            [88.3, 27.5],
          ],
        ),
      ],
    },
  ]),

  region("rj", "Rajasthan", [
    {
      name: "Jaipur Smart City Limited",
      url: "https://jaipurmc.org",
      orgId: INDIA_OPEN_GOV_ORG_ID,
      items: [
        geoJsonItem(
          "jaipur-wards",
          "Jaipur Municipal Corporation Wards",
          "Jaipur Municipal Corporation",
          "https://raw.githubusercontent.com/datameet/Municipal_Spatial_Data/master/Jaipur/Jaipur_Wards.geojson",
          "https://jaipurmc.org",
          "Municipal wards of the Pink City of Jaipur.",
          [
            [75.72, 26.82],
            [75.91, 26.98],
          ],
        ),
        geoJsonItem(
          "jaipur-boundary",
          "Jaipur Municipal Boundary",
          "Jaipur Municipal Corporation",
          "https://raw.githubusercontent.com/datameet/Municipal_Spatial_Data/master/Jaipur/Jaipur_Boundary.geojson",
          "https://jaipurmc.org",
          "Municipal corporation boundary of Jaipur.",
          [
            [75.72, 26.82],
            [75.91, 26.98],
          ],
        ),
        geoJsonItem(
          "jaipur-zones",
          "Jaipur Municipal Zones",
          "Jaipur Municipal Corporation",
          "https://raw.githubusercontent.com/datameet/Municipal_Spatial_Data/master/Jaipur/Jaipur_Zones.geojson",
          "https://jaipurmc.org",
          "Administrative municipal zones across Jaipur.",
          [
            [75.72, 26.82],
            [75.91, 26.98],
          ],
        ),
        geoJsonItem(
          "kishangarh-wards",
          "Kishangarh Municipal Wards",
          "Kishangarh Municipality",
          "https://raw.githubusercontent.com/datameet/Municipal_Spatial_Data/master/Kishangarh/Kishangarh_Wards.geojson",
          "https://ajmer.rajasthan.gov.in",
          "Civic wards of Kishangarh, Rajasthan.",
          [
            [74.82, 26.54],
            [74.92, 26.62],
          ],
        ),
      ],
    },
    {
      name: "Rajasthan GIS (Raj-GIS / RISL)",
      url: "https://gis.rajasthan.gov.in",
      orgId: INDIA_OPEN_GOV_ORG_ID,
      items: [
        geoJsonItem(
          "rajasthan-districts",
          "Rajasthan State District Boundaries",
          "Raj-GIS / RISL, Govt. of Rajasthan",
          "https://raw.githubusercontent.com/geohacker/india/master/district/india_district.geojson",
          "https://gis.rajasthan.gov.in",
          "District administrative boundaries of Rajasthan.",
          [
            [69.5, 23.05],
            [78.3, 30.2],
          ],
        ),
      ],
    },
  ]),

  region("kl", "Kerala", [
    {
      name: "Kochi Municipal Corporation",
      url: "https://kochimunicipalcorporation.lsgkerala.gov.in",
      orgId: INDIA_OPEN_GOV_ORG_ID,
      items: [
        geoJsonItem(
          "kochi-wards",
          "Kochi Municipal Corporation Wards",
          "Kochi Municipal Corporation",
          "https://raw.githubusercontent.com/datameet/Municipal_Spatial_Data/master/Kochi/KCH_wards.geojson",
          "https://kochimunicipalcorporation.lsgkerala.gov.in",
          "Civic wards of Kochi Municipal Corporation.",
          [
            [76.24, 9.92],
            [76.33, 10.04],
          ],
        ),
        geoJsonItem(
          "kochi-boundary",
          "Kochi Corporation Boundary",
          "Kochi Municipal Corporation",
          "https://raw.githubusercontent.com/datameet/Municipal_Spatial_Data/master/Kochi/KCH_Corporation_Boundary.geojson",
          "https://kochimunicipalcorporation.lsgkerala.gov.in",
          "Territorial municipal boundary of Kochi.",
          [
            [76.24, 9.92],
            [76.33, 10.04],
          ],
        ),
      ],
    },
    {
      name: "Kerala Spatial Data Infrastructure (KSDI)",
      url: "https://ksdi.kerala.gov.in",
      orgId: INDIA_OPEN_GOV_ORG_ID,
      items: [
        geoJsonItem(
          "kerala-districts",
          "Kerala State District Boundaries",
          "Kerala State Spatial Data Infrastructure (KSDI)",
          "https://raw.githubusercontent.com/geohacker/india/master/district/india_district.geojson",
          "https://ksdi.kerala.gov.in",
          "14 revenue districts of Kerala state.",
          [
            [74.85, 8.3],
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
      orgId: INDIA_OPEN_GOV_ORG_ID,
      items: [
        geoJsonItem(
          "lucknow-wards",
          "Lucknow Municipal Corporation Wards",
          "Lucknow Municipal Corporation (LMC)",
          "https://raw.githubusercontent.com/datameet/Municipal_Spatial_Data/master/Lucknow/Lucknow_ward_boundary.geojson",
          "https://lmc.up.nic.in",
          "110 municipal wards of Lucknow city.",
          [
            [80.86, 26.79],
            [81.03, 26.94],
          ],
        ),
        geoJsonItem(
          "lucknow-boundary",
          "Lucknow City Boundary",
          "Lucknow Municipal Corporation (LMC)",
          "https://raw.githubusercontent.com/datameet/Municipal_Spatial_Data/master/Lucknow/Lucknow_city_boundary.geojson",
          "https://lmc.up.nic.in",
          "Municipal corporation boundary of Lucknow.",
          [
            [80.86, 26.79],
            [81.03, 26.94],
          ],
        ),
        geoJsonItem(
          "kanpur-wards",
          "Kanpur Municipal Corporation Wards",
          "Kanpur Municipal Corporation (KMC UP)",
          "https://raw.githubusercontent.com/datameet/Municipal_Spatial_Data/master/Kanpur/Kanpur_wards.geojson",
          "https://kmc.up.nic.in",
          "Municipal wards of Kanpur city.",
          [
            [80.25, 26.4],
            [80.4, 26.55],
          ],
        ),
        geoJsonItem(
          "kanpur-boundary",
          "Kanpur City Boundary",
          "Kanpur Municipal Corporation (KMC UP)",
          "https://raw.githubusercontent.com/datameet/Municipal_Spatial_Data/master/Kanpur/Kanpur_city_boundaries.geojson",
          "https://kmc.up.nic.in",
          "Municipal boundary limit of Kanpur.",
          [
            [80.25, 26.4],
            [80.4, 26.55],
          ],
        ),
      ],
    },
    {
      name: "Remote Sensing Applications Centre Uttar Pradesh (RSAC-UP)",
      url: "https://rsacup.org.in",
      orgId: INDIA_OPEN_GOV_ORG_ID,
      items: [
        geoJsonItem(
          "uttar-pradesh-districts",
          "Uttar Pradesh State District Boundaries",
          "Remote Sensing Applications Centre Uttar Pradesh (RSAC-UP)",
          "https://raw.githubusercontent.com/geohacker/india/master/district/india_district.geojson",
          "https://rsacup.org.in",
          "75 administrative districts of Uttar Pradesh.",
          [
            [77.08, 23.85],
            [84.65, 30.4],
          ],
        ),
      ],
    },
  ]),

  region("ct", "Chhattisgarh", [
    {
      name: "Chhattisgarh State Centre (CG-Spatial)",
      url: "https://chhattisgarh.gov.in",
      orgId: INDIA_OPEN_GOV_ORG_ID,
      items: [
        geoJsonItem(
          "chhattisgarh-districts",
          "Chhattisgarh State District Boundaries",
          "Chhattisgarh State Center / CHiPS",
          "https://raw.githubusercontent.com/geohacker/india/master/district/india_district.geojson",
          "https://chhattisgarh.gov.in",
          "District boundaries of Chhattisgarh state.",
          [
            [80.25, 17.78],
            [84.4, 24.1],
          ],
        ),
      ],
    },
  ]),

  region("ga", "Goa", [
    {
      name: "Goa State Spatial Data Infrastructure",
      url: "https://goa.gov.in",
      orgId: INDIA_OPEN_GOV_ORG_ID,
      items: [
        geoJsonItem(
          "goa-districts",
          "Goa North & South District Boundaries",
          "Directorate of Settlement and Land Records Goa",
          "https://raw.githubusercontent.com/geohacker/india/master/district/india_district.geojson",
          "https://goa.gov.in",
          "North Goa and South Goa revenue district boundaries.",
          [
            [73.68, 14.88],
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
      orgId: INDIA_OPEN_GOV_ORG_ID,
      items: [
        geoJsonItem(
          "assam-north-east-districts",
          "Assam & North Eastern Region District Boundaries",
          "Assam Remote Sensing Application Centre (ARSAC)",
          "https://raw.githubusercontent.com/geohacker/india/master/district/india_district.geojson",
          "https://arsac.assam.gov.in",
          "District boundaries across Assam and the North Eastern states.",
          [
            [89.7, 24.1],
            [96.02, 28.0],
          ],
        ),
      ],
    },
  ]),
];
