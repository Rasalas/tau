import { describe, expect, it, vi } from "vitest";
import { placePromptLink } from "./prompt-link-flow";
import { parsePromptLink } from "../shared/prompt-links";

function setup(text = "", draftPending = true) {
  let draft = text;
  let active = { draftPending, workspaceId: "ws", cwd: "/project" };
  const actions = {
    activeThread: () => active, composerDraft: () => draft,
    setComposerDraft: vi.fn((value: string) => { draft = value; }),
    newSession: vi.fn(() => { active = { ...active, draftPending: true }; draft = ""; }),
    focusComposer: vi.fn(), notify: vi.fn(), setModel: vi.fn(async () => true),
    submitPrompt: vi.fn(), runShellAction: vi.fn(), setComposerImages: vi.fn(),
  };
  const ports = { actions, projects: () => [{ path: "/project", workspaceId: "ws", name: "Project", lastOpenedAt: 0 }],
    models: async () => [{ provider: "p", id: "m" }], confirm: vi.fn(async () => true), wait: async () => {} };
  return { actions, ports };
}

describe("placing a linked prompt", () => {
  it("opens a draft in a known project and sets a known model without sending or executing", async () => {
    const { actions, ports } = setup("", false);
    await placePromptLink(parsePromptLink("tau://new?prompt=%2Fdeploy&project=ws&provider=p&model=m&send=true")!, ports);
    expect(actions.newSession).toHaveBeenCalledWith({ workspace: "ws" });
    expect(actions.setComposerDraft).toHaveBeenCalledWith("/deploy");
    expect(actions.setModel).toHaveBeenCalledWith("p", "m");
    expect(actions.submitPrompt).not.toHaveBeenCalled();
    expect(actions.runShellAction).not.toHaveBeenCalled();
    expect(actions.setComposerImages).not.toHaveBeenCalled();
  });
  it("asks before replacing text and leaves it alone on cancellation", async () => {
    const { actions, ports } = setup("My draft");
    ports.confirm.mockResolvedValue(false);
    await placePromptLink(parsePromptLink("tau://new?prompt=Other")!, ports);
    expect(ports.confirm).toHaveBeenCalled();
    expect(actions.composerDraft()).toBe("My draft");
    expect(actions.setComposerDraft).not.toHaveBeenCalled();
  });
  it("places the text after confirmation", async () => {
    const { actions, ports } = setup("My draft");
    await placePromptLink(parsePromptLink("tau://new?prompt=Other")!, ports);
    expect(actions.composerDraft()).toBe("Other");
  });
  it("warns about unknown context and shortened text while keeping defaults", async () => {
    const { actions, ports } = setup();
    await placePromptLink({ prompt: "Text", project: "unknown", provider: "p", model: "missing", truncated: true }, ports);
    expect(actions.composerDraft()).toBe("Text");
    expect(actions.setModel).not.toHaveBeenCalled();
    expect(actions.notify.mock.calls.flat().join(" ")).toMatch(/project.*not available/iu);
    expect(actions.notify.mock.calls.flat().join(" ")).toMatch(/model.*not available/iu);
    expect(actions.notify.mock.calls.flat().join(" ")).toContain("8,000");
  });
});

it("does not overwrite a different draft reached while the model catalog was loading", async () => {
  const { actions, ports } = setup();
  let scope = "first";
  const models = vi.fn(async () => { scope = "second"; return [{ provider: "p", id: "m" }]; });
  await placePromptLink({ prompt: "Linked", model: "m", truncated: false }, { ...ports, models, scope: () => scope });
  expect(actions.setComposerDraft).not.toHaveBeenCalled();
  expect(actions.setModel).not.toHaveBeenCalled();
});

it("uses the visible project's path when older projects have no workspace IDs", async () => {
  const { actions, ports } = setup("", false);
  const projects = () => [{ path: "/other", name: "Other", lastOpenedAt: 0 }, { path: "/project", name: "Project", lastOpenedAt: 0 }];
  await placePromptLink({ prompt: "Linked", truncated: false }, { ...ports, projects });
  expect(actions.newSession).toHaveBeenCalledWith({ workspace: "/project" });
});
