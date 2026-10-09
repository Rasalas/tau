import { describe, expect, it } from "vitest";
import type { UiProject, UiSession } from "../shared/contracts";
import { lastUsedProject, newThreadProject, rootLast, selectionOnScreen, startDraftProject } from "./new-thread-project";
import { createNewThreadDraft } from "./draft-store";

const project = (path: string, lastOpenedAt: number): UiProject => ({ path, name: path.split("/").at(-1) || path, lastOpenedAt });
const thread = (projectPath: string, modifiedAt: number, messageCount = 2): UiSession =>
  ({ id: `${projectPath}-${modifiedAt}`, path: `${projectPath}/${modifiedAt}.jsonl`, title: "", modifiedAt, projectPath, projectName: "", messageCount });

describe("lastUsedProject", () => {
  it("takes the project the host opened last", () => {
    expect(lastUsedProject([project("/a", 1), project("/b", 5)], [])?.path).toBe("/b");
  });

  it("prefers the project whose threads were busy more recently", () => {
    expect(lastUsedProject([project("/a", 1), project("/b", 5)], [thread("/a", 9)])?.path).toBe("/a");
  });

  it("ignores a session nobody wrote in", () => {
    expect(lastUsedProject([project("/a", 1), project("/b", 5)], [thread("/a", 9, 0)])?.path).toBe("/b");
  });

  it("never picks the filesystem root, however recent", () => {
    expect(lastUsedProject([project("/", 99), project("/a", 1)], [thread("/", 100)])?.path).toBe("/a");
  });

  it("asks when there is no project but the root", () => {
    expect(lastUsedProject([project("/", 99)], [])).toBeUndefined();
    expect(lastUsedProject([], [])).toBeUndefined();
  });
});

describe("rootLast", () => {
  it("moves / to the end and keeps the rest in order", () => {
    expect(rootLast([project("/", 9), project("/b", 2), project("/a", 1)]).map((entry) => entry.path)).toEqual(["/b", "/a", "/"]);
  });
});

describe("newThreadProject", () => {
  const projects = [project("/a", 1), { ...project("/b", 5), workspaceId: "ws1_b" }];
  const onA = { sessionId: "t", cwd: "/a" };

  it("takes the project of the thread on screen, by id or by path", () => {
    expect(newThreadProject(projects, [], { thread: onA })?.path).toBe("/a");
    expect(newThreadProject(projects, [], { thread: { sessionId: "t", workspaceId: "ws1_b", cwd: "/elsewhere" } })?.path).toBe("/b");
  });

  it("takes the draft's project over the thread behind it", () => {
    expect(newThreadProject(projects, [], { thread: { sessionId: "t", cwd: "/b" }, draft: createNewThreadDraft({ projectPath: "/a", projectName: "a" }) })?.path).toBe("/a");
  });

  it("falls back to where the host last worked when nothing is on screen or the project is unknown", () => {
    expect(newThreadProject(projects, [], { thread: onA, covered: true })?.path).toBe("/b");
    expect(newThreadProject(projects, [], {})?.path).toBe("/b");
    expect(newThreadProject(projects, [], { thread: { sessionId: "t", cwd: "/gone" } })?.path).toBe("/b");
    expect(newThreadProject([], [], { thread: onA })).toBeUndefined();
  });
});

describe("selectionOnScreen", () => {
  const luna = { provider: "openai", id: "gpt-5.6-luna", name: "GPT-5.6 Luna" };

  it("takes the thread's runtime, model with its level, and mode", () => {
    expect(selectionOnScreen({ thread: { sessionId: "t", backendKind: "codex", model: luna, thinkingLevel: "high", mode: "plan" } }))
      .toEqual({ runtime: "codex", model: luna, thinkingLevel: "high", mode: "plan" });
    // A level without a model says nothing.
    expect(selectionOnScreen({ thread: { sessionId: "t", thinkingLevel: "off" } })).toEqual({ runtime: "pi" });
  });

  it("takes what a draft chose for the runtime it is bound to", () => {
    const draft = { ...createNewThreadDraft({ projectPath: "/a", projectName: "a" }), model: luna, thinkingLevel: "low", selectionRuntime: "codex", mode: "plan" };
    expect(selectionOnScreen({ draft, draftRuntime: "codex" })).toEqual({ runtime: "codex", model: luna, thinkingLevel: "low", mode: "plan" });
    expect(selectionOnScreen({ draft, draftRuntime: "pi" })).toEqual({ runtime: "pi", mode: "plan" });
  });

  it("takes nothing while the thread is covered or there is none", () => {
    expect(selectionOnScreen({ thread: { sessionId: "t", model: luna }, covered: true })).toBeUndefined();
    expect(selectionOnScreen({})).toBeUndefined();
  });
});

describe("startDraftProject", () => {
  const empty = { messages: [], isStreaming: false, activeTools: [], sessionId: "s" };
  const projects = [project("/a", 1), project("/b", 2)];
  const threadIndex = { projects, sessions: [] };

  it("opens a draft in the project of an empty startup thread", () => {
    expect(startDraftProject({ detail: empty, project: { cwd: "/a" }, threadIndex }, projects)?.path).toBe("/a");
  });

  it("keeps a thread that has messages or is running", () => {
    const message = { id: "m", role: "user", text: "hi" } as never;
    expect(startDraftProject({ detail: { ...empty, messages: [message] }, project: { cwd: "/a" }, threadIndex }, projects)).toBeUndefined();
    expect(startDraftProject({ detail: { ...empty, isStreaming: true }, project: { cwd: "/a" }, threadIndex }, projects)).toBeUndefined();
  });

  it("replaces the host's fresh thread, which the index lists without messages", () => {
    const listed = { projects, sessions: [thread("/a", 1, 0)] };
    expect(startDraftProject({ detail: { ...empty, sessionId: listed.sessions[0]!.id }, project: { cwd: "/a" }, threadIndex: listed }, projects)?.path).toBe("/a");
  });

  it("keeps a thread the index counts messages for, before its transcript is on screen", () => {
    const listed = { projects, sessions: [thread("/a", 1, 3)] };
    expect(startDraftProject({ detail: { ...empty, sessionId: listed.sessions[0]!.id }, project: { cwd: "/a" }, threadIndex: listed }, projects)).toBeUndefined();
  });

  it("keeps the thread when its folder is no listed project", () => {
    expect(startDraftProject({ detail: empty, project: { cwd: "/c" }, threadIndex }, projects)).toBeUndefined();
    expect(startDraftProject({ detail: empty, project: { cwd: "/" }, threadIndex }, [...projects, project("/", 3)])).toBeUndefined();
  });
});
