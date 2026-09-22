// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RegionProps, WorkbenchActions } from "tau";
import { createKitHarness } from "../../src/renderer/test-support/kit-harness.js";
import projectScriptsExtension from "./desktop.js";
import {
  PREVIEW_BROWSER_SERVICE,
  PROJECT_SCRIPTS_HOST_EXTENSION_ID,
  RUN_EVENT,
  SCRIPTS_CHANGED_EVENT,
  TERMINAL_HOST_EXTENSION_ID,
  type PreviewBrowserService,
  type ProjectScript,
  type ProjectScriptsState,
  type UiScriptRun,
} from "./protocol.js";

afterEach(cleanup);

const FILE = "/repo/.tau/project.json";
const script = (fields: Partial<ProjectScript> & Pick<ProjectScript, "id" | "name" | "command">): ProjectScript => ({
  icon: "play", runOnWorktreeCreate: false, async: true, autoOpenPreview: false, ...fields,
});
const state = (scripts: ProjectScript[], problems: ProjectScriptsState["problems"] = []): ProjectScriptsState => ({
  directory: "/repo", file: FILE, exists: true, scripts, problems,
});
const run = (fields: Partial<UiScriptRun>): UiScriptRun => ({
  id: "run-1", scriptId: "serve", name: "Serve", command: "python3 -m http.server 8000", icon: "play", directory: "/repo",
  trigger: "user", status: "running", startedAt: 1, output: "", outputLength: 0, autoOpenPreview: false, ...fields,
});

function setup(initial: ProjectScriptsState) {
  let current = initial;
  const invoke = vi.fn(async (extensionId: string, command: string, input?: unknown) => {
    if (extensionId === TERMINAL_HOST_EXTENSION_ID) return command === "open" ? { id: "term-1" } : undefined;
    if (command === "list") return current;
    if (command === "runs") return [];
    if (command === "run") {
      const scriptId = (input as { scriptId: string }).scriptId;
      const found = current.scripts.find((candidate) => candidate.id === scriptId)!;
      return { run: run({ scriptId, name: found.name, command: found.command, ...(found.previewUrl ? { previewUrl: found.previewUrl } : {}), autoOpenPreview: found.autoOpenPreview }), started: true };
    }
    return undefined;
  });
  const { registry } = createKitHarness(invoke);
  const opened: string[] = [];
  registry.activate({
    id: "tau.preview",
    name: "Preview",
    activate: (context) => context.provideService<PreviewBrowserService>(PREVIEW_BROWSER_SERVICE, { open: async (url) => { opened.push(url); } }),
  });
  registry.activate(projectScriptsExtension);
  const notify = vi.fn();
  const actions = {
    notify,
    openPanel: vi.fn(),
    openExternal: vi.fn(),
    openSettings: vi.fn(),
    openFile: vi.fn(),
    activeThread: () => ({ sessionId: "thread-1", workspaceId: "workspace-1", draftPending: false }),
  } as unknown as WorkbenchActions;
  const Bar = registry.getRegions("composer-above").find((region) => region.id === "project-scripts.bar")!.Component;
  const view = render(<Bar actions={actions} snapshot={undefined as RegionProps["snapshot"]} />);
  const push = (name: string, payload: unknown) => act(() => registry.dispatchExtensionEvent({ type: "extension-event", extensionId: PROJECT_SCRIPTS_HOST_EXTENSION_ID, name, payload }));
  return { registry, invoke, actions, notify, opened, view, push, setState: (next: ProjectScriptsState) => { current = next; } };
}

