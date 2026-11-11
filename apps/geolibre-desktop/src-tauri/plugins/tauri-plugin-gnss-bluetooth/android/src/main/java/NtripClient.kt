// NTRIP client for the GeoLibre Android app (GeoLibre#3400): pulls RTCM
// corrections from a caster and writes them to the connected GNSS receiver, so
// an RTK rover needs no second app to deliver corrections. Plain Kotlin on
// java.net, with no Android imports, so it runs in a JVM unit test against a
// fake caster (src/test/java/NtripClientTest.kt).

package org.geolibre.gnssbluetooth

import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.net.InetSocketAddress
import java.net.Socket
import java.net.SocketTimeoutException
import javax.net.ssl.SSLHandshakeException
import javax.net.ssl.SSLPeerUnverifiedException
import javax.net.ssl.SSLSocket
import javax.net.ssl.SSLSocketFactory

/** Where to get corrections. `mountpoint` has no leading slash. */
data class NtripConfig(
  val host: String,
  val port: Int,
  val mountpoint: String,
  val username: String,
  val password: String,
  val tls: Boolean,
  /** How often to send the rover position to the caster, in seconds. */
  val ggaIntervalSec: Int = 10,
)

/** One status change, forwarded to the webview as an `ntrip` channel event. */
data class NtripStatus(
  /** `connecting`, `connected`, `error`, or `stopped`. */
  val state: String,
  /** Correction bytes written to the receiver this session. */
  val bytes: Long,
  val message: String? = null,
  /**
   * For `error`: `AUTH_FAILED`, `MOUNTPOINT` and `TLS_FAILED` stop the client
   * (retrying cannot help); `FAILED` is retried after [RETRY_DELAY_MS].
   */
  val code: String? = null,
)

private const val CONNECT_TIMEOUT_MS = 10_000
/** No data for this long means the caster stalled; reconnect. */
private const val READ_TIMEOUT_MS = 30_000
private const val RETRY_DELAY_MS = 5_000L
/** Throttle for `connected` byte-count updates. */
private const val STATUS_INTERVAL_MS = 1_000L
private const val MAX_HEADER_LINE = 8192

/** A caster answer that retrying cannot fix. */
private class FatalNtripError(message: String, val code: String) : IOException(message)

/**
 * Remembers the latest GGA sentence with a real fix from the receiver's own
 * NMEA stream. Network casters (VRS and nearest-base) need the rover position
 * to choose or synthesize a base, and the receiver's GGA is exactly that.
 */
class GgaTracker {
  private val line = StringBuilder()
  @Volatile var latest: String? = null
    private set

  /** Feed raw receiver bytes (one char per byte, as the plugin reads them). */
  fun feed(bytes: ByteArray, count: Int) {
    for (i in 0 until count) {
      val c = (bytes[i].toInt() and 0xff).toChar()
      if (c == '\n') {
        consider(line.toString().trim())
        line.setLength(0)
      } else if (line.length < 256) {
        line.append(c)
      } else {
        line.setLength(0)
      }
    }
  }

  private fun consider(sentence: String) {
    if (sentence.length < 7 || sentence[0] != '$' || sentence.substring(3, 6) != "GGA") return
    // Field 6 is the fix quality; 0 (or empty) means no fix, and some casters
    // drop a client that sends a position without one.
    val quality = sentence.split(',').getOrNull(6) ?: return
    // A lost fix clears the position, so a VRS caster is not kept building
    // corrections for where the rover used to be.
    latest = if (quality.isEmpty() || quality == "0") null else sentence + "\r\n"
  }
}

/** Builds the caster request. NTRIP 2.0 headers; a 1.0 caster ignores them. */
internal fun ntripRequest(config: NtripConfig): ByteArray {
  val hostHeader = if (config.port == 80 || config.port == 443) config.host else "${config.host}:${config.port}"
  val request = StringBuilder()
    .append("GET /").append(config.mountpoint).append(" HTTP/1.1\r\n")
    .append("Host: ").append(hostHeader).append("\r\n")
    .append("Ntrip-Version: Ntrip/2.0\r\n")
    .append("User-Agent: NTRIP GeoLibre/1.0\r\n")
  if (config.username.isNotEmpty()) {
    val token = base64("${config.username}:${config.password}".toByteArray(Charsets.UTF_8))
    request.append("Authorization: Basic ").append(token).append("\r\n")
  }
  request.append("Connection: close\r\n\r\n")
  return request.toString().toByteArray(Charsets.ISO_8859_1)
}

