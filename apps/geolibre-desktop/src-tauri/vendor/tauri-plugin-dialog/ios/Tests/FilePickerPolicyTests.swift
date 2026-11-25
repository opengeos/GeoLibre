import Foundation

/// Run with the real policy source, without UIKit or the Tauri build graph.
@main
struct FilePickerPolicyTests {
  static func main() throws {
    var cases = 0
    func check(
      _ expected: Bool, _ access: FileAccessMode?, _ mode: PickerMode?, _ mimeKinds: Set<String>
    ) {
      precondition(
        usesMediaPicker(fileAccessMode: access, pickerMode: mode, mimeKinds: mimeKinds) == expected,
        "Unexpected document/media picker choice")
      cases += 1
    }

    let modes: [PickerMode?] = [nil, .document, .media, .image, .video]
    for mode in modes {
      check(false, .copy, mode, ["image"])
      check(false, .copy, mode, ["video"])
      check(false, .copy, mode, [])
    }
    check(true, nil, nil, ["image"])
    check(true, nil, nil, ["video"])
    check(true, nil, nil, ["image", "video"])
    check(false, nil, nil, [])
    check(false, nil, nil, ["image", "application"])
    check(true, nil, .media, ["application"])
    check(true, nil, .image, [])
    check(true, nil, .video, [])
    check(true, .scoped, .image, ["image"])
    check(false, .scoped, .document, ["application"])
    let access = try JSONDecoder().decode(FileAccessMode.self, from: Data("\"copy\"".utf8))
    check(false, access, .image, ["image"])
    print("iOS picker policy: \(cases) scenarios passed")
  }
}
