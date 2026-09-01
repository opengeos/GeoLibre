// Copyright 2019-2023 Tauri Programme within The Commons Conservancy
// SPDX-License-Identifier: Apache-2.0
// SPDX-License-Identifier: MIT

package app.tauri.geolocation

import android.annotation.SuppressLint
import android.content.Context
import android.location.Location
import android.location.LocationManager
import android.os.SystemClock
import androidx.core.content.ContextCompat
import androidx.core.location.GnssStatusCompat
import androidx.core.location.LocationManagerCompat
import app.tauri.Logger
import com.google.android.gms.common.ConnectionResult
import com.google.android.gms.common.GoogleApiAvailability
import com.google.android.gms.location.FusedLocationProviderClient
import com.google.android.gms.location.LocationCallback
import com.google.android.gms.location.LocationRequest
import com.google.android.gms.location.LocationResult
import com.google.android.gms.location.LocationServices
import com.google.android.gms.location.Priority


public class Geolocation(private val context: Context) {
    private companion object {
        const val SATELLITE_STALENESS_NANOS = 3_000_000_000L
    }

    private var fusedLocationClient: FusedLocationProviderClient? = null
    private var locationCallback: LocationCallback? = null
    private val locationManager =
        context.getSystemService(Context.LOCATION_SERVICE) as LocationManager
    private var gnssStatusCallback: GnssStatusCompat.Callback? = null
    private val satelliteListeners = mutableSetOf<(Int) -> Unit>()
    @Volatile var satellitesUsed: Int? = null
        private set
    @Volatile private var satellitesUpdatedAtNanos: Long? = null

    @SuppressLint("MissingPermission")
    fun startGnssStatusUpdates() {
        if (gnssStatusCallback != null) return
        val callback =
            object : GnssStatusCompat.Callback() {
                override fun onSatelliteStatusChanged(status: GnssStatusCompat) {
                    var used = 0
                    for (index in 0 until status.satelliteCount) {
                        if (status.usedInFix(index)) used += 1
                    }
                    satellitesUsed = used
                    satellitesUpdatedAtNanos = SystemClock.elapsedRealtimeNanos()
                    val listeners = satelliteListeners.toList()
                    satelliteListeners.clear()
                    listeners.forEach { it(used) }
                }

                override fun onStopped() {
                    satellitesUsed = null
                    satellitesUpdatedAtNanos = null
                }
            }
        try {
            if (
                LocationManagerCompat.registerGnssStatusCallback(
                    locationManager,
                    ContextCompat.getMainExecutor(context),
                    callback,
                )
            ) {
                gnssStatusCallback = callback
            }
        } catch (_: SecurityException) {
            satellitesUsed = null
            satellitesUpdatedAtNanos = null
        }
    }

    /**
     * Return GNSS metadata only when it was observed close to this location.
     * Fused fixes may come from Wi-Fi/cell positioning, while the GNSS status
     * callback is global and otherwise leaves a stale count attached indoors.
     */
    fun satellitesUsedFor(location: Location): Int? {
        val updatedAt = satellitesUpdatedAtNanos ?: return null
        val ageNanos = kotlin.math.abs(location.elapsedRealtimeNanos - updatedAt)
        return satellitesUsed?.takeIf { ageNanos <= SATELLITE_STALENESS_NANOS }
    }

    /** True when a future GNSS callback could still match this location fix. */
    fun canWaitForSatellites(location: Location): Boolean {
        val locationAgeNanos = SystemClock.elapsedRealtimeNanos() - location.elapsedRealtimeNanos
        return locationAgeNanos in 0..SATELLITE_STALENESS_NANOS
    }

    /**
     * Run once when a GNSS status update supplies a satellite count. The
     * returned callback unregisters the listener when a caller times out.
     */
    fun onSatellitesUsedAvailable(callback: (Int) -> Unit): () -> Unit {
        val updatedAt = satellitesUpdatedAtNanos
        if (
            updatedAt != null &&
            SystemClock.elapsedRealtimeNanos() - updatedAt <= SATELLITE_STALENESS_NANOS
        ) {
            satellitesUsed?.let {
                callback(it)
                return {}
            }
        }
        satelliteListeners.add(callback)
        return { satelliteListeners.remove(callback) }
    }


    fun isLocationServicesEnabled(): Boolean {
        val lm = context.getSystemService(Context.LOCATION_SERVICE) as LocationManager
        return LocationManagerCompat.isLocationEnabled(lm)
    }

