// Native Bluetooth GNSS receiver transport for the GeoLibre Android app
// (GeoLibre#3397). The Android WebView has neither Web Serial nor Web
// Bluetooth, so this plugin opens a Serial Port Profile (RFCOMM) socket to a
// receiver paired in Android settings and streams its bytes to the webview,
// where src/lib/nmea-source.ts parses them like any other NMEA transport.

package org.geolibre.gnssbluetooth

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothSocket
import android.content.Context
import android.os.Build
import androidx.appcompat.app.AppCompatActivity
import app.tauri.Logger
import app.tauri.PermissionState
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.Permission
import app.tauri.annotation.PermissionCallback
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Channel
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSArray
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.IOException
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger

/** The well-known Serial Port Profile service UUID every SPP GNSS receiver exposes. */
private val SPP_UUID: UUID = UUID.fromString("00001101-0000-1000-8000-00805F9B34FB")

private const val ALIAS_BLUETOOTH = "bluetooth"

/** Bytes per socket read; NMEA at 10 Hz is well under this per read. */
private const val READ_BUFFER_BYTES = 4096

@InvokeArg
class ConnectArgs {
  lateinit var address: String
  lateinit var channel: Channel
}

@InvokeArg
class DisconnectArgs {
  var id: Int = 0
}

/** One open receiver: its socket and the thread pumping it into a channel. */
private class Connection(val socket: BluetoothSocket, val channel: Channel) {
  @Volatile var closed = false

  fun close() {
    closed = true
    try {
      socket.close()
    } catch (_: IOException) {
      // Already closed by the remote end; nothing left to release.
    }
  }
}

@TauriPlugin(
  permissions = [
    // Only a runtime permission on Android 12+. On older releases the manifest's
    // install-time BLUETOOTH permission covers sockets and this alias is skipped
    // (see needsRuntimePermission), because asking for a permission the OS does
    // not know reports it as denied.
    Permission(strings = [Manifest.permission.BLUETOOTH_CONNECT], alias = ALIAS_BLUETOOTH),
  ],
)
class GnssBluetoothPlugin(private val activity: Activity) : Plugin(activity) {
  private val connections = ConcurrentHashMap<Int, Connection>()
  private val nextId = AtomicInteger(1)

  private fun adapter(): BluetoothAdapter? {
    val manager = activity.getSystemService(Context.BLUETOOTH_SERVICE) as BluetoothManager?
    return manager?.adapter
  }

  private fun needsRuntimePermission(): Boolean =
    Build.VERSION.SDK_INT >= Build.VERSION_CODES.S &&
      getPermissionState(ALIAS_BLUETOOTH) != PermissionState.GRANTED

  /**
   * Run [action] once Bluetooth is usable: the permission is granted (asking
   * for it if needed) and the adapter exists and is switched on. Rejects with a
   * code the frontend maps to a localized message otherwise.
   */
  private fun withBluetooth(invoke: Invoke, callbackName: String, action: (BluetoothAdapter) -> Unit) {
    if (needsRuntimePermission()) {
      requestPermissionForAlias(ALIAS_BLUETOOTH, invoke, callbackName)
      return
    }
    val adapter = adapter()
    if (adapter == null) {
      invoke.reject("This device has no Bluetooth adapter.", "UNAVAILABLE")
      return
    }
    if (!adapter.isEnabled) {
      invoke.reject("Bluetooth is turned off.", "DISABLED")
      return
    }
    action(adapter)
  }

  private fun permissionGranted(invoke: Invoke): Boolean {
    if (getPermissionState(ALIAS_BLUETOOTH) == PermissionState.GRANTED) return true
    invoke.reject("Bluetooth permission was denied.", "PERMISSION_DENIED")
    return false
  }

  /** Paired devices, so the user can pick their receiver from a list. */
  @Command
  fun listDevices(invoke: Invoke) {
    withBluetooth(invoke, "listDevicesPermissionCallback") { adapter -> resolveDevices(invoke, adapter) }
  }

  @PermissionCallback
  private fun listDevicesPermissionCallback(invoke: Invoke) {
    if (permissionGranted(invoke)) listDevices(invoke)
  }

  @SuppressLint("MissingPermission") // Checked by withBluetooth.
  private fun resolveDevices(invoke: Invoke, adapter: BluetoothAdapter) {
    val devices = JSArray()
    for (device in adapter.bondedDevices.orEmpty()) {
      val entry = JSObject()
      entry.put("address", device.address)
      entry.put("name", device.name ?: device.address)
      entry.put(
        "type",
        when (device.type) {
          BluetoothDevice.DEVICE_TYPE_CLASSIC -> "classic"
          BluetoothDevice.DEVICE_TYPE_LE -> "le"
          BluetoothDevice.DEVICE_TYPE_DUAL -> "dual"
          else -> "unknown"
        },
      )
      devices.put(entry)
    }
    val result = JSObject()
    result.put("devices", devices)
    invoke.resolve(result)
  }

