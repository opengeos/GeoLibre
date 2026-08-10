// Copyright 2019-2023 Tauri Programme within The Commons Conservancy
// SPDX-License-Identifier: Apache-2.0
// SPDX-License-Identifier: MIT

package app.tauri.dialog


import android.content.ContentUris
import android.database.Cursor
import android.provider.MediaStore
import android.content.Context
import android.graphics.BitmapFactory
import android.media.MediaMetadataRetriever
import android.net.Uri
import android.os.Environment
import android.provider.DocumentsContract
import android.provider.OpenableColumns
import android.util.Base64
import app.tauri.Logger
import java.io.ByteArrayOutputStream
import java.io.FileNotFoundException
import java.io.IOException
import java.io.InputStream

class FilePickerUtils {
  class FileResolution(var height: Int, var width: Int)

  companion object {
    fun getPathFromUri(context: Context, uri: Uri): String? {
      if (DocumentsContract.isDocumentUri(context, uri)) {
        if (isExternalStorageDocument(uri)) {
          val docId = DocumentsContract.getDocumentId(uri)
          val split = docId.split(":")
          return if ("primary".equals(split[0], ignoreCase = true)) {
            "${Environment.getExternalStorageDirectory()}/${split[1]}"
          } else {
            null
          }
        } else if (isDownloadsDocument(uri)) {
          val id = DocumentsContract.getDocumentId(uri)
          val contentUri = ContentUris.withAppendedId(
            Uri.parse("content://downloads/public_downloads"), java.lang.Long.valueOf(id))
          return getDataColumn(context, contentUri, null, null)
        } else if (isMediaDocument(uri)) {
          val docId = DocumentsContract.getDocumentId(uri)
          val split = docId.split(":")
          val contentUri: Uri? = when (split[0]) {
            "image" -> MediaStore.Images.Media.EXTERNAL_CONTENT_URI
            "video" -> MediaStore.Video.Media.EXTERNAL_CONTENT_URI
            "audio" -> MediaStore.Audio.Media.EXTERNAL_CONTENT_URI
            else -> null
          }
          val selection = "_id=?"
          val selectionArgs = arrayOf(split[1])
          return getDataColumn(context, contentUri, selection, selectionArgs)
        }
      } else if ("content".equals(uri.scheme, ignoreCase = true)) {
        return getDataColumn(context, uri, null, null)
      } else if ("file".equals(uri.scheme, ignoreCase = true)) {
        return uri.path
      }
      return null
    }

    fun getNameFromUri(context: Context, uri: Uri): String? {
      var displayName: String? = ""
      val projection = arrayOf(OpenableColumns.DISPLAY_NAME)
      val cursor =
        context.contentResolver.query(uri, projection, null, null, null)
      if (cursor != null) {
        cursor.moveToFirst()
        val columnIdx = cursor.getColumnIndex(projection[0])
        displayName = cursor.getString(columnIdx)
        cursor.close()
      }
      if (displayName.isNullOrEmpty()) {
        displayName = uri.lastPathSegment
      }
      return displayName
    }

    fun getDataFromUri(context: Context, uri: Uri): String {
      try {
        val stream = context.contentResolver.openInputStream(uri) ?: return ""
        val bytes = getBytesFromInputStream(stream)
        return Base64.encodeToString(bytes, Base64.NO_WRAP)
      } catch (e: FileNotFoundException) {
        Logger.error("openInputStream failed.", e)
      } catch (e: IOException) {
        Logger.error("getBytesFromInputStream failed.", e)
      }
      return ""
    }

    fun getMimeTypeFromUri(context: Context, uri: Uri): String? {
      return context.contentResolver.getType(uri)
    }

    fun getModifiedAtFromUri(context: Context, uri: Uri): Long? {
      return try {
        var modifiedAt: Long = 0
        val cursor =
          context.contentResolver.query(uri, null, null, null, null)
        if (cursor != null) {
          cursor.moveToFirst()
          val columnIdx =
            cursor.getColumnIndex(DocumentsContract.Document.COLUMN_LAST_MODIFIED)
          modifiedAt = cursor.getLong(columnIdx)
          cursor.close()
        }
        modifiedAt
      } catch (e: Exception) {
        Logger.error("getModifiedAtFromUri failed.", e)
        null
      }
    }

    fun getSizeFromUri(context: Context, uri: Uri): Long {
      var size: Long = 0
      val projection = arrayOf(OpenableColumns.SIZE)
      val cursor =
        context.contentResolver.query(uri, projection, null, null, null)
      if (cursor != null) {
        cursor.moveToFirst()
        val columnIdx = cursor.getColumnIndex(projection[0])
        size = cursor.getLong(columnIdx)
        cursor.close()
      }
      return size
    }

    fun getDurationFromUri(context: Context, uri: Uri): Long? {
      if (isVideoUri(context, uri)) {
        val retriever = MediaMetadataRetriever()
        retriever.setDataSource(context, uri)
        val time = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)
        val durationMs = time?.toLong() ?: 0
        try {
          retriever.release()
        } catch (e: Exception) {
          Logger.error("MediaMetadataRetriever.release() failed.", e)
        }
        return durationMs / 1000L
      }
      return null
    }

