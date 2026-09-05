// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { HostConnectionState } from "./host-connection";
import { HostClientProvider } from "./host-client-context";
import { HostConnectionStatus } from "./host-connection-status";
import { createFakeHostClient } from "./test-support/fake-host-client";

afterEach(cleanup);

/** A client whose link state the test moves, the way a dropped socket does. */
function clientWithMovableState() {
  const listeners = new Set<(state: HostConnectionState) => void>();
  let state: HostConnectionState = "connected";
  const client = createFakeHostClient({
    getConnectionState: () => state,
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
});
