// Native user presence without collecting or passing the user's password to JavaScript.
import Foundation
import LocalAuthentication
import AppKit

if let command = CommandLine.arguments.dropFirst().first, command == "copy" || command == "clear" {
    let data = FileHandle.standardInput.readDataToEndOfFile()
    guard data.count <= 32768, let text = String(data: data, encoding: .utf8), !text.isEmpty else { exit(2) }
    let pasteboard = NSPasteboard.general
    if command == "copy" {
        pasteboard.prepareForNewContents(with: .currentHostOnly)
        guard pasteboard.setString(text, forType: .string) else { exit(3) }
        pasteboard.setString("", forType: NSPasteboard.PasteboardType("org.nspasteboard.ConcealedType"))
        pasteboard.setString("", forType: NSPasteboard.PasteboardType("org.nspasteboard.TransientType"))
    } else if pasteboard.string(forType: .string) == text {
        pasteboard.clearContents()
    }
    exit(0)
}

let context = LAContext()
context.localizedCancelTitle = "取消"
var error: NSError?
guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &error) else { exit(2) }
context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: "允许 Dublin Lab 访问本机保存的 API 密钥") { success, _ in
    exit(success ? 0 : 1)
}
RunLoop.main.run()
