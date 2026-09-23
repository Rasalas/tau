// @vitest-environment jsdom
import { cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { APP_MENU_CHORDS, CLIENT_PROFILES, createKitHarness, expectKitActivatesCleanly, normalizeKeyChord, runtimeControls } from "../src/renderer/test-support/kit-harness.js";
import agents from "./agents/desktop.js";
import preview from "./preview/desktop.js";
import packages from "./packages/desktop.js";
import access from "./access/desktop.js";
import keybindings from "./keybindings/desktop.js";
import notifications from "./notifications/desktop.js";
import onboarding from "./onboarding/desktop.js";
import questionnaire from "./questionnaire/desktop.js";
import serviceTier from "./service-tier/desktop.js";
import computerUse from "./computer-use/desktop.js";
import composerContext from "./composer-context/desktop.js";
import files from "./files/desktop.js";
import review from "./review/desktop.js";
import signals from "./signals/desktop.js";
import subscriptionLogin from "./subscription-login/desktop.js";
import terminal from "./terminal/desktop.js";
import usage from "./usage/desktop.js";
import claudeCode from "./claude-code/desktop.js";
import codex from "./codex/desktop.js";
import openCode from "./opencode/desktop.js";
import piProviders from "./pi-providers/desktop.js";
import cursor from "./cursor/desktop.js";
import grok from "./grok/desktop.js";
import piUi from "./pi-ui/desktop.js";
import plan from "./plan/desktop.js";
import projectScripts from "./project-scripts/desktop.js";
import promptTools from "./prompt-tools/desktop.js";
import search from "./search/desktop.js";
import { workspaceHostStub } from "../src/renderer/test-support/workspace-host-stub.js";
import threadRail from "./thread-rail/desktop.js";
import titleGenerator from "./thread-titles/desktop.js";
import workspace from "./workspace/desktop.js";
import worktreeNames from "./worktree-names/desktop.js";
import appearance from "./appearance/desktop.js";
import handoff from "./handoff/desktop.js";
import { screenService } from "./preview/screen-store.js";

// Every kit under `kits/` fills core slots and gives them all back. Add the
// kit's default export here when you move one; the shape of this list is the
// point, not its length.
const kits = [access, agents, claudeCode, codex, openCode, cursor, grok, composerContext, computerUse, files, keybindings, notifications, onboarding, packages, piProviders, piUi, plan, preview, projectScripts, promptTools, questionnaire, review, search, serviceTier, signals, subscriptionLogin, terminal, threadRail, titleGenerator, usage, workspace, worktreeNames, appearance, handoff];

afterEach(cleanup);

describe("packaged kits", () => {
  for (const extension of kits) {
    it(`${extension.id} activates into core slots and leaves nothing behind`, async () => {
      await expect(expectKitActivatesCleanly(extension, workspaceHostStub())).resolves.toBeUndefined();
    });
  }
});

// A kit that draws something has to say which clients can draw it. The default
// is desktop-only, which is safe but silent: this makes the claim deliberate.
describe("client profiles", () => {
  for (const extension of kits) {
    it(`${extension.id} declares a profile set for every contribution it renders`, () => {
      const { registry } = createKitHarness(workspaceHostStub());
      registry.activate(extension);
      const silent = registry.getProfiledContributions().filter((entry) => !entry.declared);
      expect(silent.map((entry) => `${entry.kind} ${entry.id}`)).toEqual([]);
      registry.deactivate(extension.id);
    });
  }

  for (const profile of CLIENT_PROFILES) {
    it(`activates every kit on the ${profile} profile without an error`, () => {
      for (const extension of kits) {
        const { registry } = createKitHarness(workspaceHostStub(), profile);
        expect(() => registry.activate(extension)).not.toThrow();
        expect(registry.isActive(extension.id)).toBe(true);
        registry.deactivate(extension.id);
      }
    });
  }

  // The web client exists now, so nothing may quietly go missing there: every
  // contribution a kit registers is either drawn or named as absent, with
  // enough about it for Settings to show a line the user can act on.
  it("accounts for every contribution on the web profile: drawn, or named as absent", () => {
    for (const extension of kits) {
      const { registry } = createKitHarness(workspaceHostStub(), "web");
      registry.activate(extension);
      const all = registry.getProfiledContributions();
      const absent = registry.getUnrenderedContributions();
      expect(absent.filter((entry) => entry.profiles.includes("web"))).toEqual([]);
      expect(all.filter((entry) => !entry.profiles.includes("web"))).toEqual(absent);
      const nameless = absent.filter((entry) => !entry.kind || !entry.id || !entry.extensionName);
      expect(nameless.map((entry) => entry.id)).toEqual([]);
      registry.deactivate(extension.id);
    }
  });

  // Two bindings claiming one chord means one of them silently never fires.
  // Core's own chords count, `mod` is Ctrl off macOS, and a `when` clause that
  // cannot hold beside the other one's keeps two bindings apart.
  for (const mac of [true, false]) {
    it(`binds no default chord twice across core and the kits Tau ships (${mac ? "macOS" : "Linux and Windows"})`, () => {
      const { registry } = createKitHarness(workspaceHostStub());
      registry.activateCore(runtimeControls);
      for (const extension of kits) registry.activate(extension);
      expect(registry.getKeybindingConflicts(mac).map((conflict) => `${conflict.keys}: ${conflict.commandId} vs ${conflict.boundTo.commandId}`)).toEqual([]);
      for (const extension of kits) registry.deactivate(extension.id);
    });
  }

  // The app menu takes its accelerators before the page sees them; Settings is
  // the one chord both bind, to the same command. A preview that wants the zoom
  // chords for its own page takes them in that view (`src/main/app-menu.ts`).
  it("leaves the app menu's chords to the menu, but Settings, which both bind to one command", () => {
    const { registry } = createKitHarness(workspaceHostStub());
    registry.activateCore(runtimeControls);
    for (const extension of kits) registry.activate(extension);
    const menu = new Set(Object.values(APP_MENU_CHORDS).map((chord) => normalizeKeyChord(chord)));
    const taken = registry.getKeybindings().filter((binding) => menu.has(normalizeKeyChord(binding.keys)));
    expect(taken.map((binding) => `${binding.keys}: ${binding.commandId}`)).toEqual([`${APP_MENU_CHORDS.settings}: runtime.settings`]);
    for (const extension of kits) registry.deactivate(extension.id);
  });

  it("gives a shared chord to the binding whose context the keyboard is in", () => {
    const { registry } = createKitHarness(workspaceHostStub());
    registry.activateCore(runtimeControls);
    for (const extension of kits) registry.activate(extension);
    const mac = /mac/iu.test(navigator.platform);
    const press = (key: string, contexts: string[], shift = false, code = "") => registry.matchKeybinding(
      new KeyboardEvent("keydown", { key, code, metaKey: mac, ctrlKey: !mac, shiftKey: shift }),
      (name) => contexts.includes(name),
    )?.command.id;
    expect(press("d", ["terminalFocus"])).toBe("terminal.split");
    expect(press("d", [])).toBe("review.toggle");
    expect(press("D", ["terminalFocus"], true)).toBe("terminal.splitDown");
    expect(press("D", [], true)).toBe("review.open");
    expect(press("n", ["terminalFocus"])).toBe("terminal.new");
    expect(press("n", [])).toBe("runtime.new-session");
    expect(press("w", ["terminalFocus"])).toBe("terminal.close");
    expect(press("w", ["terminalFocus", "stageFocus"])).toBe("workbench.close-stage-tab");
    expect(press("w", [])).toBe("workbench.close-stage-tab");
    expect(press("s", ["editorFocus"])).toBe("files.save");
    expect(press("s", [])).toBe("prompt-tools.stash");
    expect(press("s", ["terminalFocus"])).toBeUndefined();
    expect(press("1", [])).toBe("thread.jump-1");
    expect(press("1", ["modelPickerOpen"])).toBeUndefined();
    expect(press("j", ["terminalFocus"])).toBe("terminal.toggle");
    expect(press("b", [])).toBe("workbench.toggle-sidebar");
    // ⇧ turns ] into }; the physical key still names the chord.
    expect(press("}", [], true, "BracketRight")).toBe("thread.next");
    for (const extension of kits) registry.deactivate(extension.id);
  });

  it("leaves the host half of a kit alone when this client draws none of it", () => {
    const invoked: string[] = [];
    const host = async (extensionId: string, command: string) => { invoked.push(`${extensionId}:${command}`); return undefined; };
    const { registry } = createKitHarness(host, "web");
    registry.activate(workspace);
    // Workspace Kit is desktop-only, so nothing of it is drawn here …
    expect(registry.getPanels()).toEqual([]);
    expect(registry.getSidebarContributions()).toEqual([]);
    expect(registry.getDocumentSource()).toBeUndefined();
    // … and every one of those contributions is named as absent, not lost.
    const unrendered = registry.getUnrenderedContributions();
    expect(unrendered.length).toBeGreaterThan(8);
    expect(unrendered.every((entry) => entry.extensionId === workspace.id)).toBe(true);
    // The host half was never asked to stand down: it keeps taking checkpoints.
    expect(registry.isActive(workspace.id)).toBe(true);
    expect(invoked.some((entry) => entry.includes("deactivate"))).toBe(false);
    registry.deactivate(workspace.id);
  });
});

describe("kits that meet through a service", () => {
  it("hands Computer Use's screen to Preview Kit's Screen view, and takes it back", () => {
    const { registry } = createKitHarness(workspaceHostStub());
    registry.activate(preview);
    expect(screenService.get()).toBeUndefined();
    registry.activate(computerUse);
    expect(screenService.get()).toBeDefined();
    registry.deactivate(computerUse.id);
    expect(screenService.get()).toBeUndefined();
    registry.deactivate(preview.id);
  });
});
