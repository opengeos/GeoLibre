package app.tauri.dialog

import java.io.Closeable
import java.io.File
import java.io.FileOutputStream
import java.io.InputStream
import java.security.MessageDigest
import java.util.UUID

/** One selection, with an existing storage parent, published together to retain companion files. */
internal class DocumentCopyBatch(storageRoot: File, private val syncDirectory: (File) -> Unit) : Closeable {
  private val root = storageRoot.canonicalFile
  private val id = UUID.randomUUID().toString()
  private val directory = File(root, ".pending-$id")
  private val publishedDirectory = File(root, id)
  private val data = File(directory, "data")
  private val storageParents = listOfNotNull(root.parentFile)
  private val copies = mutableListOf<Copy>()
  private var committed = false

  companion object {
    private val commitLocks = Array(32) { Any() }
    private val lifecycleLock = Any()
    private val activeDirectories = mutableSetOf<File>()
    private val pendingName = Regex("\\.pending-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}")
  }

  init {
    synchronized(lifecycleLock) {
      check(root.mkdir() || root.isDirectory) { "Could not create the document storage directory" }
      // Only this app process writes these stages. Register active selections
      // under the same lock as the sweep, including selections still streaming.
      var removed = false
      for (candidate in root.listFiles().orEmpty()) {
        if (pendingName.matches(candidate.name) && candidate.isDirectory &&
          candidate.canonicalFile == candidate.absoluteFile && candidate !in activeDirectories) {
          if (candidate.deleteRecursively()) removed = true
        }
      }
      if (removed) syncDirectory(root)
      check(directory.mkdir()) { "Could not allocate document storage" }
      if (!data.mkdir()) {
        directory.deleteRecursively()
        error("Could not create document data directory")
      }
      activeDirectories.add(directory)
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
      if (candidate.name.startsWith(".pending-") || !candidate.isDirectory) return@firstOrNull false
      try {
        if (candidate.canonicalFile != candidate.absoluteFile) return@firstOrNull false
        val marker = File(candidate, "identity.sha256")
        if (marker.length() != 64L || marker.readText() != identity) return@firstOrNull false
        val candidateData = File(candidate, "data")
        if (candidateData.canonicalFile != candidateData.absoluteFile) return@firstOrNull false
        if (candidateData.listFiles()?.map { it.name }?.toSet() != names) return@firstOrNull false
        copies.all { copy ->
          val file = File(candidateData, copy.file.name)
          if (!file.isFile || file.canonicalFile != file.absoluteFile || file.length() != copy.bytes) return@all false
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
  fun commit(manifest: String): List<File> {
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
    // A fixed set of locks bounds memory while identical selections share a
    // lock. Other identities can stream, verify, and publish independently.
    val lock = commitLocks[(identity.hashCode() and Int.MAX_VALUE) % commitLocks.size]
    return synchronized(lock) {
      val existing = matchingSelection(identity)
      if (existing != null) {
        syncDirectory(File(existing, "data"))
        syncDirectory(existing)
        check(directory.deleteRecursively()) { "Could not remove the duplicate document copy" }
        syncDirectory(root)
        storageParents.forEach(syncDirectory)
        committed = true
        return@synchronized copies.map { File(File(existing, "data"), it.file.name) }
      }
      writeSynced(File(directory, "source.json"), manifest)
      writeSynced(File(directory, "identity.sha256"), identity)
      syncDirectory(data)
      syncDirectory(directory)
      check(!publishedDirectory.exists() && directory.renameTo(publishedDirectory)) {
        "Could not publish the imported documents"
      }
      try {
        syncDirectory(root)
        storageParents.forEach(syncDirectory)
      } catch (error: Throwable) {
        // Roll back before releasing this identity's lock. Otherwise another
        // import could reuse this folder while close() was about to delete it.
        try {
          publishedDirectory.deleteRecursively()
          syncDirectory(root)
        } catch (_: Throwable) { }
        throw error
      }
      committed = true
      copies.map { File(File(publishedDirectory, "data"), it.file.name) }
    }
  }

  override fun close() {
    synchronized(lifecycleLock) {
      try {
        if (!committed) {
          directory.deleteRecursively()
          // Cleanup must not mask the import's original error.
          try { syncDirectory(root) } catch (_: Exception) { }
        }
      } finally {
        activeDirectories.remove(directory)
      }
    }
  }
}
