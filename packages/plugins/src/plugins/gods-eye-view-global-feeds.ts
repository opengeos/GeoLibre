import type { CzmlPacket } from "@geolibre/core";
import type { Feature, FeatureCollection, Point } from "geojson";
import type { GodsEyeViewFeedPayload } from "./gods-eye-view-catalog-feeds";

export const LAUNCH_LIBRARY_EDGE_URL = "https://tiles.geolibre.app/launch-library/recent";
export const LAUNCH_LIBRARY_API_URL = "https://ll.thespacedevs.com/2.3.0/launches/";
export const LAUNCH_LIBRARY_DEV_URL = "/launch-library/recent";

interface GbfsSystem {
  id: string;
  city: string;
  provider: string;
  informationUrl: string;
  statusUrl: string;
}

const bcycle = (id: string, city: string, system: string, provider = "BCycle"): GbfsSystem => ({
  id,
  city,
  provider,
  informationUrl: `https://gbfs.bcycle.com/${system}/station_information.json`,
  statusUrl: `https://gbfs.bcycle.com/${system}/station_status.json`,
});

/** Currently reachable systems from the upstream 32-system public GBFS registry. */
export const GBFS_SYSTEMS: readonly GbfsSystem[] = [
  {
    id: "nyc-citibike",
    city: "New York, NY",
    provider: "Citi Bike",
    informationUrl: "https://gbfs.lyft.com/gbfs/2.3/bkn/en/station_information.json",
    statusUrl: "https://gbfs.lyft.com/gbfs/2.3/bkn/en/station_status.json",
  },
  {
    id: "chicago-divvy",
    city: "Chicago, IL",
    provider: "Divvy",
    informationUrl: "https://gbfs.lyft.com/gbfs/2.3/chi/en/station_information.json",
    statusUrl: "https://gbfs.lyft.com/gbfs/2.3/chi/en/station_status.json",
  },
  {
    id: "dc-capital-bikeshare",
    city: "Washington, DC",
    provider: "Capital Bikeshare",
    informationUrl: "https://gbfs.lyft.com/gbfs/2.3/dca-cabi/en/station_information.json",
    statusUrl: "https://gbfs.lyft.com/gbfs/2.3/dca-cabi/en/station_status.json",
  },
  {
    id: "sf-bay-wheels",
    city: "San Francisco, CA",
    provider: "Bay Wheels",
    informationUrl: "https://gbfs.lyft.com/gbfs/2.3/bay/en/station_information.json",
    statusUrl: "https://gbfs.lyft.com/gbfs/2.3/bay/en/station_status.json",
  },
  {
    id: "boston-bluebikes",
    city: "Boston, MA",
    provider: "Blue Bikes",
    informationUrl: "https://gbfs.bluebikes.com/gbfs/en/station_information.json",
    statusUrl: "https://gbfs.bluebikes.com/gbfs/en/station_status.json",
  },
  bcycle("philadelphia-indego", "Philadelphia, PA", "bcycle_indego", "Indego"),
  {
    id: "portland-biketown",
    city: "Portland, OR",
    provider: "BIKETOWN",
    informationUrl: "https://gbfs.biketownpdx.com/gbfs/2.3/en/station_information.json",
    statusUrl: "https://gbfs.biketownpdx.com/gbfs/2.3/en/station_status.json",
  },
  bcycle("la-metro-bike", "Los Angeles, CA", "bcycle_lametro", "Metro Bike"),
  {
    id: "austin-capmetro",
    city: "Austin, TX",
    provider: "CapMetro",
    informationUrl:
      "https://austin.publicbikesystem.net/customer/gbfs/v2/en/station_information.json",
    statusUrl: "https://austin.publicbikesystem.net/customer/gbfs/v2/en/station_status.json",
  },
  {
    id: "honolulu-biki",
    city: "Honolulu, HI",
    provider: "Biki",
    informationUrl: "https://hon.publicbikesystem.net/customer/gbfs/v2/en/station_information.json",
    statusUrl: "https://hon.publicbikesystem.net/customer/gbfs/v2/en/station_status.json",
  },
  {
    id: "chattanooga-bikechatt",
    city: "Chattanooga, TN",
    provider: "Bike Chattanooga",
    informationUrl:
      "https://chat.publicbikesystem.net/customer/gbfs/v2/en/station_information.json",
    statusUrl: "https://chat.publicbikesystem.net/customer/gbfs/v2/en/station_status.json",
  },
  bcycle("boulder-bcycle", "Boulder, CO", "bcycle_boulder"),
  bcycle("milwaukee-bublr", "Milwaukee, WI", "bcycle_bublr", "Bublr"),
  bcycle("madison-bcycle", "Madison, WI", "bcycle_madison"),
  bcycle("nashville-bcycle", "Nashville, TN", "bcycle_nashville"),
  bcycle("salt-lake-greenbike", "Salt Lake City, UT", "bcycle_greenbikeslc", "GREENbike"),
  bcycle("san-antonio-bcycle", "San Antonio, TX", "bcycle_sanantonio"),
  bcycle("cincinnati-red-bike", "Cincinnati, OH", "bcycle_cincyredbike", "Red Bike"),
  bcycle("el-paso-bcycle", "El Paso, TX", "bcycle_elpaso"),
  bcycle("indianapolis-pacers", "Indianapolis, IN", "bcycle_pacersbikeshare", "Pacers Bikeshare"),
  bcycle("memphis-bcycle", "Memphis, TN", "bcycle_memphis"),
  bcycle("des-moines-bcycle", "Des Moines, IA", "bcycle_desmoines"),
  bcycle("omaha-heartland", "Omaha, NE", "bcycle_heartland", "Heartland B-cycle"),
  bcycle("lincoln-bikelnk", "Lincoln, NE", "bcycle_bikelnk", "BikeLNK"),
  bcycle("greenville-sc-bcycle", "Greenville, SC", "bcycle_greenville"),
  bcycle("las-vegas-rtc-bike-share", "Las Vegas, NV", "bcycle_rtcbikeshare", "RTC Bike Share"),
  bcycle("santa-barbara-bcycle", "Santa Barbara, CA", "bcycle_santabarbara"),
];

