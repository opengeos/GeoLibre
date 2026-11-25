// Copyright 2019-2023 Tauri Programme within The Commons Conservancy
// SPDX-License-Identifier: Apache-2.0
// SPDX-License-Identifier: MIT

enum FileAccessMode: String, Decodable {
  case copy
  case scoped
}

enum PickerMode: String, Decodable {
  case document
  case media
  case image
  case video
}

/// Explicit data imports use Files, including rasters with image MIME types.
/// Ordinary photo/video picks retain the upstream gallery-selection behavior.
func usesMediaPicker(
  fileAccessMode: FileAccessMode?, pickerMode: PickerMode?, mimeKinds: Set<String>
) -> Bool {
  if fileAccessMode == .copy { return false }
  if pickerMode == .media || pickerMode == .image || pickerMode == .video { return true }
  return !mimeKinds.contains(where: { $0 != "image" && $0 != "video" })
    && (mimeKinds.contains("image") || mimeKinds.contains("video"))
}
