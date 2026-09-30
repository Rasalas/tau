import Foundation
import Network

/// Forwards encrypted host TLS bytes. The existing PinnedSocket owns inner TLS.
final class ConnectRelay: NSObject, URLSessionWebSocketDelegate {
    private let queue = DispatchQueue(label: "de.tbuck.tau.connect")
    private let remote: URL
    private let token: String
    private var listener: NWListener?
    private var local: NWConnection?
    private var session: URLSession?
    private var task: URLSessionWebSocketTask?
    private var finished = false
    private var ready: ((Result<URL, Error>) -> Void)?
    private let failure: () -> Void

    init(remote: URL, token: String, failure: @escaping () -> Void) {
        self.remote = remote; self.token = token; self.failure = failure
        super.init()
    }

    func start(inner: URL, ready: @escaping (Result<URL, Error>) -> Void) {
        queue.async {
            self.ready = ready
            do {
                let parameters = NWParameters.tcp
                parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: .any)
                let listener = try NWListener(using: parameters)
                self.listener = listener
                listener.stateUpdateHandler = { [weak self] state in
                    guard let self, !self.finished else { return }
                    if case .ready = state, let port = listener.port {
                        var url = URLComponents(url: inner, resolvingAgainstBaseURL: false)!
                        url.host = "127.0.0.1"; url.port = Int(port.rawValue); url.fragment = nil
                        self.ready?(.success(url.url!)); self.ready = nil
                    } else if case .failed(let error) = state { self.stop(error) }
                }
                listener.newConnectionHandler = { [weak self] connection in self?.accept(connection) }
                listener.start(queue: self.queue)
                self.queue.asyncAfter(deadline: .now() + 15) { if self.local == nil { self.stop() } }
            } catch { self.stop(error) }
        }
    }

    private func accept(_ connection: NWConnection) {
        guard !finished, local == nil else { connection.cancel(); return }
        local = connection
        listener?.cancel(); listener = nil
        connection.stateUpdateHandler = { [weak self] state in
            guard let self, !self.finished else { return }
            if case .ready = state { self.openRemote() }
            else if case .failed = state { self.stop() }
        }
        connection.start(queue: queue)
    }

    private func openRemote() {
        let config = URLSessionConfiguration.ephemeral
        config.httpCookieStorage = nil; config.urlCache = nil
        config.timeoutIntervalForRequest = 15
        let session = URLSession(configuration: config, delegate: self, delegateQueue: nil)
        self.session = session
        var request = URLRequest(url: remote)
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        let task = session.webSocketTask(with: request)
        task.maximumMessageSize = 64 * 1024
        self.task = task
        task.resume()
    }

    private func readLocal() {
        guard !finished else { return }
        local?.receive(minimumIncompleteLength: 1, maximumLength: 64 * 1024) { [weak self] data, _, complete, error in
            guard let self else { return }
            self.queue.async {
                guard !self.finished else { return }
                if let data, !data.isEmpty {
                    self.task?.send(.data(data)) { sendError in
                        self.queue.async { if sendError != nil || complete || error != nil { self.stop() } else { self.readLocal() } }
                    }
                } else if complete || error != nil { self.stop() } else { self.readLocal() }
            }
        }
    }

    private func readRemote() {
        guard !finished else { return }
        task?.receive { [weak self] result in
            guard let self else { return }
            self.queue.async {
                guard !self.finished else { return }
                guard case .success(.data(let data)) = result, !data.isEmpty else { self.stop(); return }
                self.local?.send(content: data, completion: .contentProcessed { error in
                    self.queue.async { if error != nil { self.stop() } else { self.readRemote() } }
                })
            }
        }
    }

    func close() { queue.async { self.stop(notify: false) } }

    private func stop(_ error: Error? = nil, notify: Bool = true) {
        guard !finished else { return }
        finished = true
        listener?.cancel(); listener = nil
        local?.cancel(); local = nil
        task?.cancel(with: .goingAway, reason: nil); task = nil
        session?.invalidateAndCancel(); session = nil
        ready?(.failure(error ?? URLError(.networkConnectionLost))); ready = nil
        if notify { failure() }
    }

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol protocol: String?) {
        queue.async { self.readLocal(); self.readRemote() }
    }
    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) { queue.async { self.stop() } }
    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) { queue.async { self.stop() } }
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}
