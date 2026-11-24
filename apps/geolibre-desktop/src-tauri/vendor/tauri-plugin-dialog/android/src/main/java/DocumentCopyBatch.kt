package app.tauri.dialog

import java.io.Closeable
import java.io.File
import java.io.FileOutputStream
import java.io.InputStream
import java.security.MessageDigest
import java.util.UUID

/** One picker selection, committed together so shapefile companions retain a common directory. */
internal class DocumentCopyBatch(root: File) : Closeable {
  private val directory: File
  private val data: File
  private var committed = false

  init {
    check(root.mkdirs() || root.isDirectory) { "Could not create the document storage directory" }
    directory = File(root, UUID.randomUUID().toString())
    check(directory.mkdir()) { "Could not allocate document storage" }
    data = File(directory, "data")
    if (!data.mkdir()) {
      directory.deleteRecursively()
      error("Could not create document data directory")
    }
  }

  data class Copy(val file: File, val bytes: Long, val sha256: String)

  /** Stream a provider's file without exposing provider-defined names as paths. */
  fun copy(name: String, openSource: () -> InputStream): Copy {
    check(!committed) { "The document selection has already been committed" }
    require(name.isNotBlank() && name != "." && name != ".." &&
      !name.any { it == '/' || it == '\\' || it.isISOControl() } &&
      name.toByteArray(Charsets.UTF_8).size <= 255) { "Invalid document file name" }
    val destination = File(data, name)
    check(destination.createNewFile()) { "Two selected documents have the same name: $name" }
    val digest = MessageDigest.getInstance("SHA-256")
    var bytes = 0L
    openSource().use { input ->
      FileOutputStream(destination).use { output ->
        val buffer = ByteArray(128 * 1024)
        while (true) {
          val count = input.read(buffer)
          if (count < 0) break
          if (count == 0) continue
          output.write(buffer, 0, count)
          digest.update(buffer, 0, count)
          bytes += count
        }
        output.fd.sync()
      }
    }
    val hash = digest.digest().joinToString("") { "%02x".format(it.toInt() and 0xff) }
    return Copy(destination, bytes, hash)
  }

  /** Retain the source references and fingerprints before publishing any paths. */
  fun commit(manifest: String) {
    check(!committed) { "The document selection has already been committed" }
    FileOutputStream(File(directory, "source.json")).use { output ->
      output.write(manifest.toByteArray(Charsets.UTF_8))
      output.fd.sync()
    }
    committed = true
  }

  override fun close() {
    if (!committed) directory.deleteRecursively()
  }
}
