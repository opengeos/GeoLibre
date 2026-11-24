package app.tauri.dialog

import java.io.ByteArrayInputStream
import java.io.File
import java.io.IOException
import java.io.InputStream
import java.nio.file.Files
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import org.junit.Assert.*
import org.junit.Test

class DocumentCopyBatchTest {
  @Test fun reusesAnUnchangedSelectionWithoutAccumulatingStorage() {
    val root = Files.createTempDirectory("document-copy").toFile()
    try {
      repeat(2) {
        DocumentCopyBatch(root).use { batch ->
          batch.copy("roads.gpkg") { ByteArrayInputStream("abc".toByteArray()) }
          batch.commit("{}")
        }
      }
      assertEquals(1, root.listFiles()!!.size)
    } finally { root.deleteRecursively() }
  }

  @Test fun preservesEditedCopiesAndOnlyReusesUnchangedBytes() {
    val root = Files.createTempDirectory("document-copy").toFile()
    try {
      fun import(): File = DocumentCopyBatch(root).use { batch ->
        batch.copy("roads.gpkg", "content://provider/document/42") {
          ByteArrayInputStream("abc".toByteArray())
        }
        batch.commit("{}").single()
      }
      val edited = import()
      edited.writeText("xyz")
      val clean = import()
      assertNotEquals(edited, clean)
      assertEquals("xyz", edited.readText())
      assertEquals("abc", clean.readText())
      assertEquals(clean, import())
      assertEquals(2, root.listFiles()!!.size)
    } finally { root.deleteRecursively() }
  }

  @Test fun keepsDifferentProviderDocumentsIndependent() {
    val root = Files.createTempDirectory("document-copy").toFile()
    try {
      for (source in listOf("content://provider/one", "content://provider/two")) {
        DocumentCopyBatch(root).use { batch ->
          batch.copy("roads.gpkg", source) { ByteArrayInputStream("abc".toByteArray()) }
          batch.commit("{}")
        }
      }
      assertEquals(2, root.listFiles()!!.size)
    } finally { root.deleteRecursively() }
  }

  @Test fun concurrentIdenticalSelectionsPublishOnlyOneFolder() {
    val root = Files.createTempDirectory("document-copy").toFile()
    val pool = Executors.newFixedThreadPool(2)
    val ready = CountDownLatch(2)
    try {
      val futures = (1..2).map {
        pool.submit<File> {
          DocumentCopyBatch(root).use { batch ->
            batch.copy("roads.gpkg", "content://provider/document/42") {
              ByteArrayInputStream("abc".toByteArray())
            }
            ready.countDown()
            check(ready.await(5, TimeUnit.SECONDS))
            batch.commit("{}").single()
          }
        }
      }
      val files = futures.map { it.get(5, TimeUnit.SECONDS) }
      assertEquals(files[0], files[1])
      assertTrue(files[0].isFile)
      assertEquals(1, root.listFiles()!!.size)
    } finally {
      pool.shutdownNow()
      root.deleteRecursively()
    }
  }

  @Test fun reusesCompanionsInEitherSelectionOrderAndReturnsPublishedPaths() {
    val root = Files.createTempDirectory("document-copy").toFile()
    try {
      val names = listOf("roads.shp", "roads.dbf")
      var first: List<File> = emptyList()
      for ((index, order) in listOf(names, names.reversed()).withIndex()) {
        DocumentCopyBatch(root).use { batch ->
          for (name in order) {
            batch.copy(name, "content://provider/$name") { ByteArrayInputStream(name.toByteArray()) }
          }
          val published = batch.commit("{}")
          if (index == 0) first = published
          else assertEquals(first.reversed(), published)
          assertTrue(published.all { it.isFile })
        }
      }
      assertEquals(1, root.listFiles()!!.size)
    } finally { root.deleteRecursively() }
  }

