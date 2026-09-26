import type { EndpointNames, Interfaces } from "../host-endpoints.js";

/**
 * A Linux server with Docker and Tailscale, as the machine that listed ten
 * addresses in its pairing link: two Docker bridges and docker0, a global
 * and a unique-local IPv6 address, Tailscale IPv4 and IPv6.
 */
export const REX_INTERFACES = {
  lo: [{ address: "127.0.0.1", family: "IPv4", internal: true }, { address: "::1", family: "IPv6", internal: true }],
  enp5s0: [
    { address: "192.168.1.40", family: "IPv4", internal: false },
    { address: "2a02:8109:b6c0:5600:1a2b:3c4d:5e6f:7a8b", family: "IPv6", internal: false },
    { address: "fd00::1a2b:3c4d:5e6f:7a8b", family: "IPv6", internal: false },
    { address: "fe80::1a2b:3c4d:5e6f:7a8b", family: "IPv6", internal: false },
  ],
  docker0: [{ address: "172.17.0.1", family: "IPv4", internal: false }, { address: "fe80::42:acff:fe11:1", family: "IPv6", internal: false }],
  "br-3f9c2a1b7d4e": [{ address: "172.19.0.1", family: "IPv4", internal: false }, { address: "fd01::1", family: "IPv6", internal: false }],
  "br-8e7d6c5b4a39": [{ address: "172.20.0.1", family: "IPv4", internal: false }],
  veth1a2b3c4: [{ address: "fe80::a0b1:c2ff:fed3:e4f5", family: "IPv6", internal: false }],
  virbr0: [{ address: "192.168.122.1", family: "IPv4", internal: false }],
  tailscale0: [
    { address: "100.87.123.45", family: "IPv4", internal: false },
    { address: "fd7a:115c:a1e0::6f01:7b2d", family: "IPv6", internal: false },
    { address: "fe80::9c3b:1234:5678:9abc", family: "IPv6", internal: false },
  ],
} as unknown as Interfaces;

export const REX_NAMES: EndpointNames = { localName: "rex.local", magicDns: "rex.tail1a2b3c.ts.net" };
