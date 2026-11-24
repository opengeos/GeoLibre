package app.tauri.dialog

import java.io.ByteArrayInputStream
import java.io.IOException
import java.io.InputStream
import java.nio.file.Files
import org.junit.Assert.*
import org.junit.Test

class DocumentCopyBatchTest {
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
        for (name in listOf("../roads.gpkg", "x/roads.gpkg", "x\\roads.gpkg", ".", "..", "bad\u0000.tif")) {
          assertThrows(IllegalArgumentException::class.java) {
            batch.copy(name) { ByteArrayInputStream(byteArrayOf(1)) }
          }
        }
        val first = batch.copy("roads.gpkg") { ByteArrayInputStream(byteArrayOf(1)) }
        assertThrows(IllegalStateException::class.java) {
          batch.copy("roads.gpkg") { ByteArrayInputStream(byteArrayOf(2)) }
        }
        assertArrayEquals(byteArrayOf(1), first.file.readBytes())
      }
      assertEquals(0, root.listFiles()!!.size)
    } finally { root.deleteRecursively() }
  }
}
