// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostExtensionClient } from "tau";
import { TestProviders } from "../../src/renderer/test-support/test-providers";
import { createMachineToolsSection } from "./runtime-tools-section.js";
import { MACHINE_TOOLS_STATE, MACHINE_TOOLS_UPDATE, type MachineTools } from "./protocol.js";

afterEach(cleanup);
const initial: MachineTools[] = [{ id: "local", name: "mini", local: true, state: { tools: [{ kinds: ["codex"], label: "Codex", tool: "codex", installed: "1.0.0", latest: "1.1.0", source: "npm", update: "npm update" }], log: [] } }, { id: "rex", name: "rex", problem: "connection dropped" }, { id: "sleep", name: "sleep", skipped: "Disconnected" }];
function setup() {
  const invoke = vi.fn(async () => initial);
  const Section = createMachineToolsSection({ invoke } as unknown as HostExtensionClient);
  render(<TestProviders><Section /></TestProviders>);
  return invoke;
}
describe("shared machine tool settings", () => {
  it("shows per-machine availability and skips disconnected hosts", async () => {
    const invoke = setup();
    await screen.findByText("Codex 1.0.0 → 1.1.0");
    expect(screen.getByText("Disconnected")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Update available tools" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith(MACHINE_TOOLS_UPDATE, undefined));
  });
  it("retries only the failed machine", async () => {
    const invoke = setup();
    const retry = await screen.findByRole("button", { name: "Retry" });
    expect(invoke).toHaveBeenCalledWith(MACHINE_TOOLS_STATE);
    fireEvent.click(retry);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith(MACHINE_TOOLS_UPDATE, { machine: "rex" }));
  });
});
