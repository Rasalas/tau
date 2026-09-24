// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_NETWORK_SETTINGS, type UiConnections, type UiCreatedPairingLink, type UiNetworkAccess } from "../../shared/connections";
import type { HostClient } from "../../workbench/host-client";
import { HostClientProvider } from "../host-client-context";
import { createFakeHostClient } from "../test-support/fake-host-client";
import { TestProviders } from "../test-support/test-providers";
import { ConnectionsPage } from "./ConnectionsPage";
import { qrPath } from "./PairingQrCode";

afterEach(cleanup);

const soon = (ms: number) => new Date(Date.now() + ms).toISOString();

function connections(overrides: Partial<UiConnections> = {}): UiConnections {
  return {
    scheme: "ws",
    endpoints: [{ url: "http://127.0.0.1:4100/", label: "This machine", reachability: "loopback" }],
    webClient: true,
    tokenPath: "/w/.tau-dev/host-token",
    links: [],
    clients: [{
      id: "c1", label: "Kitchen iPad", device: { kind: "tablet", browser: "Safari", os: "iPadOS" },
      pairedAt: soon(-3_600_000), lastAddress: "192.0.2.7", connections: 1, current: false,
    }],
    owners: [{ id: "o1", profile: "desktop", device: { kind: "desktop", browser: "Tau window", os: "macOS" }, address: "127.0.0.1", since: soon(-60_000), current: true }],
    ...overrides,
  };
}

function renderPage(overrides: Partial<HostClient>, sections: ComponentProps<typeof ConnectionsPage>["sections"] = []) {
  const notify = vi.fn();
  const client = createFakeHostClient(overrides);
  render(<TestProviders><HostClientProvider client={client}><ConnectionsPage onNotify={notify} sections={sections} /></HostClientProvider></TestProviders>);
  return { client, notify };
}

