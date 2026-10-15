import Foundation
import WebKit

/// The resource bytes arrive through the existing pinned socket in the workbench.
/// This scheme supplies a document response, so it never inherits the workbench CSP.
public final class BrowserResources: NSObject, WKURLSchemeHandler {
    public static let shared = BrowserResources()
    var request: (([String: Any]) -> Void)?
    private struct Pending {
        let task: WKURLSchemeTask
        let connection: String
        let timeout: DispatchWorkItem
    }
    private var pending: [String: Pending] = [:]
    private let maxBytes = 10 * 1024 * 1024

    public func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        guard let url = task.request.url, url.scheme == "tau-resource", url.host == "localhost",
              url.port == nil, url.user == nil, url.password == nil, url.query == nil, url.fragment == nil,
              task.request.httpMethod == "GET",
              url.path.range(of: "^/[0-9a-f-]{36}/resources/[0-9a-f]{64}$", options: .regularExpression) != nil,
              pending.count < 16, let request else { finish(task, status: 404); return }
        let pieces = url.path.split(separator: "/")
        let connection = String(pieces[0])
        guard UUID(uuidString: connection) != nil else { finish(task, status: 404); return }
        let id = UUID().uuidString
        let timeout = DispatchWorkItem { [weak self] in
            guard let entry = self?.pending.removeValue(forKey: id) else { return }
            self?.finish(entry.task, status: 504)
        }
        pending[id] = Pending(task: task, connection: connection, timeout: timeout)
        DispatchQueue.main.asyncAfter(deadline: .now() + 30, execute: timeout)
        request(["id": id, "connectionId": connection, "path": "/resources/\(pieces[2])"])
    }

    public func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {
        if let id = pending.first(where: { $0.value.task === task })?.key {
            pending.removeValue(forKey: id)?.timeout.cancel()
        }
    }

    func respond(id: String, status: Int, headers: [String: String], body: String) {
        guard let entry = pending.removeValue(forKey: id) else { return }
        entry.timeout.cancel()
        guard (200...599).contains(status), !(300...399).contains(status), body.utf8.count <= ((maxBytes + 2) / 3) * 4,
              let bytes = Data(base64Encoded: body), bytes.count <= maxBytes else { finish(entry.task, status: 502); return }
        finish(entry.task, status: status, headers: headers, bytes: bytes)
    }

    func close(connection: String) {
        for id in pending.keys.filter({ pending[$0]?.connection == connection }) {
            guard let entry = pending.removeValue(forKey: id) else { continue }
            entry.timeout.cancel()
            finish(entry.task, status: 404)
        }
    }

    private func finish(_ task: WKURLSchemeTask, status: Int, headers: [String: String] = [:], bytes: Data = Data()) {
        guard let url = task.request.url else { task.didFailWithError(URLError(.badURL)); return }
        var safe: [String: String] = [:]
        for name in ["content-type", "content-security-policy", "content-disposition", "content-range", "accept-ranges"] {
            if let value = headers[name], value.utf8.count <= 16_384, !value.contains("\r"), !value.contains("\n") { safe[name] = value }
        }
        let sandbox = "sandbox allow-scripts allow-forms"
        safe["content-security-policy"] = safe["content-security-policy"].map { "\($0), \(sandbox)" } ?? "\(sandbox); default-src 'none'"
        safe["cache-control"] = "private, no-store"
        safe["x-content-type-options"] = "nosniff"
        safe["referrer-policy"] = "no-referrer"
        safe["content-type"] = safe["content-type"] ?? "application/octet-stream"
        guard let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: nil, headerFields: safe) else {
            task.didFailWithError(URLError(.badServerResponse)); return
        }
        task.didReceive(response)
        task.didReceive(bytes)
        task.didFinish()
    }
}
