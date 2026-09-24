import { describe, expect, it } from "vitest";
import { describeFailure, isTauProxy, otherServes, parseServeConfig, parseStatus, tauServePort } from "./cli.js";

/** The shape `tailscale status --json` printed on a Mac (1.102.4), names changed, peers left out. */
const STATUS = {
  Version: "1.102.4-t3caf7d9e7-g084ee3b64",
  BackendState: "Running",
  CertDomains: null,
  MagicDNSSuffix: "tail0000.ts.net",
  CurrentTailnet: { Name: "someone@example.com", MagicDNSSuffix: "tail0000.ts.net", MagicDNSEnabled: true },
  TailscaleIPs: ["100.101.102.1", "fd7a:115c:a1e0::1"],
  Self: { DNSName: "Box-One.tail0000.ts.net.", HostName: "Box One", TailscaleIPs: ["100.101.102.1"], Online: true },
  Peer: { key: { DNSName: "phone.tail0000.ts.net." } },
};

describe("tailscale status --json", () => {
  it("gives the machine's MagicDNS name, and HTTPS only where CertDomains lists it", () => {
    expect(parseStatus(JSON.stringify(STATUS))).toEqual({ state: "running", backendState: "Running", dnsName: "box-one.tail0000.ts.net", magicDns: true, https: false });
    expect(parseStatus(JSON.stringify({ ...STATUS, CertDomains: ["box-one.tail0000.ts.net"] }))?.https).toBe(true);
    expect(parseStatus(JSON.stringify({ ...STATUS, CertDomains: ["other.tail0000.ts.net"] }))?.https).toBe(false);
  });

  it("names a signed-out or stopped client, and takes no name that is not one", () => {
    expect(parseStatus(JSON.stringify({ ...STATUS, BackendState: "NeedsLogin" }))?.state).toBe("needs-login");
    expect(parseStatus(JSON.stringify({ ...STATUS, BackendState: "Stopped" }))?.state).toBe("not-running");
    expect(parseStatus(JSON.stringify({ ...STATUS, Self: { DNSName: "not a name; rm -rf" } }))?.dnsName).toBeUndefined();
    expect(parseStatus("failed to connect to local tailscaled")).toBeUndefined();
  });

  it("treats a MagicDNS name as MagicDNS on where the client reports no tailnet", () => {
    const { CurrentTailnet: _omitted, ...older } = STATUS;
    expect(parseStatus(JSON.stringify(older))?.magicDns).toBe(true);
  });
});

describe("tailscale serve status --json", () => {
  const config = {
    TCP: { 443: { HTTPS: true }, 8443: { HTTPS: true }, 2222: { TCPForward: "127.0.0.1:22" } },
    Web: {
      "box-one.tail0000.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:3773" } } },
      "box-one.tail0000.ts.net:8443": { Handlers: { "/": { Proxy: "http://127.0.0.1:7789" }, "/docs": { Path: "/srv/docs" } } },
      "other.tail0000.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:7789" } } },
    },
  };

  it("finds Tau's `/` by its proxy port and lists everything else Serve forwards", () => {
    const ports = parseServeConfig(JSON.stringify(config), "box-one.tail0000.ts.net")!;
    expect(tauServePort(ports, 7789)).toBe(8443);
    expect(tauServePort(ports, 7790)).toBeUndefined();
    expect(otherServes(ports, 7789)).toEqual([
      { httpsPort: 443, path: "/", target: "http://127.0.0.1:3773" },
      { httpsPort: 2222, path: "", target: "TCP to 127.0.0.1:22" },
      { httpsPort: 8443, path: "/docs", target: "files at /srv/docs" },
    ]);
  });

  it("reads an empty config as nothing served, and refuses one that is no JSON", () => {
    expect(parseServeConfig("{}\n", "box-one.tail0000.ts.net")).toEqual([]);
    expect(parseServeConfig("", "box-one.tail0000.ts.net")).toEqual([]);
    expect(parseServeConfig("No serve config", "box-one.tail0000.ts.net")).toBeUndefined();
  });

  it("knows Tau's proxy however the CLI wrote the target down", () => {
    expect(isTauProxy("http://127.0.0.1:7789", 7789)).toBe(true);
    expect(isTauProxy("http://localhost:7789/", 7789)).toBe(true);
    expect(isTauProxy("7789", 7789)).toBe(true);
    expect(isTauProxy("https://127.0.0.1:7789", 7789)).toBe(false);
    expect(isTauProxy("http://192.168.1.2:7789", 7789)).toBe(false);
  });
});

describe("a failed serve", () => {
  it("is put in the user's words and never quotes the CLI", () => {
    const secret = { code: 1, stdout: "", stderr: "Access denied: serve config denied (tskey-auth-SECRET)" };
    expect(describeFailure(secret, "linux")).toBe("Tailscale refused: this user may not change Serve. Run `sudo tailscale set --operator=$USER` once in a terminal, then try again.");
    expect(describeFailure(secret, "darwin")).not.toContain("tskey");
    expect(describeFailure({ code: 3, stdout: "", stderr: "tskey-auth-SECRET" }, "darwin")).toBe("Tailscale did not do it (exit code 3).");
    expect(describeFailure({ code: null, stdout: "", stderr: "", timedOut: true }, "darwin")).toMatch(/did not answer in time/u);
  });
});
