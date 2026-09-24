import CryptoKit
import Foundation
import Security

/// A WebSocket that accepts the host's self-signed certificate only when its
/// SHA-256 is the pinned one. WKWebView's own WebSocket cannot pin, so every
/// socket to a host goes through here.
final class PinnedSocket: NSObject, URLSessionWebSocketDelegate {
    typealias Emit = ([String: Any]) -> Void

    let id: String
    private let pin: String?
    private let allowAuthority: Bool
    private let emit: Emit
    private let queue: OperationQueue
    private var session: URLSession?
    private var task: URLSessionWebSocketTask?
    private var seen: String?
    private var mismatch = false
    private var finished = false

    init(id: String, url: URL, pin: String?, allowAuthority: Bool, headers: [String: String], emit: @escaping Emit) {
        self.id = id
        self.pin = pin.map(PinnedSocket.normalized)
        self.allowAuthority = allowAuthority
        self.emit = emit
        queue = OperationQueue()
        queue.maxConcurrentOperationCount = 1
        super.init()
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 60
        configuration.waitsForConnectivity = false
        configuration.httpCookieStorage = nil
        configuration.urlCache = nil
        let session = URLSession(configuration: configuration, delegate: self, delegateQueue: queue)
        var request = URLRequest(url: url)
        for (name, value) in headers { request.setValue(value, forHTTPHeaderField: name) }
        let task = session.webSocketTask(with: request)
        // Kit bundles and a bootstrap can be larger than the 1 MB default.
        task.maximumMessageSize = 64 * 1024 * 1024
        self.session = session
        self.task = task
        task.resume()
        receive()
    }

    func send(_ text: String) {
        task?.send(.string(text)) { _ in }
    }

    func close(code: Int, reason: String?) {
        queue.addOperation { [weak self] in
            guard let self, let task = self.task else { return }
            task.cancel(with: URLSessionWebSocketTask.CloseCode(rawValue: code) ?? .normalClosure, reason: reason.map { Data($0.utf8) })
            self.finish(code: code, reason: reason)
        }
    }

    private func receive() {
        task?.receive { [weak self] result in
            guard let self else { return }
            switch result {
            case .success(.string(let text)):
                self.emit(["id": self.id, "type": "message", "data": text])
                self.receive()
            case .success(.data(let data)):
                self.emit(["id": self.id, "type": "message", "data": String(decoding: data, as: UTF8.self)])
                self.receive()
            case .success:
                self.receive()
            case .failure:
                // The delegate reports the close with its code.
                break
            }
        }
    }

    private func finish(code: Int, reason: String?) {
        guard !finished else { return }
        finished = true
        var event: [String: Any] = ["id": id, "type": "close", "code": code]
        if let reason, !reason.isEmpty { event["reason"] = reason }
        if mismatch { event["pinMismatch"] = true }
        emit(event)
        session?.invalidateAndCancel()
        session = nil
        task = nil
    }

    // MARK: URLSessionDelegate

    func urlSession(_ session: URLSession, didReceive challenge: URLAuthenticationChallenge, completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        decide(challenge, completionHandler)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didReceive challenge: URLAuthenticationChallenge, completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        decide(challenge, completionHandler)
    }

    private func decide(_ challenge: URLAuthenticationChallenge, _ completion: (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
              let trust = challenge.protectionSpace.serverTrust else {
            completion(.performDefaultHandling, nil)
            return
        }
        let fingerprint = PinnedSocket.leafFingerprint(trust)
        seen = fingerprint
        guard let pin else {
            completion(.performDefaultHandling, nil)
            return
        }
        // The pin is stronger than a name check: the self-signed certificate names none of the LAN addresses.
        if fingerprint.map(PinnedSocket.normalized) == pin {
            completion(.useCredential, URLCredential(trust: trust))
            return
        }
        if allowAuthority, SecTrustEvaluateWithError(trust, nil) {
            completion(.useCredential, URLCredential(trust: trust))
            return
        }
        mismatch = true
        completion(.cancelAuthenticationChallenge, nil)
    }

    // MARK: URLSessionWebSocketDelegate

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol protocol: String?) {
        var event: [String: Any] = ["id": id, "type": "open"]
        if let seen { event["fingerprint"] = seen }
        emit(event)
    }

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        finish(code: closeCode.rawValue, reason: reason.flatMap { String(data: $0, encoding: .utf8) })
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        // A close frame may arrive with the completion rather than before it; its code matters (4401).
        if let socket = task as? URLSessionWebSocketTask, socket.closeCode != .invalid {
            finish(code: socket.closeCode.rawValue, reason: socket.closeReason.flatMap { String(data: $0, encoding: .utf8) })
            return
        }
        finish(code: 1006, reason: mismatch ? "certificate-mismatch" : error?.localizedDescription)
    }

    // MARK: Fingerprints

    /// SHA-256 of the leaf certificate, `AB:CD:…`, the way a pairing link spells it.
    static func leafFingerprint(_ trust: SecTrust) -> String? {
        guard let chain = SecTrustCopyCertificateChain(trust) as? [SecCertificate], let leaf = chain.first else { return nil }
        let digest = SHA256.hash(data: SecCertificateCopyData(leaf) as Data)
        return digest.map { String(format: "%02X", $0) }.joined(separator: ":")
    }

    static func normalized(_ fingerprint: String) -> String {
        fingerprint.replacingOccurrences(of: ":", with: "").uppercased()
    }
}
