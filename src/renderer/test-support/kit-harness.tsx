import { render } from "@testing-library/react";
import { ExtensionRegistry, type DesktopExtension, type HostExtensionBridge, type RegionPlacement, type WorkbenchActions } from "../extension-system";
import type { HostSnapshot } from "../../shared/contracts";
import type { ClientProfile } from "../../workbench/client-profile";
import { Region, StatusLine } from "../components/Regions";
import { createMemoryStorage } from "../../workbench/client-storage";
import { ClientStorageProvider } from "../client-storage-context";
import { PreferencesStore } from "../preferences";
import { RendererServicesProvider } from "../renderer-services-context";
import { ObservatoryContext, WorkbenchContext, WorkbenchShellContext } from "../workbench-context";

export const KIT_REGION_PLACEMENTS: RegionPlacement[] = ["title-bar", "thread-title", "composer-above", "composer-below", "transcript-header", "transcript-footer"];

const KIT_SNAPSHOT = {
  sessionId: "s1", cwd: "/project", isStreaming: false, models: [], thinkingLevel: "medium",
  thinkingLevels: ["medium"], messages: [], activeTools: [], allTools: [], extensionCount: 0,
} as unknown as HostSnapshot;

export interface KitHarness {
  registry: ExtensionRegistry;
  preferences: PreferencesStore;
}

/**
 * A registry with the renderer's own shared services, for a kit's own tests.
 * Kits live outside `src/`, so this, `workspaceHostStub` and
 * `createFakeHostClient` are the only renderer modules their tests reach for.
 */
export function createKitHarness(invoke?: HostExtensionBridge["invoke"], profile?: ClientProfile): KitHarness {
  const preferences = new PreferencesStore();
  const registry = new ExtensionRegistry({ invoke: invoke ?? (async () => undefined) }, { preferences, ...(profile ? { profile } : {}) });
  return { registry, preferences };
}

/**
 * Activates one kit into the core slots, renders every slot it may fill, then
 * removes it and fails if anything of it stayed behind.
 */
export async function expectKitActivatesCleanly(
  extension: DesktopExtension,
  invoke?: HostExtensionBridge["invoke"],
): Promise<void> {
  const { registry, preferences } = createKitHarness(invoke);
  const snapshot = KIT_SNAPSHOT;
  const actions = new Proxy({}, { get: () => () => undefined }) as WorkbenchActions;
  registry.activate(extension);
  if (!registry.isActive(extension.id)) throw new Error(`${extension.id} did not activate`);
  const workbench = { snapshot, tools: [], events: [], registry, openFile: () => undefined, applySnapshot: () => undefined, handleHostEvent: () => undefined };
  const view = render(
    <ClientStorageProvider storage={createMemoryStorage()}>
      <RendererServicesProvider services={{ preferences }}>
        <WorkbenchShellContext.Provider value={{ snapshot, registry }}>
          <WorkbenchContext.Provider value={workbench}>
            <ObservatoryContext.Provider value={{ events: [], snapshot, tools: [], registry }}>
              {KIT_REGION_PLACEMENTS.map((placement) => <Region key={placement} placement={placement} registry={registry} snapshot={snapshot} actions={actions} />)}
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
  if (registry.isActive(extension.id)) throw new Error(`${extension.id} stayed active after deactivation`);
  const leftovers = [
    ...registry.getPanels(), ...registry.getSidebarContributions(), ...registry.getProjectSources(), ...registry.getCommands(),
    ...registry.getSlashCommands(), ...registry.getKeybindings(), ...registry.getComposerControls(), ...registry.getStatusItems(),
    ...registry.getSettingsPages(), ...registry.getStageTabKinds(), ...registry.getComposerGates(), ...registry.getModelBadges(),
    ...KIT_REGION_PLACEMENTS.flatMap((placement) => registry.getRegions(placement)),
  ];
  if (leftovers.length > 0) throw new Error(`${extension.id} left ${leftovers.length} contributions behind`);
  if (registry.getDocumentSource()) throw new Error(`${extension.id} left its document source registered`);
  if (registry.getServiceIds().length > 0) throw new Error(`${extension.id} left ${registry.getServiceIds().join(", ")} published`);
}

/**
 * The renderer pieces a kit's own tests need to stand one of its components
 * up on its own. They are re-exported here rather than imported directly so
 * that `kits-boundary.test.ts` keeps its one rule: a kit reaches core through
 * the API, and its tests reach core through the two harnesses.
 */
export { PreferencesStore } from "../preferences";
export { RendererServicesProvider } from "../renderer-services-context";
export { WorkbenchContext, WorkbenchShellContext, ObservatoryContext } from "../workbench-context";
export { ClientStorageProvider } from "../client-storage-context";
export { createMemoryStorage, getClientStorage, setClientStorage } from "../../workbench/client-storage";
export { createNewThreadDraft, writeNewThreadDraft } from "../../workbench/draft-store";
export { createNewThreadRequestId } from "../../shared/contracts";
export { HostClientProvider, setHostClient } from "../host-client-context";
export { HOST_CAPABILITY } from "../../shared/host-transport";
export { CLIENT_PROFILES, type ClientProfile } from "../../workbench/client-profile";
