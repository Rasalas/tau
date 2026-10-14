// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostSnapshot } from "tau";
import { createKitHarness, KitShell, RendererServicesProvider } from "../../src/renderer/test-support/kit-harness.js";
import { accessKitExtension } from "./desktop.js";
import { ACCESS_HOST_EXTENSION_ID } from "./protocol.js";

afterEach(cleanup);

function activate() {
  const calls: unknown[][] = [];
  const { registry, preferences } = createKitHarness(async (...args) => {
    calls.push(args);
    return args[2];
  });
  preferences.setValue(ACCESS_HOST_EXTENSION_ID, "level", "full");
  registry.activate(accessKitExtension);
  return { registry, calls, preferences };
}

const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("Access Kit desktop extension", () => {
  it("sends nothing on load, whatever this client stored, and the level a person picks at once", async () => {
    const { registry, calls, preferences } = activate();
    await settled();
    expect(calls).toEqual([]);
    // A sync from the host changes the stored value; that is not this client's change.
    preferences.applyConfig({ values: { "tau.access.level": "read-only" } });
    await settled();
    expect(calls).toEqual([]);
    const run = (id: string) => registry.getCommands().find((command) => command.id === id)!.run({ notify: vi.fn() } as never);
    void run("access.ask");
    expect(calls).toEqual([[ACCESS_HOST_EXTENSION_ID, "set-level", { level: "ask" }]]);
    // A pick of the level shown is still the person's: this client's copy may be stale.
    void run("access.ask");
    expect(calls).toHaveLength(2);
    expect(preferences.value(ACCESS_HOST_EXTENSION_ID, "level")).toBe("ask");
  });

  it("puts the level in the composer menu and disables ask mode a runtime cannot serve", () => {
    const { registry, preferences } = activate();
    const [control] = registry.getComposerControls();
    expect(control).toMatchObject({ id: "access.level", placement: "menu", shortcuts: ["composer.mode"] });
    const snapshot = { backendKind: "claude-code", runtimeCapabilities: { skillInvocationDialect: "claude-code", interactiveApprovals: false } } as unknown as HostSnapshot;
    const openSettings = vi.fn();
    render(
      <RendererServicesProvider services={{ preferences }}>
        <control.Component snapshot={snapshot} actions={{ openSettings } as never} />
      </RendererServicesProvider>,
    );
    expect(screen.getByRole("group", { name: "Access" })).toBeTruthy();
    // Settings' names, and the Edit files card's line for each level.
    const full = screen.getByRole("radio", { name: /^Full access/u });
    expect(full.getAttribute("aria-checked")).toBe("true");
    expect(full.textContent).toContain("Edit files, run commands: allowed without asking");
    const ask = screen.getByRole("radio", { name: /^Ask/u });
    expect(ask.textContent).toContain("asks every time");
    expect(ask).toHaveProperty("disabled", true);
    expect(ask.getAttribute("data-tooltip")).toContain("cannot stop for an approval");
    // Most runtimes ask at auto, so it needs approvals too.
    expect(screen.getByRole("radio", { name: /^Auto/u })).toHaveProperty("disabled", true);
    fireEvent.click(screen.getByRole("radio", { name: /^Read only/u }));
    expect(preferences.value(ACCESS_HOST_EXTENSION_ID, "level")).toBe("read-only");
    fireEvent.click(screen.getByRole("button", { name: "Details in Settings → Runtimes" }));
    expect(openSettings).toHaveBeenCalledWith("runtimes#runtime-permissions");
  });

  it("shows the level in force at every level, the default included, and opens its choices without duplicating the shortcut", () => {
    const { registry, preferences } = activate();
    const control = registry.getComposerControls().find((entry) => entry.id === "access.status")!;
    expect(control.placement).toBe("lead");
    const opened = vi.fn();
    render(
      <KitShell registry={registry}>
        <button type="button" data-composer-menu="" onClick={() => { throw new Error("Unrelated composer opened"); }}>Other composer</button>
        <div className="composer-chips"><button type="button" data-composer-menu="" onClick={opened}>More</button><control.Component /></div>
      </KitShell>,
    );
    // Full access is what a fresh workbench runs at, so it is the level that most needs saying.
    const full = screen.getByRole("button", { name: "Access: Full access" });
    expect(full.textContent).toBe("Full access");
    expect(full.getAttribute("data-tooltip")).toContain("allowed without asking");
    expect(full.getAttribute("data-tooltip-shortcut")).toBe(registry.keybindingLabel("composer.mode"));
    expect(full.getAttribute("data-tooltip-shortcut")).toBeTruthy();
    expect(full.hasAttribute("data-composer-shortcut")).toBe(false);
    // The footer row hides the label of a chip it marks collapsible, so a narrow composer keeps the lock and the aria-label.
    expect(full.hasAttribute("data-composer-collapsible")).toBe(true);
    fireEvent.click(full);
    expect(opened).toHaveBeenCalledOnce();
    const names: Array<[string, string]> = [["read-only", "Read only"], ["ask", "Ask before edits"], ["auto", "Auto review"], ["full", "Full access"]];
    for (const [level, name] of names) {
      act(() => { preferences.setValue(ACCESS_HOST_EXTENSION_ID, "level", level); });
      expect(screen.getByRole("button", { name: `Access: ${name}` }).textContent).toBe(name);
    }
    // A value this client does not know shows the default rather than nothing.
    act(() => { preferences.setValue(ACCESS_HOST_EXTENSION_ID, "level", "everything"); });
    expect(screen.getByRole("button", { name: "Access: Full access" })).toBeTruthy();
  });

  it("hides the chip's label when the footer row marks itself narrow, leaving the lock and the aria-label", () => {
    const css = readFileSync("kits/access/styles.css", "utf8");
    expect(css).toMatch(/\.composer-chips\[data-lead-icons\] \.composer-access-status \.composer-access-label \{ display: none; \}/u);
  });

  it("offers one palette command per level", () => {
    const { registry, preferences } = activate();
    const commands = registry.getCommands().filter((command) => command.id.startsWith("access."));
    expect(commands.map((command) => command.label)).toEqual(["Access: read-only", "Access: ask before edits", "Access: auto review", "Access: full access"]);
    const notify = vi.fn();
    void commands[1]?.run({ notify } as never);
    expect(preferences.value(ACCESS_HOST_EXTENSION_ID, "level")).toBe("ask");
  });

  it("opens the composer menu with composer.mode", () => {
    const { registry } = activate();
    const opened = vi.fn();
    render(<button type="button" data-composer-shortcut="composer.mode" onClick={opened}>…</button>);
    const notify = vi.fn();
    act(() => { void registry.getCommands().find((command) => command.id === "composer.mode")!.run({ notify } as never); });
    expect(opened).toHaveBeenCalledOnce();
    expect(registry.getKeybindings().find((binding) => binding.commandId === "composer.mode")?.keys).toBe("mod+shift+a");
    cleanup();
    void registry.getCommands().find((command) => command.id === "composer.mode")!.run({ notify } as never);
    expect(notify).toHaveBeenCalled();
  });
});
