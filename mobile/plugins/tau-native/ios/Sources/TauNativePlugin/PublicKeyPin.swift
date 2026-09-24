import CryptoKit
import Foundation
import Security

/// SHA-256 of a certificate's SubjectPublicKeyInfo, `AB:CD:…`: the key pin a
/// pairing link carries as `pk`. It survives the host renewing its
/// certificate with the same key; the certificate fingerprint does not.
enum PublicKeyPin {
    static func of(_ certificate: SecCertificate) -> String? {
        let der = [UInt8](SecCertificateCopyData(certificate) as Data)
        guard let spki = subjectPublicKeyInfo(der) else { return nil }
        return SHA256.hash(data: Data(spki)).map { String(format: "%02X", $0) }.joined(separator: ":")
    }

    /// The SubjectPublicKeyInfo element of a DER certificate, tag and length included.
    static func subjectPublicKeyInfo(_ der: [UInt8]) -> ArraySlice<UInt8>? {
        guard let certificate = element(der, at: 0), certificate.tag == 0x30,
              let tbs = element(der, at: certificate.contentStart), tbs.tag == 0x30,
              let first = element(der, at: tbs.contentStart) else { return nil }
        // version [0] is optional; then serial, signature, issuer, validity, subject.
        var offset = first.tag == 0xA0 ? first.end : first.start
        for _ in 0..<5 {
            guard let next = element(der, at: offset), next.end <= tbs.end else { return nil }
            offset = next.end
        }
        guard let spki = element(der, at: offset), spki.tag == 0x30, spki.end <= tbs.end else { return nil }
        return der[spki.start..<spki.end]
    }

    private struct Element {
        let tag: UInt8
        let start: Int
        let contentStart: Int
        let end: Int
    }

    private static func element(_ der: [UInt8], at offset: Int) -> Element? {
        guard offset >= 0, offset + 2 <= der.count else { return nil }
        var length = Int(der[offset + 1])
        var header = 2
        if length & 0x80 != 0 {
            let count = length & 0x7F
            guard (1...4).contains(count), offset + 2 + count <= der.count else { return nil }
            length = 0
            for index in 0..<count { length = (length << 8) | Int(der[offset + 2 + index]) }
            header += count
        }
        let end = offset + header + length
        guard end <= der.count else { return nil }
        return Element(tag: der[offset], start: offset, contentStart: offset + header, end: end)
    }
}
