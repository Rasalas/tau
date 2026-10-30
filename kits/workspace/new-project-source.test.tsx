// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakeHostClient } from "../../src/renderer/test-support/fake-host-client.js";
import { PreferencesStore, setHostClient } from "../../src/renderer/test-support/kit-harness.js";
import { NewProjectSource } from "./navigation.js";
import { createWorkspaceHostClient, type CreatedProject } from "./protocol.js";
import { withWorkspaceStore } from "./store-context.js";
import { WorkspaceStore } from "./store.js";

afterEach(() => { cleanup(); setHostClient(undefined); });

function renderSource(answer: CreatedProject) {
  const calls: unknown[] = [];
  const invoke = vi.fn(async (command: string, input: unknown) => {
    if (command === "create-project") { calls.push(input); return answer; }
    return undefined;
  });
  setHostClient(createFakeHostClient({ invokeHostExtension: (_id: string, command: string, input: unknown) => invoke(command, input) }));
  const store = new WorkspaceStore(new PreferencesStore(), createWorkspaceHostClient((command, input) => invoke(command, input) as never));
  store.setProjectBaseDirectory("/repos");
  const notify = vi.fn();
  const openWorkspace = vi.fn(async () => true);
  const Source = withWorkspaceStore(store, NewProjectSource);
  render(<Source actions={{ openWorkspace, notify, newSession: vi.fn() } as never} onBack={() => {}} onDone={() => {}} />);
  return { calls, notify, openWorkspace };
}

const workspace = { workspaceId: "ws-new", displayPath: "/repos/Quiet Lake" };

describe("New project with a GitHub repository", () => {
  it("sends the owner and visibility, shows the repository name and says where it went", async () => {
    const { calls, notify, openWorkspace } = renderSource({ workspace, github: { repository: "acme/Quiet-Lake", url: "https://github.com/acme/Quiet-Lake", pushed: true, branch: "main" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Project name" }), { target: { value: "Quiet Lake" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "Create a GitHub repository" }));
    expect(screen.getByRole("radio", { name: "Private" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByText("/Quiet-Lake")).toBeTruthy();
    fireEvent.change(screen.getByRole("textbox", { name: "GitHub owner" }), { target: { value: "acme" } });
    fireEvent.click(screen.getByRole("radio", { name: "Public" }));
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(openWorkspace).toHaveBeenCalledWith("ws-new"));
    expect(calls).toEqual([{ name: "Quiet Lake", parentPath: "/repos", github: { owner: "acme", visibility: "public" } }]);
    expect(notify).toHaveBeenCalledWith("Created acme/Quiet-Lake on GitHub and pushed main.", "info");
  });

  it("refuses an owner GitHub would not accept, and sends no GitHub choice without the box", async () => {
    const { calls } = renderSource({ workspace });
    fireEvent.change(screen.getByRole("textbox", { name: "Project name" }), { target: { value: "Quiet Lake" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "Create a GitHub repository" }));
    fireEvent.change(screen.getByRole("textbox", { name: "GitHub owner" }), { target: { value: "not/an owner" } });
    expect((screen.getByRole("button", { name: "Create" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("checkbox", { name: "Create a GitHub repository" }));
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(calls).toEqual([{ name: "Quiet Lake", parentPath: "/repos" }]));
  });

  it("opens the project and shows the host's warning when GitHub could not be reached", async () => {
    const warning = "Project created, but not its GitHub repository: GitHub CLI (gh) is not signed in. Run `gh auth login` in a terminal, then try again. Publish it later with \"Publish repository…\" in the Changes panel.";
    const { notify, openWorkspace } = renderSource({ workspace, warning });
    fireEvent.change(screen.getByRole("textbox", { name: "Project name" }), { target: { value: "Quiet Lake" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "Create a GitHub repository" }));
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(openWorkspace).toHaveBeenCalledWith("ws-new"));
    expect(notify).toHaveBeenCalledWith(warning, "warning");
  });
});
