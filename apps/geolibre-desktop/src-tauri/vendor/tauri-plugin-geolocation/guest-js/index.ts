// Copyright 2019-2023 Tauri Programme within The Commons Conservancy
// SPDX-License-Identifier: Apache-2.0
// SPDX-License-Identifier: MIT

import {
  Channel,
  invoke,
  PermissionState,
  checkPermissions as checkPluginPermissions
} from '@tauri-apps/api/core'

export type Coordinates = {
  /**
   * Latitude in decimal degrees.
   */
  latitude: number
  /**
   * Longitude in decimal degrees.
   */
  longitude: number
  /**
   * Accuracy level of the latitude and longitude coordinates in meters.
   */
  accuracy: number
  /**
   * Accuracy level of the altitude coordinate in meters, if available.
   * Available on all iOS versions and on Android 8 and above.
   */
  altitudeAccuracy: number | null
  /**
   * The altitude the user is at, if available.
   */
  altitude: number | null
  speed: number | null
  /**
   * The heading the user is facing, if available.
   */
  heading: number | null
}

export type PermissionStatus = {
  /**
   * Permission state for the location alias.
   *
   * On Android it requests/checks both ACCESS_COARSE_LOCATION and ACCESS_FINE_LOCATION permissions.
   *
   * On iOS it requests/checks location permissions.
   */
  location: PermissionState
  /**
   * Permissions state for the coarseLoaction alias.
   *
   * On Android it requests/checks ACCESS_COARSE_LOCATION.
   *
   * On Android 12+, users can choose between Approximate location (ACCESS_COARSE_LOCATION) and Precise location (ACCESS_FINE_LOCATION).
   *
   * On iOS it will have the same value as the `location` alias.
   */
  coarseLocation: PermissionState
}

export type PermissionType = 'location' | 'coarseLocation'

export type Position = {
  /**
   * Creation time for these coordinates.
   */
  timestamp: number
  /**
   * The GPD coordinates along with the accuracy of the data.
   */
  coords: Coordinates
}

export type PositionOptions = {
  /**
   * High accuracy mode (such as GPS, if available)
   * Will be ignored on Android 12+ if users didn't grant the ACCESS_FINE_LOCATION permission (`coarseLocation` permission).
   */
  enableHighAccuracy: boolean
  /**
   * The maximum wait time in milliseconds for location updates.
   * On Android the timeout gets ignored for getCurrentPosition.
   * Ignored on iOS
   */
  timeout: number
  /**
   * The maximum age in milliseconds of a possible cached position that is acceptable to return.
   * Default: 0
   * Ignored on iOS
   */
  maximumAge: number
}

export async function watchPosition(
  options: PositionOptions,
  cb: (location: Position | null, error?: string) => void
): Promise<number> {
  const channel = new Channel<Position | string>()
  channel.onmessage = (message) => {
    if (typeof message === 'string') {
      cb(null, message)
    } else {
      cb(message)
    }
  }
  await invoke('plugin:geolocation|watch_position', {
    options,
    channel
  })
  return channel.id
}

export async function getCurrentPosition(
  options?: PositionOptions
): Promise<Position> {
  return await invoke('plugin:geolocation|get_current_position', {
    options
  })
}

export async function clearWatch(channelId: number): Promise<void> {
  await invoke('plugin:geolocation|clear_watch', {
    channelId
  })
}

export async function checkPermissions(): Promise<PermissionStatus> {
  return await checkPluginPermissions('geolocation')
}

export async function requestPermissions(
  permissions: PermissionType[] | null
): Promise<PermissionStatus> {
  return await invoke('plugin:geolocation|request_permissions', {
    permissions
  })
}
