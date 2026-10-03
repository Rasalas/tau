// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostExtensionClient } from "tau";
import { TestProviders } from "../../src/renderer/test-support/test-providers";
import { createMachineToolsSection } from "./runtime-tools-section.js";
import { MACHINE_TOOLS_PROGRESS, MACHINE_TOOLS_STATE, MACHINE_TOOLS_UPDATE, type MachineTools } from "./protocol.js";

afterEach(cleanup);
const initial: MachineTools[] = [{ id: "local", name: "mini", local: true, state: { tools: [{ kinds: ["codex"], label: "Codex", tool: "codex", installed: "1.0.0", latest: "1.1.0", source: "npm", update: "npm update" }], log: [] } }, { id: "rex", name: "rex", problem: "connection dropped" }, { id: "sleep", name: "sleep", skipped: "Disconnected" }];
function setup() {
  const invoke = vi.fn(async () => initial);
  const Section = createMachineToolsSection({ invoke, onEvent: () => () => undefined } as unknown as HostExtensionClient);
  render(<TestProviders><Section /></TestProviders>);
  return invoke;
}
describe("shared machine tool settings", () => {
  it("shows per-machine availability and skips disconnected hosts", async () => {
    const invoke = setup();
    await screen.findByText("Codex 1.0.0 → 1.1.0");
    expect(screen.getByText("Disconnected")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Update available tools" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith(MACHINE_TOOLS_UPDATE, { requestId: expect.any(String) }));
  });
  it("retries only the failed machine", async () => {
    const invoke = setup();
    const retry = await screen.findByRole("button", { name: "Retry" });
    expect(invoke).toHaveBeenCalledWith(MACHINE_TOOLS_STATE, { requestId: expect.any(String) });
    fireEvent.click(retry);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith(MACHINE_TOOLS_UPDATE, { machine: "rex", requestId: expect.any(String) }));
  });
  it("shows completed machines while a slow peer is still pending and ignores stale events", async () => {
    let resolve!: (value: MachineTools[]) => void;
    const invoke = vi.fn((_command: string, _input?: unknown) => new Promise<MachineTools[]>((done) => { resolve = done; }));
    let event!: (payload: unknown) => void;
    const stop = vi.fn();
    const watch = vi.fn(() => stop);
    const onEvent = vi.fn((_name: string, listener: (payload: unknown) => void) => { event = listener; return stop; });
    const Section = createMachineToolsSection({ invoke, watch, onEvent });
    const mounted = render(<TestProviders><Section /></TestProviders>);
    await waitFor(() => expect(invoke).toHaveBeenCalledOnce());
    const id = (invoke.mock.calls[0]![1] as { requestId: string }).requestId;
    act(() => {
      event({ requestId: id, machine: { id: "slow", name: "slow", requesting: true } });
      event({ requestId: id, machine: { id: "fast", name: "fast", state: { tools: [], log: [] } } });
      event({ requestId: "old", machine: { id: "stale", name: "stale" } });
    });
    expect(screen.getByText("No managed tools")).toBeTruthy();
    expect(screen.getByText("Requesting…")).toBeTruthy();
    expect(screen.queryByText("stale")).toBeNull();
    expect(watch).toHaveBeenCalledWith(MACHINE_TOOLS_PROGRESS);
    await act(async () => { resolve([{ id: "slow", name: "slow", skipped: "Disconnected" }]); });
    expect(screen.getByText("Disconnected")).toBeTruthy();
    mounted.unmount();
    expect(stop).toHaveBeenCalledTimes(2);
  });
  it("offers no retry for an update whose outcome is still unknown", async () => {
    const invoke = vi.fn(async () => [{ id: "rex", name: "rex", uncertain: true, problem: "The update request may still be running." }]);
    const Section = createMachineToolsSection({ invoke, onEvent: () => () => undefined });
    render(<TestProviders><Section /></TestProviders>);
    await screen.findByText("The update request may still be running.");
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(screen.getByRole("button", { name: "Update available tools" }).hasAttribute("disabled")).toBe(true);
  });

});
