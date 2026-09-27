import { render, renderHook } from "@testing-library/react";
import { vi, type Mock } from "vitest";
import { ExtensionRegistry, type DesktopExtension, type HostExtensionBridge, type RegionPlacement, type WorkbenchActions } from "../extension-system";
import type { HostSnapshot } from "../../shared/contracts";
import type { ClientProfile } from "../../workbench/client-profile";
import type { Platform } from "../../workbench/platform";
import { Region, StatusLine } from "../components/Regions";
import { createMemoryStorage } from "../../workbench/client-storage";
import { ClientStorageProvider } from "../client-storage-context";
import { PreferencesStore } from "../preferences";
import { RendererServicesProvider } from "../renderer-services-context";
import { ObservatoryContext, WorkbenchContext, WorkbenchShellContext } from "../workbench-context";
import { useAppKeybindings as useWindowKeybindings } from "../use-app-keybindings";

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
export function createKitHarness(invoke?: HostExtensionBridge["invoke"], profile?: ClientProfile, platform?: Partial<Platform>): KitHarness {
  const preferences = new PreferencesStore();
  const registry = new ExtensionRegistry({ invoke: invoke ?? (async () => undefined) }, {
    preferences,
    ...(profile ? { profile } : {}),
    ...(platform ? { platform: () => platform as Platform } : {}),
  });
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
    ...registry.getSettingsPages(), ...registry.getPages(), ...registry.getStageTabKinds(), ...registry.getMessageActions(), ...registry.getMessageBlocks(), ...registry.getComposerInlines(), ...registry.getComposerGates(), ...registry.getModelBadges(),
    ...registry.getPaletteSources(),
    ...KIT_REGION_PLACEMENTS.flatMap((placement) => registry.getRegions(placement)),
  ];
  if (leftovers.length > 0) throw new Error(`${extension.id} left ${leftovers.length} contributions behind`);
  if (registry.getDocumentSource()) throw new Error(`${extension.id} left its document source registered`);
  if (registry.getModelSelection()) throw new Error(`${extension.id} left its model selection registered`);
  if (registry.getServiceIds().length > 0) throw new Error(`${extension.id} left ${registry.getServiceIds().join(", ")} published`);
}

/**
 * The renderer pieces a kit's own tests need to stand one of its components
 * up on its own. They are re-exported here rather than imported directly so
 * that `kits-boundary.test.ts` keeps its one rule: a kit reaches core through
 * the API, and its tests reach core through the two harnesses.
 */
export { PreferencesStore } from "../preferences";
/** Core's own chords, for tests that weigh a kit's chords against them. */
export { runtimeControls } from "../settings/runtime-controls";
/** The window's keydown dispatcher, for tests that press a kit's chords. */
export { useAppKeybindings } from "../use-app-keybindings";
export { RendererServicesProvider } from "../renderer-services-context";
export { WorkbenchContext, WorkbenchShellContext, ObservatoryContext, ThreadStoreContext } from "../workbench-context";
export { ThreadStore } from "../../workbench/thread-store";
export { ClientStorageProvider } from "../client-storage-context";
export { createMemoryStorage, getClientStorage, setClientStorage } from "../../workbench/client-storage";
export { createNewThreadDraft, writeNewThreadDraft } from "../../workbench/draft-store";
export { createNewThreadRequestId } from "../../shared/contracts";
export { HostClientProvider, setHostClient } from "../host-client-context";
export { HOST_CAPABILITY } from "../../shared/host-transport";
export { CLIENT_PROFILES, type ClientProfile } from "../../workbench/client-profile";
export { APP_MENU_CHORDS } from "../../shared/window-shell";
export { normalizeKeyChord } from "../keybindings";

/**
 * A running turn as the window's keyboard sees it: core's Escape binding for
 * Stop, live. `abort` counts the stops; the chat is whatever is marked
 * `data-keybinding-context="chat"`.
 */
export function runningTurn(): { abort: Mock; registry: ExtensionRegistry } {
  const registry = new ExtensionRegistry();
  const abort = vi.fn();
  registry.activate({ id: "test.core", name: "Core stand-in", activate: (context) => {
    context.registerCommand({ id: "runtime.abort", label: "Stop the run", group: "Runtime", run: abort });
    context.registerKeybinding({ keys: "escape", commandId: "runtime.abort", when: "chatFocus" });
  } });
  renderHook(() => useWindowKeybindings(registry, { notify: vi.fn(), openSettings: vi.fn() } as unknown as WorkbenchActions, vi.fn()));
  return { abort, registry };
}
