// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UiConnections, UiCreatedPairingLink } from "../../shared/connections";
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

function renderPage(overrides: Partial<HostClient>) {
  const notify = vi.fn();
  const client = createFakeHostClient(overrides);
  render(<TestProviders><HostClientProvider client={client}><ConnectionsPage onNotify={notify} /></HostClientProvider></TestProviders>);
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

describe("the QR code", () => {
  it("draws one unit square per dark module", () => {
    expect(qrPath([[true, false], [false, true]])).toBe("M0 0h1v1h-1zM1 1h1v1h-1z");
  });
});
