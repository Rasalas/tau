// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { HostSnapshot } from "../../shared/contracts";
import { Region, StatusLine } from "../components/Regions";
import { ExtensionRegistry, type RegionPlacement, type WorkbenchActions } from "../extension-system";
import { createMemoryStorage } from "../client-storage";
import { ClientStorageProvider } from "../client-storage-context";
import { PreferencesStore } from "../preferences";
import { RendererServicesProvider } from "../renderer-services-context";
import { workspaceHostStub } from "../test-support/workspace-host-stub";
import { ObservatoryContext, WorkbenchContext, WorkbenchShellContext } from "../workbench-context";
import { bundledExtensions } from "./index";
import { WorkspaceStore } from "./workspace-store";

const PLACEMENTS: RegionPlacement[] = ["title-bar", "composer-above", "composer-below", "transcript-header", "transcript-footer"];
const snapshot = { sessionId: "s1", cwd: "/project", isStreaming: false, models: [], thinkingLevel: "medium", thinkingLevels: ["medium"], messages: [], activeTools: [], allTools: [], extensionCount: 0 } as unknown as HostSnapshot;
const actions = new Proxy({}, { get: () => () => undefined }) as WorkbenchActions;

afterEach(cleanup);

describe("bundled kits", () => {
  for (const extension of bundledExtensions) {
    it(`${extension.id} activates into core slots and leaves nothing behind`, async () => {
      const preferences = new PreferencesStore();
      const workspaceStore = new WorkspaceStore(preferences);
      const registry = new ExtensionRegistry({ invoke: workspaceHostStub() }, { preferences, workspaceStore });
      registry.activate(extension);
      expect(registry.isActive(extension.id)).toBe(true);
      const workbench = { snapshot, tools: [], events: [], registry, openFile: () => undefined, applySnapshot: () => undefined, handleHostEvent: () => undefined };
      const view = render(
        <ClientStorageProvider storage={createMemoryStorage()}>
          <RendererServicesProvider services={{ preferences, workspaceStore }}>
            <WorkbenchShellContext.Provider value={{ snapshot, registry }}>
              <WorkbenchContext.Provider value={workbench}>
                <ObservatoryContext.Provider value={{ events: [], snapshot, tools: [], registry }}>
                  {PLACEMENTS.map((placement) => <Region key={placement} placement={placement} registry={registry} snapshot={snapshot} actions={actions} />)}
                  <StatusLine registry={registry} snapshot={snapshot} actions={actions} />
                </ObservatoryContext.Provider>
              </WorkbenchContext.Provider>
            </WorkbenchShellContext.Provider>
          </RendererServicesProvider>
        </ClientStorageProvider>,
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
      view.unmount();
      registry.deactivate(extension.id);
      expect(registry.isActive(extension.id)).toBe(false);
      const leftovers = [
        ...registry.getPanels(), ...registry.getSidebarContributions(), ...registry.getProjectSources(), ...registry.getCommands(),
        ...registry.getSlashCommands(), ...registry.getKeybindings(), ...registry.getComposerControls(), ...registry.getStatusItems(),
        ...PLACEMENTS.flatMap((placement) => registry.getRegions(placement)),
      ];
      expect(leftovers).toEqual([]);
      expect(registry.getDocumentSource()).toBeUndefined();
    });
  }
});
