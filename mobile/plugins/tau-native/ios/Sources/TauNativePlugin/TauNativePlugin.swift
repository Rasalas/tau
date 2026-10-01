import ActivityKit
import AVFoundation
import Capacitor
import Foundation
import UIKit

/// The Tau app's own native side: Keychain, pinned sockets, the QR scanner
/// and Bonjour. `mobile/src/native.ts` is its TypeScript face.
@objc(TauNativePlugin)
public class TauNativePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "TauNativePlugin"
    public let jsName = "TauNative"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "activityRemoteStatus", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "activityRemoteConfigure", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "activityRemoteDisable", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "activityKey", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "activityTokens", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "activityUpdate", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "activityUsage", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "activityClear", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "dictationLanguages", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "dictationDownload", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "dictationStart", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "dictationFinish", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "dictationCancel", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "secureGet", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "secureSet", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "secureRemove", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "socketOpen", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "socketSend", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "socketClose", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "scanQr", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "discoveryStart", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "discoveryStop", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "deviceInfo", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "pushAvailable", returnType: CAPPluginReturnPromise)
    ]

    private var dictationBackgroundObserver: NSObjectProtocol?
    private var localDictation: Any?

    private let lock = NSLock()
    private var sockets: [String: PinnedSocket] = [:]
    private var relays: [String: ConnectRelay] = [:]
    private var browser: HostBrowser?

    override public func load() {
        SecureStore.forgetAfterReinstall()
        dictationBackgroundObserver = NotificationCenter.default.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in
                if #available(iOS 26.0, *), let dictation = self?.localDictation as? LocalDictation { dictation.cancel() }
            }
        }
        // Capacitor lets script focus raise the keyboard; the composer takes focus on every
        // thread, so a phone would open with half its screen covered. Only a tap opens it.
        DispatchQueue.main.async { [weak self] in
            self?.bridge?.webView?.capacitor.setKeyboardShouldRequireUserInteraction(nil)
        }
    }

    @available(iOS 26.0, *)
    @MainActor private func dictation() -> LocalDictation {
        if let current = localDictation as? LocalDictation { return current }
        let current = LocalDictation(); localDictation = current; return current
    }
    @objc func dictationLanguages(_ call: CAPPluginCall) {
        Task { @MainActor in
            guard #available(iOS 26.0, *) else { call.resolve(["available": false, "languages": []]); return }
            let languages = await dictation().languages()
            call.resolve(["available": !languages.isEmpty, "languages": languages])
        }
    }
    @objc func dictationDownload(_ call: CAPPluginCall) { dictationAction(call, action: "download") }
    @objc func dictationStart(_ call: CAPPluginCall) { dictationAction(call, action: "start") }
    @objc func dictationFinish(_ call: CAPPluginCall) { dictationAction(call, action: "finish") }
    @objc func dictationCancel(_ call: CAPPluginCall) { dictationAction(call, action: "cancel") }
    private func dictationAction(_ call: CAPPluginCall, action: String) {
        Task { @MainActor in
            guard #available(iOS 26.0, *) else { call.reject("Local dictation requires iOS 26.", "unavailable"); return }
            do {
                let current = dictation()
                if action == "cancel" { current.cancel(); call.resolve(); return }
                if action == "finish" { call.resolve(["text": try await current.finish()]); return }
                guard let language = call.getString("language") else { call.reject("Choose a dictation language."); return }
                if action == "download" { try await current.download(language) } else { try await current.start(language) }
                call.resolve()
            } catch { call.reject(error.localizedDescription, "dictation-failed") }
        }
    }

    @objc func activityRemoteStatus(_ call: CAPPluginCall) {
        guard let host = call.getString("hostId") else { call.reject("hostId is required"); return }
        Task { @MainActor in call.resolve(ActivityRemote.status(host)) }
    }
    @objc func activityRemoteConfigure(_ call: CAPPluginCall) {
        Task { @MainActor in
            do { try await ActivityRemote.configure(call.options as? [String: Any] ?? [:]); call.resolve() }
            catch { call.reject("Remote Live Activities could not be enabled.", "activity-unavailable") }
        }
    }
    @objc func activityRemoteDisable(_ call: CAPPluginCall) {
        guard let host = call.getString("hostId") else { call.reject("hostId is required"); return }
        Task { @MainActor in do { try await ActivityRemote.disable(host); call.resolve() } catch { call.reject("Remote Live Activities could not be disabled.") } }
    }
    @objc func activityKey(_ call: CAPPluginCall) {
        guard let host = call.getString("hostId"), let keyId = call.getString("keyId"), let key = call.getString("key") else { call.reject("A host and an activity key are required."); return }
        do { try ActivityCipher.install(host: host, keyId: keyId, key: key); call.resolve() } catch { call.reject("The shared activity keychain could not save this key.", "activity-keychain") }
    }
    @objc func activityTokens(_ call: CAPPluginCall) {
        if #available(iOS 16.2, *) {
            let tokens = Activity<TauActivityAttributes>.activities.compactMap { activity -> [String: Any]? in
                guard let host = activity.attributes.hostId, let thread = activity.attributes.threadId, let token = activity.pushToken else { return nil }
                return ["hostId": host, "threadId": thread, "token": token.map { String(format: "%02x", $0) }.joined(), "topic": Bundle.main.bundleIdentifier ?? "de.tbuck.tau"]
            }
            call.resolve(["tokens": tokens])
        } else { call.resolve(["tokens": []]) }
    }
    @objc func activityUpdate(_ call: CAPPluginCall) {
        Task { @MainActor [weak self] in
            guard #available(iOS 16.2, *) else { call.resolve(); return }
            do { try await MobileActivityStore.update(call.options as? [String: Any] ?? [:]) { [weak self] event in self?.notifyListeners("activityToken", data: event, retainUntilConsumed: true) }; call.resolve() } catch { call.reject(error.localizedDescription) }
        }
    }
    @objc func activityUsage(_ call: CAPPluginCall) { MobileActivityStore.usage(call.options as? [String: Any] ?? [:]); call.resolve() }
    @objc func activityClear(_ call: CAPPluginCall) {
        guard let host = call.getString("hostId") else { call.reject("hostId is required"); return }
        Task { @MainActor in try? await ActivityRemote.disable(host); await MobileActivityStore.clear(host); call.resolve() }
    }

    // MARK: Secure store

    @objc func secureGet(_ call: CAPPluginCall) {
        guard let key = call.getString("key") else { return call.reject("key is required") }
        do {
            if let value = try SecureStore.get(key) { call.resolve(["value": value]) } else { call.resolve([:]) }
        } catch {
            call.reject("\(error)")
        }
    }

    @objc func secureSet(_ call: CAPPluginCall) {
        guard let key = call.getString("key"), let value = call.getString("value") else { return call.reject("key and value are required") }
        do { try SecureStore.set(key, value); call.resolve() } catch { call.reject("\(error)") }
    }

    @objc func secureRemove(_ call: CAPPluginCall) {
        guard let key = call.getString("key") else { return call.reject("key is required") }
        do { try SecureStore.remove(key); call.resolve() } catch { call.reject("\(error)") }
    }

    // MARK: Sockets

    @objc func socketOpen(_ call: CAPPluginCall) {
        guard let id = call.getString("id"), let text = call.getString("url"), let url = URL(string: text),
              url.scheme == "ws" || url.scheme == "wss" else { return call.reject("id and a ws: or wss: url are required") }
        var headers: [String: String] = [:]
        for (name, value) in call.getObject("headers") ?? [:] { if let value = value as? String { headers[name] = value } }
        let open: (URL) -> Void = { [weak self] socketURL in
            guard let self else { return }
            let socket = PinnedSocket(id: id, url: socketURL, keyPin: call.getString("publicKey"), pin: call.getString("fingerprint"), allowAuthority: call.getObject("connect") == nil && (call.getBool("allowAuthority") ?? false), headers: headers) { [weak self] event in
                guard let self else { return }
                if event["type"] as? String == "close" { self.forget(id) }
                self.notifyListeners("socket", data: event)
            }
            self.lock.lock(); self.sockets[id] = socket; self.lock.unlock()
            call.resolve()
        }
        guard let connect = call.getObject("connect") else { open(url); return }
        guard url.scheme == "wss", url.host != nil, url.user == nil, url.password == nil,
              call.getString("publicKey") != nil || call.getString("fingerprint") != nil,
              let remoteText = connect["url"] as? String, let remote = URL(string: remoteText),
              remote.scheme == "wss", remote.host != nil, remote.user == nil, remote.password == nil, remote.fragment == nil,
              let token = connect["token"] as? String, token.range(of: "^[A-Za-z0-9_-]{43}$", options: .regularExpression) != nil
        else { call.reject("Connect requires a secure relay and a pinned host."); return }
        let relay = ConnectRelay(remote: remote, token: token) { [weak self] in
            guard let self else { return }
            if let socket = self.find(id) { socket.close(code: 1006, reason: "Connect relay disconnected.") }
            else { self.forget(id); self.notifyListeners("socket", data: ["id": id, "type": "close", "code": 1006]) }
        }
        lock.lock(); relays[id] = relay; lock.unlock()
        relay.start(inner: url) { result in
            switch result {
            case .success(let local): open(local)
            case .failure: self.forget(id); call.reject("Connect relay could not start.")
            }
        }
    }

    @objc func socketSend(_ call: CAPPluginCall) {
        guard let id = call.getString("id"), let data = call.getString("data") else { return call.reject("id and data are required") }
        guard let socket = find(id) else { return call.reject("unknown socket", "unknown-socket") }
        socket.send(data)
        call.resolve()
    }

    @objc func socketClose(_ call: CAPPluginCall) {
        guard let id = call.getString("id") else { return call.reject("id is required") }
        guard let socket = find(id) else {
            lock.lock(); let relay = relays.removeValue(forKey: id); lock.unlock()
            if let relay { relay.close(); notifyListeners("socket", data: ["id": id, "type": "close", "code": call.getInt("code") ?? 1000]); call.resolve() } else { call.reject("unknown socket", "unknown-socket") }
            return
        }
        socket.close(code: call.getInt("code") ?? 1000, reason: call.getString("reason"))
        call.resolve()
    }

    private func find(_ id: String) -> PinnedSocket? {
        lock.lock(); defer { lock.unlock() }
        return sockets[id]
    }

    private func forget(_ id: String) {
        lock.lock(); sockets.removeValue(forKey: id); let relay = relays.removeValue(forKey: id); lock.unlock()
        relay?.close()
    }

    // MARK: QR scanner

    @objc func scanQr(_ call: CAPPluginCall) {
        guard AVCaptureDevice.default(for: .video) != nil else { return call.reject("This device has no camera.", "no-camera") }
        let present = { [weak self] in
            DispatchQueue.main.async {
                guard let host = self?.bridge?.viewController else { return call.reject("No window to scan in.") }
                host.present(QrScannerController { outcome in
                    switch outcome {
                    case .text(let text): call.resolve(["text": text])
                    case .cancelled: call.reject("Scanning was cancelled.", "cancelled")
                    case .failed(let code): call.reject("The camera could not start.", code)
                    }
                }, animated: true)
            }
        }
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized: present()
        case .notDetermined:
            AVCaptureDevice.requestAccess(for: .video) { granted in
                if granted { present() } else { call.reject("Camera access was denied.", "camera-denied") }
            }
        default: call.reject("Camera access was denied.", "camera-denied")
        }
    }

    // MARK: Bonjour

    @objc func discoveryStart(_ call: CAPPluginCall) {
        guard let type = call.getString("type"), type.hasPrefix("_"), type.hasSuffix("._tcp") else { return call.reject("type must be like _tau._tcp") }
        let browser = self.browser ?? HostBrowser { [weak self] services, error in
            var event: [String: Any] = ["services": services]
            if let error { event["error"] = error }
            self?.notifyListeners("discovery", data: event)
        }
        self.browser = browser
        browser.start(type: type)
        call.resolve()
    }

    @objc func discoveryStop(_ call: CAPPluginCall) {
        browser?.stop()
        call.resolve()
    }

    // MARK: Device

    @objc func deviceInfo(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            var virtual = false
            #if targetEnvironment(simulator)
            virtual = true
            #endif
            call.resolve(["name": UIDevice.current.name, "model": UIDevice.current.model, "platform": "ios", "virtual": virtual])
        }
    }

    /// APNs needs nothing in the app beyond the capability; the host holds the key.
    @objc func pushAvailable(_ call: CAPPluginCall) {
        call.resolve(["available": true])
    }
}
