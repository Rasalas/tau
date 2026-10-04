// @vitest-environment jsdom
import { act, cleanup, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { HostConnectionState } from "../workbench/host-connection";
import { setClientStorage } from "../workbench/client-storage";
import { setHostClient } from "./host-client-context";
import { createFakeHostClient } from "./test-support/fake-host-client";
import { renderApp } from "./test-support/render-app";

afterEach(() => { cleanup(); setHostClient(undefined); setClientStorage(undefined); });

it("loads the workbench after its initial bootstrap was lost with the connection", async () => {
  const listeners = new Set<(state: HostConnectionState) => void>();
  let state: HostConnectionState = "reconnecting";
  const base = createFakeHostClient();
  const bootstrap = vi.fn(async () => {
    const snapshot = await base.bootstrap();
    return { ...snapshot, detail: {
      ...snapshot.detail,
      sessionId: "recovered-thread",
      messages: [{ id: "recovered-message", role: "user" as const, text: "Restored after reconnect", timestamp: 1 }],
    } };
  });
  bootstrap.mockRejectedValueOnce(new Error("The host connection dropped."));
  const client = createFakeHostClient({
    bootstrap,
    getConnectionState: () => state,
    onConnectionState: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
  });
  const view = renderApp(client);
  await screen.findByText("The host connection dropped.");
  act(() => { state = "connected"; for (const listener of listeners) listener(state); });
  await waitFor(() => expect(bootstrap).toHaveBeenCalledTimes(2));
  expect(await screen.findByText("Restored after reconnect")).toBeTruthy();
  await waitFor(() => expect(view.storage.keys().some((key) => key.includes("bootstrap"))).toBe(true));
  act(() => { state = "reconnecting"; for (const listener of listeners) listener(state); });
  act(() => { state = "connected"; for (const listener of listeners) listener(state); });
  expect(bootstrap).toHaveBeenCalledTimes(2);
});
