package org.geolibre.gnssbluetooth

import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Runs [NtripClient] against an in-process fake caster: the request it sends,
 * both response dialects (NTRIP 1.0 `ICY` and 2.0 chunked HTTP), the fatal
 * answers, and GGA forwarding.
 */
class NtripClientTest {
  private val server = ServerSocket(0)
  private var client: NtripClient? = null

  @After
  fun tearDown() {
    client?.stop()
    server.close()
  }

  private val rtcm = byteArrayOf(0xD3.toByte(), 0x00, 0x13, 0x3E, 0xD0.toByte(), 0x00, 0x03)

  private fun config(username: String = "rover", mountpoint: String = "MOUNT") =
    NtripConfig("127.0.0.1", server.localPort, mountpoint, username, "secret", tls = false, ggaIntervalSec = 1)

  private class Run {
    val received = ByteArrayOutputStream()
    val statuses = CopyOnWriteArrayList<NtripStatus>()
    val gotBytes = CountDownLatch(1)
    val stopped = CountDownLatch(1)
  }

  private fun start(config: NtripConfig, gga: GgaTracker = GgaTracker(), expectBytes: Int = 1): Run {
    val run = Run()
    client = NtripClient(
      config,
      sink = { b, n ->
        synchronized(run.received) { run.received.write(b, 0, n) }
        if (run.received.size() >= expectBytes) run.gotBytes.countDown()
      },
      gga = gga,
      onStatus = { s ->
        run.statuses.add(s)
        if (s.state == "stopped") run.stopped.countDown()
      },
    ).also { it.start() }
    return run
  }

  /** Reads the request headers up to the blank line. */
  private fun readRequest(input: InputStream): String {
    val sb = StringBuilder()
    while (!sb.endsWith("\r\n\r\n")) {
      val b = input.read()
      if (b < 0) break
      sb.append(b.toChar())
    }
    return sb.toString()
  }

  private fun readLineFrom(input: InputStream): String {
    val sb = StringBuilder()
    while (true) {
      val b = input.read()
      if (b < 0 || b == '\n'.code) return sb.toString().trimEnd('\r')
      sb.append(b.toChar())
    }
  }

  @Test
  fun ntrip1StreamReachesReceiverAndRequestCarriesAuth() {
    val run = start(config(), expectBytes = rtcm.size)
    server.accept().use { sock: Socket ->
      val request = readRequest(sock.getInputStream())
      assertTrue(request, request.startsWith("GET /MOUNT HTTP/1.1\r\n"))
      assertTrue(request.contains("Ntrip-Version: Ntrip/2.0\r\n"))
      assertTrue(request.contains("Authorization: Basic ${base64("rover:secret".toByteArray())}\r\n"))
      sock.getOutputStream().apply {
        write("ICY 200 OK\r\n".toByteArray())
        write(rtcm)
        flush()
      }
      assertTrue(run.gotBytes.await(5, TimeUnit.SECONDS))
    }
    assertArrayEquals(rtcm, run.received.toByteArray())
    assertTrue(run.statuses.any { it.state == "connected" })
  }

  @Test
  fun ntrip2ChunkedStreamIsDecoded() {
    val run = start(config(), expectBytes = rtcm.size)
    server.accept().use { sock ->
      readRequest(sock.getInputStream())
      sock.getOutputStream().apply {
        write("HTTP/1.1 200 OK\r\nContent-Type: gnss/data\r\nTransfer-Encoding: chunked\r\n\r\n".toByteArray())
        write("3\r\n".toByteArray()); write(rtcm, 0, 3); write("\r\n".toByteArray())
        write("4\r\n".toByteArray()); write(rtcm, 3, 4); write("\r\n".toByteArray())
        flush()
      }
      assertTrue(run.gotBytes.await(5, TimeUnit.SECONDS))
    }
    assertArrayEquals(rtcm, run.received.toByteArray())
  }

  @Test
  fun rejectedLoginStopsWithoutRetrying() {
    val run = start(config())
    server.accept().use { sock ->
      readRequest(sock.getInputStream())
      sock.getOutputStream().write("HTTP/1.1 401 Unauthorized\r\n\r\n".toByteArray())
    }
    assertTrue(run.stopped.await(5, TimeUnit.SECONDS))
    assertEquals("AUTH_FAILED", run.statuses.first { it.state == "error" }.code)
  }

  @Test
  fun unknownMountpointAnsweredWithSourceTableIsFatal() {
    val run = start(config(mountpoint = "NOPE"))
    server.accept().use { sock ->
      readRequest(sock.getInputStream())
      sock.getOutputStream().write("SOURCETABLE 200 OK\r\n\r\nSTR;MOUNT;\r\nENDSOURCETABLE\r\n".toByteArray())
    }
    assertTrue(run.stopped.await(5, TimeUnit.SECONDS))
    assertEquals("MOUNTPOINT", run.statuses.first { it.state == "error" }.code)
  }

  @Test
  fun anonymousRequestHasNoAuthorizationHeader() {
    start(config(username = ""))
    server.accept().use { sock ->
      val request = readRequest(sock.getInputStream())
      assertTrue(!request.contains("Authorization"))
    }
  }

  @Test
  fun forwardsTheReceiversFixedGgaToTheCaster() {
    val gga = GgaTracker()
    val fixed = "\$GNGGA,174512.00,3557.5432,N,08355.1234,W,4,12,0.6,268.4,M,-33.2,M,1.0,0000*4A"
    val bytes = "\$GNGGA,174511.00,,,,,0,00,,,M,,M,,*66\r\n$fixed\r\n".toByteArray(Charsets.ISO_8859_1)
    gga.feed(bytes, bytes.size)
    start(config(), gga = gga)
    server.accept().use { sock ->
      val input = sock.getInputStream()
      readRequest(input)
      sock.getOutputStream().apply {
        write("ICY 200 OK\r\n".toByteArray())
        flush()
      }
      assertEquals(fixed, readLineFrom(input))
    }
  }

  @Test
  fun ggaTrackerIgnoresSentencesWithoutAFix() {
    val gga = GgaTracker()
    val bytes = "\$GPGGA,174511.00,,,,,0,00,,,M,,M,,*66\r\n\$GPRMC,1,A\r\n".toByteArray()
    gga.feed(bytes, bytes.size)
    assertNull(gga.latest)
  }

  @Test
  fun base64MatchesRfc4648Vectors() {
    val cases = mapOf("" to "", "f" to "Zg==", "fo" to "Zm8=", "foo" to "Zm9v", "foobar" to "Zm9vYmFy")
    for ((input, expected) in cases) assertEquals(expected, base64(input.toByteArray()))
  }
}
