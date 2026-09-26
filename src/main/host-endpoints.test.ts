import { describe, expect, it } from "vitest";
import { MagicDnsNames, classifyAddress, isTailscaleAddress, isVirtualInterface, linkEndpoints, listenerEndpoints, localHostName, mergeEndpoints, type Interfaces } from "./host-endpoints.js";
import { REX_INTERFACES, REX_NAMES } from "./test-support/rex-interfaces.js";

const interfaces = {
  lo0: [{ address: "127.0.0.1", family: "IPv4", internal: true }, { address: "::1", family: "IPv6", internal: true }],
  en0: [
    { address: "192.168.1.20", family: "IPv4", internal: false },
    { address: "fe80::1c2b:3aff:fe4d:5e6f", family: "IPv6", internal: false },
    { address: "2a02:810d:4b3f:e100::1a", family: "IPv6", internal: false },
  ],
  en5: [{ address: "169.254.10.2", family: "IPv4", internal: false }],
  utun4: [
    { address: "100.96.0.12", family: "IPv4", internal: false },
    { address: "fd7a:115c:a1e0::2301:8dd4", family: "IPv6", internal: false },
  ],
} as unknown as Interfaces;

const names = { localName: "Mac-mini.local", magicDns: "mac-mini.tail5e6f7a.ts.net" };

describe("address classes", () => {
  it.each([
    ["100.64.0.1", true], ["100.127.255.254", true], ["100.63.0.1", false], ["100.128.0.1", false],
    ["fd7a:115c:a1e0::1", true], ["FD7A:115C:A1E0:ab12::1", true], ["fd7a:115c:a1e1::1", false], ["10.0.0.1", false],
  ])("knows whether %s is Tailscale's", (address, expected) => {
    expect(isTailscaleAddress(address)).toBe(expected);
  });

  it.each([
    ["127.0.0.1", "loopback"], ["::1", "loopback"], ["::ffff:127.0.0.1", "loopback"],
    ["169.254.1.1", "link-local"], ["fe80::1", "link-local"], ["febf::1", "link-local"],
    ["100.100.1.1", "tailscale"], ["192.168.0.2", "lan"], ["2a02:810d::1", "lan"], ["fd00::5", "lan"],
  ])("puts %s among %s", (address, expected) => {
    expect(classifyAddress(address)).toBe(expected);
  });
});

describe("the endpoints of one listener", () => {
  it("label every address of a dual-stack wildcard bind, and add the names that point at them", () => {
    expect(listenerEndpoints({ scheme: "https", host: "::", port: 7788 }, interfaces, names, { loopback: false })).toEqual([
      { url: "https://192.168.1.20:7788/", label: "LAN (en0)", reachability: "network", kind: "lan", interface: "en0" },
      { url: "https://[2a02:810d:4b3f:e100::1a]:7788/", label: "LAN IPv6 (en0)", reachability: "network", kind: "lan", interface: "en0", ipv6: true },
      { url: "https://100.96.0.12:7788/", label: "Tailscale", reachability: "network", kind: "tailscale", interface: "utun4" },
      { url: "https://[fd7a:115c:a1e0::2301:8dd4]:7788/", label: "Tailscale IPv6", reachability: "network", kind: "tailscale", interface: "utun4", ipv6: true },
      { url: "https://Mac-mini.local:7788/", label: ".local", reachability: "network", kind: "mdns" },
      { url: "https://mac-mini.tail5e6f7a.ts.net:7788/", label: "MagicDNS", reachability: "network", kind: "magicdns" },
    ]);
  });

  it("name one global and one unique-local IPv6 address per interface, not every temporary one", () => {
    const privacy = { en0: [
      { address: "2003:e5::4e4", family: "IPv6", internal: false },
      { address: "fdf5:796::93", family: "IPv6", internal: false },
      { address: "2003:e5::50b1", family: "IPv6", internal: false },
      { address: "2003:e5::5b3", family: "IPv6", internal: false },
      { address: "fdf5:796::842", family: "IPv6", internal: false },
    ] } as unknown as Interfaces;
    expect(listenerEndpoints({ scheme: "https", host: "::", port: 1 }, privacy, {}, { loopback: false }).map((endpoint) => endpoint.url))
      .toEqual(["https://[2003:e5::4e4]:1/", "https://[fdf5:796::93]:1/"]);
  });

  it("keep an IPv4 wildcard to IPv4, with this machine last", () => {
    const urls = listenerEndpoints({ scheme: "http", host: "0.0.0.0", port: 1 }, interfaces).map((endpoint) => endpoint.url);
    expect(urls).toEqual(["http://192.168.1.20:1/", "http://100.96.0.12:1/", "http://127.0.0.1:1/"]);
  });

  it("name a Tailscale address it bound alone, and its MagicDNS name, but no .local", () => {
    expect(listenerEndpoints({ scheme: "https", host: "100.96.0.12", port: 7788 }, interfaces, names).map((endpoint) => endpoint.label))
      .toEqual(["Tailscale", "MagicDNS"]);
  });

  it("keep a loopback bind on this machine, and a host name as the operator wrote it", () => {
    expect(listenerEndpoints({ scheme: "http", host: "127.0.0.1", port: 1 }, interfaces)).toEqual([
      { url: "http://127.0.0.1:1/", label: "This machine", reachability: "loopback", kind: "loopback" },
    ]);
    expect(listenerEndpoints({ scheme: "https", host: "box.example", port: 2 }, interfaces)).toEqual([
      { url: "https://box.example:2/", label: "box.example", reachability: "network" },
    ]);
  });

  it("merge listeners best first, each URL once", () => {
    const loopback = listenerEndpoints({ scheme: "http", host: "127.0.0.1", port: 5000 }, interfaces);
    const network = listenerEndpoints({ scheme: "https", host: "0.0.0.0", port: 7788 }, interfaces, names, { loopback: false });
    expect(mergeEndpoints([loopback, network, network]).map((endpoint) => endpoint.label)).toEqual([
      "LAN (en0)", ".local", "MagicDNS", "Tailscale", "This machine",
    ]);
  });
});