  /**
   * Open an SPP socket to a paired receiver and stream its bytes to the
   * channel. Resolves with the connection id once the socket is open; the
   * connect itself blocks for seconds, so it runs off the main thread.
   */
  @Command
  fun connect(invoke: Invoke) {
    withBluetooth(invoke, "connectPermissionCallback") { adapter ->
      val args = invoke.parseArgs(ConnectArgs::class.java)
      Thread({ openAndPump(invoke, adapter, args) }, "gnss-bluetooth-connect").start()
    }
  }

  @PermissionCallback
  private fun connectPermissionCallback(invoke: Invoke) {
    if (permissionGranted(invoke)) connect(invoke)
  }

  @SuppressLint("MissingPermission") // Checked by withBluetooth.
  private fun openAndPump(invoke: Invoke, adapter: BluetoothAdapter, args: ConnectArgs) {
    val device = try {
      adapter.getRemoteDevice(args.address)
    } catch (e: IllegalArgumentException) {
      invoke.reject("Invalid Bluetooth address: ${args.address}", "FAILED")
      return
    }
    val socket = openSocket(device)
    if (socket == null) {
      invoke.reject(
        "Could not connect to ${device.name ?: args.address}. Make sure the receiver is on, in range, and not connected to another app.",
        "CONNECT_FAILED",
      )
      return
    }

    val id = nextId.getAndIncrement()
    val connection = Connection(socket, args.channel)
    connections[id] = connection
    val result = JSObject()
    result.put("id", id)
    result.put("name", device.name ?: args.address)
    invoke.resolve(result)
    pump(id, connection)
  }

  /**
   * Try the standard secure SPP socket, then an insecure one, then the raw
   * channel-1 RFCOMM socket. Many GNSS receivers answer only one of these
   * (some cheap modules publish no SDP record at all, which only the last
   * reaches), so stopping at the first failure would strand them.
   */
  @SuppressLint("MissingPermission")
  private fun openSocket(device: BluetoothDevice): BluetoothSocket? {
    val attempts: List<() -> BluetoothSocket> = listOf(
      { device.createRfcommSocketToServiceRecord(SPP_UUID) },
      { device.createInsecureRfcommSocketToServiceRecord(SPP_UUID) },
      {
        device.javaClass
          .getMethod("createRfcommSocket", Int::class.javaPrimitiveType)
          .invoke(device, 1) as BluetoothSocket
      },
    )
    for (attempt in attempts) {
      var socket: BluetoothSocket? = null
      try {
        socket = attempt()
        socket.connect()
        return socket
      } catch (e: Exception) {
        Logger.debug("GnssBluetooth", "SPP connect attempt failed: ${e.message}")
        try {
          socket?.close()
        } catch (_: IOException) {
        }
      }
    }
    return null
  }

  /** Read until the socket closes, forwarding each chunk as a `data` event. */
  private fun pump(id: Int, connection: Connection) {
    val buffer = ByteArray(READ_BUFFER_BYTES)
    var failure: String? = null
    try {
      val input = connection.socket.inputStream
      while (!connection.closed) {
        val n = input.read(buffer)
        if (n < 0) break
        if (n == 0) continue
        val event = JSObject()
        event.put("event", "data")
        // ISO-8859-1 maps every byte to one char, so a binary RTCM/UBX frame
        // mixed into the stream cannot throw or merge with the NMEA around
        // it; the NMEA checksum rejects whatever is not a valid sentence.
        event.put("data", String(buffer, 0, n, Charsets.ISO_8859_1))
        connection.channel.send(event)
      }
    } catch (e: IOException) {
      failure = e.message
    } finally {
      connections.remove(id)
      val wasClosedByUser = connection.closed
      connection.close()
      if (!wasClosedByUser) {
        val event = JSObject()
        event.put("event", "closed")
        if (failure != null) event.put("error", failure)
        connection.channel.send(event)
      }
    }
  }

  @Command
  fun disconnect(invoke: Invoke) {
    val args = invoke.parseArgs(DisconnectArgs::class.java)
    connections.remove(args.id)?.close()
    invoke.resolve()
  }

  override fun onDestroy(activity: AppCompatActivity) {
    super.onDestroy(activity)
    for (connection in connections.values) connection.close()
    connections.clear()
  }
}
