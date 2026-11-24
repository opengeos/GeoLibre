package app.tauri.dialog

import java.io.Closeable
import java.io.File
import java.io.FileOutputStream
import java.io.InputStream
import java.security.MessageDigest
import java.util.UUID

/** One picker selection, committed together so shapefile companions retain a common directory. */
internal class DocumentCopyBatch(private val root: File) : Closeable {
  private val directory: File
  private val data: File
  private val copies = mutableListOf<Copy>()
  private var committed = false

  companion object {
    private val commitLock = Any()
  }

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

  data class Copy(val file: File, val bytes: Long, val sha256: String, val sourceUri: String)

  /** Stream a provider's file without exposing provider-defined names as paths. */
  fun copy(name: String, sourceUri: String = "", openSource: () -> InputStream): Copy {
    check(!committed) { "The document selection has already been committed" }
    val safeName = name.map { if (it == '/' || it == '\\' || it.isISOControl()) '_' else it }.joinToString("")
    require(safeName.isNotBlank() && safeName != "." && safeName != ".." &&
      safeName.toByteArray(Charsets.UTF_8).size <= 255) { "Invalid document file name" }
    val destination = File(data, safeName)
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
    return Copy(destination, bytes, hex(digest.digest()), sourceUri).also { copies.add(it) }
  }

  /** Reuse an identical source selection only while its copies still match their baseline bytes. */
  private fun matchingSelection(identity: String): File? {
    val names = copies.map { it.file.name }.toSet()
    return root.listFiles()?.firstOrNull { candidate ->
      if (candidate == directory || !candidate.isDirectory) return@firstOrNull false
      try {
        val marker = File(candidate, "identity.sha256")
        if (marker.length() != 64L || marker.readText() != identity) return@firstOrNull false
        val candidateData = File(candidate, "data")
        if (candidateData.listFiles()?.map { it.name }?.toSet() != names) return@firstOrNull false
        copies.all { copy ->
          val file = File(candidateData, copy.file.name)
          if (!file.isFile || file.length() != copy.bytes) return@all false
          val digest = MessageDigest.getInstance("SHA-256")
          file.inputStream().use { input ->
            val buffer = ByteArray(128 * 1024)
            while (true) {
              val count = input.read(buffer)
              if (count < 0) break
              if (count > 0) digest.update(buffer, 0, count)
            }
          }
          hex(digest.digest()) == copy.sha256
        }
      } catch (_: java.io.IOException) {
        false
      }
    }
  }

  private fun hex(bytes: ByteArray): String =
    bytes.joinToString("") { "%02x".format(it.toInt() and 0xff) }

  private fun writeSynced(file: File, text: String) {
    FileOutputStream(file).use { output ->
      output.write(text.toByteArray(Charsets.UTF_8))
      output.fd.sync()
    }
  }

  /** Retain source fingerprints, deduplicate unchanged selections, and return the published paths. */
  fun commit(manifest: String): List<File> = synchronized(commitLock) {
    check(!committed) { "The document selection has already been committed" }
    check(copies.isNotEmpty()) { "The document selection is empty" }
    val digest = MessageDigest.getInstance("SHA-256")
    for (copy in copies.sortedBy { it.file.name }) {
      for (part in listOf(copy.file.name, copy.sourceUri, copy.sha256)) {
        digest.update(part.toByteArray(Charsets.UTF_8))
        digest.update(0.toByte())
      }
    }
    val identity = hex(digest.digest())
    val existing = matchingSelection(identity)
    if (existing != null) {
      check(directory.deleteRecursively()) { "Could not remove the duplicate document copy" }
      committed = true
      return@synchronized copies.map { File(File(existing, "data"), it.file.name) }
    }
    writeSynced(File(directory, "source.json"), manifest)
    writeSynced(File(directory, "identity.sha256"), identity)
    committed = true
    copies.map { it.file }
  }

  override fun close() {
    if (!committed) directory.deleteRecursively()
  }
}
