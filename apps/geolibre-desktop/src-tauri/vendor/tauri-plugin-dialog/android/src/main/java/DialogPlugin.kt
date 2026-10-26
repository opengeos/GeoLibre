// Copyright 2019-2023 Tauri Programme within The Commons Conservancy
// SPDX-License-Identifier: Apache-2.0
// SPDX-License-Identifier: MIT

package app.tauri.dialog

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.webkit.MimeTypeMap
import androidx.activity.result.ActivityResult
import app.tauri.Logger
import app.tauri.annotation.ActivityCallback
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSArray
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import com.google.android.material.dialog.MaterialAlertDialogBuilder

@InvokeArg
class Filter {
  lateinit var extensions: Array<String>
}

@InvokeArg
class FilePickerOptions {
  lateinit var filters: Array<Filter>
  var multiple: Boolean? = null
  var pickerMode: String? = null
}

@InvokeArg
class MessageOptions {
  var title: String? = null
  lateinit var message: String
  var okButtonLabel: String? = null
  var noButtonLabel: String? = null
  var cancelButtonLabel: String? = null
}

@InvokeArg
class SaveFileDialogOptions {
  var fileName: String? = null
  lateinit var filters: Array<Filter>
}

/**
 * Persisted document grants kept, a margin below Android's per-app cap: 128
 * persisted grants before Android 11, 512 from it.
 */
private val MAX_PERSISTED_GRANTS = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) 500 else 120

@TauriPlugin
class DialogPlugin(private val activity: Activity): Plugin(activity) {
  var filePickerOptions: FilePickerOptions? = null

