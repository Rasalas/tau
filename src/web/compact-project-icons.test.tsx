// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DesktopExtension } from "../renderer/extension-system";
import { setHostClient } from "../renderer/host-client-context";
import { createRendererServices } from "../renderer/renderer-services";
import { createFakeHostClient } from "../renderer/test-support/fake-host-client";
import { installPointerEvents } from "../renderer/test-support/pointer-events";
import { workspaceHostStub } from "../renderer/test-support/workspace-host-stub";
import { createMemoryStorage, setClientStorage } from "../workbench/client-storage";
import { WebWorkbench, webClientEnvironment } from "./WebWorkbench";
import { webcrypto } from "node:crypto";
import { withTrustedExtensions } from "../../mobile/src/trusted-extensions";

const kitModules = import.meta.glob<{ default: DesktopExtension }>("../../kits/workspace/desktop.tsx");
const { default: workspaceExtension } = await kitModules["../../kits/workspace/desktop.tsx"]!();

const picture = (name: string) => `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg"><text>${name}</text></svg>`)}`;
const divekit = picture("divekit");
const home = picture("home");
const projects = [
  { path: "/repos/divekit", name: "divekit-cli", workspaceId: "ws-divekit", lastOpenedAt: 2 },
  { path: "/home/tbuck", name: "tbuck", workspaceId: "ws-home", lastOpenedAt: 1 },
];

beforeEach(() => {
  installPointerEvents();
  Object.defineProperty(window, "innerWidth", { value: 400, configurable: true, writable: true });
  Object.defineProperty(window, "innerHeight", { value: 844, configurable: true, writable: true });
  Object.defineProperty(window.screen, "width", { value: 400, configurable: true });
  Object.defineProperty(window.screen, "height", { value: 844, configurable: true });
});
afterEach(() => {
  cleanup(); setHostClient(undefined); setClientStorage(undefined);
  vi.unstubAllGlobals();
  Object.defineProperty(window, "innerWidth", { value: 1024, configurable: true, writable: true });
  window.history.replaceState(null, "", "/");
});

describe("chosen project pictures on a phone", () => {
  it("keeps chosen pictures when the native client rejects a different workspace kit version", async () => {
    vi.stubGlobal("crypto", webcrypto);
    const kit = { id: "tau.workspace", path: "/workspace.js", scope: "bundled" as const, code: "export default {}", permissions: [] };
    const source = createFakeHostClient({
      bootstrap: async () => ({
        version: 1,
        threadIndex: { projects, sessions: [] },
        detail: { sessionId: "blank", messages: [], isStreaming: false, activeTools: [] },
        catalog: { sessionId: "blank", models: [], thinkingLevel: "off", thinkingLevels: ["off"], allTools: [], extensionCount: 0, supportsImageInput: false },
        project: { cwd: "/repos/divekit", workspaceId: "ws-divekit" },
      }),
      getConfig: async () => ({ values: {
        "tau.workspace.project-icon:ws-divekit": JSON.stringify({ kind: "image", image: divekit }),
        "tau.workspace.project-icon:/home/tbuck": JSON.stringify({ kind: "image", image: home }),
      } }),
      loadDesktopExtensions: async () => ({ bundles: [{ ...kit, code: "export default { changed: true }" }], errors: [], skipped: [] }),
    });
    const client = withTrustedExtensions(source, async () => [kit]);
    const rejected = await client.loadDesktopExtensions("/repos/divekit", {});
    expect(rejected.bundles).toEqual([]);
    expect(rejected.errors).toContainEqual(expect.objectContaining({ message: "This machine runs another version of this extension; install the same Tau version on both." }));
    const storage = createMemoryStorage();
    setHostClient(client); setClientStorage(storage);
    render(<WebWorkbench client={client} storage={storage} services={createRendererServices()} environment={webClientEnvironment("compact")} />);
    const threads = await screen.findByRole("region", { name: "Threads" });
    fireEvent.click(within(threads).getByRole("button", { name: "New thread" }));
    const picker = await screen.findByRole("dialog", { name: "Choose project" });
    await waitFor(() => expect(within(picker).getByRole("option", { name: /divekit-cli/u }).querySelector("img")?.getAttribute("src")).toBe(divekit));
    expect(within(picker).getByRole("option", { name: /tbuck/u }).querySelector("img")?.getAttribute("src")).toBe(home);
  });

  it("loads workspace and legacy path choices from the host and follows a changed choice in the project picker", async () => {
    let selected = divekit;
    const host = workspaceHostStub();
    const client = createFakeHostClient({
      bootstrap: async () => ({
        version: 1,
        threadIndex: { projects, sessions: [] },
        detail: { sessionId: "blank", messages: [], isStreaming: false, activeTools: [] },
        catalog: { sessionId: "blank", models: [], thinkingLevel: "off", thinkingLevels: ["off"], allTools: [], extensionCount: 0, supportsImageInput: false },
        project: { cwd: "/repos/divekit", workspaceId: "ws-divekit" },
      }),
      getConfig: async () => ({ values: {
        "tau.workspace.project-icon:ws-divekit": JSON.stringify({ kind: "image", image: selected }),
        "tau.workspace.project-icon:/home/tbuck": JSON.stringify({ kind: "image", image: home }),
      } }),
      invokeHostExtension: host,
    });
    const storage = createMemoryStorage();
    setHostClient(client); setClientStorage(storage);
    render(<WebWorkbench client={client} storage={storage} services={createRendererServices([workspaceExtension])} environment={webClientEnvironment("compact")} />);
    const threads = await screen.findByRole("region", { name: "Threads" });
    fireEvent.click(within(threads).getByRole("button", { name: "New thread" }));
    const picker = await screen.findByRole("dialog", { name: "Choose project" });
    const option = (name: string) => within(picker).getByRole("option", { name: new RegExp(name, "u") });
    await waitFor(() => expect(option("divekit-cli").querySelector("img")?.getAttribute("src")).toBe(divekit));
    expect(option("tbuck").querySelector("img")?.getAttribute("src")).toBe(home);
    selected = picture("new-divekit");
    act(() => client.emit({ type: "config-changed", kind: "config", paths: [] }));
    await waitFor(() => expect(option("divekit-cli").querySelector("img")?.getAttribute("src")).toBe(selected));
  });
});
