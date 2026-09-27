// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { HostSnapshot } from "tau";
import { createKitHarness, ObservatoryContext } from "../../src/renderer/test-support/kit-harness.js";
import { missingSettingsRows } from "../../src/renderer/test-support/kit-settings-page.js";
import { observatoryExtension } from "./desktop.js";
import { SIGNALS_SETTINGS_PAGE } from "./protocol.js";

afterEach(cleanup);

function renderPage(events: Array<{ id: string; label: string; detail: string; timestamp: number }>) {
  const { registry } = createKitHarness();
  registry.activate(observatoryExtension);
  const page = registry.getSettingsPages().find((entry) => entry.id === SIGNALS_SETTINGS_PAGE)!;
  const snapshot = { sessionId: "01a0e3c6-aaaa", extensionCount: 22 } as unknown as HostSnapshot;
  render(<ObservatoryContext.Provider value={{ events, snapshot, tools: [], registry }}><page.Component onNotify={() => undefined} /></ObservatoryContext.Provider>);
  return page;
}

describe("Settings → Signals", () => {
  it("states the live counts and streams host events newest first", () => {
    const page = renderPage([
      { id: "e1", label: "bootstrap.full-ready", detail: "", timestamp: 1_000 },
      { id: "e2", label: "codex.session", detail: "app-server for /work", timestamp: 2_000 },
    ]);
    const now = screen.getByLabelText("Now");
    expect(within(now).getByText("01a0e3c6")).toBeTruthy();
    expect(within(now).getByText("22")).toBeTruthy();
    expect(screen.getByText("Live")).toBeTruthy();
    const log = screen.getByRole("log", { name: "Host events" });
    expect([...log.querySelectorAll("strong")].map((label) => label.textContent)).toEqual(["codex.session", "bootstrap.full-ready"]);
    expect(missingSettingsRows(page)).toEqual([]);
  });

  it("says no event came yet instead of an empty box", () => {
    renderPage([]);
    expect(screen.getByText("No host events yet")).toBeTruthy();
    expect(screen.queryByRole("log")).toBeNull();
  });
});