    @SuppressWarnings("MissingPermission")
    fun sendLocation(enableHighAccuracy: Boolean, successCallback: (location: Location) -> Unit, errorCallback: (error: String) -> Unit) {
        startGnssStatusUpdates()
        val resultCode = GoogleApiAvailability.getInstance().isGooglePlayServicesAvailable(context);
        if (resultCode == ConnectionResult.SUCCESS) {
            val lm = context.getSystemService(Context.LOCATION_SERVICE) as LocationManager

            if (this.isLocationServicesEnabled()) {
                var networkEnabled = false

                try {
                    networkEnabled = lm.isProviderEnabled(LocationManager.NETWORK_PROVIDER)
                } catch (_: Exception) {
                    Logger.error("isProviderEnabled failed")
                }

                val lowPrio = if (networkEnabled) Priority.PRIORITY_BALANCED_POWER_ACCURACY else Priority.PRIORITY_LOW_POWER
                val prio = if (enableHighAccuracy) Priority.PRIORITY_HIGH_ACCURACY else lowPrio

                Logger.error(prio.toString())

                LocationServices
                    .getFusedLocationProviderClient(context)
                    .getCurrentLocation(prio, null)
                    .addOnFailureListener { e -> e.message?.let { errorCallback(it) } }
                    .addOnSuccessListener { location ->
                        if (location == null) {
                            errorCallback("Location unavailable.")
                        } else {
                            successCallback(location)
                        }
                    }
            } else {
                errorCallback("Location disabled.")
            }
        } else {
            errorCallback("Google Play Services unavailable.")
        }
    }

    @SuppressLint("MissingPermission")
    fun requestLocationUpdates(enableHighAccuracy: Boolean, timeout: Long, successCallback: (location: Location) -> Unit, errorCallback: (error: String) -> Unit) {
        val resultCode = GoogleApiAvailability.getInstance().isGooglePlayServicesAvailable(context);
        if (resultCode == ConnectionResult.SUCCESS) {
            clearLocationUpdates()
            startGnssStatusUpdates()
            fusedLocationClient = LocationServices.getFusedLocationProviderClient(context)

            val lm = context.getSystemService(Context.LOCATION_SERVICE) as LocationManager

            if (this.isLocationServicesEnabled()) {
                var networkEnabled = false

                try {
                    networkEnabled = lm.isProviderEnabled(LocationManager.NETWORK_PROVIDER)
                } catch (_: Exception) {
                    Logger.error("isProviderEnabled failed")
                }

                val lowPrio = if (networkEnabled) Priority.PRIORITY_BALANCED_POWER_ACCURACY else Priority.PRIORITY_LOW_POWER
                val prio = if (enableHighAccuracy) Priority.PRIORITY_HIGH_ACCURACY else lowPrio

                val locationRequest = LocationRequest.Builder(timeout)
                    .setMaxUpdateDelayMillis(timeout)
                    .setMinUpdateIntervalMillis(timeout)
                    .setPriority(prio)
                    .build()

                locationCallback =
                    object : LocationCallback() {
                        override fun onLocationResult(locationResult: LocationResult) {
                            val lastLocation = locationResult.lastLocation
                            if (lastLocation == null) {
                                errorCallback("Location unavailable.")
                            } else {
                                successCallback(lastLocation)
                            }
                        }
                    }

                fusedLocationClient?.requestLocationUpdates(locationRequest, locationCallback!!, null)
            } else {
                errorCallback("Location disabled.")
            }
        } else {
            errorCallback("Google Play Services not available.")
        }
    }

    fun clearLocationUpdates() {
        if (locationCallback != null) {
            fusedLocationClient?.removeLocationUpdates(locationCallback!!)
            locationCallback = null
        }
        stopGnssStatusUpdates()
    }

    fun stopGnssStatusUpdates() {
        gnssStatusCallback?.let {
            LocationManagerCompat.unregisterGnssStatusCallback(locationManager, it)
        }
        gnssStatusCallback = null
        satellitesUsed = null
        satellitesUpdatedAtNanos = null
    }

    @SuppressLint("MissingPermission")
    fun getLastLocation(maximumAge: Long): Location? {
        var lastLoc: Location? = null
        val lm = context.getSystemService(Context.LOCATION_SERVICE) as LocationManager

        for (provider in lm.allProviders) {
            val tmpLoc = lm.getLastKnownLocation(provider)
            if (tmpLoc != null) {
                val locationAge = SystemClock.elapsedRealtimeNanos() - tmpLoc.elapsedRealtimeNanos
                val maxAgeNano = maximumAge * 1000000L
                if (locationAge <= maxAgeNano && (lastLoc == null || lastLoc.elapsedRealtimeNanos > tmpLoc.elapsedRealtimeNanos)) {
                    lastLoc = tmpLoc
                }
            }
        }

        return lastLoc
    }
}
