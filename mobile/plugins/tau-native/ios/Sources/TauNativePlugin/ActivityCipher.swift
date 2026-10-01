import CryptoKit
import Foundation
import Security

/// ActivityKit's ciphertext opens only in the app and its extension. The shared
/// keychain group must be present in both signed provisioning profiles.
enum ActivityCipher {
    private static let service = "de.tbuck.tau.activity"
    private static func query(_ key: String) -> [String: Any] {
        var query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: key]
        if let group = Bundle.main.object(forInfoDictionaryKey: "TauSharedKeychainGroup") as? String { query[kSecAttrAccessGroup as String] = group }
        return query
    }
    private static func read(_ key: String) -> String? {
        var query = query(key); query[kSecReturnData as String] = true; query[kSecMatchLimit as String] = kSecMatchLimitOne
        var value: AnyObject?
        guard SecItemCopyMatching(query as CFDictionary, &value) == errSecSuccess, let data = value as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }
    private static func write(_ key: String, value: String) throws {
        let bytes = Data(value.utf8)
        let updated = SecItemUpdate(query(key) as CFDictionary, [kSecValueData as String: bytes] as CFDictionary)
        if updated == errSecSuccess { return }
        var item = query(key); item[kSecValueData as String] = bytes; item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(item as CFDictionary, nil)
        guard status == errSecSuccess else { throw NSError(domain: "TauActivityKey", code: Int(status)) }
    }
    static func install(host: String, keyId: String, key: String) throws {
        guard let bytes = decode(key), bytes.count == 32, keyId.range(of: "^[A-Za-z0-9_-]{16,64}$", options: .regularExpression) != nil else { throw NSError(domain: "TauActivityKey", code: 1) }
        try write(keyId, value: key); try write("host:" + host, value: keyId)
    }
    static func installRemote(host: String, keyId: String, key: String) throws {
        guard let bytes = decode(key), bytes.count == 32, keyId.range(of: "^[A-Za-z0-9_-]{16,64}$", options: .regularExpression) != nil else { throw NSError(domain: "TauActivityKey", code: 1) }
        try write(keyId, value: key); try write("remote-host:" + host, value: keyId)
    }
    static func reset() {
        var all = query(""); all.removeValue(forKey: kSecAttrAccount as String)
        SecItemDelete(all as CFDictionary)
    }
    static func forget(host: String) {
        if let saved = read("bindings:" + host), let bytes = saved.data(using: .utf8), let ids = try? JSONSerialization.jsonObject(with: bytes) as? [String] {
            for id in ids { removeToken(activityId: id) }
        }
        SecItemDelete(query("bindings:" + host) as CFDictionary)
        if let key = read("remote-host:" + host) { SecItemDelete(query(key) as CFDictionary) }
        SecItemDelete(query("remote-host:" + host) as CFDictionary)
        if let key = read("host:" + host) { SecItemDelete(query(key) as CFDictionary) }
        SecItemDelete(query("host:" + host) as CFDictionary)
    }
    static func open(_ sealed: String) -> [String: Any]? {
        let pieces = sealed.split(separator: ".", omittingEmptySubsequences: false)
        guard pieces.count == 3, pieces[0] == "1", let keyText = read(String(pieces[1])), let key = decode(keyText),
              let bytes = decode(String(pieces[2])), bytes.count >= 28,
              let box = try? AES.GCM.SealedBox(combined: bytes),
              let plain = try? AES.GCM.open(box, using: SymmetricKey(data: key), authenticating: Data("tau-push:1:\(pieces[1])".utf8)),
              let value = try? JSONSerialization.jsonObject(with: plain) as? [String: Any] else { return nil }
        return value
    }
    static func tokenBinding(activityId: String, host: String, token: Data) throws -> String {
        let digest = SHA256.hash(data: token).map { String(format: "%02x", $0) }.joined()
        try write("token:" + activityId, value: digest)
        let saved = read("bindings:" + host).flatMap { $0.data(using: .utf8) }.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String] } ?? []
        let ids = Array(Set(saved + [activityId])).suffix(500)
        let bytes = try JSONSerialization.data(withJSONObject: Array(ids))
        try write("bindings:" + host, value: String(decoding: bytes, as: UTF8.self))
        return digest
    }
    static func removeToken(activityId: String) { SecItemDelete(query("token:" + activityId) as CFDictionary) }
    static func openActivity(_ sealed: String, activityId: String, purpose: String) -> [String: Any]? {
        guard activityId.range(of: "^[A-Za-z0-9_-]{22}$", options: .regularExpression) != nil,
              ["start", "update"].contains(purpose) else { return nil }
        let pieces = sealed.split(separator: ".", omittingEmptySubsequences: false)
        guard pieces.count == 3, pieces[0] == "2", let keyText = read(String(pieces[1])), let key = decode(keyText), key.count == 32,
              let binding = purpose == "start" ? "" : read("token:" + activityId),
              let bytes = decode(String(pieces[2])), bytes.count >= 28, bytes.count <= 2304,
              let box = try? AES.GCM.SealedBox(combined: bytes),
              let plain = try? AES.GCM.open(box, using: SymmetricKey(data: key), authenticating: Data("tau-activity:2:\(pieces[1]):\(purpose):\(activityId):\(binding)".utf8)),
              let value = try? JSONSerialization.jsonObject(with: plain) as? [String: Any],
              let host = value["hostId"] as? String, let thread = value["threadId"] as? String,
              host.range(of: "^[\\w.:-]{1,200}$", options: .regularExpression) != nil,
              thread.range(of: "^[\\w.:-]{1,200}$", options: .regularExpression) != nil,
              read("remote-host:" + host) == String(pieces[1]), value["version"] as? Int == 1,
              let title = value["title"] as? String, title.count <= 100,
              let state = value["state"] as? String, ["running", "completed", "needs-input"].contains(state),
              let updated = value["updatedAt"] as? Double, let expires = value["expiresAt"] as? Double,
              updated.isFinite, expires.isFinite, expires > updated, expires - updated <= 8 * 60 * 60 * 1000,
              updated <= Date().timeIntervalSince1970 * 1000 + 60_000, expires > Date().timeIntervalSince1970 * 1000 else { return nil }
        return value
    }
    private static func decode(_ text: String) -> Data? {
        let padded = text.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        return Data(base64Encoded: padded + String(repeating: "=", count: (4 - padded.count % 4) % 4))
    }
}
