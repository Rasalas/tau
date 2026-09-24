# ADR 0026: Devices pin the host's key, and trust a CA only where the host says

## Status

Accepted, 2026-09-24. Amends [ADR 0024](0024-pairing-allowed-on-the-host.md)
(what the pairing digits are bound to) and
[ADR 0025](0025-a-window-follows-the-threads-machine.md) (what a saved machine
pins).

## Context

Under ADR 0024 the app and a desktop window pin the SHA-256 of the host's
self-signed certificate. The host renews that certificate a week before its
825 days run out, with a new key, so every paired device would refuse the host
on the day of the renewal and need pairing again.

Tailscale Serve answers at `https://<machine>.<tailnet>.ts.net/` with a
certificate a public CA issued, not the host's own. F05 marked that endpoint
`trustedCertificate`, but a pairing link carried only kinds, so the app
guessed: any DNS name outside `.local` could pass with a CA-trusted
certificate instead of the pin. A desktop window pinned every `wss:` address
and refused the Serve address outright.

A phone paired over Bonjour knew only the LAN addresses the record gave it,
so it lost the host as soon as it left home.

## Decision

1. **Pin the key.** A device pins the SHA-256 of the certificate's
   SubjectPublicKeyInfo (`publicKeyPin`, `AB:CD:…`). Renewing the self-signed
   certificate keeps the key in `<userData>/tls/host-key.pem`; only an
   unreadable key file makes a new one. A pairing link carries it as `pk=`
   and the Bonjour record as `pk=`, both beside `fp=`, which older devices
   still read. A key pin is strict: nothing else is accepted in its place.
2. **A CA only where the host says.** Each address a CA vouches for is named
   in the link with `ca=<url>` and in the hello's `host.endpoints` with
   `trustedCertificate: true`. A device checks such an address by chain and
   name, pins nothing there, and binds no digits there, because the proxy
   ends TLS. The flag counts only on a DNS name outside `.local`
   (`authorityName`); on an IP address or a `.local` name the key is pinned
   whatever the flag says.
3. **Digits bound to the key.** A device that pinned the key sends
   `binding: "key"` with its commitment. The host then computes the digits as
   `tau-pair-v2` over the key of the listener the socket came through. Without
   the field the host keeps `tau-pair-v1` over the certificate, so older
   devices pair as before.
4. **Migration on the next hello.** A device or window that saved a
   certificate pin keeps it until a hello succeeds on a socket that this pin
   let in. It then saves the key of that certificate and drops the
   certificate pin. A socket that a CA let in teaches no key, because that key
   belongs to the proxy. Until the migration, the old certificate pin may give
   way to a CA for a DNS name, as before, so a phone away from home still
   reaches Serve.
5. **Every address after every hello.** The hello reply names the host's
   network addresses with their kinds and the CA flag, never loopback
   (`host.endpoints`, which F18 added for the window). The app takes them the
   way the window does (`refreshEndpoints`): the named ones first, then the
   saved names, Tailscale addresses and the address it is connected on.

## Consequences

- A renewal no longer breaks a pairing. A host whose key really changed is
  refused as before, and the notice says the key differs.
- Losing `host-key.pem` means every device has to pair again, the same as a
  new certificate did before.
- Serve works in the app and in the window without guessing, and the direct
  Tailscale bind under its MagicDNS name stays pinned.
- `TAU_HOST_URL` with `TAU_HOST_FINGERPRINT` or known-hosts still pins a
  certificate. That path is outside this decision.
