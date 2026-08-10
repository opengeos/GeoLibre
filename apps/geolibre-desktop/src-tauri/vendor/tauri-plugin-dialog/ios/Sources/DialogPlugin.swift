// Copyright 2019-2023 Tauri Programme within The Commons Conservancy
// SPDX-License-Identifier: Apache-2.0
// SPDX-License-Identifier: MIT

import MobileCoreServices
import Photos
import PhotosUI
import SwiftRs
import Tauri
import UIKit
import UniformTypeIdentifiers
import WebKit

enum FilePickerEvent {
  case selected([URL])
  case cancelled
  case error(String)
}

struct MessageDialogOptions: Decodable {
  var title: String?
  let message: String
  var okButtonLabel: String?
  var noButtonLabel: String?
  var cancelButtonLabel: String?
}

struct Filter: Decodable {
  var extensions: [String]?
}

struct FilePickerOptions: Decodable {
  var multiple: Bool?
  var filters: [Filter]?
  var defaultPath: String?
  var pickerMode: PickerMode?
  var fileAccessMode: FileAccessMode?
}

struct SaveFileDialogOptions: Decodable {
  var fileName: String?
  var defaultPath: String?
}

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

class DialogPlugin: Plugin {

  var filePickerController: FilePickerController!
  var onFilePickerResult: ((FilePickerEvent) -> Void)? = nil

  override init() {
    super.init()
    filePickerController = FilePickerController(self)

  }

