import type { ArcGisHubCatalog, ArcGisHubCatalogSet } from "./maplibre-arcgis-hub";

type PortalEntry = Omit<ArcGisHubCatalog, "id">;

/**
 * Describe a city or county portal built on ArcGIS Hub.
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
 * Describe a city or county portal built on Socrata.
 *
 * Args:
 *   name: The name shown in the picker.
 *   domain: The portal's hostname, which scopes the Socrata catalog search.
 *
 * Returns:
 *   The portal entry.
 */
function socrata(name: string, domain: string): PortalEntry {
  return { name, url: `https://${domain}`, socrataDomain: domain };
}

/**
 * Build one state's catalog set. A portal's id is derived from its name rather
 * than its position, so adding or dropping a portal later does not change
 * which one a user's remembered choice points at.
 *
 * Args:
 *   code: The state's two-letter postal code, lowercased.
 *   name: The state's name.
 *   portals: Its city and county portals, alphabetically.
 *
 * Returns:
 *   The state's catalog set.
 */
function state(code: string, name: string, portals: PortalEntry[]): ArcGisHubCatalogSet {
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
 * The public GIS and open-data portals of large US cities and counties (plus
 * a few regional agencies), grouped by state, as catalogs the US Local GIS
 * panel can search. Most are ArcGIS Hub sites; the rest are Socrata portals,
 * which many of the largest cities (New York, Chicago, San Francisco, Seattle,
 * Austin) use instead. Portals on other platforms (CKAN, OpenDataSoft, custom
 * sites) are not listed, since the panel cannot search them.
 *
 * Every entry was checked live to return datasets: a Hub site's catalog
 * groups (or organization) must hold public GIS items, and a Socrata portal
 * must publish datasets with a geometry column. `npm run check:gis-portals`
 * repeats that check. Snapshot of September 2026.
 */
export const US_LOCAL_GIS_CATALOGS: readonly ArcGisHubCatalogSet[] = [
  state("al", "Alabama", [
    hub(
      "Jefferson County (Birmingham)",
      "data-jeffco-al.opendata.arcgis.com",
      "01f85376565647d385c7dbc702e372af",
      "2FZPLYt8NeStZfN0",
    ),
  ]),
  state("az", "Arizona", [
    hub(
      "Chandler",
      "share-open-data-changis.hub.arcgis.com",
      "fe9b58eeda704c7da2894f50e2bf48eb",
      "HIBNcuytta1apnkB",
    ),
    hub(
      "Maricopa County",
      "data-maricopa.opendata.arcgis.com",
      "99e683720a984c64b99ff5b6db48b06c",
      "ykpntM6e3tHvzKRJ",
    ),
    socrata("Mesa", "data.mesaaz.gov"),
    hub(
      "Phoenix",
      "mapping-phoenix.opendata.arcgis.com",
      "a5bb48923e424bc69529f759146bbafd",
      "cfKakmeHE95cgeEK",
    ),
    hub(
      "Pima County",
      "gisopendata.pima.gov",
      "d8f0599e6dd14fd69a00d982ad4fd985",
      "UTBp78iglGpbqp1B",
    ),
    hub(
      "Scottsdale",
      "data.scottsdaleaz.gov",
      "a6371d6040274c2a8a0020e68fe6059f",
      "hvDuIN6e7bxkHpdO",
    ),
    hub("Tempe", "data.tempe.gov", "2722e04735c84b3db11b63135d1f161f", "lQySeXwbBg53XWDi"),
    hub("Tucson", "gisdata.tucsonaz.gov", "c069f7b3210640e6bb31ae2adbeda9fe", "9coHY2fvuFjG9HQX"),
  ]),
  state("ca", "California", [
    hub("Alameda County", "data.acgov.org", "6b8917a95a694c1b93750d03a05d7b72", "ROBnTHSNjoZ2Wm1P"),
    socrata("Berkeley", "data.cityofberkeley.info"),
    hub(
      "Fresno",
      "gis-cityoffresno.hub.arcgis.com",
      "070c879d03f94cd38e1fd4d3537eecb0",
      "WkBUojyNPhsWOk1W",
    ),
    hub(
      "Irvine",
      "city-of-irvine-open-data-portal-cityofirvine.hub.arcgis.com",
      "1183f17528c0457aa7886cbb8a8d2e34",
      "3mkVbLdbLBFHrfbK",
    ),
    hub(
      "Long Beach",
      "datalb.longbeach.gov",
      "5f5a5ce5987b438bae2a4d98158c00fb",
      "yCArG7wGXGyWLqav",
    ),
    hub(
      "Los Angeles County eGIS",
      "egis-lacounty.hub.arcgis.com",
      "4406d6e5e99345078342e91082e517a0",
      "RmCCgQtiZLDCtblq",
    ),
    hub(
      "Los Angeles County Open Data",
      "data.lacounty.gov",
      "ade02d0e6aa44df5bc3c9994c827c744",
      "RmCCgQtiZLDCtblq",
    ),
    hub(
      "Los Angeles GeoHub",
      "geohub.lacity.org",
      "e51ee91017d940c1be47fa639906bfe7",
      "7nsPwEMP38bSkCjy",
    ),
    socrata("Los Angeles Open Data", "data.lacity.org"),
    socrata("Marin County", "data.marincounty.gov"),
    socrata("Oakland", "data.oaklandca.gov"),
    hub(
      "Orange County",
      "data-ocpw.opendata.arcgis.com",
      "701e29e22a9740029a3fa6139810f80a",
      "UXmFoWC7yDHcDN5Q",
    ),
    hub(
      "Riverside County",
      "gisopendata-countyofriverside.opendata.arcgis.com",
      "d7050d61bdbd4a7c807d3624c35ec64f",
      "pWmBUdSlVpXStHU6",
    ),
    hub(
      "Sacramento",
      "data.cityofsacramento.org",
      "bca1167f95b64534b8717a1895313a4e",
      "54falWtcpty3V47Z",
    ),
    hub(
      "Sacramento County",
      "data.saccounty.gov",
      "1a43a893ae944983a6ca23548da3b072",
      "5NARefyPVtAeuJPU",
    ),
    hub(
      "San Bernardino County",
      "open-data-sbcounty.hub.arcgis.com",
      "9f65b78ad1d948c79be169eb8833da53",
      "aA3snZwJfFkVyDuP",
    ),
    socrata("San Diego County", "data.sandiegocounty.gov"),
    socrata("San Francisco", "data.sf.gov"),
    hub(
      "San Jose",
      "gisdata-csj.opendata.arcgis.com",
      "328f7cf06fc243e0a974b4b4b7aa2398",
      "6kSayNlqm3HvsYZ8",
    ),
    socrata("San Mateo County", "data.smcgov.org"),
    socrata("Santa Clara County", "data.sccgov.org"),
    hub(
      "Santa Monica",
      "gisdata.santamonica.gov",
      "9a2a5d77633e44c5863a9660d709a9e1",
      "ntb1ZybmOdA9GyKm",
    ),
    socrata("Sonoma County", "data.sonomacounty.ca.gov"),
    socrata("West Hollywood", "data.weho.org"),
  ]),
  state("co", "Colorado", [
    hub(
      "Aurora",
      "data-auroraco.opendata.arcgis.com",
      "af35aff0c1b84d98829031a57a77bdbb",
      "0Va1ID99NSrNyyPX",
    ),
    hub(
      "Boulder",
      "open-data.bouldercolorado.gov",
      "4ce1e35aa122446caf541b7179f3e8c9",
      "ePKBjXrBZ2vEEgWd",
    ),
    hub(
      "Denver",
      "opendata-geospatialdenver.hub.arcgis.com",
      "08ac95d2733c45059ec5a3c76faa770d",
      "zdB7qR0BtYrg0Xpl",
    ),
    hub(
      "El Paso County (Colorado Springs)",
      "opendata-elpasoco.hub.arcgis.com",
      "755cb06024d84559b3068d022f98a97f",
      "r1Gf4AJYRBIM0N25",
    ),
    socrata("Fort Collins", "opendata.fcgov.com"),
  ]),
  state("ct", "Connecticut", [
    hub(
      "Hartford",
      "open-data-hartford-hartfordgis.hub.arcgis.com",
      "09f51357187b444c95d3c339fc05245a",
      "WM6ZNcwewSWH8Mo9",
    ),
  ]),
  state("fl", "Florida", [
    hub(
      "Broward County",
      "geohub-bcgis.opendata.arcgis.com",
      "27302957e4714e1abbb9753cd7042520",
      "JMAJrTsHNLrSsWf5",
    ),
    socrata("Gainesville", "data.cityofgainesville.org"),
    hub(
      "Miami",
      "datahub-miamigis.opendata.arcgis.com",
      "8b9b67f78e1c4b8fb8073b05d9bdc2a5",
      "CvuPhqcTQpZPT9qY",
    ),
    hub(
      "Miami-Dade County",
      "gis-mdc.opendata.arcgis.com",
      "d2e3d8b28e74451bbd1db16e1f577e60",
      "8Pc9XBTAsYuxx9Ny",
    ),
    socrata("Orlando", "data.cityoforlando.net"),
    hub(
      "Palm Beach County",
      "opendata2-pbcgov.opendata.arcgis.com",
      "a1b6b8c47ba74bdf96506d2ee331e7ac",
      "ZWOoUZbtaYePLlPw",
    ),
    hub(
      "St. Petersburg",
      "geohub-csp.opendata.arcgis.com",
      "aa0d8876a64444d687c9028bce388366",
      "9qPLjNtocjo438CJ",
    ),
    hub(
      "Tallahassee-Leon County",
      "geodata-tlcgis.opendata.arcgis.com",
      "2809d608961543cf918be6587b975f01",
      "ptvDyBs1KkcwzQNJ",
    ),
    hub(
      "Tampa",
      "city-tampa.opendata.arcgis.com",
      "316ee3c5e5ef40bc84694258182d94f3",
      "IbNXlmt2RVVRCZ6M",
    ),
  ]),
  state("ga", "Georgia", [
    hub(
      "Athens-Clarke County",
      "data-athensclarke.opendata.arcgis.com",
      "5933dee3d8ec482db975644976db96de",
      "xSEULKvB31odt3XQ",
    ),
    hub(
      "Atlanta Regional Commission",
      "opendata.atlantaregional.com",
      "0baf04b4a2c64480be1beac144560262",
      "Ug5xGQbHsD8zuZzM",
    ),
    hub(
      "DeKalb County",
      "dcgis-dekalbgis.hub.arcgis.com",
      "533d0bcf1d4343d5b279ea35143b52c5",
      "IxVN2oUE9EYLSnPE",
    ),
    hub(
      "Gwinnett County",
      "gcgis-gwinnettcountyga.hub.arcgis.com",
      "8ef19395d08f42c495d53ce6bfbb3850",
      "RfpmnkSAQleRbndX",
    ),
  ]),
  state("hi", "Hawaii", [
    hub(
      "Honolulu GIS",
      "honolulu-cchnl.opendata.arcgis.com",
      "8e80ac7782c1415baf3346b2d07ac493",
      "tNJpAOha4mODLkXz",
    ),
    socrata("Honolulu Open Data", "data.honolulu.gov"),
  ]),
  state("id", "Idaho", [
    hub(
      "Boise",
      "opendata.cityofboise.org",
      "ee109a20969d4317918cfead374dbb2f",
      "WHM6qC35aMtyAAlN",
    ),
  ]),
  state("il", "Illinois", [
    socrata("Chicago", "data.cityofchicago.org"),
    hub(
      "Cook County GIS",
      "hub-cookcountyil.opendata.arcgis.com",
      "2a191092b4de474883802824e9593ffa",
      "I5Or36sMcO7Y9vQ3",
    ),
    socrata("Cook County Open Data", "datacatalog.cookcountyil.gov"),
    hub(
      "Naperville",
      "data.naperville.il.us",
      "68c4ed288a9d43b0a504c742885e7f06",
      "rXJ6QApc2sOtl1Pd",
    ),
  ]),
  state("in", "Indiana", [
    socrata("Bloomington", "data.bloomington.in.gov"),
    hub(
      "Hamilton County",
      "geohub.hamiltoncounty.in.gov",
      "e1e638229287427eb85a94e23c690fc2",
      "beYj0ONLvCt8qxHA",
    ),
    hub("Indianapolis", "data.indy.gov", "7753aa0e70414d92bce4b29dc9313011", "xBsPUWYKO89lShIO"),
  ]),
  state("ks", "Kansas", [
    hub(
      "Johnson County",
      "jocogov-aims.opendata.arcgis.com",
      "40721007a46645068b3ddc58f3ab7054",
      "VI7SIDfzMs53TTMm",
    ),
    hub(
      "Olathe",
      "data-cityofolathe.opendata.arcgis.com",
      "6687ef797a85482eb86164f2ecedae1d",
      "V5kJ9QPOiI1K62Ac",
    ),
    hub(
      "Sedgwick County",
      "sedgwick-county-gis-sedgwickcounty.hub.arcgis.com",
      "d7b2326339b34d33bae6db68e9d50594",
      "McLat6HlPl45bNBv",
    ),
    hub(
      "Wichita",
      "data-cityofwichita.hub.arcgis.com",
      "5a479578cbd1446b8a3e58d004fcb794",
      "lOHEurd1BgncOSk1",
    ),
  ]),
  state("ky", "Kentucky", [
    hub(
      "Lexington",
      "data-lfucg.hub.arcgis.com",
      "87de3890a26e41a7bd54752ef1699f98",
      "Mg7DLdfYcSWIaDnu",
    ),
    hub(
      "Louisville",
      "data.louisvilleky.gov",
      "105d192e2725465fa5ff70d163ca457a",
      "79kfd2K6fskCAkyg",
    ),
  ]),
  state("la", "Louisiana", [
    socrata("Baton Rouge", "data.brla.gov"),
    socrata("New Orleans", "data.nola.gov"),
  ]),
  state("md", "Maryland", [
    hub(
      "Baltimore",
      "data.baltimorecity.gov",
      "bb5a4d421ed64feeb4c3c879dede44f2",
      "UWYHeuuJISiGmgXx",
    ),
    hub(
      "Baltimore County",
      "opendata.baltimorecountymd.gov",
      "6df978664d834dcfa43c84503d040e1b",
      "Ynpzre7M7vSGY7dh",
    ),
    socrata("Montgomery County", "data.montgomerycountymd.gov"),
    socrata("Prince George's County", "data.princegeorgescountymd.gov"),
  ]),
  state("ma", "Massachusetts", [
    hub(
      "Boston",
      "bostonopendata-boston.opendata.arcgis.com",
      "f23bac8afcd343f1a24a7e26d8d2bf96",
      "sFnw0xNflSi8J0uh",
    ),
    socrata("Cambridge", "data.cambridgema.gov"),
  ]),
  state("mi", "Michigan", [
    hub("Detroit", "data.detroitmi.gov", "c4f0193f90d44ec7a59236d681a74dbb", "qvkbeam7Wirps6zC"),
  ]),
  state("mn", "Minnesota", [
    hub(
      "Hennepin County",
      "gis-hennepin.hub.arcgis.com",
      "05cd4c5cbdb8413a9258cc24f5d19224",
      "ziLNoRgqnICUM0q1",
    ),
    hub(
      "Minneapolis",
      "opendata.minneapolismn.gov",
      "c74e041718394d85bb291822c415f46b",
      "afSMGVsC7QlRK1kZ",
    ),
    hub(
      "St. Paul",
      "information.stpaul.gov",
      "1e2bdd73bc384d70aea7a337ba0cd3ce",
      "9meaaHE3uiba0zr8",
    ),
  ]),
  state("mo", "Missouri", [
    hub(
      "Columbia",
      "datahub-gocolumbiamo.opendata.arcgis.com",
      "adaa409fd4814ebabe212fdb818b944a",
      "GHhNHT1xiCkCAXvo",
    ),
    socrata("Kansas City", "data.kcmo.org"),
  ]),
  state("ne", "Nebraska", [
    hub(
      "Omaha-Douglas County",
      "data-dogis.opendata.arcgis.com",
      "31381668ca6f490281ec54d2cf659640",
      "pDAi2YK0L0QxVJHj",
    ),
  ]),
  state("nv", "Nevada", [
    hub(
      "Las Vegas",
      "opendataportal-lasvegas.opendata.arcgis.com",
      "b966d215cd7a4c6caf2132e8ed6ce1fc",
      "F1v0ufATbBQScMtY",
    ),
    hub(
      "Reno",
      "data-cityofreno.opendata.arcgis.com",
      "55a2a7fb3b6342129c6c32278f5e5d40",
      "RjM4BJrv5ZkqP4XC",
    ),
  ]),
  state("ny", "New York", [
    socrata("Buffalo", "data.buffalony.gov"),
    socrata("New York City", "data.cityofnewyork.us"),
    hub(
      "Rochester",
      "data.cityofrochester.gov",
      "273dc226904e43f0a83baecf54a31397",
      "yoz1ZtATTCokO9nU",
    ),
    hub(
      "Suffolk County",
      "opendata.suffolkcountyny.gov",
      "57f3191192114c32a0e22586cb257278",
      "JsDD4qdG5r2a7hR5",
    ),
    hub("Syracuse", "data.syr.gov", "86710986bc1842389faaa1c17fe654cf", "bdPqSfflsdgFRVVM"),
    hub(
      "Westchester County",
      "gis.westchestercountyny.gov",
      "606726bec1944726a4c505503445a5c3",
      "XKEHpOulfycN9cGC",
    ),
  ]),
  state("nc", "North Carolina", [
    hub(
      "Charlotte",
      "data.charlottenc.gov",
      "5d8ea37690104b94b358119129487e47",
      "9Nl857LBlQVyzq54",
    ),
    hub(
      "Durham",
      "live-durhamnc.opendata.arcgis.com",
      "8a5ccf6bcfad4c81beab417e8577b26b",
      "G5vR3cOjh6g2Ed8E",
    ),
    hub(
      "Greensboro",
      "data.greensboro-nc.gov",
      "88aa78a3f03f470f8adb6e03072dcaaa",
      "A7KFW0gHh8qBaXk3",
    ),
    hub(
      "Raleigh",
      "data-ral.opendata.arcgis.com",
      "9afa0ba9c92f4cf6b0eb4356e40423ab",
      "v400IkDOw1ad7Yad",
    ),
    hub(
      "Wake County",
      "data-wake.opendata.arcgis.com",
      "8e6dd38a07da45cd984b1cd29930a81c",
      "a7CWfuGP5ZnLYE7I",
    ),
  ]),
  state("oh", "Ohio", [
    hub(
      "Cleveland",
      "data.clevelandohio.gov",
      "a643b07bea7143f393679ed7dc9554e4",
      "dty2kHktVXHrqO8i",
    ),
    hub(
      "Columbus",
      "opendata.columbus.gov",
      "0a37e4488b1f405eb0ea052607047b60",
      "9yy6msODkIBzkUXU",
    ),
    hub(
      "Cuyahoga County",
      "geospatial.gis.cuyahogacounty.gov",
      "4f3cc376f3734fde9031e5ef7481c7de",
      "GXM8JipKyc0m6HBi",
    ),
    hub("Toledo", "data.toledo.gov", "f3a8acb5f2fc4f3a92fde0fd04dad2f5", "2snQ88YUjP9CNEbe"),
  ]),
  state("ok", "Oklahoma", [
    hub("Oklahoma City", "data.okc.gov", "de916683e3f345df9df48a455c5f9d0b", "2mOVdIcRtNH2JsSF"),
    hub(
      "Tulsa",
      "gis2-cityoftulsa.opendata.arcgis.com",
      "49f5fe956376420ab114b0ed70c5e826",
      "XkZ90iCdbTJ9oNXl",
    ),
  ]),
  state("or", "Oregon", [
    hub(
      "Jackson County",
      "gis-jcgis.opendata.arcgis.com",
      "09be49da318c4bb89f0f0bd7f87205d1",
      "DwYBkWQPdaJNWrPG",
    ),
    hub(
      "Oregon Metro (Portland region)",
      "rlisdiscovery.oregonmetro.gov",
      "9d88a36ba6d44751ae38c60707269eec",
      "McQ0OlIABe29rJJy",
    ),
    hub(
      "Portland",
      "gis-pdx.opendata.arcgis.com",
      "2bd881f893fe47b9bf44bbd6d22ce2b2",
      "quVN97tn06YNGj9s",
    ),
  ]),
  state("pa", "Pennsylvania", [
    hub(
      "Philadelphia",
      "data-phl.opendata.arcgis.com",
      "80ecb6974200435f8e4b5696b11ca2b8",
      "fLeGjb7u4uXqeF9q",
    ),
    hub(
      "Pittsburgh",
      "pghgishub-pittsburghpa.opendata.arcgis.com",
      "4a9d0380ac4a4627b9abafdff5342434",
      "YZCmUqbcsUpOKfj7",
    ),
  ]),
  state("ri", "Rhode Island", [
    hub(
      "Providence GIS",
      "providence-gis-hub-pvdgis.hub.arcgis.com",
      "759e60c6c41c4fe3aa8f27aa8e55ef62",
      "wv9mHoqblhTsnqdG",
    ),
    socrata("Providence Open Data", "data.providenceri.gov"),
  ]),
  state("sc", "South Carolina", [
    hub(
      "Charleston County",
      "charleston-county-gis-chascogis.hub.arcgis.com",
      "b96c970103654cd082d5f126daff4f30",
      "jR9eNCjAkxwH2nLe",
    ),
  ]),
  state("tn", "Tennessee", [
    hub(
      "Memphis",
      "memphis-open-data-hub-memegis.hub.arcgis.com",
      "fb4f65e9707e4bb2b1e503f140938880",
      "saWmpKJIUAjyyNVc",
    ),
    hub("Nashville", "data.nashville.gov", "57dd8b686ef0408998f719669b95d629", "HdTo6HJqh92wn4D8"),
  ]),
  state("tx", "Texas", [
    socrata("Austin", "data.austintexas.gov"),
    hub(
      "Bexar County",
      "gis-bexar.opendata.arcgis.com",
      "03bd1f8488e249df8ebbf9580ed8d21a",
      "8onVmslF2KXErTHT",
    ),
    hub(
      "Corpus Christi",
      "gis-corpus.opendata.arcgis.com",
      "0e6f8151eceb437c856e4bc3cf920227",
      "0J4ZNc4NaTguvRy0",
    ),
    hub(
      "Dallas County",
      "dallas-county-open-data-hub-dallascountygis.hub.arcgis.com",
      "8c9f415c80084ea5ab5bf454173a09af",
      "zqe2kwz79KUqUvxC",
    ),
    hub(
      "Dallas GIS",
      "egisdata-dallasgis.hub.arcgis.com",
      "7cc3ddb4800e436f8ba771ea523b5ddc",
      "rwnOSbfKSwyTBcwN",
    ),
    socrata("Dallas Open Data", "www.dallasopendata.com"),
    hub(
      "El Paso",
      "opendata.elpasotexas.gov",
      "4bd6c73d119a4350897641f8d8a61a2a",
      "hyTVSIhR7dHyDsJF",
    ),
    hub(
      "Fort Worth",
      "data.fortworthtexas.gov",
      "365a6ab74e0448db93c6ecddbb6514bb",
      "3ddLCBXe1bRt7mzj",
    ),
    hub(
      "Harris County",
      "geo-harriscounty.opendata.arcgis.com",
      "17abd25f5caf4befb06005c691007e02",
      "su8ic9KbA7PYVxPS",
    ),
    hub(
      "Houston",
      "cohgis-mycity.opendata.arcgis.com",
      "0330146b830f4487a89ff170e62a8878",
      "NummVBqZSIJKUeVR",
    ),
    hub(
      "San Antonio",
      "opendata-cosagis.opendata.arcgis.com",
      "11dea7e722da42a1a6a6407a8c3ff4be",
      "g1fRTDLeMgspWrYp",
    ),
    hub(
      "Tarrant County",
      "data-tarrantcounty.opendata.arcgis.com",
      "07dd6150f130406ea6bb68ab2b7f98f7",
      "KgTkwJ7lfG2eHF3z",
    ),
    hub(
      "Travis County",
      "tnr-traviscountytx.hub.arcgis.com",
      "2eff5d073fca4eeb97d600cda4699e46",
      "HGcSYZ5bvjRswoCb",
    ),
  ]),
  state("ut", "Utah", [
    hub(
      "Salt Lake City",
      "gis-slcgov.opendata.arcgis.com",
      "5db27243a95d4f8099aba0470f9f1f6d",
      "mMBpeYj0vPFotzbe",
    ),
    hub(
      "Salt Lake County",
      "gisdata-slco.opendata.arcgis.com",
      "40cc6e95079f4f7ebcc01635e7f344f7",
      "DJP723NX3ukQ2LtF",
    ),
  ]),
  state("va", "Virginia", [
    hub(
      "Arlington County",
      "gisdata-arlgis.opendata.arcgis.com",
      "3248008859c34cfaa7cac22f1273fdd3",
      "JrtUzVcH8S2wnzVH",
    ),
    hub(
      "Chesapeake",
      "public-chesva.opendata.arcgis.com",
      "3c358a52954e4baea8723c2d842e5784",
      "OAphVRUvJVpBRovs",
    ),
    hub(
      "Fairfax County",
      "data-fairfaxcountygis.opendata.arcgis.com",
      "f8be7fd5a7a4462891868cbfe4a1aa6d",
      "ioennV6PpG5Xodq0",
    ),
    hub(
      "Loudoun County",
      "geohub-loudoungis.opendata.arcgis.com",
      "7310fc278f624a06bd2226f137da963b",
      "MxjRokvPm7bjslyR",
    ),
    socrata("Norfolk", "data.norfolk.gov"),
    socrata("Richmond", "data.richmondgov.com"),
    hub(
      "Virginia Beach",
      "gis.data.vbgov.com",
      "d12298bf52cd4f389051844e9a66d629",
      "CyVvlIiUfRBmMQuu",
    ),
  ]),
  state("wa", "Washington", [
    hub(
      "Clark County",
      "hub-clarkcountywa.opendata.arcgis.com",
      "805517b5067a46c380ea4c4f64e55cc8",
      "ylxwjFBdCPBzP16d",
    ),
    hub(
      "King County GIS",
      "gis-kingcounty.opendata.arcgis.com",
      "d334817cbde1483292c219421e32da9c",
      "Ej0PsM5Aw677QF1W",
    ),
    socrata("King County Open Data", "data.kingcounty.gov"),
    hub(
      "Pierce County",
      "gisdata-piercecowa.opendata.arcgis.com",
      "34f7b1740f7f4806a7f1352d371d5bfa",
      "1UvBaQ5y1ubjUPmd",
    ),
    hub(
      "Seattle GeoData",
      "data-seattlecitygis.opendata.arcgis.com",
      "334a4a5204ba4b3dac75109352611677",
      "ZOyb2t4B0UYuYNYH",
    ),
    socrata("Seattle Open Data", "data.seattle.gov"),
    hub(
      "Snohomish County",
      "snohomish-county-open-data-portal-snoco-gis.hub.arcgis.com",
      "ddea1d4950c44f86bcc9efff71aaf02d",
      "z6WYi9VRHfgwgtyW",
    ),
    hub(
      "Spokane",
      "data-spokane.opendata.arcgis.com",
      "a741c4955dd147b195c49e3e30ab78cb",
      "3PDwyTturHqnGCu0",
    ),
    hub("Tacoma", "data.tacoma.gov", "28cb0ea3b4a6406d99366c4f4ae52dd0", "SCwJH1pD8WSn5T5y"),
  ]),
  state("wi", "Wisconsin", [
    hub(
      "Madison",
      "data-cityofmadison.opendata.arcgis.com",
      "067c50f1d3d847e7b7c36c4efa5168cf",
      "lx96Ahunbwmk5g5p",
    ),
    hub(
      "Milwaukee County",
      "data.county.milwaukee.gov",
      "251150da257b4095912cdcaa5038184e",
      "s1wgJQKbKJihhhaT",
    ),
  ]),
  state("wy", "Wyoming", [
    hub(
      "Cheyenne-Laramie County",
      "hub.clcgisc.com",
      "45c91db66706494b86519a5cb635c87c",
      "e5t4ywWgRBNUuDeU",
    ),
  ]),
];
