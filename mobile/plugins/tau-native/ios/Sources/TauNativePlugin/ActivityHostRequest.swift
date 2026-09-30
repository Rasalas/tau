import Foundation

/// One short authenticated request on the existing pinned TLS transport. No
/// notification data or paired credentials are passed to the widget extension.
@MainActor final class ActivityHostRequest {
    private var socket: PinnedSocket?
    private var relay: ConnectRelay?
    private var continuation: CheckedContinuation<[String: Any], Error>?
    private var timeout: Task<Void, Never>?
    private static var commands: [String: Task<[String: Any], Error>] = [:]
    private let route: [String: Any]
    private let command: String
    private let input: [String: Any]
    init(_ route: [String: Any], command: String, input: [String: Any]) { self.route = route; self.command = command; self.input = input }
    static func send(_ route: [String: Any], command: String, input: [String: Any]) async throws -> [String: Any] {
        let host = route["hostId"] as? String ?? ""
        let prior = commands[host]
        let work = Task { () throws -> [String: Any] in
            _ = try? await prior?.value
            return try await sendNow(route, command: command, input: input)
        }
        commands[host] = work
        return try await work.value
    }
    private static func sendNow(_ route: [String: Any], command: String, input: [String: Any]) async throws -> [String: Any] {
        guard let candidates = route["candidates"] as? [[String: Any]] else { throw ActivityRemote.Failure.unavailable }
        for candidate in candidates.prefix(3) {
            let request = ActivityHostRequest(route, command: command, input: input)
            do { return try await request.run(candidate) } catch { if (error as NSError).code == 4401 { throw error } }
        }
        throw ActivityRemote.Failure.unavailable
    }
    private func run(_ candidate: [String: Any]) async throws -> [String: Any] {
        try await withCheckedThrowingContinuation { continuation in
            self.continuation = continuation
            timeout = Task { try? await Task.sleep(nanoseconds: 7_000_000_000); if !Task.isCancelled { finish(.failure(ActivityRemote.Failure.unavailable)) } }
            guard let text = candidate["url"] as? String, let url = URL(string: text), url.scheme == "wss",
                  candidate["trust"] as? String == "pin" || candidate["trust"] as? String == "authority" else { finish(.failure(ActivityRemote.Failure.unavailable)); return }
            let open: (URL) -> Void = { [self] target in
                socket = PinnedSocket(id: UUID().uuidString, url: target, keyPin: candidate["publicKey"] as? String, pin: candidate["fingerprint"] as? String, allowAuthority: candidate["allowAuthority"] as? Bool ?? false, headers: [:]) { [weak self] event in
                    Task { @MainActor in self?.event(event) }
                }
            }
            if let connect = candidate["connect"] as? [String: String], let remote = connect["url"].flatMap(URL.init(string:)), let token = connect["token"], remote.scheme == "wss", candidate["publicKey"] != nil || candidate["fingerprint"] != nil {
                relay = ConnectRelay(remote: remote, token: token) { [weak self] in Task { @MainActor in self?.finish(.failure(ActivityRemote.Failure.unavailable)) } }
                relay?.start(inner: url) { result in Task { @MainActor in if case .success(let local) = result { open(local) } else { self.finish(.failure(ActivityRemote.Failure.unavailable)) } } }
            } else { open(url) }
        }
    }
    private func event(_ event: [String: Any]) {
        if event["type"] as? String == "open" {
            wire(["type": "hello", "id": "activity-hello", "hello": ["protocol": 1, "token": route["token"]!, "profile": "compact", "subscription": ["threads": [], "topics": []]]])
        } else if event["type"] as? String == "message", let text = event["data"] as? String, let bytes = text.data(using: .utf8), let frame = try? JSONSerialization.jsonObject(with: bytes) as? [String: Any] {
            if frame["type"] as? String == "hello-reply", frame["id"] as? String == "activity-hello" {
                wire(["type": "request", "request": ["id": "activity-request", "method": "host-extension", "params": ["tau.push", command, input]]])
            } else if frame["type"] as? String == "response", let response = frame["response"] as? [String: Any], response["id"] as? String == "activity-request" {
                if response["error"] != nil { finish(.failure(ActivityRemote.Failure.unavailable)) } else { finish(.success(response["result"] as? [String: Any] ?? [:])) }
            }
        } else if event["type"] as? String == "close" {
            finish(.failure(NSError(domain: "TauActivityHost", code: event["code"] as? Int ?? 1006)))
        }
    }
    private func wire(_ value: [String: Any]) { if let bytes = try? JSONSerialization.data(withJSONObject: value) { socket?.send(String(decoding: bytes, as: UTF8.self)) } }
    private func finish(_ result: Result<[String: Any], Error>) {
        guard let continuation else { return }; self.continuation = nil
        timeout?.cancel(); socket?.close(code: 1000, reason: nil); relay?.close(); socket = nil; relay = nil
        continuation.resume(with: result)
    }
}
