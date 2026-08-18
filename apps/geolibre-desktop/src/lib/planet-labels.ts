import type { ParseKeys } from "i18next";
import type { EllipsoidId } from "@geolibre/core";

/**
 * Translation keys for the celestial-body names, keyed by ellipsoid id.
 *
 * Shared rather than local to the planet switcher because the Measure panel's
 * non-Earth note names the same body (issue #1128), and the two must agree —
 * a user who picked "Mars" in the switcher should not read a different name in
 * the measurement note. These are the plain names ("Mars"), not the ellipsoid
 * records' datum-qualified ones ("Mars (IAU 2000)").
 */
export const PLANET_SWITCHER_LABEL_KEYS: Record<EllipsoidId, ParseKeys> = {
  earth: "planetSwitcher.earth",
  mercury: "planetSwitcher.mercury",
  venus: "planetSwitcher.venus",
  moon: "planetSwitcher.moon",
  mars: "planetSwitcher.mars",
  io: "planetSwitcher.io",
  europa: "planetSwitcher.europa",
  ganymede: "planetSwitcher.ganymede",
  callisto: "planetSwitcher.callisto",
  titan: "planetSwitcher.titan",
  pluto: "planetSwitcher.pluto",
  charon: "planetSwitcher.charon",
};
