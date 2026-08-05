// Copyright 2019-2023 Tauri Programme within The Commons Conservancy
// SPDX-License-Identifier: Apache-2.0
// SPDX-License-Identifier: MIT

import CoreLocation
import SwiftRs
import Tauri
import UIKit
import WebKit

class GetPositionArgs: Decodable {
  var enableHighAccuracy: Bool?
}

class WatchPositionArgs: Decodable {
  let options: GetPositionArgs
  let channel: Channel
}

class ClearWatchArgs: Decodable {
  let channelId: UInt32
}

class GeolocationPlugin: Plugin, CLLocationManagerDelegate {
  private let locationManager = CLLocationManager()
  private var isUpdatingLocation: Bool = false
  private var permissionRequests: [Invoke] = []
  private var positionRequests: [Invoke] = []
  private var watcherChannels: [Channel] = []

  override init() {
    super.init()
    locationManager.delegate = self
  }

  //
  // Tauri commands
  //

  @objc public func getCurrentPosition(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(GetPositionArgs.self)

    self.positionRequests.append(invoke)

    DispatchQueue.main.async {
      if args.enableHighAccuracy == true {
        self.locationManager.desiredAccuracy = kCLLocationAccuracyBest
      } else {
        self.locationManager.desiredAccuracy = kCLLocationAccuracyKilometer
      }

      // TODO: Use the authorizationStatus instance property with locationManagerDidChangeAuthorization(_:) instead.
      if CLLocationManager.authorizationStatus() == .notDetermined {
        self.locationManager.requestWhenInUseAuthorization()
      } else {
        self.locationManager.requestLocation()
      }
    }
  }

  @objc public func watchPosition(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(WatchPositionArgs.self)

    self.watcherChannels.append(args.channel)

    DispatchQueue.main.async {
      if args.options.enableHighAccuracy == true {
        self.locationManager.desiredAccuracy = kCLLocationAccuracyBest
      } else {
        self.locationManager.desiredAccuracy = kCLLocationAccuracyKilometer
      }

      // TODO: Use the authorizationStatus instance property with locationManagerDidChangeAuthorization(_:) instead.
      if CLLocationManager.authorizationStatus() == .notDetermined {
        self.locationManager.requestWhenInUseAuthorization()
      } else {
        self.locationManager.startUpdatingLocation()
        self.isUpdatingLocation = true
      }
    }

    invoke.resolve()
  }

  @objc public func clearWatch(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(ClearWatchArgs.self)

    self.watcherChannels = self.watcherChannels.filter { $0.id != args.channelId }

    // TODO: capacitor plugin calls stopUpdating unconditionally
    if self.watcherChannels.isEmpty {
      self.stopUpdating()
    }

    invoke.resolve()
  }

  @objc override public func checkPermissions(_ invoke: Invoke) {
    var status: String = ""

    if CLLocationManager.locationServicesEnabled() {
      // TODO: Use the authorizationStatus instance property with locationManagerDidChangeAuthorization(_:) instead.
      switch CLLocationManager.authorizationStatus() {
      case .notDetermined:
        status = "prompt"
      case .restricted, .denied:
        status = "denied"
      case .authorizedAlways, .authorizedWhenInUse:
        status = "granted"
      @unknown default:
        status = "prompt"
      }
    } else {
      invoke.reject("Location services are not enabled.")
      return
    }

    let result = ["location": status, "coarseLocation": status]

    invoke.resolve(result)
  }

  @objc override public func requestPermissions(_ invoke: Invoke) {
    if CLLocationManager.locationServicesEnabled() {
      // TODO: Use the authorizationStatus instance property with locationManagerDidChangeAuthorization(_:) instead.
      if CLLocationManager.authorizationStatus() == .notDetermined {
        self.permissionRequests.append(invoke)

        DispatchQueue.main.async {
          self.locationManager.requestWhenInUseAuthorization()
        }
      } else {
        checkPermissions(invoke)
      }
    } else {
      invoke.reject("Location services are not enabled.")
    }
  }

  //
  // Delegate methods
  //

  public func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
    Logger.error(error)

    let requests = self.positionRequests + self.permissionRequests
    self.positionRequests.removeAll()
    self.permissionRequests.removeAll()

    for request in requests {
      request.reject(error.localizedDescription)
    }

    for channel in self.watcherChannels {
      do {
        try channel.send(error.localizedDescription)
      } catch {
        Logger.error(error)
      }
    }
  }

  public func locationManager(
    _ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]
  ) {
    // Respond to all getCurrentPosition() calls.
    for request in self.positionRequests {
      // The capacitor plugin uses locations.first but .last should be the most current one
      // and i don't see a reason to use old locations
      if let location = locations.last {
        let result = convertLocation(location)
        request.resolve(result)
      } else {
        request.reject("Location service returned an empty Location array.")
      }
    }

    for channel in self.watcherChannels {
      // The capacitor plugin uses locations.first but .last should be the most recent one
      // and i don't see a reason to use old locations
      if let location = locations.last {
        let result = convertLocation(location)
        do {
          try channel.send(result)
        } catch {
          Logger.error(error)
        }
      } else {
        do {
          try channel.send("Location service returned an empty Location array.")
        } catch {
          Logger.error(error)
        }
      }
    }
  }

  public func locationManager(
    _ manager: CLLocationManager, didChangeAuthorization status: CLAuthorizationStatus
  ) {
    let requests = self.permissionRequests
    self.permissionRequests.removeAll()

    for request in requests {
      checkPermissions(request)
    }

    if !self.positionRequests.isEmpty {
      self.locationManager.requestLocation()
    }

    if !self.watcherChannels.isEmpty && !self.isUpdatingLocation {
      self.locationManager.startUpdatingLocation()
      self.isUpdatingLocation = true
    }
  }

  //
  // Internal/Helper methods
  //

  // TODO: Why is this pub in capacitor
  private func stopUpdating() {
    self.locationManager.stopUpdatingLocation()
    self.isUpdatingLocation = false
  }

  private func convertLocation(_ location: CLLocation) -> JsonObject {
    var ret: JsonObject = [:]
    var coords: JsonObject = [:]

    coords["latitude"] = location.coordinate.latitude
    coords["longitude"] = location.coordinate.longitude
    coords["accuracy"] = location.horizontalAccuracy
    coords["altitude"] = location.altitude
    coords["altitudeAccuracy"] = location.verticalAccuracy
    coords["speed"] = location.speed
    coords["heading"] = location.course
    ret["timestamp"] = Int((location.timestamp.timeIntervalSince1970 * 1000))
    ret["coords"] = coords

    return ret
  }
}

@_cdecl("init_plugin_geolocation")
func initPlugin() -> Plugin {
  return GeolocationPlugin()
}
