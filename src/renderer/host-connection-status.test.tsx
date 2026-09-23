// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { HostConnectionState } from "../workbench/host-connection";
import { HostClientProvider } from "./host-client-context";
import { HostConnectionStatus } from "./host-connection-status";
import { createFakeHostClient } from "./test-support/fake-host-client";

afterEach(cleanup);

/** A client whose link state the test moves, the way a dropped socket does. */
function clientWithMovableState(refusal?: string) {
  const listeners = new Set<(state: HostConnectionState) => void>();
  let state: HostConnectionState = "connected";
  const client = createFakeHostClient({
    getConnectionState: () => state,
    getConnectionRefusal: () => (state === "refused" ? refusal : undefined),
    onConnectionState: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
  });
  return {
    client,
    set(next: HostConnectionState) {
      state = next;
      act(() => { for (const listener of listeners) listener(next); });
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
});