/** RFC 4648 base64; java.util.Base64 needs API 26 and the plugin supports 24. */
internal fun base64(data: ByteArray): String {
  val alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
  val out = StringBuilder((data.size + 2) / 3 * 4)
  var i = 0
  while (i < data.size) {
    val b0 = data[i].toInt() and 0xff
    val b1 = if (i + 1 < data.size) data[i + 1].toInt() and 0xff else 0
    val b2 = if (i + 2 < data.size) data[i + 2].toInt() and 0xff else 0
    out.append(alphabet[b0 shr 2])
    out.append(alphabet[((b0 and 0x03) shl 4) or (b1 shr 4)])
    out.append(if (i + 1 < data.size) alphabet[((b1 and 0x0f) shl 2) or (b2 shr 6)] else '=')
    out.append(if (i + 2 < data.size) alphabet[b2 and 0x3f] else '=')
    i += 3
  }
  return out.toString()
}

/** Reads one CRLF- or LF-terminated header line, or null at end of stream. */
private fun readLine(input: InputStream): String? {
  val line = StringBuilder()
  while (true) {
    val b = input.read()
    if (b < 0) return if (line.isEmpty()) null else line.toString()
    if (b == '\n'.code) return line.toString().trimEnd('\r')
    if (line.length >= MAX_HEADER_LINE) throw IOException("Caster response header is too long.")
    line.append(b.toChar())
  }
}

/** Decodes an HTTP/1.1 chunked body; NTRIP 2.0 casters send the stream this way. */
private class ChunkedInputStream(private val input: InputStream) : InputStream() {
  private var remaining = 0
  private var done = false

  private fun nextChunk(): Boolean {
    if (done) return false
    val sizeLine = readLine(input) ?: return false.also { done = true }
    val size = sizeLine.substringBefore(';').trim().toIntOrNull(16)
      ?: throw IOException("Malformed chunk size from caster: $sizeLine")
    if (size == 0) {
      done = true
      return false
    }
    remaining = size
    return true
  }

  override fun read(): Int {
    val one = ByteArray(1)
    return if (read(one, 0, 1) < 0) -1 else one[0].toInt() and 0xff
  }

  override fun read(b: ByteArray, off: Int, len: Int): Int {
    if (remaining == 0) {
      // Each chunk's data is followed by CRLF, except before the first chunk.
      if (!nextChunkAfterBoundary()) return -1
    }
    val n = input.read(b, off, minOf(len, remaining))
    if (n < 0) return -1
    remaining -= n
    return n
  }

  private var started = false

  private fun nextChunkAfterBoundary(): Boolean {
    if (started) readLine(input) // the CRLF that closes the previous chunk
    started = true
    return nextChunk()
  }
}

/**
 * One NTRIP session against one caster. [start] spawns a thread that connects,
 * streams corrections into [sink], and reconnects after a dropped or stalled
 * stream until [stop] is called or the caster refuses the login or mountpoint.
 */
