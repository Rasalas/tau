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
    static func forget(host: String) {
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
    private static func decode(_ text: String) -> Data? {
        let padded = text.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        return Data(base64Encoded: padded + String(repeating: "=", count: (4 - padded.count % 4) % 4))
    }
}
