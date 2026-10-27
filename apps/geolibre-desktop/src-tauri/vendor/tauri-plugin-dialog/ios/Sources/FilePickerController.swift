// Copyright 2019-2023 Tauri Programme within The Commons Conservancy
// SPDX-License-Identifier: Apache-2.0
// SPDX-License-Identifier: MIT

import UIKit
import MobileCoreServices
import PhotosUI
import Photos
import Tauri

public class FilePickerController: NSObject {
  var plugin: DialogPlugin

	init(_ dialogPlugin: DialogPlugin) {
		plugin = dialogPlugin
	}

	private func dismissViewController(_ viewControllerToPresent: UIViewController, completion: (() -> Void)? = nil) {
		viewControllerToPresent.dismiss(animated: true, completion: completion)
	}

	public func getModifiedAtFromUrl(_ url: URL) -> Int? {
		do {
			let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
			if let modifiedDateInSec = (attributes[.modificationDate] as? Date)?.timeIntervalSince1970 {
					return Int(modifiedDateInSec * 1000.0)
			} else {
					return nil
			}
		} catch let error as NSError {
			Logger.error("getModifiedAtFromUrl failed", error.localizedDescription)
			return nil
    }
  }

	public func getMimeTypeFromUrl(_ url: URL) -> String {
		let fileExtension = url.pathExtension as CFString
		guard let extUTI = UTTypeCreatePreferredIdentifierForTag(kUTTagClassFilenameExtension, fileExtension, nil)?.takeUnretainedValue() else {
			return ""
		}
		guard let mimeUTI = UTTypeCopyPreferredTagWithClass(extUTI, kUTTagClassMIMEType) else {
			return ""
		}
		return mimeUTI.takeRetainedValue() as String
	}

	public func getSizeFromUrl(_ url: URL) throws -> Int {
		let values = try url.resourceValues(forKeys: [.fileSizeKey])
		return values.fileSize ?? 0
	}

	public func getVideoDuration(_ url: URL) -> Int {
		let asset = AVAsset(url: url)
		let duration = asset.duration
		let durationTime = CMTimeGetSeconds(duration)
		return Int(round(durationTime))
	}

	public func getImageDimensions(_ url: URL) -> (Int?, Int?) {
		if let imageSource = CGImageSourceCreateWithURL(url as CFURL, nil) {
			if let imageProperties = CGImageSourceCopyPropertiesAtIndex(imageSource, 0, nil) as Dictionary? {
				return getHeightAndWidthFromImageProperties(imageProperties)
			}
		}
		return (nil, nil)
	}

	public func getVideoDimensions(_ url: URL) -> (Int?, Int?) {
		guard let track = AVURLAsset(url: url).tracks(withMediaType: AVMediaType.video).first else { return (nil, nil) }
		let size = track.naturalSize.applying(track.preferredTransform)
		let height = abs(Int(size.height))
		let width = abs(Int(size.width))
		return (height, width)
	}

	private func getHeightAndWidthFromImageProperties(_ properties: [NSObject: AnyObject]) -> (Int?, Int?) {
		let width = properties[kCGImagePropertyPixelWidth] as? Int
		let height = properties[kCGImagePropertyPixelHeight] as? Int
		let orientation = properties[kCGImagePropertyOrientation] as? Int ?? UIImage.Orientation.up.rawValue
		switch orientation {
		case UIImage.Orientation.left.rawValue, UIImage.Orientation.right.rawValue, UIImage.Orientation.leftMirrored.rawValue, UIImage.Orientation.rightMirrored.rawValue:
			return (width, height)
		default:
			return (height, width)
		}
	}

	private func getFileUrlByPath(_ path: String) -> URL? {
		guard let url = URL.init(string: path) else {
			return nil
		}
		if FileManager.default.fileExists(atPath: url.path) {
			return url
		} else {
			return nil
		}
	}

	/// ## In which cases do we need to save a copy of a file selected by a user to the app sandbox?
	/// In short, only when the file is **not** selected using UIDocumentPickerDelegate.
	/// For the rest of the cases, we need to write a copy of the file to the app sandbox.
	///
	/// For PHPicker (used for photos and videos), `NSItemProvider.loadFileRepresentation` returns a temporary file URL that is deleted after the completion handler.
	/// The recommendation is to [Persist](https://developer.apple.com/documentation/foundation/nsitemprovider/2888338-loadfilerepresentation) the file by moving/copying
	/// it to your app’s directory within the completion handler.
	///
	/// If available, `loadInPlaceFileRepresentation` can open a file in place; Photos assets typically do not support true in-place access,
	/// so fall back to persisting a local file.
	/// Ref: https://developer.apple.com/documentation/foundation/nsitemprovider/2888335-loadinplacefilerepresentation
	///
	/// For UIDocumentPicker, prefer "open in place" and avoid copying when possible.
	/// Ref: https://developer.apple.com/documentation/uikit/uidocumentpickerviewcontroller
	private func saveTemporaryFile(_ sourceUrl: URL) throws -> URL {

		var directory = URL(fileURLWithPath: NSTemporaryDirectory())
		if let cachesDirectory = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first {
			directory = cachesDirectory
		}

		let targetUrl = directory.appendingPathComponent(sourceUrl.lastPathComponent)
		do {
			try deleteFile(targetUrl)
		}

		try FileManager.default.copyItem(at: sourceUrl, to: targetUrl)
		return targetUrl
	}