describe("Settings → Connections", () => {
  it("lists paired clients and this window, and revokes a client", async () => {
    const revokeClient = vi.fn(async () => ({ revoked: true }));
    const { notify } = renderPage({ listConnections: async () => connections(), revokeClient });
    expect(await screen.findByText("Kitchen iPad")).toBeTruthy();
    expect(screen.getByText(/Safari · iPadOS · 192\.0\.2\.7 · paired 1 h ago · connected/u)).toBeTruthy();
    expect(screen.getByText("This device")).toBeTruthy();
    expect(screen.getByText("http://127.0.0.1:4100/")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Revoke" }));
    await waitFor(() => expect(revokeClient).toHaveBeenCalledWith("c1"));
    expect(notify).toHaveBeenCalledWith("Kitchen iPad can no longer connect");
  });

  it("shows a new link once, without a QR code for loopback, and copies it", async () => {
    const created: UiCreatedPairingLink = {
      link: { id: "l1", label: "Laptop", createdAt: soon(0), expiresAt: soon(10 * 60_000) },
      code: "abc",
      urls: [{ url: "http://127.0.0.1:4100/#pair=abc", label: "This machine", reachability: "loopback" }],
    };
    let listed = connections({ clients: [] });
    const createPairingLink = vi.fn(async () => { listed = { ...listed, links: [created.link] }; return created; });
    const copyText = vi.fn(async () => undefined);
    renderPage({ listConnections: async () => listed, createPairingLink, copyText });
    fireEvent.click(await screen.findByRole("button", { name: /Create link/u }));
    fireEvent.change(screen.getByPlaceholderText("e.g. Kitchen iPad"), { target: { value: "Laptop" } });
    fireEvent.click(screen.getByRole("button", { name: "Create Link" }));
    await waitFor(() => expect(createPairingLink).toHaveBeenCalledWith({ label: "Laptop", lifetimeMs: 600_000 }));
    expect(await screen.findByText("Laptop is ready")).toBeTruthy();
    expect(screen.getByText(/No QR code for a loopback address/u)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Copy link" }));
    await waitFor(() => expect(copyText).toHaveBeenCalledWith("http://127.0.0.1:4100/#pair=abc"));
  });

  it("draws a package's section, which asks the page to read its data again, and names the user a proxy saw", async () => {
    const listConnections = vi.fn(async () => connections({ clients: [{ ...connections().clients[0]!, proxyUser: "alice@example.com" }] }));
    renderPage({ listConnections }, [{
      id: "acme.section",
      Component: ({ onChanged }) => <button type="button" onClick={onChanged}>Acme changed something</button>,
    }]);
    fireEvent.click(await screen.findByRole("button", { name: "Acme changed something" }));
    await waitFor(() => expect(listConnections).toHaveBeenCalledTimes(2));
    expect(screen.getByText(/192\.0\.2\.7 · as alice@example\.com · paired/u)).toBeTruthy();
  });

  it("rotates the host token only after asking", async () => {
    const rotateHostToken = vi.fn(async () => undefined);
    renderPage({ listConnections: async () => connections(), rotateHostToken });
    fireEvent.click(await screen.findByRole("button", { name: "Rotate…" }));
    expect(rotateHostToken).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Rotate Token" }));
    await waitFor(() => expect(rotateHostToken).toHaveBeenCalledOnce());
  });

  it("tells a paired client that the owner manages connections", async () => {
    renderPage({ listConnections: async () => { throw Object.assign(new Error("no"), { code: "forbidden" }); } });
    expect(await screen.findByText("Only the host’s owner manages connections")).toBeTruthy();
  });

  it("offers no link where no web client is served", async () => {
    renderPage({ listConnections: async () => connections({ webClient: false }) });
    expect((await screen.findByRole("button", { name: /Create link/u }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("Settings → Connections → Network access", () => {
  const off: UiNetworkAccess = { settings: DEFAULT_NETWORK_SETTINGS, listeners: [], problems: [], tailscaleUp: true };

  it("is not offered by a host that opens no listeners of its own", async () => {
    renderPage({ listConnections: async () => connections() });
    await screen.findByText("Kitchen iPad");
    expect(screen.queryByText("Network access")).toBeNull();
  });

  it("turns the local network on only after asking, and lists what the host is reachable at", async () => {
    let network = off;
    let endpoints = connections().endpoints;
    const setNetworkAccess = vi.fn(async (input: { lan?: boolean }) => {
      network = { ...network, settings: { ...network.settings, lan: input.lan ?? false }, listeners: [{ host: "::", port: 7788, kind: "network" }],
        certificate: { source: "self-signed", fingerprint: "AB:CD", validTo: "2028-12-01T00:00:00.000Z", certPath: "/u/tls/host-cert.pem", warnings: [] } };
      endpoints = [{ url: "https://192.168.1.20:7788/", label: "LAN (en0)", reachability: "network", kind: "lan" }, ...endpoints];
      return network;
    });
    const { notify } = renderPage({ listConnections: async () => connections({ network, endpoints }), setNetworkAccess });
    expect(await screen.findByText("Only this machine can connect.")).toBeTruthy();
    expect(screen.getByText("Tailscale runs on this machine. Turn this on to let your tailnet’s devices connect.")).toBeTruthy();

    fireEvent.click(screen.getByRole("switch", { name: "Local network" }));
    expect(setNetworkAccess).not.toHaveBeenCalled();
    expect(screen.getByText("Let devices on your network connect?")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Turn On" }));
    await waitFor(() => expect(setNetworkAccess).toHaveBeenCalledWith({ lan: true }));
    expect(notify).toHaveBeenCalledWith("Local network on");
    expect(await screen.findByText("https://192.168.1.20:7788/")).toBeTruthy();
    expect(screen.getByText("LAN (en0)")).toBeTruthy();
    expect(screen.getByText("AB:CD")).toBeTruthy();
    expect(screen.getByText(/Devices on the same network reach Tau over HTTPS on port 7788\./u)).toBeTruthy();
  });

  it("shows why a listener did not open and the proxy port Tailscale serve forwards to", async () => {
    const network: UiNetworkAccess = {
      ...off,
      settings: { ...DEFAULT_NETWORK_SETTINGS, tailscale: true },
      listeners: [{ host: "127.0.0.1", port: 7789, kind: "proxy" }],
      problems: ["The listener on 100.96.0.12, port 7788, did not open: another program uses port 7788."],
    };
    renderPage({ listConnections: async () => connections({ network }) });
    expect(await screen.findByText(/another program uses port 7788/u)).toBeTruthy();
    expect(screen.getByText("http://127.0.0.1:7789")).toBeTruthy();
  });

  it("changes the port only to one in range that is not the proxy's", async () => {
    const setNetworkAccess = vi.fn(async () => off);
    renderPage({ listConnections: async () => connections({ network: off }), setNetworkAccess });
    const port = await screen.findByRole("textbox", { name: "Port" });
    const apply = screen.getByRole("button", { name: "Apply" }) as HTMLButtonElement;
    expect(apply.disabled).toBe(true);
    for (const refused of ["80", "7789"]) {
      fireEvent.change(port, { target: { value: refused } });
      expect(apply.disabled).toBe(true);
    }
    fireEvent.change(port, { target: { value: "8443" } });
    fireEvent.click(apply);
    await waitFor(() => expect(setNetworkAccess).toHaveBeenCalledWith({ port: 8443 }));
  });

  it("takes a certificate of the user's own, keeps the dialog open when it does not load, and reloads it", async () => {
    const setNetworkAccess = vi.fn(async () => { throw new Error("/c.pem holds no PEM certificate"); });
    const reloadCertificate = vi.fn(async () => ({ changed: true }));
    const network: UiNetworkAccess = { ...off, certificate: { source: "self-signed", fingerprint: "AB:CD", validTo: "2028-12-01T00:00:00.000Z", certPath: "/u/tls/host-cert.pem", warnings: [] } };
    const { notify } = renderPage({ listConnections: async () => connections({ network }), setNetworkAccess, reloadCertificate });
    fireEvent.click(await screen.findByRole("button", { name: "Use Own…" }));
    fireEvent.change(screen.getByPlaceholderText("/path/to/machine.crt"), { target: { value: "/c.pem" } });
    fireEvent.change(screen.getByPlaceholderText("/path/to/machine.key"), { target: { value: "/k.pem" } });
    fireEvent.click(screen.getByRole("button", { name: "Use Certificate" }));
    await waitFor(() => expect(setNetworkAccess).toHaveBeenCalledWith({ certificate: { certPath: "/c.pem", keyPath: "/k.pem" } }));
    expect(notify).toHaveBeenCalledWith("/c.pem holds no PEM certificate");
    expect(screen.getByText("Use your own certificate")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    await waitFor(() => expect(notify).toHaveBeenCalledWith("Tau now serves the renewed certificate"));
  });
});

describe("the QR code", () => {
  it("draws one unit square per dark module", () => {
    expect(qrPath([[true, false], [false, true]])).toBe("M0 0h1v1h-1zM1 1h1v1h-1z");
  });
});
