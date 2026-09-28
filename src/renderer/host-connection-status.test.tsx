// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostConnectionState } from "../workbench/host-connection";
import type { HostLink } from "../workbench/host-link";
import { HostClientProvider } from "./host-client-context";
import { HostConnectionStatus, HostLinkIndicator, describeHostLink, hostUpdatedTo } from "./host-connection-status";
import { ClientEnvironmentProvider, electronClientEnvironment } from "./client-environment";
import { createFakeHostClient } from "./test-support/fake-host-client";

afterEach(cleanup);

/** A client whose link state the test moves, the way a dropped socket does. */
function clientWithMovableState(refusal?: string, options: { link?: HostLink; localFiles?: boolean } = {}) {
  const listeners = new Set<(state: HostConnectionState) => void>();
  const linkListeners = new Set<(link: HostLink) => void>();
  let state: HostConnectionState = "connected";
  let link = options.link;
  const reconnectNow = vi.fn();
  const client = createFakeHostClient({
    getConnectionState: () => state,
    getConnectionRefusal: () => (state === "refused" ? refusal : undefined),
    onConnectionState: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    getConnectionLink: () => link,
    onConnectionLink: (listener) => { linkListeners.add(listener); return () => linkListeners.delete(listener); },
    hasCapability: (capability) => capability === "local-files" && options.localFiles === true,
    reconnectNow,
  });
  return {
    client,
    reconnectNow,
    set(next: HostConnectionState) {
      state = next;
      act(() => { for (const listener of listeners) listener(next); });
    },
    setLink(next: HostLink) {
      link = next;
      act(() => { for (const listener of linkListeners) listener(next); });
    },
  };
}