describe("Project Scripts desktop", () => {
  it("asks for the scripts of the thread on screen and draws one button per script", async () => {
    const kit = setup(state([script({ id: "build", name: "Build", command: "make", icon: "build" }), script({ id: "test", name: "Test", command: "npm test", icon: "test" })]));
    expect(await screen.findByRole("button", { name: "Run Build" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Run Test" })).toBeTruthy();
    expect(kit.invoke).toHaveBeenCalledWith(PROJECT_SCRIPTS_HOST_EXTENSION_ID, "list", { sessionId: "thread-1", workspaceId: "workspace-1" });
  });

  it("registers script.<id>.run for every script and binds the chords the file names", async () => {
    const kit = setup(state([
      script({ id: "dev", name: "Dev", command: "npm run dev", keybinding: "mod+shift+r" }),
      script({ id: "lint", name: "Lint", command: "npm run lint", keybinding: "mod+shift+" }),
    ]));
    await waitFor(() => expect(kit.registry.getCommands().map((command) => command.id)).toContain("script.dev.run"));
    expect(kit.registry.getCommands().map((command) => command.id)).toEqual(expect.arrayContaining(["script.dev.run", "script.lint.run", "project-scripts.reload"]));
    expect(kit.registry.getKeybindings().filter((binding) => binding.extensionId === PROJECT_SCRIPTS_HOST_EXTENSION_ID).map((binding) => [binding.keys, binding.commandId]))
      .toEqual([["mod+shift+r", "script.dev.run"]]);
    // A chord the workbench cannot read is a problem in the Inspector, not a crash.
    expect(kit.registry.getProblems()).toEqual([expect.objectContaining({ source: FILE, level: "warning", message: expect.stringContaining('"Lint"') })]);

    await kit.registry.getCommands().find((command) => command.id === "script.dev.run")!.run(kit.actions);
    expect(kit.invoke).toHaveBeenCalledWith(PROJECT_SCRIPTS_HOST_EXTENSION_ID, "run", { sessionId: "thread-1", workspaceId: "workspace-1", scriptId: "dev" });
  });

  it("follows the file: a change re-registers the commands and shows its problems", async () => {
    const kit = setup(state([script({ id: "dev", name: "Dev", command: "npm run dev", keybinding: "mod+shift+r" })]));
    await waitFor(() => expect(kit.registry.getCommands().map((command) => command.id)).toContain("script.dev.run"));
    kit.setState(state([script({ id: "serve", name: "Serve", command: "npm start" })], [{ source: FILE, message: 'scripts[1]: "command" is missing or empty.', level: "error" }]));
    kit.push(SCRIPTS_CHANGED_EVENT, { directory: "/repo" });
    await waitFor(() => expect(kit.registry.getCommands().map((command) => command.id)).toContain("script.serve.run"));
    expect(kit.registry.getCommands().map((command) => command.id)).not.toContain("script.dev.run");
    expect(kit.registry.getKeybindings().filter((binding) => binding.extensionId === PROJECT_SCRIPTS_HOST_EXTENSION_ID)).toEqual([]);
    expect(kit.registry.getProblems()).toEqual([expect.objectContaining({ level: "error", extensionId: PROJECT_SCRIPTS_HOST_EXTENSION_ID })]);
    expect(await screen.findByText("1 problem in .tau/project.json")).toBeTruthy();

    kit.registry.deactivate(PROJECT_SCRIPTS_HOST_EXTENSION_ID);
    expect(kit.registry.getCommands().filter((command) => command.id.startsWith("script."))).toEqual([]);
    expect(kit.registry.getProblems()).toEqual([]);
  });

  it("runs a script from its button, shows the card and opens the preview once the host says it answers", async () => {
    const kit = setup(state([script({ id: "serve", name: "Serve", command: "python3 -m http.server 8000", previewUrl: "http://localhost:8000/", autoOpenPreview: true })]));
    fireEvent.click(await screen.findByRole("button", { name: "Run Serve" }));
    expect(await screen.findByRole("button", { name: "Stop Serve" })).toBeTruthy();
    expect(kit.opened).toEqual([]);

    kit.push(RUN_EVENT, run({ previewUrl: "http://localhost:8000/", autoOpenPreview: true, previewReady: true, output: "Serving HTTP on :: port 8000\n", outputLength: 29 }));
    await waitFor(() => expect(kit.opened).toEqual(["http://localhost:8000/"]));
    // The same push again does not open it twice.
    kit.push(RUN_EVENT, run({ previewUrl: "http://localhost:8000/", autoOpenPreview: true, previewReady: true }));
    expect(kit.opened).toHaveLength(1);
  });

  it("hands back a failure: exit code on the card, its output open, and a notice", async () => {
    const kit = setup(state([script({ id: "test", name: "Test", command: "npm test" })]));
    fireEvent.click(await screen.findByRole("button", { name: "Run Test" }));
    await screen.findByRole("button", { name: "Stop Test" });
    kit.push(RUN_EVENT, run({ scriptId: "test", name: "Test", command: "npm test", status: "failed", exitCode: 2, endedAt: 2_001, output: "1 failing\n", outputLength: 10 }));
    expect(await screen.findByText(/exit 2/u)).toBeTruthy();
    expect(screen.getByLabelText("Test output").textContent).toContain("1 failing");
    expect(kit.notify).toHaveBeenCalledWith("Test exited with 2.");
    fireEvent.click(screen.getByRole("button", { name: "Dismiss Test" }));
    expect(kit.invoke).toHaveBeenCalledWith(PROJECT_SCRIPTS_HOST_EXTENSION_ID, "dismiss", { runId: "run-1" });
    expect(screen.queryByRole("button", { name: "Dismiss Test" })).toBeNull();
  });

  it("types a script into a Terminal Kit shell when asked to", async () => {
    const kit = setup(state([script({ id: "serve", name: "Serve", command: "npm start" })]));
    fireEvent.click(await screen.findByRole("button", { name: "More script actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Serve/u }));
    await waitFor(() => expect(kit.invoke).toHaveBeenCalledWith(TERMINAL_HOST_EXTENSION_ID, "input", { id: "term-1", data: "npm start\r" }));
    expect(kit.invoke).toHaveBeenCalledWith(TERMINAL_HOST_EXTENSION_ID, "open", { sessionId: "thread-1", workspaceId: "workspace-1", label: "Serve" });
    expect(kit.actions.openPanel).toHaveBeenCalledWith("terminal");
  });

  it("draws nothing for a checkout without scripts", async () => {
    const kit = setup({ directory: "/repo", file: FILE, exists: false, scripts: [], problems: [] });
    await waitFor(() => expect(kit.invoke).toHaveBeenCalledWith(PROJECT_SCRIPTS_HOST_EXTENSION_ID, "list", expect.anything()));
    expect(kit.view.container.innerHTML).toBe("");
  });
});
