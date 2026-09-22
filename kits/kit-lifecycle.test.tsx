// @vitest-environment jsdom
import { cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { CLIENT_PROFILES, createKitHarness, expectKitActivatesCleanly } from "../src/renderer/test-support/kit-harness.js";
import agents from "./agents/desktop.js";
import preview from "./preview/desktop.js";
import packages from "./packages/desktop.js";
import access from "./access/desktop.js";
import keybindings from "./keybindings/desktop.js";
import notifications from "./notifications/desktop.js";
import questionnaire from "./questionnaire/desktop.js";
import serviceTier from "./service-tier/desktop.js";
import computerUse from "./computer-use/desktop.js";
import composerContext from "./composer-context/desktop.js";
import review from "./review/desktop.js";
import signals from "./signals/desktop.js";
import subscriptionLogin from "./subscription-login/desktop.js";
import terminal from "./terminal/desktop.js";
import usage from "./usage/desktop.js";
import claudeCode from "./claude-code/desktop.js";
import codex from "./codex/desktop.js";
import piUi from "./pi-ui/desktop.js";
import projectScripts from "./project-scripts/desktop.js";
import promptTools from "./prompt-tools/desktop.js";
import search from "./search/desktop.js";
import { workspaceHostStub } from "../src/renderer/test-support/workspace-host-stub.js";
import threadRail from "./thread-rail/desktop.js";
import titleGenerator from "./thread-titles/desktop.js";
import workspace from "./workspace/desktop.js";
import worktreeNames from "./worktree-names/desktop.js";
import appearance from "./appearance/desktop.js";

// Every kit under `kits/` fills core slots and gives them all back. Add the
// kit's default export here when you move one; the shape of this list is the
// point, not its length.
const kits = [access, agents, claudeCode, codex, composerContext, computerUse, keybindings, notifications, packages, piUi, preview, projectScripts, promptTools, questionnaire, review, search, serviceTier, signals, subscriptionLogin, terminal, threadRail, titleGenerator, usage, workspace, worktreeNames, appearance];

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

  // Two kits claiming one chord means one of them silently never fires.
  it("binds no default chord twice across the kits Tau ships", () => {
    const { registry } = createKitHarness(workspaceHostStub());
    for (const extension of kits) registry.activate(extension);
    // A binding that says it `replaces` the other command holds the chord on purpose.
    const intended = (conflict: ReturnType<typeof registry.getKeybindingConflicts>[number]) => registry.getKeybindings()
      .some((binding) => binding.commandId === conflict.boundTo.commandId && binding.replaces === conflict.commandId);
    expect(registry.getKeybindingConflicts().filter((conflict) => !intended(conflict))
      .map((conflict) => `${conflict.keys}: ${conflict.commandId} vs ${conflict.boundTo.commandId}`)).toEqual([]);
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