function documentPacket(name: string): CzmlPacket {
  return { id: "document", name, version: "1.0" };
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function finite(value: unknown): number | null {
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function stations(value: unknown): Record<string, unknown>[] {
  const data = objectRecord(objectRecord(value).data);
  const list = Array.isArray(data.stations) ? data.stations : [];
  return list.map(objectRecord);
}

export function buildLaunchLibraryUrl(now = new Date()): string {
  const url = new URL(LAUNCH_LIBRARY_API_URL);
  url.searchParams.set("net__gte", new Date(now.getTime() - 30 * 86_400_000).toISOString());
  url.searchParams.set("net__lte", now.toISOString());
  url.searchParams.set("limit", "100");
  url.searchParams.set("mode", "detailed");
  return url.toString();
}

export function buildLaunchLibraryRequestUrls(now = new Date(), hostname?: string): string[] {
  const browserHostname =
    hostname ?? (typeof globalThis.location === "undefined" ? "" : globalThis.location.hostname);
  return [
    ...(browserHostname === "localhost" || browserHostname === "127.0.0.1"
      ? [LAUNCH_LIBRARY_DEV_URL]
      : []),
    LAUNCH_LIBRARY_EDGE_URL,
    buildLaunchLibraryUrl(now),
  ];
}

export function launchLibraryToCzml(value: unknown): GodsEyeViewFeedPayload {
  const results = Array.isArray(value) ? value : objectRecord(value).results;
  const packets: CzmlPacket[] = [documentPacket("Space Missions")];
  const features: Feature<Point>[] = [];
  for (const [index, raw] of (Array.isArray(results) ? results : []).entries()) {
    const launch = objectRecord(raw);
    const pad = objectRecord(launch.pad);
    const location = objectRecord(pad.location);
    const longitude = finite(pad.longitude);
    const latitude = finite(pad.latitude);
    if (longitude === null || latitude === null || longitude < -180 || longitude > 180) continue;
    if (latitude < -90 || latitude > 90) continue;
    const id = `space-mission-${text(launch.id) || text(launch.slug) || index}`;
    const name = text(launch.name) || `Space Mission ${index + 1}`;
    const status = text(objectRecord(launch.status).name);
    const provider = text(objectRecord(launch.launch_service_provider).name);
    const mission = objectRecord(launch.mission);
    const properties = {
      name,
      status,
      provider,
      launchTime: text(launch.net) || text(launch.window_start),
      launchSite: text(pad.name) || text(location.name),
      mission: text(mission.name),
      description: text(mission.description),
      source: "Launch Library 2",
    };
    packets.push({
      id,
      name,
      position: { cartographicDegrees: [longitude, latitude, 0] },
      properties,
      point: {
        pixelSize: 8,
        color: { rgba: [251, 146, 60, 240] },
        outlineColor: { rgba: [255, 255, 255, 210] },
        outlineWidth: 1,
      },
    });
    features.push({
      type: "Feature",
      id,
      geometry: { type: "Point", coordinates: [longitude, latitude] },
      properties,
    });
  }
  return { packets, attributes: { type: "FeatureCollection", features } };
}

export async function fetchSpaceMissionsCzml(
  options: { fetch?: typeof fetch; signal?: AbortSignal; now?: Date } = {},
): Promise<GodsEyeViewFeedPayload> {
  const request = options.fetch ?? fetch;
  let lastError: Error | null = null;
  for (const url of buildLaunchLibraryRequestUrls(options.now)) {
    try {
      const response = await request(url, { signal: options.signal });
      if (!response.ok) throw new Error(`Launch Library 2 failed (${response.status})`);
      return launchLibraryToCzml(await response.json());
    } catch (error) {
      if (options.signal?.aborted) throw error;
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }
  throw lastError ?? new Error("Launch Library 2 unavailable");
}

export function gbfsSystemToCzml(
  system: GbfsSystem,
  information: unknown,
  status: unknown,
): GodsEyeViewFeedPayload {
  const statusById = new Map(
    stations(status).map((station) => [text(station.station_id ?? station.id), station]),
  );
  const packets: CzmlPacket[] = [documentPacket("Bike Share")];
  const features: Feature<Point>[] = [];
  for (const station of stations(information)) {
    const stationId = text(station.station_id ?? station.id);
    const longitude = finite(station.lon ?? station.longitude);
    const latitude = finite(station.lat ?? station.latitude);
    if (!stationId || longitude === null || latitude === null) continue;
    if (longitude < -180 || longitude > 180 || latitude < -90 || latitude > 90) continue;
    const live = statusById.get(stationId) ?? {};
    const bikesAvailable = finite(live.num_bikes_available);
    const docksAvailable = finite(live.num_docks_available);
    const capacity = finite(station.capacity);
    const id = `bike-share-${system.id}-${stationId}`;
    const name = text(station.name) || `${system.provider} station`;
    const properties = {
      name,
      city: system.city,
      provider: system.provider,
      ...(bikesAvailable === null ? {} : { bikesAvailable }),
      ...(docksAvailable === null ? {} : { docksAvailable }),
      ...(capacity === null ? {} : { capacity }),
    };
    const availability =
      bikesAvailable !== null && capacity !== null && capacity > 0
        ? bikesAvailable / capacity
        : null;
    const color: [number, number, number, number] =
      availability === null
        ? [145, 164, 180, 220]
        : availability > 0.6
          ? [0, 255, 136, 240]
          : availability >= 0.3
            ? [255, 170, 0, 240]
            : [255, 68, 68, 240];
    packets.push({
      id,
      name,
      position: { cartographicDegrees: [longitude, latitude, 0] },
      properties,
      point: {
        pixelSize: 6,
        color: { rgba: color },
        outlineColor: { rgba: [0, 0, 0, 120] },
        outlineWidth: 1,
      },
    });
    features.push({
      type: "Feature",
      id,
      geometry: { type: "Point", coordinates: [longitude, latitude] },
      properties,
    });
  }
  return { packets, attributes: { type: "FeatureCollection", features } };
}

async function fetchGbfsSystem(
  system: GbfsSystem,
  request: typeof fetch,
  signal?: AbortSignal,
): Promise<GodsEyeViewFeedPayload> {
  const [information, status] = await Promise.all(
    [system.informationUrl, system.statusUrl].map(async (url) => {
      const response = await request(url, { signal });
      if (!response.ok) throw new Error(`${system.provider} GBFS failed (${response.status})`);
      return response.json();
    }),
  );
  return gbfsSystemToCzml(system, information, status);
}

export async function fetchBikeShareCzml(
  options: { fetch?: typeof fetch; signal?: AbortSignal } = {},
): Promise<GodsEyeViewFeedPayload> {
  const request = options.fetch ?? fetch;
  const queue = [...GBFS_SYSTEMS];
  const payloads: GodsEyeViewFeedPayload[] = [];
  const workers = Array.from({ length: 6 }, async () => {
    while (queue.length > 0) {
      const system = queue.shift();
      if (!system) return;
      try {
        payloads.push(await fetchGbfsSystem(system, request, options.signal));
      } catch (error) {
        if (options.signal?.aborted) throw error;
      }
    }
  });
  await Promise.all(workers);
  if (payloads.length === 0) throw new Error("No bike-share systems were available");
  return {
    packets: [
      documentPacket("Bike Share"),
      ...payloads.flatMap((payload) => payload.packets.slice(1)).slice(0, 8_000),
    ],
    attributes: {
      type: "FeatureCollection",
      features: payloads.flatMap((payload) => payload.attributes.features).slice(0, 8_000),
    },
  };
}