describe("host connection status", () => {
  it("stays out of the way until the link to a remote host breaks", () => {
    const link = clientWithMovableState();
    render(<HostClientProvider client={link.client}><HostConnectionStatus /></HostClientProvider>);
    expect(screen.queryByRole("status")).toBeNull();

    link.set("reconnecting");
    expect(screen.getByRole("status").textContent).toBe("Reconnecting to the host…");
    expect(screen.queryByRole("button", { name: "Retry now" })).toBeNull();

    link.set("resyncing");
    expect(screen.getByRole("status").textContent).toBe("Refetching the workbench state…");

    link.set("connected");
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("shows a refusal as an alert with the reason in full", () => {
    const link = clientWithMovableState("Expected SHA-256: AA\nPresented SHA-256: BB");
    render(<HostClientProvider client={link.client}><HostConnectionStatus /></HostClientProvider>);
    link.set("refused");
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("Tau refused the connection to the host");
    expect(alert.textContent).toContain("Expected SHA-256: AA\nPresented SHA-256: BB");
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("shows a version mismatch between the window's process and the host until dismissed", () => {
    const listeners = new Set<() => void>();
    let versions: { host?: string; window?: string } = { window: "0.4.1" };
    const client = createFakeHostClient({
      getVersions: () => versions,
      onVersions: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    });
    render(<HostClientProvider client={client}><HostConnectionStatus /></HostClientProvider>);
    expect(screen.queryByRole("status")).toBeNull();

    versions = { window: "0.4.1", host: "0.4.0" };
    act(() => { for (const listener of listeners) listener(); });
    const notice = screen.getByRole("status");
    expect(notice.textContent).toContain("This window runs Tau 0.4.1, its host runs 0.4.0.");

    act(() => { screen.getByRole("button", { name: "Dismiss" }).click(); });
    expect(screen.queryByRole("status")).toBeNull();

    versions = { window: "0.4.1", host: "0.3.0" };
    act(() => { for (const listener of listeners) listener(); });
    expect(screen.getByRole("status").textContent).toContain("its host runs 0.3.0");
  });

  it("offers a reload in a page the host served once the host runs another version", () => {
    const listeners = new Set<() => void>();
    let versions: { host?: string; window?: string } = {};
    const client = createFakeHostClient({
      getVersions: () => versions,
      onVersions: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    });
    const hello = (host: string) => { versions = { host }; act(() => { for (const listener of listeners) listener(); }); };
    render(<ClientEnvironmentProvider environment={{ ...electronClientEnvironment(new URLSearchParams()), servedByHost: true }}>
      <HostClientProvider client={client}><HostConnectionStatus /></HostClientProvider>
    </ClientEnvironmentProvider>);
    hello("0.7.8");
    expect(screen.queryByRole("status")).toBeNull();
    // A reconnect to the same host says nothing new.
    hello("0.7.8");
    expect(screen.queryByRole("status")).toBeNull();
    hello("0.7.9");
    expect(screen.getByRole("status").textContent).toBe("Tau was updated. Reload to continue.Reload");
  });

  it("says nothing about a host update where the page's code is its own", () => {
    const client = createFakeHostClient({ getVersions: () => ({ host: "0.7.8" }), onVersions: () => () => undefined });
    expect(hostUpdatedTo(client, "0.7.8")).toBeUndefined();
    expect(hostUpdatedTo(client, "0.7.9")).toBe("0.7.9");
    render(<ClientEnvironmentProvider environment={electronClientEnvironment(new URLSearchParams())}>
      <HostClientProvider client={client}><HostConnectionStatus /></HostClientProvider>
    </ClientEnvironmentProvider>);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("offers to retry now while waiting for the next attempt, and says so when the device is offline", () => {
    const link = clientWithMovableState(undefined, { link: { phase: "open", attempts: 0 } });
    render(<HostClientProvider client={link.client}><HostConnectionStatus /></HostClientProvider>);
    link.set("reconnecting");
    link.setLink({ phase: "waiting", attempts: 2, retryAt: 0 });
    act(() => { screen.getByRole("button", { name: "Retry now" }).click(); });
    expect(link.reconnectNow).toHaveBeenCalledTimes(1);

    link.setLink({ phase: "offline", attempts: 3, retryAt: 0 });
    expect(screen.getByRole("status").textContent).toContain("Offline. Tau reconnects when the network is back.");
  });
});

describe("host link indicator", () => {
  it("names the link's health for every state it can be in", () => {
    const open: HostLink = { phase: "open", attempts: 0 };
    expect(describeHostLink("connected", open)).toEqual({ tone: "ok", label: "Connected to the host" });
    expect(describeHostLink("connected", { ...open, roundTripMs: 42 })).toEqual({ tone: "ok", label: "Connected to the host, 42 ms round trip" });
    expect(describeHostLink("connected", { ...open, roundTripMs: 1_340 })).toEqual({ tone: "slow", label: "Slow connection to the host, 1.3 s round trip" });
    expect(describeHostLink("reconnecting", { phase: "waiting", attempts: 1 }).tone).toBe("pending");
    expect(describeHostLink("reconnecting", { phase: "connecting", attempts: 1 }).tone).toBe("pending");
    expect(describeHostLink("resyncing", open)).toEqual({ tone: "pending", label: "Refetching the workbench state…" });
    expect(describeHostLink("reconnecting", { phase: "offline", attempts: 4 }).tone).toBe("offline");
    expect(describeHostLink("refused", { phase: "closed", attempts: 0 }).tone).toBe("refused");
  });

  it("shows a dot for a host on another machine, and a click checks the link", () => {
    const link = clientWithMovableState(undefined, { link: { phase: "open", attempts: 0, roundTripMs: 30 } });
    render(<HostClientProvider client={link.client}><HostLinkIndicator /></HostClientProvider>);
    const dot = screen.getByRole("button", { name: "Connected to the host, 30 ms round trip" });
    expect(dot.getAttribute("data-tooltip")).toBe("Connected to the host, 30 ms round trip");
    act(() => dot.click());
    expect(link.reconnectNow).toHaveBeenCalledTimes(1);

    link.set("reconnecting");
    link.setLink({ phase: "waiting", attempts: 1, retryAt: 0 });
    expect(screen.getByRole("button", { name: "Reconnecting to the host…" }).className).toContain("pending");
  });

  it("stays away for the window's own host and for a client without a socket", () => {
    const local = clientWithMovableState(undefined, { link: { phase: "open", attempts: 0 }, localFiles: true });
    const { container } = render(<HostClientProvider client={local.client}><HostLinkIndicator /></HostClientProvider>);
    expect(container.innerHTML).toBe("");
    cleanup();
    const ipc = clientWithMovableState();
    const second = render(<HostClientProvider client={ipc.client}><HostLinkIndicator /></HostClientProvider>);
    expect(second.container.innerHTML).toBe("");
  });
});
