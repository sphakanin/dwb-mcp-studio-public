import AppKit
import WebKit
import Security

// This executable also provides a small Keychain bridge. Input and output use
// pipes; API keys never enter a shell, argv, preferences, or a profile file.
if CommandLine.arguments.contains("--keychain") {
    do {
        let data = FileHandle.standardInput.readDataToEndOfFile()
        guard data.count <= 32768,
              let request = try JSONSerialization.jsonObject(with: data) as? [String: String],
              let service = request["service"], service.hasPrefix("com.dwb.mcp-studio."),
              let account = request["account"], let operation = request["operation"] else {
            throw NSError(domain: "DWB", code: 1)
        }
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
                                    kSecAttrService as String: service, kSecAttrAccount as String: account]
        var result: [String: Any] = ["ok": true]
        var status: OSStatus = errSecSuccess
        switch operation {
        case "get":
            var lookup = query
            lookup[kSecReturnData as String] = true
            lookup[kSecMatchLimit as String] = kSecMatchLimitOne
            var value: CFTypeRef?
            status = SecItemCopyMatching(lookup as CFDictionary, &value)
            if status == errSecItemNotFound { status = errSecSuccess; result["secret"] = "" }
            else if let bytes = value as? Data { result["secret"] = String(data: bytes, encoding: .utf8) ?? "" }
        case "set":
            guard let secret = request["secret"], !secret.isEmpty else { throw NSError(domain: "DWB", code: 2) }
            let attributes: [String: Any] = [kSecValueData as String: Data(secret.utf8)]
            status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
            if status == errSecItemNotFound {
                var item = query; item[kSecValueData as String] = Data(secret.utf8)
                status = SecItemAdd(item as CFDictionary, nil)
            }
        case "delete":
            status = SecItemDelete(query as CFDictionary)
            if status == errSecItemNotFound { status = errSecSuccess }
        default: throw NSError(domain: "DWB", code: 3)
        }
        guard status == errSecSuccess else { throw NSError(domain: NSOSStatusErrorDomain, code: Int(status)) }
        FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: result))
        exit(0)
    } catch {
        FileHandle.standardError.write(Data("Keychain operation failed. Unlock the login keychain and allow DWB access, then retry.\n".utf8))
        exit(1)
    }
}