	private func deleteFile(_ url: URL) throws {
		if FileManager.default.fileExists(atPath: url.path) {
			try FileManager.default.removeItem(atPath: url.path)
		}
	}
}

extension FilePickerController: UIDocumentPickerDelegate {
	public func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
		do {
			self.plugin.onFilePickerEvent(.selected(urls))
		} catch {
			self.plugin.onFilePickerEvent(.error("Failed to create a temporary copy of the file"))
		}
	}

	public func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
		self.plugin.onFilePickerEvent(.cancelled)
	}
}

extension FilePickerController: UIImagePickerControllerDelegate, UINavigationControllerDelegate, UIPopoverPresentationControllerDelegate {
	public func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
		dismissViewController(picker)
		self.plugin.onFilePickerEvent(.cancelled)
	}

	public func popoverPresentationControllerDidDismissPopover(_ popoverPresentationController: UIPopoverPresentationController) {
		self.plugin.onFilePickerEvent(.cancelled)
	}

	public func presentationControllerDidDismiss(_ presentationController: UIPresentationController) {
		self.plugin.onFilePickerEvent(.cancelled)
	}

	public func imagePickerController(_ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
		dismissViewController(picker) {
			if let url = info[.mediaURL] as? URL {
				do {
					let temporaryUrl = try self.saveTemporaryFile(url)
					self.plugin.onFilePickerEvent(.selected([temporaryUrl]))
				} catch {
					self.plugin.onFilePickerEvent(.error("Failed to create a temporary copy of the file"))
				}
			} else {
				self.plugin.onFilePickerEvent(.cancelled)
			}
		}
	}
}

@available(iOS 14, *)
extension FilePickerController: PHPickerViewControllerDelegate {
	public func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
		dismissViewController(picker)
		if results.first == nil {
			self.plugin.onFilePickerEvent(.cancelled)
			return
		}
		var temporaryUrls: [URL] = []
		var errorMessage: String?
		let dispatchGroup = DispatchGroup()
		for result in results {
			if errorMessage != nil {
				break
			}
			if result.itemProvider.hasItemConformingToTypeIdentifier(UTType.movie.identifier) {
				dispatchGroup.enter()
				result.itemProvider.loadFileRepresentation(forTypeIdentifier: UTType.movie.identifier, completionHandler: { url, error in
					defer {
						dispatchGroup.leave()
					}
					if let error = error {
						errorMessage = error.localizedDescription
						return
					}
					guard let url = url else {
						errorMessage = "Unknown error"
						return
					}
					do {
						// We have to make a copy of the file to the app sandbox here, as PHPicker returns an NSItemProvider with either an ephemeral file URL or content that is deleted after the completion handler.
						// This is a different behavior from UIDocumentPicker, where the file can either be copied to the app sandbox or opened in place, and then accessed with `startAccessingSecurityScopedResource`.
						let temporaryUrl = try self.saveTemporaryFile(url)
						temporaryUrls.append(temporaryUrl)
					} catch {
						errorMessage = "Failed to create a temporary copy of the file"
					}
				})
			} else if result.itemProvider.hasItemConformingToTypeIdentifier(UTType.image.identifier) {
				dispatchGroup.enter()
				result.itemProvider.loadFileRepresentation(forTypeIdentifier: UTType.image.identifier, completionHandler: { url, error in
					defer {
						dispatchGroup.leave()
					}
					if let error = error {
						errorMessage = error.localizedDescription
						return
					}
					guard let url = url else {
						errorMessage = "Unknown error"
						return
					}
					do {
						// We have to make a copy of the file to the app sandbox here, as PHPicker returns an NSItemProvider with either an ephemeral file URL or content that is deleted after the completion handler.
						// This is a different behavior from UIDocumentPicker, where the file can either be copied to the app sandbox or opened in place, and then accessed with `startAccessingSecurityScopedResource`.
						let temporaryUrl = try self.saveTemporaryFile(url)
						temporaryUrls.append(temporaryUrl)
					} catch {
						errorMessage = "Failed to create a temporary copy of the file"
					}
				})
			} else {
				errorMessage = "Unsupported file type identifier"
			}
		}
		dispatchGroup.notify(queue: .main) {
			if let errorMessage = errorMessage {
				self.plugin.onFilePickerEvent(.error(errorMessage))
				return
			}
			self.plugin.onFilePickerEvent(.selected(temporaryUrls))
		}
	}
}
