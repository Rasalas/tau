// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import type { UiSession } from "../shared/contracts";
import type { DesktopExtension } from "../renderer/extension-system";
import { createFakeHostClient } from "../renderer/test-support/fake-host-client";
import { createRendererServices } from "../renderer/renderer-services";
import { setHostClient } from "../renderer/host-client-context";
import { createMemoryStorage, setClientStorage } from "../workbench/client-storage";
import { WebWorkbench, webClientEnvironment } from "./WebWorkbench";

afterEach(() => { cleanup(); setHostClient(undefined); setClientStorage(undefined); window.history.replaceState(null, "", "/"); });

it("opens a machine proxy as an own thread while displaying its home marks on the phone", async () => {
  const local: UiSession = { id: "local", path: "/local", title: "Local", modifiedAt: 2, projectPath: "/api", projectName: "api", messageCount: 1 };
  const proxy: UiSession = {
    ...local, id: "rex~t1", path: "rex~t1", title: "Build on rex", backendKind: "machine", modelProvider: "anthropic",
    machine: { id: "rex", name: "rex", backendKind: "codex", modelProvider: "openai" },
  };
  const client = createFakeHostClient({
    bootstrap: async () => ({
      version: 1,
      threadIndex: { projects: [], sessions: [local, proxy] },
      detail: { sessionId: local.id, messages: [], isStreaming: false, activeTools: [] },
      catalog: { sessionId: local.id, models: [], thinkingLevel: "off", thinkingLevels: ["off"], allTools: [], extensionCount: 0 },
      project: { cwd: "/api" },
    }),
  });
  // The list names the own host too; a proxy must still name its home machine.
  const machines: DesktopExtension = {
    id: "test.machines", name: "Machines",
    activate(context) {
      context.registerThreadListSource({ id: "machines", subscribe: () => () => undefined, threads: () => [], here: () => ({ name: "mini", icon: <svg /> }) });
    },
  };
  const storage = createMemoryStorage();
  setHostClient(client);
  setClientStorage(storage);
  render(<WebWorkbench client={client} storage={storage} services={createRendererServices([machines])} environment={webClientEnvironment("compact")} />);
  const row = await screen.findByRole("button", { name: "Open thread Build on rex on rex" });
  expect(await within(row).findByLabelText(/^Codex.*OpenAI/)).toBeTruthy();
  expect(await within(row).findByText("rex")).toBeTruthy();
  fireEvent.click(row);
  expect(client.calls.filter((call) => call.method === "switchSession").at(-1)?.args[0]).toBe(proxy.path);
});