  @Test fun sanitizesProviderLabelsAndKeepsTheirCompanionNamesAligned() {
    val root = Files.createTempDirectory("document-copy").toFile()
    try {
      DocumentCopyBatch(root).use { batch ->
        val first = batch.copy("roads/area.shp") { ByteArrayInputStream(byteArrayOf(1)) }
        val second = batch.copy("roads/area.dbf") { ByteArrayInputStream(byteArrayOf(2)) }
        assertEquals("roads_area.shp", first.file.name)
        assertEquals("roads_area.dbf", second.file.name)
        assertEquals(first.file.parentFile, second.file.parentFile)
        val control = batch.copy("bad\u0000.tif") { ByteArrayInputStream(byteArrayOf(3)) }
        assertEquals("bad_.tif", control.file.name)
      }
    } finally { root.deleteRecursively() }
  }

  @Test fun commitsStreamingCopiesAndKeepsCompanionsTogether() {
    val root = Files.createTempDirectory("document-copy").toFile()
    try {
      var closed = false
      val content = ByteArray(400_000) { (it % 251).toByte() }
      lateinit var first: DocumentCopyBatch.Copy
      DocumentCopyBatch(root).use { batch ->
        first = batch.copy("roads.shp") {
          object : ByteArrayInputStream(content) {
            override fun close() { closed = true; super.close() }
          }
        }
        val second = batch.copy("roads.dbf") { ByteArrayInputStream("abc".toByteArray()) }
        assertEquals(first.file.parentFile, second.file.parentFile)
        assertArrayEquals(content, first.file.readBytes())
        assertEquals(content.size.toLong(), first.bytes)
        assertEquals(64, first.sha256.length)
        assertEquals("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", second.sha256)
        batch.commit("{\"sourceUri\":\"content://provider/document/42\"}")
      }
      assertTrue(closed)
      assertTrue(first.file.isFile)
      assertTrue(first.file.parentFile!!.parentFile!!.resolve("source.json").readText().contains("content://"))
    } finally { root.deleteRecursively() }
  }

  @Test fun rollsBackTheWholeSelectionWhenAProviderFails() {
    val root = Files.createTempDirectory("document-copy").toFile()
    try {
      assertThrows(IOException::class.java) {
        DocumentCopyBatch(root).use { batch ->
          batch.copy("first.gpkg") { ByteArrayInputStream(byteArrayOf(1)) }
          batch.copy("second.tif") {
            object : InputStream() { override fun read(): Int { throw IOException("provider failed") } }
          }
        }
      }
      assertEquals(0, root.listFiles()!!.size)
    } finally { root.deleteRecursively() }
  }

  @Test fun rejectsTraversalAndDuplicateNamesWithoutOverwriting() {
    val root = Files.createTempDirectory("document-copy").toFile()
    try {
      DocumentCopyBatch(root).use { batch ->
        for (name in listOf(".", "..", "", "a".repeat(256))) {
          assertThrows(IllegalArgumentException::class.java) {
            batch.copy(name) { ByteArrayInputStream(byteArrayOf(1)) }
          }
        }
        val first = batch.copy("roads.gpkg") { ByteArrayInputStream(byteArrayOf(1)) }
        assertThrows(IllegalStateException::class.java) {
          batch.copy("roads.gpkg") { ByteArrayInputStream(byteArrayOf(2)) }
        }
        assertArrayEquals(byteArrayOf(1), first.file.readBytes())
        batch.copy("x/roads.gpkg") { ByteArrayInputStream(byteArrayOf(3)) }
        assertThrows(IllegalStateException::class.java) {
          batch.copy("x\\roads.gpkg") { ByteArrayInputStream(byteArrayOf(4)) }
        }
        val sanitized = batch.copy("../roads.gpkg") { ByteArrayInputStream(byteArrayOf(5)) }
        assertEquals(".._roads.gpkg", sanitized.file.name)
        assertEquals(first.file.parentFile, sanitized.file.parentFile)
      }
      assertEquals(0, root.listFiles()!!.size)
    } finally { root.deleteRecursively() }
  }
}
