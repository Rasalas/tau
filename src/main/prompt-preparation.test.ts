import { describe, expect, it, vi } from "vitest";
import { PromptPreparation } from "./prompt-preparation.js";
import { PI_AGENT_RUNTIME_ADAPTER } from "./runtime-adapters.js";
import { ThreadRuntime } from "./thread-runtime.js";

function makePrompts(assertPromptAllowed?: (level: string) => void) {
  return new PromptPreparation({
    requireBackend: () => ({ assertPromptAllowed } as never),
    permissionLevel: () => "read-only",
  });
}

function piThread(threadId = "session", supportsImageInput = false, fileAttachments = false) {
  const backend = {
    kind: "pi" as const,
    runtimeAdapter: fileAttachments
      ? { ...PI_AGENT_RUNTIME_ADAPTER, capabilities: { ...PI_AGENT_RUNTIME_ADAPTER.capabilities, fileAttachments: true } }
      : PI_AGENT_RUNTIME_ADAPTER,
    threadId,
    providerSessionId: threadId,
    cwd: "/repo",
    turnReporting: "streamed" as const,
    capabilities: {},
    state: () => ({ streaming: false, idle: true, hasMessages: false, activeTools: [], supportsImageInput, extensionCount: 0 }),
    catalogView: () => ({ thinkingLevel: "off", thinkingLevels: [], allTools: [] }),
    models: async () => [],
    composerCommands: () => [],
    transcript: async () => [],
    persist: async () => undefined,
    setTitle: async () => undefined,
    preparePrompt: async () => undefined,
    prompt: async () => ({}),
    abort: async () => undefined,
    dispose: async () => undefined,
    start: async () => undefined,
    waitForIdle: async () => undefined,
  };
  return new ThreadRuntime(backend as never);
}

describe("PromptPreparation", () => {
  it("carries the visible text and a fingerprint of it", () => {
    const prepared = makePrompts().prepare("hello", undefined, PI_AGENT_RUNTIME_ADAPTER, [], "session", "pi");
    expect(prepared).toMatchObject({
      backendKind: "pi",
      visibleText: "hello",
      runtimeText: "hello",
      tauThreadId: "session",
      providerSessionId: "session",
    });
    expect(prepared.sourceFingerprint).toBeTruthy();
  });

  it("leaves an owner-less prompt without a thread id", () => {
    const prepared = makePrompts().prepare("hello", undefined, PI_AGENT_RUNTIME_ADAPTER, [], undefined, "pi");
    expect(prepared.tauThreadId).toBeUndefined();
    expect(prepared.sessionId).toBeUndefined();
  });

  it("asks a non-Pi backend whether the access level allows a prompt at all", () => {
    const gate = vi.fn((level: string) => { if (level === "read-only") throw new Error("Read-only access."); });
    const adapter = { ...PI_AGENT_RUNTIME_ADAPTER, id: "test" };
    expect(() => makePrompts(gate).prepare("hello", undefined, adapter as never, [], undefined, "test"))
      .toThrow("Read-only access.");
    expect(gate).toHaveBeenCalledWith("read-only");
  });

  it("refuses a prepared prompt bound to another thread", () => {
    const prompts = makePrompts();
    const prepared = prompts.prepare("hello", undefined, PI_AGENT_RUNTIME_ADAPTER, [], "other", "pi");
    expect(() => prompts.assertBound(piThread(), "hello", prepared, [])).toThrow();
  });

  it("refuses a prepared prompt whose visible text was swapped", () => {
    const prompts = makePrompts();
    const prepared = prompts.prepare("hello", undefined, PI_AGENT_RUNTIME_ADAPTER, [], "session", "pi");
    expect(() => prompts.assertBound(piThread(), "goodbye", prepared, [])).toThrow();
    expect(() => prompts.assertBound(piThread(), "hello", prepared, [])).not.toThrow();
  });

  it("accepts an owner-less prompt on the preflight of a new thread", () => {
    const prompts = makePrompts();
    const prepared = prompts.prepare("hello", undefined, PI_AGENT_RUNTIME_ADAPTER, [], undefined, "pi");
    expect(() => prompts.assertUnbound("hello", prepared, PI_AGENT_RUNTIME_ADAPTER, [], "pi")).not.toThrow();
    expect(() => prompts.assertUnbound("forged", prepared, PI_AGENT_RUNTIME_ADAPTER, [], "pi")).toThrow();
  });

  it("refuses images for a model that does not take them", () => {
    const prompts = makePrompts();
    const attachment = { kind: "image" as const, name: "shot.png", mimeType: "image/png", data: "iVBORw==", size: 4 };
    expect(() => prompts.assertAttachmentInput(piThread(), [attachment])).toThrow("does not support image input");
    expect(() => prompts.assertAttachmentInput(piThread("session", true), [attachment])).not.toThrow();
    // No attachment is always allowed, whatever the model says.
    expect(() => prompts.assertAttachmentInput(piThread(), [])).not.toThrow();
  });

  it("takes files only from a runtime that declares them, and only by absolute path", () => {
    const prompts = makePrompts();
    const file = { kind: "file" as const, name: "spec.pdf", mimeType: "application/pdf", path: "/state/spec.pdf", size: 2048 };
    expect(() => prompts.assertAttachmentInput(piThread(), [file])).toThrow("does not take file attachments");
    expect(() => prompts.assertAttachmentInput(piThread("session", false, true), [file])).not.toThrow();
    expect(() => prompts.assertAttachmentInput(piThread("session", false, true), [{ ...file, path: "spec.pdf" }])).toThrow("absolute path");
    expect(() => prompts.assertAttachmentInput(piThread("session", false, true), [{ ...file, size: 51 * 1024 * 1024 }])).toThrow("50 MB");
  });
});