  @objc public func showFilePicker(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(FilePickerOptions.self)

    onFilePickerResult = { (event: FilePickerEvent) -> Void in
      switch event {
      case .selected(let urls):
        invoke.resolve(["files": urls])
      case .cancelled:
        invoke.resolve(["files": nil])
      case .error(let error):
        invoke.reject(error)
      }
    }

    if #available(iOS 14, *) {
      let parsedTypes = parseFiltersOption(args.filters ?? [])

      let mimeKinds = Set(
        parsedTypes.compactMap { $0.preferredMIMEType?.components(separatedBy: "/")[0] })
      let filtersIncludeImage = mimeKinds.contains("image")
      let filtersIncludeVideo = mimeKinds.contains("video")
      let filtersIncludeNonMedia = mimeKinds.contains(where: { $0 != "image" && $0 != "video" })

      // If the picker mode is media, images, or videos, we always want to show the media picker regardless of what's in the filters.
      // Otherwise, if the filters A) do not include non-media types and B) include either image or video, we want to show the media picker.
      if args.pickerMode == .media
        || args.pickerMode == .image
        || args.pickerMode == .video
        || (!filtersIncludeNonMedia && (filtersIncludeImage || filtersIncludeVideo))
      {
        DispatchQueue.main.async {
          var configuration = PHPickerConfiguration(photoLibrary: PHPhotoLibrary.shared())
          configuration.selectionLimit = (args.multiple ?? false) ? 0 : 1

          // If the filters include image or video, use the appropriate filter.
          // If both are true, don't define a filter, which means we will display all media.
          if args.pickerMode == .image || (filtersIncludeImage && !filtersIncludeVideo) {
            configuration.filter = .images
          } else if args.pickerMode == .video || (filtersIncludeVideo && !filtersIncludeImage) {
            configuration.filter = .videos
          }

          let picker = PHPickerViewController(configuration: configuration)
          picker.delegate = self.filePickerController
          picker.modalPresentationStyle = .fullScreen
          self.presentViewController(picker)
        }
      } else {
        DispatchQueue.main.async {
          // The UTType.item is the catch-all, allowing for any file type to be selected.
          let contentTypes = parsedTypes.isEmpty ? [UTType.item] : parsedTypes
          let picker: UIDocumentPickerViewController = UIDocumentPickerViewController(
            forOpeningContentTypes: contentTypes,
            asCopy: args.fileAccessMode == .scoped ? false : true)

          if let defaultPath = args.defaultPath {
            picker.directoryURL = URL(string: defaultPath)
          }

          picker.delegate = self.filePickerController
          picker.allowsMultipleSelection = args.multiple ?? false
          picker.modalPresentationStyle = .fullScreen
          self.presentViewController(picker)
        }
      }
    } else {
      showFilePickerLegacy(args: args)
    }
  }

  @objc public func saveFileDialog(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(SaveFileDialogOptions.self)

    // The Tauri save dialog API prompts the user to select a path where a file must be saved
    // This behavior maps to the operating system interfaces on all platforms except iOS,
    // which only exposes a mechanism to "move file `srcPath` to a location defined by the user"
    //
    // so we have to work around it by creating an empty file matching the requested `args.fileName`,
    // and using it as `srcPath` for the operation - returning the path the user selected
    // so the app dev can write to it later - matching cross platform behavior as mentioned above
    let fileManager = FileManager.default
    let srcFolder = fileManager.urls(for: .documentDirectory, in: .userDomainMask).first!
    let srcPath = srcFolder.appendingPathComponent(args.fileName ?? "file")
    if !fileManager.fileExists(atPath: srcPath.path) {
      // the file contents must be actually provided by the tauri dev after the path is resolved by the save API
      try "".write(to: srcPath, atomically: true, encoding: .utf8)
    }

    onFilePickerResult = { (event: FilePickerEvent) -> Void in
      switch event {
      case .selected(let urls):
        invoke.resolve(["file": urls.first!])
      case .cancelled:
        invoke.resolve(["file": nil])
      case .error(let error):
        invoke.reject(error)
      }
    }

    DispatchQueue.main.async {
      let picker = UIDocumentPickerViewController(url: srcPath, in: .exportToService)
      if let defaultPath = args.defaultPath {
        picker.directoryURL = URL(string: defaultPath)
      }
      picker.delegate = self.filePickerController
      picker.modalPresentationStyle = .fullScreen
      self.presentViewController(picker)
    }
  }

  private func presentViewController(_ viewControllerToPresent: UIViewController) {
    self.manager.viewController?.present(viewControllerToPresent, animated: true, completion: nil)
  }

  @available(iOS 14, *)
  private func parseFiltersOption(_ filters: [Filter]) -> [UTType] {
    var parsedTypes: [UTType] = []
    for filter in filters {
      for ext in filter.extensions ?? [] {
        // We need to support extensions as well as MIME types.
        if let utType = UTType(mimeType: ext) {
          parsedTypes.append(utType)
        } else if let utType = UTType(filenameExtension: ext) {
          parsedTypes.append(utType)
        }
      }
    }

    return parsedTypes
  }

  /// This function is only used for iOS < 14, and should be removed if/when the deployment target is raised to 14.
  private func showFilePickerLegacy(args: FilePickerOptions) {
    let parsedTypes = parseFiltersOptionLegacy(args.filters ?? [])

    var filtersIncludeImage: Bool = false
    var filtersIncludeVideo: Bool = false
    var filtersIncludeNonMedia: Bool = false

    if !parsedTypes.isEmpty {
      let mimeKinds = Set(parsedTypes.map { $0.components(separatedBy: "/")[0] })
      filtersIncludeImage = mimeKinds.contains("image")
      filtersIncludeVideo = mimeKinds.contains("video")
      filtersIncludeNonMedia = mimeKinds.contains(where: { $0 != "image" && $0 != "video" })
    }

    if !filtersIncludeNonMedia && (filtersIncludeImage || filtersIncludeVideo) {
      DispatchQueue.main.async {
        let picker = UIImagePickerController()
        picker.delegate = self.filePickerController

        if filtersIncludeImage && !filtersIncludeVideo {
          picker.sourceType = .photoLibrary
        }

        picker.modalPresentationStyle = .fullScreen
        self.presentViewController(picker)
      }
    } else {
      let documentTypes = parsedTypes.isEmpty ? ["public.data"] : parsedTypes
      DispatchQueue.main.async {
        let picker = UIDocumentPickerViewController(documentTypes: documentTypes, in: .import)
        if let defaultPath = args.defaultPath {
          picker.directoryURL = URL(string: defaultPath)
        }

        picker.delegate = self.filePickerController
        picker.allowsMultipleSelection = args.multiple ?? false
        picker.modalPresentationStyle = .fullScreen
        self.presentViewController(picker)
      }
    }
  }

  /// This function is only used for iOS < 14, and should be removed if/when the deployment target is raised to 14.
  private func parseFiltersOptionLegacy(_ filters: [Filter]) -> [String] {
    var parsedTypes: [String] = []
    for filter in filters {
      for ext in filter.extensions ?? [] {
        guard
          let utType: String = UTTypeCreatePreferredIdentifierForTag(
            kUTTagClassMIMEType, ext as CFString, nil)?.takeRetainedValue() as String?
        else {
          continue
        }
        parsedTypes.append(utType)
      }
    }

    return parsedTypes
  }

  public func onFilePickerEvent(_ event: FilePickerEvent) {
    self.onFilePickerResult?(event)
  }

  @objc public func showMessageDialog(_ invoke: Invoke) throws {
    let manager = self.manager
    let args = try invoke.parseArgs(MessageDialogOptions.self)

    DispatchQueue.main.async { [] in
      let alert = UIAlertController(
        title: args.title, message: args.message, preferredStyle: UIAlertController.Style.alert)

      if let cancelButtonLabel = args.cancelButtonLabel {
        alert.addAction(
          UIAlertAction(
            title: cancelButtonLabel, style: UIAlertAction.Style.default,
            handler: { (_) -> Void in
              invoke.resolve(["value": cancelButtonLabel])
            }
          )
        )
      }

      if let noButtonLabel = args.noButtonLabel {
        alert.addAction(
          UIAlertAction(
            title: noButtonLabel, style: UIAlertAction.Style.default,
            handler: { (_) -> Void in
              invoke.resolve(["value": noButtonLabel])
            }
          )
        )
      }

      let okButtonLabel = args.okButtonLabel ?? "Ok"
      alert.addAction(
        UIAlertAction(
          title: okButtonLabel, style: UIAlertAction.Style.default,
          handler: { (_) -> Void in
            invoke.resolve(["value": okButtonLabel])
          }
        )
      )

      manager.viewController?.present(alert, animated: true, completion: nil)
    }
  }

}

@_cdecl("init_plugin_dialog")
func initPlugin() -> Plugin {
  return DialogPlugin()
}
