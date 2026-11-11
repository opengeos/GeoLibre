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
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger

/** The well-known Serial Port Profile service UUID every SPP GNSS receiver exposes. */
private val SPP_UUID: UUID = UUID.fromString("00001101-0000-1000-8000-00805F9B34FB")

private const val ALIAS_BLUETOOTH = "bluetooth"

/**
 * Bound on one socket connect attempt. BluetoothSocket.connect() has no
 * timeout of its own, so an out-of-range receiver would otherwise hold each of
 * the three fallback attempts for the OS's own (much longer) timeout.
 */
private const val CONNECT_TIMEOUT_MS = 10_000L

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

@InvokeArg
class StartCorrectionsArgs {
  var id: Int = 0
  lateinit var host: String
  var port: Int = 2101
  var mountpoint: String = ""
  var username: String = ""
  var password: String = ""
  var tls: Boolean = false
  var ggaIntervalSec: Int = 10
}

/** One open receiver: its socket and the thread pumping it into a channel. */
private class Connection(val socket: BluetoothSocket, val channel: Channel) {
  @Volatile var closed = false
  /** The receiver's latest fixed GGA, which an NTRIP caster may ask for. */
  val gga = GgaTracker()
  /** The NTRIP session feeding this receiver corrections, if one is running. */
  @Volatile var ntrip: NtripClient? = null

  /** Write correction bytes to the receiver. */
  fun write(bytes: ByteArray, count: Int) {
    val out = socket.outputStream
    synchronized(this) {
      out.write(bytes, 0, count)
      out.flush()
    }
  }

  fun stopCorrections() {
    ntrip?.stop()
    ntrip = null
  }

  fun close() {
    closed = true
    stopCorrections()
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
  /** Closes a socket whose connect() outlives CONNECT_TIMEOUT_MS, which makes it throw. */
  private val connectWatchdog = Executors.newSingleThreadScheduledExecutor()
  /** One connect at a time: each holds a thread and a socket for seconds. */
  private val connecting = AtomicBoolean(false)
  /** Sockets mid-connect, which onDestroy must close as well as open ones. */
  private val pendingSockets = ConcurrentHashMap.newKeySet<BluetoothSocket>()
  @Volatile private var destroyed = false

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
      if (!connecting.compareAndSet(false, true)) {
        invoke.reject("Another receiver is already connecting.", "BUSY")
        return@withBluetooth
      }
      Thread({ openAndPump(invoke, adapter, args) }, "gnss-bluetooth-connect").start()
    }
  }

  @PermissionCallback
  private fun connectPermissionCallback(invoke: Invoke) {
    if (permissionGranted(invoke)) connect(invoke)
  }

  @SuppressLint("MissingPermission") // Checked by withBluetooth.
  private fun openAndPump(invoke: Invoke, adapter: BluetoothAdapter, args: ConnectArgs) {
    val connection: Connection
    val id: Int
    try {
      // Only devices the user paired in Android settings: the command is
      // reachable from any webview code, and an arbitrary address would let it
      // probe nearby devices or raise a pairing prompt the user never asked for.
      val device = adapter.bondedDevices.orEmpty().firstOrNull {
        it.address.equals(args.address, ignoreCase = true)
      }
      if (device == null) {
        invoke.reject("${args.address} is not paired. Pair it in Android's Bluetooth settings first.", "FAILED")
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
      if (destroyed) {
        try {
          socket.close()
        } catch (_: IOException) {
        }
        invoke.reject("The app is closing.", "FAILED")
        return
      }
      id = nextId.getAndIncrement()
      connection = Connection(socket, args.channel)
      connections[id] = connection
      val result = JSObject()
      result.put("id", id)
      result.put("name", device.name ?: args.address)
      invoke.resolve(result)
    } finally {
      connecting.set(false)
    }
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
        if (destroyed) return null
        val candidate = attempt()
        socket = candidate
        pendingSockets.add(candidate)
        val timeout = connectWatchdog.schedule(
          {
            try {
              candidate.close()
            } catch (_: IOException) {
            }
          },
          CONNECT_TIMEOUT_MS,
          TimeUnit.MILLISECONDS,
        )
        try {
          candidate.connect()
        } finally {
          pendingSockets.remove(candidate)
        }
        // cancel() is false when the watchdog already ran: it closed this
        // socket just as connect() returned, so the attempt did not succeed.
        if (!timeout.cancel(false)) throw IOException("Connect timed out after $CONNECT_TIMEOUT_MS ms.")
        return candidate
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
        connection.gga.feed(buffer, n)
        val event = JSObject()
        event.put("event", "data")
        // ISO-8859-1 maps every byte to one char, so a binary RTCM/UBX frame
        // mixed into the stream cannot throw or merge with the NMEA around
        // it; the NMEA checksum rejects whatever is not a valid sentence.
        event.put("data", String(buffer, 0, n, Charsets.ISO_8859_1))
        connection.channel.send(event)
      }
    } catch (e: Exception) {
      // Not just IOException: anything escaping this background thread would
      // crash the app, and one failed socket should only end its own session.
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

  /**
   * Start an NTRIP session that writes RTCM corrections to an open receiver
   * (GeoLibre#3400). Status goes to the receiver's own channel as `ntrip`
   * events; a running session for the same receiver is replaced.
   */
  @Command
  fun startCorrections(invoke: Invoke) {
    val args = invoke.parseArgs(StartCorrectionsArgs::class.java)
    val connection = connections[args.id]
    if (connection == null) {
      invoke.reject("The receiver is not connected.", "NOT_CONNECTED")
      return
    }
    val host = args.host.trim()
    if (host.isEmpty() || args.port !in 1..65535) {
      invoke.reject("Enter a caster host and a port between 1 and 65535.", "FAILED")
      return
    }
    connection.stopCorrections()
    val config = NtripConfig(
      host = host,
      port = args.port,
      mountpoint = args.mountpoint.trim().trimStart('/'),
      username = args.username,
      password = args.password,
      tls = args.tls,
      ggaIntervalSec = args.ggaIntervalSec,
    )
    lateinit var client: NtripClient
    client = NtripClient(
      config,
      sink = { bytes, count -> connection.write(bytes, count) },
      gga = connection.gga,
      onStatus = { status ->
        // A replaced or stopped session must not report over its successor;
        // the webview already knows about a stop it asked for.
        if (connection.ntrip === client) {
          val event = JSObject()
          event.put("event", "ntrip")
          event.put("state", status.state)
          event.put("bytes", status.bytes)
          if (status.message != null) event.put("message", status.message)
          if (status.code != null) event.put("code", status.code)
          connection.channel.send(event)
        }
      },
    )
    connection.ntrip = client
    client.start()
    invoke.resolve()
  }

  @Command
  fun stopCorrections(invoke: Invoke) {
    val args = invoke.parseArgs(DisconnectArgs::class.java)
    connections[args.id]?.stopCorrections()
    invoke.resolve()
  }

  @Command
  fun disconnect(invoke: Invoke) {
    val args = invoke.parseArgs(DisconnectArgs::class.java)
    connections.remove(args.id)?.close()
    invoke.resolve()
  }

  override fun onDestroy(activity: AppCompatActivity) {
    super.onDestroy(activity)
    destroyed = true
    // shutdownNow drops queued watchdog tasks, so close in-flight sockets here;
    // their connect() then throws and openAndPump publishes nothing.
    for (socket in pendingSockets) {
      try {
        socket.close()
      } catch (_: IOException) {
      }
    }
    connectWatchdog.shutdownNow()
    for (connection in connections.values) connection.close()
    connections.clear()
  }
}
