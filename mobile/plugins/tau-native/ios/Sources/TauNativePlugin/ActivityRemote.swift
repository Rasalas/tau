import ActivityKit
import Foundation
import UIKit

/// App-only paired credentials never enter the shared keychain or APNs attributes.
/// ActivityKit wakes this observer without waiting for Capacitor or JavaScript.
@MainActor public enum ActivityRemote {
    private static let routesKey = "activity-routes.v1"
    private static let relayURL = URL(string: "https://europe-west3-tau-push-e3c95.cloudfunctions.net/relay/register")!
    private static var started = false
    private static var observers: [String: Task<Void, Never>] = [:]
    private static var stateObservers: [String: Task<Void, Never>] = [:]
    private static var revisions: [String: Int] = [:]
    private static func routes() -> [String: [String: Any]] {
        guard let text = try? SecureStore.get(routesKey), let bytes = text.data(using: .utf8),
              let saved = try? JSONSerialization.jsonObject(with: bytes) as? [String: [String: Any]] else { return [:] }
        return saved
    }
    private static func save(_ routes: [String: [String: Any]]) throws {
        let bytes = try JSONSerialization.data(withJSONObject: routes)
        try SecureStore.set(routesKey, String(decoding: bytes, as: UTF8.self))
    }
    public static func boot() {
        SecureStore.forgetAfterReinstall()
        guard !started else { return }; started = true
        guard #available(iOS 17.2, *) else { return }
        Task {
            for await token in Activity<TauActivityAttributes>.pushToStartTokenUpdates {
                for (host, route) in routes() where route["enabled"] as? Bool == true {
                    await registerStart(host: host, route: route, token: token)
                }
            }
        }
        Task {
            for await activity in Activity<TauActivityAttributes>.activityUpdates { observe(activity) }
        }
        Task {
            for activity in Activity<TauActivityAttributes>.activities { observe(activity) }
            for (host, route) in routes() {
                if !ActivityAuthorizationInfo().areActivitiesEnabled { try? await disable(host); continue }
                if route["enabled"] as? Bool == false { await disableHost(host, route: route) }
                else if let token = Activity<TauActivityAttributes>.pushToStartToken { await registerStart(host: host, route: route, token: token) }
            }
        }
        Task {
            for await enabled in ActivityAuthorizationInfo().activityEnablementUpdates where !enabled {
                for host in routes().keys { try? await disable(host) }
            }
        }
    }
    static func status(_ host: String) -> [String: Any] {
        let supported: Bool
        if #available(iOS 17.2, *) { supported = ActivityAuthorizationInfo().areActivitiesEnabled } else { supported = false }
        return ["available": supported, "enabled": routes()[host]?["enabled"] as? Bool == true]
    }
    static func configure(_ value: [String: Any]) async throws {
        guard #available(iOS 17.2, *), ActivityAuthorizationInfo().areActivitiesEnabled,
              let host = value["hostId"] as? String, let token = value["token"] as? String, token.hasPrefix("tauc."),
              let candidates = value["candidates"] as? [[String: Any]], !candidates.isEmpty,
              let keyId = value["keyId"] as? String, let key = value["key"] as? String else { throw Failure.unavailable }
        let enabled = value["enabled"] as? Bool ?? routes()[host]?["enabled"] as? Bool ?? false
        if !enabled { return }
        guard Bundle.main.object(forInfoDictionaryKey: "TauSharedKeychainGroup") as? String != nil else { throw Failure.unavailable }
        try ActivityCipher.installRemote(host: host, keyId: keyId, key: key)
        var all = routes(); all[host] = ["hostId": host, "token": token, "candidates": candidates, "keyId": keyId, "key": key, "enabled": true]
        try save(all)
        revisions[host, default: 0] += 1
        boot()
        if let token = Activity<TauActivityAttributes>.pushToStartToken { await registerStart(host: host, route: all[host]!, token: token) }
        for activity in Activity<TauActivityAttributes>.activities {
            guard let id = activity.attributes.activityId, let bootstrap = activity.attributes.bootstrap,
                  let opened = ActivityCipher.openActivity(bootstrap, activityId: id, purpose: "start"),
                  opened["hostId"] as? String == host, let thread = opened["threadId"] as? String, let token = activity.pushToken else { continue }
            await registerUpdate(activityId: id, host: host, thread: thread, token: token)
        }
    }
    static func disable(_ host: String) async throws {
        revisions[host, default: 0] += 1
        var all = routes()
        if var route = all[host] {
            route["enabled"] = false; route.removeValue(forKey: "key"); all[host] = route
            try save(all) // Tombstone first: a late token cannot re-enable this host.
            await endActivities(host)
            ActivityCipher.forget(host: host)
            await disableHost(host, route: route)
        }
    }
    private static func revoke(_ host: String) async {
        revisions[host, default: 0] += 1
        var all = routes(); all.removeValue(forKey: host); try? save(all)
        await endActivities(host)
        ActivityCipher.forget(host: host)
        try? SecureStore.remove("token.v1:" + host)
    }
    private static func disableHost(_ host: String, route: [String: Any]) async {
        guard routes()[host]?["enabled"] as? Bool == false else { return }
        if (try? await ActivityHostRequest.send(route, command: "activity-disable", input: [:])) != nil {
            var all = routes(); if all[host]?["enabled"] as? Bool == false { all.removeValue(forKey: host); try? save(all) }
        }
    }
    private static func endActivities(_ host: String) async {
        if #available(iOS 16.2, *) {
            for activity in Activity<TauActivityAttributes>.activities {
                let opened = activity.attributes.activityId.flatMap { id in activity.attributes.bootstrap.flatMap { ActivityCipher.openActivity($0, activityId: id, purpose: "start") } }
                if activity.attributes.hostId == host || opened?["hostId"] as? String == host {
                    observers.removeValue(forKey: activity.id)?.cancel()
                    stateObservers.removeValue(forKey: activity.id)?.cancel()
                    await activity.end(nil, dismissalPolicy: .immediate)
                    if let id = activity.attributes.activityId { ActivityCipher.removeToken(activityId: id) }
                }
            }
        }
    }
    private static func handle(token: Data, purpose: String) async throws -> String {
        var request = URLRequest(url: relayURL); request.httpMethod = "POST"; request.timeoutInterval = 10
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: ["platform": "ios", "token": token.map { String(format: "%02x", $0) }.joined(), "purpose": purpose])
        let (bytes, response) = try await URLSession.shared.data(for: request)
        guard (response as? HTTPURLResponse)?.statusCode == 200,
              let answer = try JSONSerialization.jsonObject(with: bytes) as? [String: Any], answer["purpose"] as? String == purpose,
              let handle = answer["handle"] as? String, handle.range(of: "^[A-Za-z0-9_-]{40,6000}$", options: .regularExpression) != nil else { throw Failure.unavailable }
        return handle
    }
    private static func registerStart(host: String, route: [String: Any], token: Data) async {
        let revision = revisions[host, default: 0]
        do {
            let sealed = try await handle(token: token, purpose: "activity-start")
            guard revisions[host, default: 0] == revision, routes()[host]?["enabled"] as? Bool == true else { return }
            _ = try await ActivityHostRequest.send(route, command: "activity-start-register", input: ["hostId": host, "topic": Bundle.main.bundleIdentifier ?? "de.tbuck.tau", "enabled": true, "inputPushToken": ProcessInfo.processInfo.operatingSystemVersion.majorVersion >= 18, "relay": ["handle": sealed, "keyId": route["keyId"]!, "key": route["key"]!]])
            // Disable might have happened while the host registration was in flight.
            if revisions[host, default: 0] != revision, let tombstone = routes()[host], tombstone["enabled"] as? Bool == false { await disableHost(host, route: tombstone) }
        } catch { if (error as NSError).code == 4401 { await revoke(host) } /* Other failures retry on token rotation, configuration or launch. */ }
    }
    @available(iOS 17.2, *) private static func observe(_ activity: Activity<TauActivityAttributes>) {
        guard observers[activity.id] == nil, let id = activity.attributes.activityId, let bootstrap = activity.attributes.bootstrap else { return }
        guard let content = ActivityCipher.openActivity(bootstrap, activityId: id, purpose: "start"),
              let host = content["hostId"] as? String, let thread = content["threadId"] as? String,
              let route = routes()[host], route["enabled"] as? Bool == true else {
            Task { await activity.end(nil, dismissalPolicy: .immediate) }; return
        }
        stateObservers[activity.id] = Task {
            var finished = false
            for await state in activity.activityStateUpdates {
                if (state == .ended || state == .dismissed) && !finished {
                    finished = true
                    if let current = routes()[host] { _ = try? await ActivityHostRequest.send(current, command: "activity-finish", input: ["activityId": id]) }
                }
                if state == .dismissed {
                    ActivityCipher.removeToken(activityId: id)
                    observers.removeValue(forKey: activity.id)?.cancel()
                    stateObservers.removeValue(forKey: activity.id)
                    return
                }
            }
        }
        observers[activity.id] = Task {
            if let token = activity.pushToken { await registerUpdate(activityId: id, host: host, thread: thread, token: token) }
            for await token in activity.pushTokenUpdates { await registerUpdate(activityId: id, host: host, thread: thread, token: token) }
        }
    }
    private static func registerUpdate(activityId: String, host: String, thread: String, token: Data) async {
        let revision = revisions[host, default: 0]
        do {
            let sealed = try await handle(token: token, purpose: "activity")
            guard let route = routes()[host], route["enabled"] as? Bool == true, revisions[host, default: 0] == revision else { return }
            let binding = try ActivityCipher.tokenBinding(activityId: activityId, host: host, token: token)
            _ = try await ActivityHostRequest.send(route, command: "activity-register", input: ["hostId": host, "threadId": thread, "activityId": activityId, "tokenHash": binding, "topic": Bundle.main.bundleIdentifier ?? "de.tbuck.tau", "relay": ["handle": sealed, "keyId": route["keyId"]!, "key": route["key"]!]])
        } catch { if (error as NSError).code == 4401 { await revoke(host) } /* Other failures retry current tokens on foreground/relaunch. */ }
    }
    enum Failure: Error { case unavailable }
}

