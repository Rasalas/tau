// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_NETWORK_SETTINGS, type UiConnections, type UiCreatedPairingLink, type UiNetworkAccess } from "../../shared/connections";
import type { HostClient } from "../../workbench/host-client";
import { HostClientProvider } from "../host-client-context";
import { createFakeHostClient } from "../test-support/fake-host-client";
import { TestProviders } from "../test-support/test-providers";
import { ConnectionsPage } from "./ConnectionsPage";
import { PairingQrCode, encodePairingQr, qrPath } from "./PairingQrCode";

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
      access: "full", idleTimeoutDays: 90, expiresAt: soon(90 * 86_400_000),
    }],
    requests: [],
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
      link: { id: "l1", label: "Laptop", access: "full", createdAt: soon(0), expiresAt: soon(10 * 60_000) },
      code: "abc",
      urls: [{ url: "http://127.0.0.1:4100/#pair=abc", label: "This machine", reachability: "loopback" }],
    };
    let listed = connections({ clients: [] });
    const createPairingLink = vi.fn(async () => { listed = { ...listed, links: [created.link] }; return created; });
    const copyText = vi.fn(async () => undefined);
    renderPage({ listConnections: async () => listed, createPairingLink, copyText });
    fireEvent.click(await screen.findByRole("button", { name: /Create link/u }));
    fireEvent.change(screen.getByPlaceholderText("e.g. Kitchen iPad"), { target: { value: "Laptop" } });
    fireEvent.click(screen.getByRole("radio", { name: "Read only" }));
    fireEvent.click(screen.getByRole("button", { name: "Create Link" }));
    await waitFor(() => expect(createPairingLink).toHaveBeenCalledWith({ label: "Laptop", lifetimeMs: 600_000, access: "read-only" }));
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
    fireEvent.click(within(screen.getByRole("dialog", { name: "Rotate the host token?" })).getByRole("button", { name: "Rotate" }));
    await waitFor(() => expect(rotateHostToken).toHaveBeenCalledOnce());
  });

  it("tells a paired client that the owner manages connections", async () => {
    renderPage({ listConnections: async () => { throw Object.assign(new Error("no"), { code: "forbidden" }); } });
    expect(await screen.findByText("Connections are managed on the host’s machine")).toBeTruthy();
  });

  it("still offers a link where no web client is served: the app pairs over the socket", async () => {
    renderPage({ listConnections: async () => connections({ webClient: false }) });
    expect((await screen.findByRole("button", { name: /Create link/u }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("shows a device waiting with its code and lets it in with the access picked", async () => {
    const request = {
      id: "r1", name: "Alex’s iPhone", device: { kind: "phone" as const, browser: "Safari", os: "iOS" }, address: "192.0.2.9",
      verification: "482913", access: "full" as const, createdAt: soon(0), expiresAt: soon(120_000),
    };
    const approvePairing = vi.fn(async () => ({ approved: true }));
    const { notify } = renderPage({ listConnections: async () => connections({ requests: [request] }), approvePairing });
    expect(await screen.findByText("482 913")).toBeTruthy();
    expect(screen.getByText(/without a pairing link/u)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Allow…" }));
    const dialog = await screen.findByRole("dialog", { name: "Alex’s iPhone wants to connect" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Read only" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Allow" }));
    await waitFor(() => expect(approvePairing).toHaveBeenCalledWith("r1", { access: "read-only" }));
    expect(notify).toHaveBeenCalledWith("Alex’s iPhone can connect now");
  });

  it("denies a waiting device from its row", async () => {
    const request = { id: "r1", device: { kind: "desktop" as const, browser: "Firefox", os: "Linux" }, link: { label: "Laptop" }, verification: "000001", access: "read-only" as const, createdAt: soon(0), expiresAt: soon(120_000) };
    const denyPairing = vi.fn(async () => ({ denied: true }));
    renderPage({ listConnections: async () => connections({ requests: [request] }), denyPairing });
    fireEvent.click(await screen.findByRole("button", { name: "Deny" }));
    await waitFor(() => expect(denyPairing).toHaveBeenCalledWith("r1"));
  });

  it("renames a device, narrows its access and changes when it is signed out", async () => {
    const updateClient = vi.fn(async () => ({ updated: true }));
    renderPage({ listConnections: async () => connections(), updateClient });
    fireEvent.click(await screen.findByRole("button", { name: "Settings for Kitchen iPad" }));
    const dialog = await screen.findByRole("dialog", { name: "Settings for Kitchen iPad" });
    fireEvent.change(within(dialog).getByDisplayValue("Kitchen iPad"), { target: { value: "Hall iPad" } });
    fireEvent.click(within(dialog).getByRole("radio", { name: "Read only" }));
    fireEvent.change(within(dialog).getByRole("combobox"), { target: { value: "never" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(updateClient).toHaveBeenCalledWith("c1", { label: "Hall iPad", access: "read-only", idleTimeoutDays: null }));
  });

  it("shows the last change, and warns a week before an unused device is signed out", async () => {
    const idle = {
      id: "c2", label: "Old phone", device: { kind: "phone" as const }, pairedAt: soon(-100 * 86_400_000), connections: 0, current: false,
      access: "read-only" as const, idleTimeoutDays: 90 as const, expiresAt: soon(3 * 86_400_000), lastSeenAt: soon(-87 * 86_400_000),
      lastAction: { action: "prompt", label: "sent a prompt", thread: "Fix the queue", at: soon(-87 * 86_400_000) },
    };
    renderPage({ listConnections: async () => connections({ clients: [idle] }) });
    expect(await screen.findByText(/Signed out in 3 days unless it connects/u)).toBeTruthy();
    expect(screen.getByText(/last change: sent a prompt in “Fix the queue”, 87 days ago/u)).toBeTruthy();
    expect(screen.getByText("Read only")).toBeTruthy();
  });

  it("signs out every other device only after asking", async () => {
    const revokeOtherClients = vi.fn(async () => ({ revoked: 1 }));
    const { notify } = renderPage({ listConnections: async () => connections(), revokeOtherClients });
    fireEvent.click(await screen.findByRole("button", { name: "Revoke others…" }));
    expect(revokeOtherClients).not.toHaveBeenCalled();
    fireEvent.click(within(screen.getByRole("dialog", { name: "Revoke every other device?" })).getByRole("button", { name: "Revoke others" }));
    await waitFor(() => expect(revokeOtherClients).toHaveBeenCalledOnce());
    expect(notify).toHaveBeenCalledWith("1 device signed out");
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

describe("Bonjour in Settings → Connections", () => {
  const off: UiNetworkAccess = { settings: DEFAULT_NETWORK_SETTINGS, listeners: [], problems: [], tailscaleUp: false };
  const lanOn: UiNetworkAccess = { ...off, settings: { ...DEFAULT_NETWORK_SETTINGS, lan: true }, listeners: [{ host: "::", port: 7788, kind: "network" }] };
  const FP = "AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89";

  it("offers the announcement only with Local network on, says how it is seen, and turns it off without asking", async () => {
    const network: UiNetworkAccess = { ...lanOn, announcement: { state: "announced", name: "Studio (2)", serviceType: "_tau._tcp" } };
    const setNetworkAccess = vi.fn(async () => network);
    renderPage({ listConnections: async () => connections({ network }), setNetworkAccess });
    expect(await screen.findByText("Devices here see this machine as “Studio (2)”.")).toBeTruthy();
    fireEvent.click(screen.getByRole("switch", { name: "Announce on this network" }));
    await waitFor(() => expect(setNetworkAccess).toHaveBeenCalledWith({ announce: false }));
    cleanup();
    renderPage({ listConnections: async () => connections({ network: off }) });
    await screen.findByText("Local network");
    expect(screen.queryByText("Announce on this network")).toBeNull();
  });

  it("says why nothing is announced", async () => {
    const network: UiNetworkAccess = { ...lanOn, announcement: { state: "unavailable", name: "Studio", serviceType: "_tau._tcp", detail: "Avahi is not installed: install avahi-utils (avahi-tools on Fedora) and run avahi-daemon." } };
    renderPage({ listConnections: async () => connections({ network }) });
    expect(await screen.findByText(/install avahi-utils/u)).toBeTruthy();
  });

  it("looks for machines only once asked, lists them with this machine marked, and says when there are none", async () => {
    const discoverHosts = vi.fn(async () => ({
      serviceType: "_tau._tcp",
      hosts: [
        { name: "Laptop", hostId: "b".repeat(32), fingerprint: FP, port: 7788, addresses: ["192.168.1.30"], endpoints: [{ url: "https://192.168.1.30:7788/", kind: "lan" as const }] },
        { name: "Studio", hostId: "a".repeat(32), fingerprint: FP, port: 7788, addresses: [], endpoints: [{ url: "https://studio.local:7788/", kind: "mdns" as const }], self: true },
      ],
    }));
    renderPage({ listConnections: async () => connections({ network: off }), discoverHosts });
    fireEvent.click(await screen.findByRole("button", { name: "Find machines…" }));
    const list = await screen.findByRole("list", { name: "Machines on this network" });
    expect(discoverHosts).toHaveBeenCalledTimes(1);
    expect(within(list).getByText(/^192\.168\.1\.30:7788 ·/u)).toBeTruthy();
    expect(within(list).getByText("This machine")).toBeTruthy();
    expect(within(list).getAllByTitle(`SHA-256 ${FP}`)).toHaveLength(2);

    discoverHosts.mockResolvedValueOnce({ serviceType: "_tau._tcp", hosts: [] });
    fireEvent.click(screen.getByRole("button", { name: "Search Again" }));
    expect(await screen.findByText("No Tau on this network")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(screen.queryByText("Machines on this network")).toBeNull();
  });

  it("says why it could not look", async () => {
    const discoverHosts = vi.fn(async () => ({ serviceType: "_tau._tcp", hosts: [], problem: "Failed to create client object: Daemon not running" }));
    renderPage({ listConnections: async () => connections({ network: off }), discoverHosts });
    fireEvent.click(await screen.findByRole("button", { name: "Find machines…" }));
    expect(await screen.findByText("Tau could not look on this network")).toBeTruthy();
    expect(screen.getByText("Failed to create client object: Daemon not running")).toBeTruthy();
  });
});

describe("the QR code", () => {
  it("draws one unit square per dark module", () => {
    expect(qrPath([[true, false], [false, true]])).toBe("M0 0h1v1h-1zM1 1h1v1h-1z");
  });

  it("takes the smallest version the link fits in at low correction", async () => {
    const small = await encodePairingQr("https://192.168.1.20:7788/#pair=abc");
    expect(small.version).toBe(3);
  });

  it("opens larger on a click and closes again", async () => {
    render(<PairingQrCode value="https://192.168.1.20:7788/#pair=abc" />);
    fireEvent.click(await screen.findByRole("button", { name: "Show the QR code larger" }));
    const dialog = screen.getByRole("dialog", { name: "Pairing QR code" });
    expect(within(dialog).getByRole("img", { name: "Pairing link as a QR code" })).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Close the large QR code" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