  @Command
  fun showFilePicker(invoke: Invoke) {
    try {
      val args = invoke.parseArgs(FilePickerOptions::class.java)
      val parsedTypes = parseFiltersOption(args.filters)

      // GeoLibre: documents open with ACTION_OPEN_DOCUMENT, whose grant can be
      // made persistable (see takePersistableGrants), so a project or data file
      // stays readable after the app process restarts. ACTION_GET_CONTENT's
      // grant dies with the activity that received it (GeoLibre#3216). Photo
      // and video picks keep ACTION_GET_CONTENT for the gallery apps it offers.
      val isMediaPick = args.pickerMode == "image" || args.pickerMode == "video" ||
        args.pickerMode == "media"
      val intent = Intent(if (isMediaPick) Intent.ACTION_GET_CONTENT else Intent.ACTION_OPEN_DOCUMENT)
      intent.addCategory(Intent.CATEGORY_OPENABLE)
      // No grant flags on the request: the document picker itself returns
      // read, persistable, and (only for a writable document) write grants, so
      // asking for write here could only narrow what it offers.

      if (args.pickerMode == "image") {
        intent.type = "image/*"
      } else if (args.pickerMode == "video") {
        intent.type = "video/*"
      } else if (args.pickerMode == "media") {
        intent.type = "*/*"
        intent.putExtra(Intent.EXTRA_MIME_TYPES, arrayOf("video/*", "image/*"))
      } else if (parsedTypes.isNotEmpty()) {
        intent.type = "*/*"
        intent.putExtra(Intent.EXTRA_MIME_TYPES, parsedTypes)
      } else {
        intent.type = "*/*"
      }

      intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, args.multiple ?: false)

      startActivityForResult(invoke, intent, "filePickerResult")
    } catch (ex: Exception) {
      val message = ex.message ?: "Failed to pick file"
      Logger.error(message)
      invoke.reject(message)
    }
  }

  @ActivityCallback
  fun filePickerResult(invoke: Invoke, result: ActivityResult) {
    try {
      when (result.resultCode) {
        Activity.RESULT_OK -> {
          val callResult = createPickFilesResult(result.data)
          takePersistableGrants(result.data)
          invoke.resolve(callResult)
        }
        Activity.RESULT_CANCELED -> invoke.reject("File picker cancelled")
        else -> invoke.reject("Failed to pick files")
      }
    } catch (ex: java.lang.Exception) {
      val message = ex.message ?: "Failed to read file pick result"
      Logger.error(message)
      invoke.reject(message)
    }
  }

  /**
   * GeoLibre: keep the picked documents' grants across process restarts, so a
   * project saved or opened in one session can be read and saved again in the
   * next instead of falling back to a stale stored copy (GeoLibre#3216).
   *
   * Only a grant the result marks persistable can be taken (ACTION_OPEN_DOCUMENT
   * and ACTION_CREATE_DOCUMENT results; never ACTION_GET_CONTENT), and a
   * provider may still refuse, so a failure leaves the session-long grant the
   * result already carries. Android caps persisted grants per app (128, or 512
   * from Android 11), so the oldest are released first to stay under it. Every
   * document pick persists (data files too, not only projects), so on a device
   * past that many distinct picks a long-unused project can lose its grant;
   * the app then falls back to its stored copy and says so.
   */
  private fun takePersistableGrants(data: Intent?) {
    // Best effort throughout: the pick or save has already succeeded, so a
    // failure here must not turn it into a rejection.
    try {
      if (data == null) return
      if (data.flags and Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION == 0) return
      val modeFlags = data.flags and
        (Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
      if (modeFlags == 0) return
      val uris: MutableList<Uri> = ArrayList()
      val clipData = data.clipData
      if (clipData == null) {
        data.data?.let { uris.add(it) }
      } else {
        for (i in 0 until clipData.itemCount) clipData.getItemAt(i).uri?.let { uris.add(it) }
      }
      if (uris.isEmpty()) return
      val resolver = activity.contentResolver
      try {
        // Re-picking a document already persisted takes no new slot, and a
        // document in this pick must never be released to make room.
        val picked = uris.toSet()
        val persisted = resolver.persistedUriPermissions
        val persistedUris = persisted.map { it.uri }.toSet()
        val added = picked.count { it !in persistedUris }
        val excess = persisted.size + added - MAX_PERSISTED_GRANTS
        if (excess > 0) {
          val releasable = persisted.filter { it.uri !in picked }.sortedBy { it.persistedTime }
          for (old in releasable.take(excess)) {
            var oldFlags = 0
            if (old.isReadPermission) oldFlags = oldFlags or Intent.FLAG_GRANT_READ_URI_PERMISSION
            if (old.isWritePermission) oldFlags = oldFlags or Intent.FLAG_GRANT_WRITE_URI_PERMISSION
            resolver.releasePersistableUriPermission(old.uri, oldFlags)
          }
        }
      } catch (ex: Exception) {
        Logger.error("Failed to release old document grants: ${ex.message}")
      }
      for (uri in uris) {
        try {
          resolver.takePersistableUriPermission(uri, modeFlags)
        } catch (ex: Exception) {
          Logger.error("Could not keep access to $uri after restart: ${ex.message}")
        }
      }
    } catch (ex: Exception) {
      Logger.error("Failed to keep document grants: ${ex.message}")
    }
  }

  private fun createPickFilesResult(data: Intent?): JSObject {
    val callResult = JSObject()
    if (data == null) {
      callResult.put("files", null)
      return callResult
    }
    val uris: MutableList<String?> = ArrayList()
    if (data.clipData == null) {
      val uri: Uri? = data.data
      uris.add(uri?.toString())
    } else {
      for (i in 0 until data.clipData!!.itemCount) {
        val uri: Uri = data.clipData!!.getItemAt(i).uri
        uris.add(uri.toString())
      }
    }
    callResult.put("files", JSArray.from(uris.toTypedArray()))
    return callResult
  }

  private fun parseFiltersOption(filters: Array<Filter>): Array<String> {
    val mimeTypes = mutableListOf<String>()
    for (filter in filters) {
      for (ext in filter.extensions) {
        if (ext.contains('/')) {
          mimeTypes.add(if (ext == "text/csv") "text/comma-separated-values" else ext)
        } else {
          MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext)?.let {
            mimeTypes.add(it)
          }
        }
      }
    }
    return mimeTypes.toTypedArray()
  }

  @Command
  fun showMessageDialog(invoke: Invoke) {
    val args = invoke.parseArgs(MessageOptions::class.java)

    if (activity.isFinishing) {
      invoke.reject("App is finishing")
      return
    }

    val handler = { value: String ->
      val ret = JSObject()
      ret.put("value", value)
      invoke.resolve(ret)
    }

    Handler(Looper.getMainLooper())
      .post {
        val builder = MaterialAlertDialogBuilder(activity)

        if (args.title != null) {
          builder.setTitle(args.title)
        }

        val okButtonLabel = args.okButtonLabel ?: "Ok"

        builder
          .setMessage(args.message)
          .setPositiveButton(okButtonLabel) { dialog, _ ->
            dialog.dismiss()
            handler(okButtonLabel)
          }
          .setOnCancelListener { dialog ->
            dialog.dismiss()
            handler(args.cancelButtonLabel ?: "Cancel")
          }

        if (args.noButtonLabel != null) {
          builder.setNeutralButton(args.noButtonLabel) { dialog, _ ->
            dialog.dismiss()
            handler(args.noButtonLabel!!)
          }
        }

        if (args.cancelButtonLabel != null) {
          builder.setNegativeButton( args.cancelButtonLabel) { dialog, _ ->
            dialog.dismiss()
            handler(args.cancelButtonLabel!!)
          }
        }

        builder.show()
      }
  }

  @Command
  fun saveFileDialog(invoke: Invoke) {
    try {
      val args = invoke.parseArgs(SaveFileDialogOptions::class.java)
      val parsedTypes = parseFiltersOption(args.filters)

      val intent = Intent(Intent.ACTION_CREATE_DOCUMENT)
      intent.addCategory(Intent.CATEGORY_OPENABLE)
      intent.putExtra(Intent.EXTRA_TITLE, args.fileName ?: "")
      if (parsedTypes.size == 1) {
        intent.type = parsedTypes.first()
      } else {
        intent.type = "*/*"
        intent.putExtra(Intent.EXTRA_MIME_TYPES, parsedTypes)
      }

      startActivityForResult(invoke, intent, "saveFileDialogResult")
    } catch (ex: Exception) {
      val message = ex.message ?: "Failed to pick save file"
      Logger.error(message)
      invoke.reject(message)
    }
  }

  @ActivityCallback
  fun saveFileDialogResult(invoke: Invoke, result: ActivityResult) {
    try {
      when (result.resultCode) {
        Activity.RESULT_OK -> {
          val callResult = JSObject()
          val intent: Intent? = result.data
          if (intent != null) {
            val uri = intent.data
            if (uri != null) {
              callResult.put("file", uri.toString())
            }
          }
          takePersistableGrants(intent)
          invoke.resolve(callResult)
        }
        Activity.RESULT_CANCELED -> invoke.reject("File picker cancelled")
        else -> invoke.reject("Failed to pick files")
      }
    } catch (ex: java.lang.Exception) {
      val message = ex.message ?: "Failed to read file pick result"
      Logger.error(message)
      invoke.reject(message)
    }
  }
}
