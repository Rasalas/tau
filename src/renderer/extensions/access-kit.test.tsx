// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostSnapshot } from "../../shared/contracts";
import { ExtensionRegistry } from "../extension-system";
import { PreferencesStore } from "../preferences";
import { RendererServicesProvider } from "../renderer-services-context";
import { accessKitExtension } from "./access-kit";

afterEach(cleanup);

function activate() {
  const preferences = new PreferencesStore();
  preferences.setValue("tau.access", "level", "full");
  const calls: unknown[][] = [];
  const registry = new ExtensionRegistry({ invoke: async (...args) => { calls.push(args); return args[2]; } }, { preferences });
  registry.activate(accessKitExtension);
  return { registry, calls, preferences };
}

describe("Access Kit desktop extension", () => {
  it("pushes the stored level on activation and after every change", async () => {
    const { registry, calls, preferences } = activate();
    expect(calls).toEqual([["tau.access", "set-level", { level: "full" }]]);
    preferences.setValue("tau.access", "level", "read-only");
    expect(calls.at(-1)).toEqual(["tau.access", "set-level", { level: "read-only" }]);
    registry.deactivate("tau.access");
    preferences.setValue("tau.access", "level", "ask");
    expect(calls).toHaveLength(2);
  });

  it("contributes the composer control and disables Claude's unsupported ask mode", () => {
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
    expect(ask.getAttribute("title")).toContain("cannot stop for an approval");
    fireEvent.click(screen.getAllByRole("menuitem", { name: /read-only/u })[0]!);
    expect(preferences.value("tau.access", "level")).toBe("read-only");
  });

  it("offers one palette command per level", () => {
    const { registry, preferences } = activate();
    const commands = registry.getCommands().filter((command) => command.id.startsWith("access."));
    expect(commands.map((command) => command.label)).toEqual(["Access: read-only", "Access: ask before edits", "Access: full access"]);
    const notify = vi.fn();
    void commands[1]?.run({ notify } as never);
    expect(preferences.value("tau.access", "level")).toBe("ask");
  });
});
