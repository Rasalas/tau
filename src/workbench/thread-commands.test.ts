import { describe, expect, it, vi } from "vitest";
import { createFakeHostClient } from "../renderer/test-support/fake-host-client";
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