describe("container and VM bridges", () => {
  it.each([
    ["docker0", true], ["br-3f9c2a1b7d4e", true], ["veth1a2b3c4", true], ["virbr0", true], ["cni0", true], ["flannel.1", true], ["podman0", true],
    ["enp5s0", false], ["en0", false], ["bridge0", false], ["tailscale0", false], ["utun4", false],
  ])("know whether %s is one", (name, expected) => {
    expect(isVirtualInterface(name)).toBe(expected);
  });

  it("are never an endpoint of a wildcard bind", () => {
    const endpoints = mergeEndpoints([listenerEndpoints({ scheme: "https", host: "::", port: 7788 }, REX_INTERFACES, REX_NAMES, { loopback: false })]);
    expect(endpoints.map((endpoint) => endpoint.url)).toEqual([
      "https://192.168.1.40:7788/",
      "https://rex.local:7788/",
      "https://rex.tail1a2b3c.ts.net:7788/",
      "https://100.87.123.45:7788/",
      "https://[2a02:8109:b6c0:5600:1a2b:3c4d:5e6f:7a8b]:7788/",
      "https://[fd00::1a2b:3c4d:5e6f:7a8b]:7788/",
      "https://[fd7a:115c:a1e0::6f01:7b2d]:7788/",
    ]);
  });

  it("stay an endpoint when the operator bound one by its address", () => {
    expect(listenerEndpoints({ scheme: "https", host: "172.19.0.1", port: 1 }, REX_INTERFACES).map((endpoint) => endpoint.url)).toEqual(["https://172.19.0.1:1/"]);
  });
});

describe("the addresses a pairing link names", () => {
  it("are the best of each kind, IPv6 only where a kind has no IPv4", () => {
    const endpoints = [
      { url: "https://192.168.1.40:7788/", kind: "lan" as const },
      { url: "https://10.0.0.5:7788/", kind: "lan" as const },
      { url: "https://rex.local:7788/", kind: "mdns" as const },
      { url: "https://rex.tail1a2b3c.ts.net/", kind: "magicdns" as const, trustedCertificate: true },
      { url: "https://rex.tail1a2b3c.ts.net:7788/", kind: "magicdns" as const },
      { url: "https://[fd7a:115c:a1e0::6f01:7b2d]:7788/", kind: "tailscale" as const },
      { url: "https://100.87.123.45:7788/", kind: "tailscale" as const },
      { url: "https://[2a02:8109::1]:7788/", kind: "lan" as const },
      { url: "https://published.example/" },
    ];
    expect(linkEndpoints(endpoints).map((endpoint) => endpoint.url)).toEqual([
      "https://192.168.1.40:7788/",
      "https://rex.local:7788/",
      "https://rex.tail1a2b3c.ts.net/",
      "https://rex.tail1a2b3c.ts.net:7788/",
      "https://100.87.123.45:7788/",
      "https://published.example/",
    ]);
    expect(linkEndpoints([{ url: "https://[2a02:8109::1]:7788/", kind: "lan" }, { url: "https://[fd00::1]:7788/", kind: "lan" }]))
      .toEqual([{ url: "https://[2a02:8109::1]:7788/", kind: "lan" }]);
  });
});

describe("machine names", () => {
  it("reads macOS's Bonjour name rather than the first label of the host name", () => {
    expect(localHostName("darwin", () => "Mac-mini-von-Alex\n")).toBe("Mac-mini-von-Alex.local");
  });

  it("falls back to the host name elsewhere and refuses one that is no DNS label", () => {
    expect(localHostName("linux", () => "ignored")).toMatch(/\.local$/u);
    expect(localHostName("darwin", () => "not a label")).toBeUndefined();
  });

  it("finds the MagicDNS name by a reverse lookup of the Tailscale address, and keeps it a while", async () => {
    const asked: string[] = [];
    let now = 0;
    const lookups = new MagicDnsNames(async (address) => {
      asked.push(address);
      return ["mac-mini.tail5e6f7a.ts.net."];
    }, () => now);
    expect(await lookups.forInterfaces(interfaces)).toBe("mac-mini.tail5e6f7a.ts.net");
    expect(await lookups.forInterfaces(interfaces)).toBe("mac-mini.tail5e6f7a.ts.net");
    now = 10 * 60_000;
    await lookups.forInterfaces(interfaces);
    expect(asked).toEqual(["100.96.0.12", "100.96.0.12"]);
  });

  it("has no name without MagicDNS or without a Tailscale address", async () => {
    const failing = new MagicDnsNames(async () => { throw Object.assign(new Error("timeout"), { code: "ETIMEOUT" }); });
    expect(await failing.forInterfaces(interfaces)).toBeUndefined();
    const never = new MagicDnsNames(async () => { throw new Error("must not be asked"); });
    expect(await never.forInterfaces({ en0: interfaces.en0 })).toBeUndefined();
  });
});
