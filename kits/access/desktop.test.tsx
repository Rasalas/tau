// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostSnapshot } from "tau";
import { createKitHarness, RendererServicesProvider } from "../../src/renderer/test-support/kit-harness.js";
import { accessKitExtension } from "./desktop.js";
import { ACCESS_HOST_EXTENSION_ID } from "./protocol.js";

afterEach(cleanup);

function activate() {
  const calls: unknown[][] = [];
  const { registry, preferences } = createKitHarness(async (...args) => { calls.push(args); return args[2]; });
  preferences.setValue(ACCESS_HOST_EXTENSION_ID, "level", "full");
  registry.activate(accessKitExtension);
  return { registry, calls, preferences };
}

describe("Access Kit desktop extension", () => {
  it("pushes the stored level on activation and after every change", () => {
    const { registry, calls, preferences } = activate();
    expect(calls).toEqual([[ACCESS_HOST_EXTENSION_ID, "set-level", { level: "full" }]]);
    preferences.setValue(ACCESS_HOST_EXTENSION_ID, "level", "read-only");
    expect(calls.at(-1)).toEqual([ACCESS_HOST_EXTENSION_ID, "set-level", { level: "read-only" }]);
    registry.deactivate(ACCESS_HOST_EXTENSION_ID);
    preferences.setValue(ACCESS_HOST_EXTENSION_ID, "level", "ask");
    expect(calls).toHaveLength(2);
  });

  it("contributes the composer control and disables ask mode a runtime cannot serve", () => {
    const { registry, preferences } = activate();
    const [control] = registry.getComposerControls();
    expect(control?.id).toBe("access.level");
    const snapshot = { backendKind: "claude-code", runtimeCapabilities: { skillInvocationDialect: "claude-code", interactiveApprovals: false } } as unknown as HostSnapshot;
    render(
      <RendererServicesProvider services={{ preferences }}>
        <control.Component snapshot={snapshot} />
      </RendererServicesProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: /full access/u }));
    const ask = screen.getByRole("menuitem", { name: /ask before edits/u });
    expect(ask).toHaveProperty("disabled", true);
    expect(ask.getAttribute("data-tooltip")).toContain("cannot stop for an approval");
    fireEvent.click(screen.getAllByRole("menuitem", { name: /read-only/u })[0]!);
    expect(preferences.value(ACCESS_HOST_EXTENSION_ID, "level")).toBe("read-only");
  });

  it("offers one palette command per level", () => {
    const { registry, preferences } = activate();
    const commands = registry.getCommands().filter((command) => command.id.startsWith("access."));
    expect(commands.map((command) => command.label)).toEqual(["Access: read-only", "Access: ask before edits", "Access: full access"]);
    const notify = vi.fn();
    void commands[1]?.run({ notify } as never);
    expect(preferences.value(ACCESS_HOST_EXTENSION_ID, "level")).toBe("ask");
  });
});