class NtripClient(
  private val config: NtripConfig,
  /** TLS sockets come from here; tests pass one that trusts their own CA. */
  private val sslSocketFactory: SSLSocketFactory = SSLSocketFactory.getDefault() as SSLSocketFactory,
  /** Writes correction bytes to the receiver. */
  private val sink: (ByteArray, Int) -> Unit,
  private val gga: GgaTracker,
  private val onStatus: (NtripStatus) -> Unit,
) {
  @Volatile private var stopped = false
  @Volatile private var socket: Socket? = null
  private var thread: Thread? = null
  private var bytes = 0L

  fun start() {
    thread = Thread({ run() }, "ntrip-client").also { it.isDaemon = true; it.start() }
  }

  fun stop() {
    stopped = true
    closeSocket()
    thread?.interrupt()
  }

  private fun closeSocket() {
    try {
      socket?.close()
    } catch (_: IOException) {
    }
  }

  private fun run() {
    while (!stopped) {
      onStatus(NtripStatus("connecting", bytes))
      try {
        session()
        if (!stopped) onStatus(NtripStatus("error", bytes, "The caster closed the stream.", "FAILED"))
      } catch (e: FatalNtripError) {
        if (!stopped) onStatus(NtripStatus("error", bytes, e.message, e.code))
        stopped = true
        break
      } catch (e: Exception) {
        if (!stopped) onStatus(NtripStatus("error", bytes, e.message ?: e.javaClass.simpleName, "FAILED"))
      } finally {
        closeSocket()
      }
      if (stopped) break
      try {
        Thread.sleep(RETRY_DELAY_MS)
      } catch (_: InterruptedException) {
        break
      }
    }
    onStatus(NtripStatus("stopped", bytes))
  }

  /** Opens the caster connection, closing whatever it opened if any step fails. */
  private fun open(): Socket {
    // Published at once so stop() can abort a connect or handshake in progress.
    val raw = Socket().also { socket = it }
    try {
      if (stopped) throw IOException("stopped")
      raw.connect(InetSocketAddress(config.host, config.port), CONNECT_TIMEOUT_MS)
      raw.soTimeout = READ_TIMEOUT_MS
      if (!config.tls) return raw
      val tls = sslSocketFactory.createSocket(raw, config.host, config.port, true) as SSLSocket
      // A bare SSLSocket checks the certificate chain but not the name in it.
      // HTTPS endpoint identification makes the handshake itself check the
      // certificate against the host, so no separate verifier is relied on.
      tls.sslParameters = tls.sslParameters.apply { endpointIdentificationAlgorithm = "HTTPS" }
      try {
        tls.startHandshake()
      } catch (e: SSLHandshakeException) {
        throw tlsError(e)
      } catch (e: SSLPeerUnverifiedException) {
        throw tlsError(e)
      }
      return tls
    } catch (e: Exception) {
      try {
        raw.close()
      } catch (_: IOException) {
      }
      throw e
    }
  }

  /**
   * An untrusted or mismatched certificate, or TLS against a plain port:
   * retrying cannot fix any of these, so the client stops.
   */
  private fun tlsError(e: Exception) = FatalNtripError(
    "Could not set up TLS with ${config.host}: ${e.message}",
    "TLS_FAILED",
  )

  private fun session() {
    val s = open()
    socket = s
    if (stopped) return
    val out = s.getOutputStream()
    out.write(ntripRequest(config))
    out.flush()

    val raw = s.getInputStream().buffered()
    val body = readResponse(raw)
    onStatus(NtripStatus("connected", bytes))
    val ggaThread = startGgaSender(out)
    try {
      pump(body)
    } finally {
      ggaThread.interrupt()
    }
  }

  /** Parses the status line and headers, returning the correction stream. */
  private fun readResponse(input: InputStream): InputStream {
    val status = readLine(input) ?: throw IOException("The caster closed the connection without answering.")
    // NTRIP 1.0: "ICY 200 OK" and the stream follows at once, with no headers.
    if (status.startsWith("ICY 200")) return input
    if (status.startsWith("SOURCETABLE")) throw mountpointError()
    // NTRIP 1.0 refusals are a bare line, e.g. "ERROR - Bad Password" or
    // "ERROR - Bad Mountpoint", not an HTTP status.
    if (status.startsWith("ERROR")) {
      val reason = status.lowercase()
      if ("password" in reason || "auth" in reason) {
        throw FatalNtripError("The caster rejected the username or password.", "AUTH_FAILED")
      }
      if ("mount" in reason) throw mountpointError()
      throw IOException("The caster answered: $status")
    }
    val code = status.split(' ').getOrNull(1)?.toIntOrNull()
      ?: throw IOException("Unexpected caster response: $status")
    val headers = mutableMapOf<String, String>()
    while (true) {
      val line = readLine(input) ?: break
      if (line.isEmpty()) break
      val colon = line.indexOf(':')
      if (colon > 0) headers[line.substring(0, colon).trim().lowercase()] = line.substring(colon + 1).trim()
    }
    when (code) {
      200 -> {}
      401, 403 -> throw FatalNtripError("The caster rejected the username or password.", "AUTH_FAILED")
      404 -> throw mountpointError()
      else -> throw IOException("The caster answered: $status")
    }
    // A 2.0 caster answers an unknown mountpoint with its source table.
    if (headers["content-type"]?.contains("sourcetable") == true) throw mountpointError()
    return if (headers["transfer-encoding"]?.contains("chunked") == true) ChunkedInputStream(input) else input
  }

  private fun mountpointError() =
    FatalNtripError("The caster has no mountpoint named \"${config.mountpoint}\".", "MOUNTPOINT")

  private fun pump(input: InputStream) {
    val buffer = ByteArray(4096)
    var lastStatus = 0L
    while (!stopped) {
      val n = try {
        input.read(buffer)
      } catch (_: SocketTimeoutException) {
        throw IOException("No corrections from the caster for ${READ_TIMEOUT_MS / 1000} s.")
      }
      if (n < 0) return
      if (n == 0) continue
      sink(buffer, n)
      bytes += n
      val now = System.currentTimeMillis()
      if (now - lastStatus >= STATUS_INTERVAL_MS) {
        lastStatus = now
        onStatus(NtripStatus("connected", bytes))
      }
    }
  }

  /**
   * Sends the latest GGA as soon as the receiver has a fix, then every
   * [NtripConfig.ggaIntervalSec]. A single-base caster ignores it; a network
   * caster needs it before it sends anything.
   */
  private fun startGgaSender(out: OutputStream): Thread {
    val thread = Thread({
      try {
        var sentAny = false
        while (!stopped) {
          val sentence = gga.latest
          if (sentence != null) {
            synchronized(out) {
              out.write(sentence.toByteArray(Charsets.ISO_8859_1))
              out.flush()
            }
            sentAny = true
          }
          Thread.sleep(if (sentAny) config.ggaIntervalSec.coerceAtLeast(1) * 1000L else 1000L)
        }
      } catch (_: InterruptedException) {
      } catch (_: IOException) {
        // The read side sees the same broken socket and reconnects.
      }
    }, "ntrip-gga")
    thread.isDaemon = true
    thread.start()
    return thread
  }
}
