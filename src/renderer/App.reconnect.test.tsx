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
  let currentText = "Restored after reconnect";
  const bootstrap = vi.fn(async () => {
    const snapshot = await base.bootstrap();
    return { ...snapshot, detail: {
      ...snapshot.detail,
      sessionId: "recovered-thread",
      messages: [{ id: "recovered-message", role: "user" as const, text: currentText, timestamp: 1 }],
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
  expect(view.container.querySelector("[data-content-freshness]")?.getAttribute("data-content-freshness")).toBe("offline");
  const warning = screen.getByRole("status", { name: "Conversation not up to date" });
  expect(warning.textContent).toContain("Reconnecting…");
  expect(warning.textContent).toContain("Messages and agent status may be out of date.");
  currentText = "Updated while disconnected";
  act(() => { state = "connected"; for (const listener of listeners) listener(state); });
  await waitFor(() => expect(bootstrap).toHaveBeenCalledTimes(3));
  await waitFor(() => expect(view.container.querySelector("[data-content-freshness]")?.getAttribute("data-content-freshness")).toBe("current"));
  expect(await screen.findByText("Updated while disconnected")).toBeTruthy();
  expect(screen.queryByText("Restored after reconnect")).toBeNull();
  // Reconnect refreshes saved content; duplicate connected notifications do
  // not restart that read or mark the confirmed content loading again.
  act(() => { for (const listener of listeners) listener("connected"); });
  expect(bootstrap).toHaveBeenCalledTimes(3);
  expect(view.container.querySelector("[data-content-freshness]")?.getAttribute("data-content-freshness")).toBe("current");
});