final class StudioApp: NSObject, NSApplicationDelegate, NSWindowDelegate, WKScriptMessageHandler, WKNavigationDelegate {
    var window: NSWindow!
    var web: WKWebView!
    var statusItem: NSStatusItem!
    var service: Process?
    var serviceInput: Pipe?
    var outputBuffer = Data()
    var controlURL: URL?
    var closeToMenuBar = true
    var minimizeToMenuBar = false
    var quitting = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        if let icon = Bundle.main.url(forResource: "dwb-logo", withExtension: "png") { NSApp.applicationIconImage = NSImage(contentsOf: icon) }
        let mainMenu = NSMenu()
        let appItem = NSMenuItem(); let appMenu = NSMenu()
        appMenu.addItem(withTitle: "Quit DWB MCP Studio", action: #selector(quitApp), keyEquivalent: "q").target = self
        appItem.submenu = appMenu; mainMenu.addItem(appItem)
        let editItem = NSMenuItem(); let editMenu = NSMenu(title: "Edit")
        editMenu.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        editMenu.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = editMenu; mainMenu.addItem(editItem); NSApp.mainMenu = mainMenu
        let content = WKUserContentController(); content.add(self, name: "dwb")
        let configuration = WKWebViewConfiguration(); configuration.userContentController = content
        configuration.websiteDataStore = .nonPersistent()
        web = WKWebView(frame: .zero, configuration: configuration); web.navigationDelegate = self
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1060, height: 800),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = "DWB MCP Studio"; window.minSize = NSSize(width: 650, height: 500)
        window.contentView = web; window.delegate = self; window.isReleasedWhenClosed = false; window.center()
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        statusItem.button?.title = "DWB"
        let menu = NSMenu()
        menu.addItem(withTitle: "Open DWB MCP Studio", action: #selector(showWindow), keyEquivalent: "").target = self
        menu.addItem(withTitle: "Stop MCP", action: #selector(stopMCP), keyEquivalent: "").target = self
        menu.addItem(.separator())
        menu.addItem(withTitle: "Stop MCP and Quit", action: #selector(quitApp), keyEquivalent: "").target = self
        statusItem.menu = menu
        if !CommandLine.arguments.contains("--background") { showWindow() }
        startService()
    }
    func startService() {
        do {
            let root = Bundle.main.bundleURL.deletingLastPathComponent()
            guard let runtimeURL = Bundle.main.url(forResource: "runtime", withExtension: "json"),
                  let runtime = try JSONSerialization.jsonObject(with: Data(contentsOf: runtimeURL)) as? [String: String],
                  let node = runtime["node"] else { throw NSError(domain: "DWB", code: 4) }
            let child = Process(); child.executableURL = URL(fileURLWithPath: node)
            child.arguments = [root.appendingPathComponent("scripts/macos/server.mjs").path]
            child.currentDirectoryURL = root
            var environment = ProcessInfo.processInfo.environment
            environment["PATH"] = URL(fileURLWithPath: node).deletingLastPathComponent().path + ":/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
            child.environment = environment
            let input = Pipe(), output = Pipe(), errors = Pipe()
            serviceInput = input; child.standardInput = input; child.standardOutput = output; child.standardError = errors
            output.fileHandleForReading.readabilityHandler = { [weak self] handle in
                let bytes = handle.availableData
                if bytes.isEmpty { handle.readabilityHandler = nil; return }
                DispatchQueue.main.async {
                    guard let self = self, self.controlURL == nil else { return }
                    self.outputBuffer.append(bytes)
                    if self.outputBuffer.count > 32768 { self.alert("Unexpected control service response."); return }
                    if let text = String(data: self.outputBuffer, encoding: .utf8), text.contains("\n"), let line = text.split(separator: "\n").first,
                       let url = URL(string: String(line)), url.host == "127.0.0.1", url.scheme == "http", url.fragment != nil {
                        self.controlURL = url; self.web.load(URLRequest(url: url)); self.outputBuffer.removeAll()
                    }
                }
            }
            // Drain stderr without surfacing environment or accidental secret material.
            errors.fileHandleForReading.readabilityHandler = { handle in
                if handle.availableData.isEmpty { handle.readabilityHandler = nil }
            }
            child.terminationHandler = { [weak self] _ in DispatchQueue.main.async {
                guard let self = self, !self.quitting else { return }
                self.alert("The local control service stopped. If another DWB window is already open, use its menu bar icon. Otherwise reopen this app or rerun Install DWB MCP Studio.command.")
            } }
            try child.run(); service = child
        } catch { alert("Cannot start Node.js. Run Install DWB MCP Studio.command again to rebuild the app for this machine.") }
    }
    func alert(_ text: String) { let box = NSAlert(); box.messageText = "DWB MCP Studio"; box.informativeText = text; box.runModal() }
    @objc func showWindow() { NSApp.activate(ignoringOtherApps: true); if window.isMiniaturized { window.deminiaturize(nil) }; window.makeKeyAndOrderFront(nil) }
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool { showWindow(); return true }
    func windowShouldClose(_ sender: NSWindow) -> Bool {
        if closeToMenuBar { sender.orderOut(nil) } else { quitApp() }
        return false
    }
    func windowDidMiniaturize(_ notification: Notification) {
        if minimizeToMenuBar { window.orderOut(nil); window.deminiaturize(nil); window.orderOut(nil) }
    }
    func request(_ path: String, completion: @escaping (Bool, String) -> Void) {
        guard let url = controlURL, let token = url.fragment,
              let destination = URL(string: path, relativeTo: url) else { completion(true, ""); return }
        var request = URLRequest(url: destination); request.httpMethod = "POST"; request.httpBody = Data("{}".utf8)
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer " + token, forHTTPHeaderField: "Authorization")
        URLSession.shared.dataTask(with: request) { data, response, error in
            let ok = (response as? HTTPURLResponse)?.statusCode == 200 && error == nil
            let result = data.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
            DispatchQueue.main.async { completion(ok, result?["error"] as? String ?? "Finish active work and try again.") }
        }.resume()
    }
    @objc func stopMCP() { request("/api/stop") { ok, error in if !ok { self.alert(error) } } }
    @objc func quitApp() { NSApp.terminate(nil) }
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        if quitting || service?.isRunning != true || controlURL == nil { return .terminateNow }
        request("/api/quit") { ok, error in
            if ok { self.quitting = true; self.serviceInput?.fileHandleForWriting.closeFile() }
            else { self.alert(error) }
            NSApp.reply(toApplicationShouldTerminate: ok)
        }
        return .terminateLater
    }
    func applicationWillTerminate(_ notification: Notification) { serviceInput?.fileHandleForWriting.closeFile(); if service?.isRunning == true { service?.terminate() } }
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.frameInfo.isMainFrame, let body = message.body as? [String: Any], let action = body["action"] as? String else { return }
        switch action {
        case "preferences": closeToMenuBar = body["closeToMenuBar"] as? Bool ?? true; minimizeToMenuBar = body["minimizeToMenuBar"] as? Bool ?? false
        case "quit": quitApp()
        case "chooseFolder":
            let panel = NSOpenPanel(); panel.canChooseDirectories = true; panel.canChooseFiles = false; panel.allowsMultipleSelection = false
            panel.beginSheetModal(for: window) { response in
                if response == .OK, let path = panel.url?.path,
                   let data = try? JSONSerialization.data(withJSONObject: [path]), let literal = String(data: data, encoding: .utf8) {
                    self.web.evaluateJavaScript("window.dwbChooseFolder(" + literal + "[0])", completionHandler: nil)
                }
            }
        default: break
        }
    }
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url, let allowed = controlURL,
              url.scheme == allowed.scheme, url.host == allowed.host, url.port == allowed.port else { decisionHandler(.cancel); return }
        decisionHandler(.allow)
    }
}
let app = NSApplication.shared
let delegate = StudioApp()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
