import type { SunSettings } from "./plugins/maplibre-sun";
import type { RouteAnimationSettings } from "./plugins/maplibre-route-animation";
import type { FlightSimulatorSettings } from "./plugins/flight-simulator";
import type { FlightModelConfig } from "./plugins/flight-simulator-physics";

// Defaults are available without evaluating implementation modules.
// The sun clock uses a fixed date to keep project files deterministic.
export const DEFAULT_FLIGHT_MODEL: FlightModelConfig = {
  minSpeedMps: 30,
  maxSpeedMps: 250,
  accelerationMps2: 25,
  pitchRateDegPerSec: 35,
  rollRateDegPerSec: 60,
  maxPitchDeg: 45,
  maxRollDeg: 70,
  levelingRateDegPerSec: 40,
  minAltitudeAglMeters: 25,
};

export const DEFAULT_SUN_SETTINGS: SunSettings = {
  dateMs: Date.UTC(2024, 5, 21, 12, 0, 0), // June solstice, noon UTC
  playing: false,
  speed: 60,
  loop: true,
  shadeOpacity: 0.55,
};

export const DEFAULT_ROUTE_ANIMATION_SETTINGS: RouteAnimationSettings = {
  layerId: null,
  playing: false,
  speedMps: 60,
  loop: true,
  progress: 0,
  followCamera: false,
  followPitch: 60,
  followZoom: 15,
  followRotate: true,
  markerStyle: "arrow",
  showTrail: true,
  color: "#2563eb",
};

export const DEFAULT_FLIGHT_SIMULATOR_SETTINGS: FlightSimulatorSettings = {
  maxSpeedMps: DEFAULT_FLIGHT_MODEL.maxSpeedMps,
  minAltitudeAglMeters: DEFAULT_FLIGHT_MODEL.minAltitudeAglMeters,
  bankCamera: true,
  invertPitch: false,
  units: "imperial",
};
