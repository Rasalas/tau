import { describe, expect, it, vi } from "vitest";
import { createFakeHostClient } from "../renderer/test-support/fake-host-client";
import { createMemoryStorage } from "./client-storage";
import { draftKey, readComposerDraft, writeComposerDraft } from "./draft-store";
import { ThreadCommands, type ThreadCommandPorts } from "./thread-commands";

function commands(readOnly: boolean) {
  const spies = { abort: vi.fn(async () => undefined), renameThread: vi.fn(async () => ({})), answerExtensionUi: vi.fn(async () => undefined) };
  const client = createFakeHostClient({ isReadOnly: () => readOnly, ...spies });
  const setNotice = vi.fn();
  const setUiPrompts = vi.fn();
  const ports = {
    client: () => client,
    view: { setNotice, setUiPrompts, getUiPrompts: () => [], getSnapshot: () => undefined },
    threads: { getSnapshot: () => ({ activeThreadId: "t" }) },
    registry: { notifyPromptAnswered: vi.fn() },
    applyActionResult: () => true,
  } as unknown as ThreadCommandPorts;
  return { thread: new ThreadCommands(ports), client: spies, setNotice, setUiPrompts };
}

describe("thread commands on a device paired Read only", () => {
  it("say why instead of sending what the host would refuse, and leave a question on screen", async () => {
    const { thread, client, setNotice, setUiPrompts } = commands(true);
    expect(await thread.renameThread("New")).toBe(false);
    thread.abort("t");
    thread.answerUiPrompt("q", { value: "yes" } as never);
    expect(client.renameThread).not.toHaveBeenCalled();
    expect(client.abort).not.toHaveBeenCalled();
    expect(client.answerExtensionUi).not.toHaveBeenCalled();
    expect(setUiPrompts).not.toHaveBeenCalled();
    expect(setNotice).toHaveBeenCalledWith("Thread rename needs Full access; this device is paired Read only.");
  });

  it("still lets a Read-only device look at another thread", () => {
    const { thread, setNotice } = commands(true);
    expect(thread.requireHost("Thread switching")).toBe(true);
    expect(setNotice).not.toHaveBeenCalled();
  });

  it("send as before with Full access", async () => {
    const { thread, client } = commands(false);
    expect(await thread.renameThread("New")).toBe(true);
    thread.abort("t");
    expect(client.abort).toHaveBeenCalledWith("t");
  });
});

describe("copying the chat", () => {
  it("puts the host's Markdown on this device's clipboard, which a Read-only device may do", async () => {
    const writeText = vi.fn(async () => undefined);
    const copyText = vi.fn(async () => undefined);
    const client = createFakeHostClient({ isReadOnly: () => true, threadMarkdown: async () => "# Thread", copyText });
    const setNotice = vi.fn();
    const thread = new ThreadCommands({
      client: () => client,
      view: { setNotice, getSnapshot: () => ({ sessionId: "s1" }) },
      platform: { clipboard: { writeText } },
    } as unknown as ThreadCommandPorts);
    await thread.copyThreadValue("chat");
    expect(writeText).toHaveBeenCalledWith("# Thread");
    expect(copyText).not.toHaveBeenCalled();
    expect(setNotice).toHaveBeenCalledWith("Chat copied as Markdown.");
  });
});

describe("forking", () => {
  function forking(prompt?: { ask: ReturnType<typeof vi.fn> }) {
    const forkThread = vi.fn(async () => ({ version: 1, updates: [] }));
    const duplicateThread = vi.fn(async () => ({ version: 1, updates: [] }));
    const client = createFakeHostClient({ isReadOnly: () => false, forkThread, duplicateThread });
    const thread = new ThreadCommands({
      client: () => client,
      view: { setNotice: vi.fn(), getSnapshot: () => ({ sessionId: "s1" }) },
      threads: { getSnapshot: () => ({ activeThreadId: "s1" }) },
      registry: { notifyPromptAnswered: vi.fn(), getForkPrompt: () => prompt },
      applyActionResult: () => true,
    } as unknown as ThreadCommandPorts);
    return { thread, forkThread, duplicateThread };
  }
  const prompt = { id: "u1", sourceEntryId: "e-u1", role: "user" as const, text: "Go", timestamp: 1 };
  const answer = { id: "a1", sourceEntryId: "e-a1", role: "assistant" as const, text: "Done", timestamp: 2 };
  const turn = { number: 1, messages: [prompt, answer], last: false };

  it.each([false, true])("sends only to the fork and preserves a rejected task as its draft (rejected=%s)", async (rejected) => {
    const storage = createMemoryStorage();
    writeComposerDraft(storage, draftKey("s1"), "Keep my original draft");
    const forkThread = vi.fn(async () => ({ version: 1, updates: [], forkedSessionId: "child" }));
    const sendPrompt = vi.fn(async () => { if (rejected) throw new Error("Offline"); });
    const client = createFakeHostClient({ isReadOnly: () => false, forkThread, sendPrompt });
    const setNotice = vi.fn();
    const taskCommands = new ThreadCommands({
      client: () => client, storage,
      view: { setNotice, getSnapshot: () => ({ sessionId: "s1" }) },
      applyActionResult: () => true,
    } as unknown as ThreadCommandPorts);
    expect(await taskCommands.forkMessage(answer, { workspace: "ws-side", prompt: "Fix validation", stayInSource: true })).toBe(true);
    expect(forkThread).toHaveBeenCalledWith("e-a1", "s1", "ws-side", true);
    expect(sendPrompt).toHaveBeenCalledWith("Fix validation", [], "child", undefined, undefined);
    expect(readComposerDraft(storage, draftKey("s1"))).toBe("Keep my original draft");
    expect(readComposerDraft(storage, draftKey("child"))).toBe(rejected ? "Fix validation" : "");
    if (rejected) expect(setNotice).toHaveBeenLastCalledWith(expect.stringContaining("saved draft"));
  });

  it("refuses an old dialog after navigation without creating a fork", async () => {
    const { thread, forkThread } = forking();
    expect(await thread.forkMessage(answer, { expectedSessionId: "another-thread", prompt: "Fix validation" })).toBe(false);
    expect(forkThread).not.toHaveBeenCalled();
  });

  it("hands `f` and Duplicate to the kit that asks for the fork's branch, through the end of the message's turn", async () => {
    const ask = vi.fn();
    const { thread, forkThread, duplicateThread } = forking({ ask });
    await thread.forkFromMessage(prompt, turn);
    expect(ask).toHaveBeenCalledWith({ entryId: "e-a1", turn });
    expect(await thread.duplicateThread()).toBe(true);
    expect(ask).toHaveBeenLastCalledWith({});
    expect(forkThread).not.toHaveBeenCalled();
    expect(duplicateThread).not.toHaveBeenCalled();
    // Handoff's continuation copies at once.
    await thread.duplicateThread({ ask: false });
    expect(duplicateThread).toHaveBeenCalledTimes(1);
    expect(ask).toHaveBeenCalledTimes(2);
  });

  it("forks at once without such a kit, and into the workspace the kit made", async () => {
    const { thread, forkThread, duplicateThread } = forking();
    await thread.forkFromMessage(answer, turn);
    expect(forkThread).toHaveBeenCalledWith("e-a1", "s1", undefined);
    expect(await thread.forkMessage({ sourceEntryId: "e-a1" }, { workspace: "ws-fork" })).toBe(true);
    expect(forkThread).toHaveBeenLastCalledWith("e-a1", "s1", "ws-fork");
    await thread.duplicateThread();
    expect(duplicateThread).toHaveBeenCalled();
  });
});
