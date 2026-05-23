import SwiftRs
import Tauri
import UIKit
import UniformTypeIdentifiers
import WebKit

// Vault access on iOS. The app is sandboxed, so a vault folder is reached
// only through a security-scoped bookmark: pickFolder opens the Files
// folder picker, mints a bookmark, and persists it; restore resolves that
// bookmark on launch and opens scoped access for the session. The Rust FS
// bridge then reads/writes under the returned path.
class VaultPlugin: Plugin, UIDocumentPickerDelegate {
  static let bookmarkKey = "order.vaultBookmark"
  var pickInvoke: Invoke?

  @objc public func pickFolder(_ invoke: Invoke) throws {
    self.pickInvoke = invoke
    DispatchQueue.main.async {
      let picker = UIDocumentPickerViewController(
        forOpeningContentTypes: [UTType.folder], asCopy: false)
      picker.delegate = self
      picker.allowsMultipleSelection = false
      picker.modalPresentationStyle = .fullScreen
      self.manager.viewController?.present(picker, animated: true, completion: nil)
    }
  }

  func documentPicker(
    _ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]
  ) {
    guard let url = urls.first else {
      pickInvoke?.resolve([:])
      pickInvoke = nil
      return
    }
    let accessed = url.startAccessingSecurityScopedResource()
    defer { if accessed { url.stopAccessingSecurityScopedResource() } }
    do {
      // iOS bookmarks from a document-picker URL are implicitly
      // security-scoped (no .withSecurityScope option as on macOS).
      let bookmark = try url.bookmarkData(
        options: [], includingResourceValuesForKeys: nil, relativeTo: nil)
      UserDefaults.standard.set(bookmark, forKey: VaultPlugin.bookmarkKey)
      pickInvoke?.resolve(["path": url.path, "name": url.lastPathComponent])
    } catch {
      pickInvoke?.reject("failed to bookmark folder: \(error.localizedDescription)")
    }
    pickInvoke = nil
  }

  func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
    pickInvoke?.resolve([:])
    pickInvoke = nil
  }

  @objc public func restore(_ invoke: Invoke) throws {
    guard let data = UserDefaults.standard.data(forKey: VaultPlugin.bookmarkKey) else {
      invoke.resolve([:])
      return
    }
    var stale = false
    do {
      let url = try URL(
        resolvingBookmarkData: data, options: [], relativeTo: nil, bookmarkDataIsStale: &stale)
      // Keep scoped access open for the app session so the Rust FS bridge
      // can read/write under this path. (No matching stop — released on
      // process exit.)
      if url.startAccessingSecurityScopedResource() {
        invoke.resolve(["path": url.path])
      } else {
        invoke.resolve([:])  // can't access -> caller prompts a re-pick
      }
    } catch {
      invoke.resolve([:])  // stale/unresolvable -> caller prompts a re-pick
    }
  }
}

@_cdecl("init_plugin_vault")
func initPlugin() -> Plugin {
  return VaultPlugin()
}
