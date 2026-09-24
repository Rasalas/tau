import Foundation
import Network

/// Browses for Tau hosts over Bonjour and resolves each to an address and
/// port. The TXT record carries the host id and the certificate fingerprint;
/// the app decides what to do with them.
final class HostBrowser {
    typealias Emit = ([[String: Any]], String?) -> Void

    private let queue = DispatchQueue(label: "tau.host-browser")
    private var browser: NWBrowser?
    private var resolving: [String: NWConnection] = [:]
    private var services: [String: [String: Any]] = [:]
    private var txt: [String: [String: String]] = [:]
    private let emit: Emit

    init(emit: @escaping Emit) {
        self.emit = emit
    }

    func start(type: String) {
        queue.async { [self] in
            stopLocked()
            let parameters = NWParameters()
            parameters.includePeerToPeer = false
            let browser = NWBrowser(for: .bonjourWithTXTRecord(type: type, domain: "local."), using: parameters)
            browser.stateUpdateHandler = { [weak self] state in
                guard let self else { return }
                switch state {
                case .failed(let error): self.emit([], HostBrowser.describe(error))
                case .waiting(let error): self.emit([], HostBrowser.describe(error))
                default: break
                }
            }
            browser.browseResultsChangedHandler = { [weak self] results, _ in
                self?.update(results)
            }
            self.browser = browser
            browser.start(queue: queue)
        }
    }

    func stop() {
        queue.async { [self] in stopLocked() }
    }

    private func stopLocked() {
        browser?.cancel()
        browser = nil
        for connection in resolving.values { connection.cancel() }
        resolving.removeAll()
        services.removeAll()
        txt.removeAll()
    }

    private func update(_ results: Set<NWBrowser.Result>) {
        var present = Set<String>()
        for result in results {
            guard case let .service(name, _, _, _) = result.endpoint else { continue }
            present.insert(name)
            var record: [String: String] = [:]
            if case let .bonjour(entries) = result.metadata { record = entries.dictionary }
            txt[name] = record
            if var known = services[name] {
                known["txt"] = record
                services[name] = known
            } else if resolving[name] == nil {
                resolve(name: name, endpoint: result.endpoint)
            }
        }
        for name in Array(services.keys) where !present.contains(name) { services.removeValue(forKey: name) }
        for (name, connection) in resolving where !present.contains(name) {
            connection.cancel()
            resolving.removeValue(forKey: name)
        }
        publish()
    }

    /// A short TCP connect is the Network framework's way to learn a service's address; nothing is sent.
    private func resolve(name: String, endpoint: NWEndpoint) {
        let parameters = NWParameters.tcp
        // IPv4 first: an IPv6 link-local address needs a zone a URL cannot carry well.
        if let ip = parameters.defaultProtocolStack.internetProtocol as? NWProtocolIP.Options { ip.version = .v4 }
        let connection = NWConnection(to: endpoint, using: parameters)
        resolving[name] = connection
        connection.stateUpdateHandler = { [weak self, weak connection] state in
            guard let self, let connection else { return }
            switch state {
            case .ready:
                if case let .hostPort(host, port) = connection.currentPath?.remoteEndpoint {
                    self.services[name] = ["name": name, "host": HostBrowser.text(host), "port": Int(port.rawValue), "txt": self.txt[name] ?? [:]]
                    self.publish()
                }
                connection.cancel()
                self.resolving.removeValue(forKey: name)
            case .failed, .waiting:
                connection.cancel()
                self.resolving.removeValue(forKey: name)
            default:
                break
            }
        }
        connection.start(queue: queue)
    }

    private func publish() {
        emit(Array(services.values), nil)
    }

    private static func text(_ host: NWEndpoint.Host) -> String {
        // An address prints with its interface ("127.0.0.1%lo0"), which a URL cannot carry.
        let bare = { (text: String) in String(text.split(separator: "%", maxSplits: 1).first ?? Substring(text)) }
        switch host {
        case .ipv4(let address): return bare("\(address)")
        case .ipv6(let address): return "[\(bare("\(address)"))]"
        case .name(let name, _): return name
        @unknown default: return "\(host)"
        }
    }

    private static func describe(_ error: NWError) -> String {
        // PolicyDenied: Local Network is off for the app; NoAuth: the type is not in NSBonjourServices.
        if case let .dns(code) = error, code == -65570 || code == -65555 { return "denied" }
        return error.localizedDescription
    }
}