    fun getHeightAndWidthFromUri(context: Context, uri: Uri): FileResolution? {
      if (isImageUri(context, uri)) {
        val options = BitmapFactory.Options()
        options.inJustDecodeBounds = true
        return try {
          BitmapFactory.decodeStream(
            context.contentResolver.openInputStream(uri),
            null,
            options
          )
          FileResolution(options.outHeight, options.outWidth)
        } catch (exception: FileNotFoundException) {
          exception.printStackTrace()
          null
        }
      } else if (isVideoUri(context, uri)) {
        val retriever = MediaMetadataRetriever()
        retriever.setDataSource(context, uri)
        val width =
          Integer.valueOf(retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_WIDTH) ?: "0")
        val height =
          Integer.valueOf(retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_HEIGHT) ?: "0")
        try {
          retriever.release()
        } catch (e: Exception) {
          Logger.error("MediaMetadataRetriever.release() failed.", e)
        }
        return FileResolution(height, width)
      }
      return null
    }

    private fun isImageUri(context: Context, uri: Uri): Boolean {
      val mimeType = getMimeTypeFromUri(context, uri) ?: return false
      return mimeType.startsWith("image")
    }

    private fun isVideoUri(context: Context, uri: Uri): Boolean {
      val mimeType = getMimeTypeFromUri(context, uri) ?: return false
      return mimeType.startsWith("video")
    }

    @Throws(IOException::class)
    private fun getBytesFromInputStream(`is`: InputStream): ByteArray {
      val os = ByteArrayOutputStream()
      val buffer = ByteArray(0xFFFF)
      var len = `is`.read(buffer)
      while (len != -1) {
        os.write(buffer, 0, len)
        len = `is`.read(buffer)
      }
      return os.toByteArray()
    }
  }
}

private fun getDataColumn(context: Context, uri: Uri?, selection: String?, selectionArgs: Array<String>?): String? {
  var cursor: Cursor? = null
  val column = "_data"
  val projection = arrayOf(column)
  try {
    cursor = context.contentResolver.query(uri!!, projection, selection, selectionArgs, null)
    if (cursor != null && cursor.moveToFirst()) {
      val columnIndex = cursor.getColumnIndexOrThrow(column)
      return cursor.getString(columnIndex)
    }
  } finally {
    cursor?.close()
  }
  return null
}

private fun isExternalStorageDocument(uri: Uri): Boolean {
  return "com.android.externalstorage.documents" == uri.authority
}

private fun isDownloadsDocument(uri: Uri): Boolean {
  return "com.android.providers.downloads.documents" == uri.authority
}

private fun isMediaDocument(uri: Uri): Boolean {
  return "com.android.providers.media.documents" == uri.authority
}
