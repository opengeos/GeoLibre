import type { StoryMap } from "./types";

const SAMPLE_ASSET_BASE = "https://opengeos.org/maplibre-gl-storymaps/assets";

/**
 * Build a ready-to-play sample story map.
 *
 * Mirrors the chapters of the `opengeos/maplibre-gl-storymaps` demo (five world
 * cities) so users can explore the feature instantly without authoring content.
 * A fresh object is returned on each call so callers can mutate it freely.
 *
 * @returns A populated {@link StoryMap} with five sample chapters.
 */
export function createSampleStoryMap(): StoryMap {
  return {
    title: "A Tour of Five Cities",
    subtitle: "A scrollytelling map experience built with GeoLibre",
    byline: "By GeoLibre",
    footer:
      'Source: Wikipedia. Built with <a href="https://github.com/opengeos/GeoLibre" target="_blank">GeoLibre</a>, inspired by <a href="https://github.com/opengeos/maplibre-gl-storymaps" target="_blank">MapLibre Storytelling</a>.',
    theme: "dark",
    showMarkers: true,
    markerColor: "#3fb1ce",
    inset: true,
    insetPosition: "bottom-left",
    chapters: [
      {
        id: "sample-san-francisco",
        title: "San Francisco, California",
        image: `${SAMPLE_ASSET_BASE}/san-francisco.jpg`,
        description:
          "San Francisco, a hilly city on the tip of a peninsula surrounded by the Pacific Ocean and San Francisco Bay, is known for its year-round fog, iconic Golden Gate Bridge, cable cars and colorful Victorian houses. <br><br>The city is also known for its vibrant tech industry, diverse neighborhoods, and rich cultural scene.",
        alignment: "left",
        hidden: false,
        location: {
          center: [-122.4194, 37.7749],
          zoom: 11,
          pitch: 45,
          bearing: 0,
        },
        mapAnimation: "flyTo",
        rotateAnimation: false,
        onChapterEnter: [],
        onChapterExit: [],
      },
      {
        id: "sample-new-york",
        title: "New York City, New York",
        image: `${SAMPLE_ASSET_BASE}/new-york.jpg`,
        description:
          "New York City comprises 5 boroughs sitting where the Hudson River meets the Atlantic Ocean. At its core is Manhattan, a densely populated borough that's among the world's major commercial, financial and cultural centers. <br><br>Its iconic sites include skyscrapers such as the Empire State Building and sprawling Central Park.",
        alignment: "right",
        hidden: false,
        location: {
          center: [-74.006, 40.7128],
          zoom: 11,
          pitch: 60,
          bearing: -43.2,
        },
        mapAnimation: "flyTo",
        rotateAnimation: true,
        onChapterEnter: [],
        onChapterExit: [],
      },
      {
        id: "sample-tokyo",
        title: "Tokyo, Japan",
        image: `${SAMPLE_ASSET_BASE}/tokyo.jpg`,
        description:
          "Tokyo, Japan's busy capital, mixes the ultramodern and the traditional, from neon-lit skyscrapers to historic temples. The opulent Meiji Shinto Shrine is known for its towering gate and surrounding woods. <br><br>The Imperial Palace sits amid large public gardens. The city's many museums offer exhibits ranging from classical art to a reconstructed kabuki theater.",
        alignment: "left",
        hidden: false,
        location: {
          center: [139.6917, 35.6895],
          zoom: 10,
          pitch: 30,
          bearing: 20,
        },
        mapAnimation: "flyTo",
        rotateAnimation: false,
        onChapterEnter: [],
        onChapterExit: [],
      },
      {
        id: "sample-sydney",
        title: "Sydney, Australia",
        image: `${SAMPLE_ASSET_BASE}/sydney.jpg`,
        description:
          "Sydney, capital of New South Wales and one of Australia's largest cities, is best known for its harbourfront Sydney Opera House, with a distinctive sail-like design. <br><br>Massive Darling Harbour and the smaller Circular Quay port are hubs of waterside life, with the arched Harbour Bridge and esteemed Royal Botanic Garden nearby.",
        alignment: "center",
        hidden: false,
        location: {
          center: [151.2093, -33.8688],
          zoom: 11,
          pitch: 45,
          bearing: 0,
        },
        mapAnimation: "flyTo",
        rotateAnimation: false,
        onChapterEnter: [],
        onChapterExit: [],
      },
      {
        id: "sample-cape-town",
        title: "Cape Town, South Africa",
        image: `${SAMPLE_ASSET_BASE}/cape-town.jpg`,
        description:
          "Cape Town is a port city on South Africa's southwest coast, on a peninsula beneath the imposing Table Mountain. Slowly rotating cable cars climb to the mountain's flat top, from which there are sweeping views of the city, the busy harbor and boats headed for Robben Island, the infamous prison that once held Nelson Mandela. <br><br>You can add as many chapters as you need to tell your story.",
        alignment: "full",
        hidden: false,
        location: {
          center: [18.4241, -33.9249],
          zoom: 10,
          pitch: 50,
          bearing: 30,
        },
        mapAnimation: "flyTo",
        rotateAnimation: false,
        onChapterEnter: [],
        onChapterExit: [],
      },
    ],
  };
}
