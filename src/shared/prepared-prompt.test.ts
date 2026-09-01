import { describe, expect, it } from "vitest";
import type { PreparedPrompt, UiComposerCommand } from "./contracts.js";
import { clientMessageFingerprint } from "./client-message-correlation.js";
import { validatePreparedPrompt } from "./prepared-prompt.js";

const commands: UiComposerCommand[] = [{
  name: "skill:tdd",
  source: "skill",
  skillCommand: "/tdd",
}];

function prepared(overrides: Partial<PreparedPrompt> = {}): PreparedPrompt {
  return {
    tauThreadId: "thread",
    providerSessionId: "provider",
    sessionId: "thread",
    backendKind: "claude-code",
    runtimeCapabilities: { skillInvocationDialect: "claude-code" },
    visibleText: "fix the parser",
    runtimeText: "/tdd fix the parser",
    skill: { name: "tdd", command: "/tdd", copyText: "/tdd fix the parser" },
    sourceFingerprint: clientMessageFingerprint("$tdd fix the parser", ["tdd"]),
    ...overrides,
  };
}

describe("prepared prompt boundary", () => {
  it("accepts only a result owned by the selected thread and provider session", () => {
    expect(() => validatePreparedPrompt("$tdd fix the parser", prepared(), {
      backendKind: "claude-code",
      threadId: "thread",
      providerSessionId: "provider",
      runtimeCapabilities: { skillInvocationDialect: "claude-code" },
      commands,
    })).not.toThrow();

    expect(() => validatePreparedPrompt("$tdd fix the parser", prepared({ providerSessionId: "other-provider" }), {
      backendKind: "claude-code",
      threadId: "thread",
      providerSessionId: "provider",
      runtimeCapabilities: { skillInvocationDialect: "claude-code" },
      commands,
    })).toThrow("another runtime");
  });

  it("rejects a forged catalog command even when its skill name is known", () => {
    expect(() => validatePreparedPrompt("$tdd fix the parser", prepared(), {
      backendKind: "claude-code",
      threadId: "thread",
      providerSessionId: "provider",
      runtimeCapabilities: { skillInvocationDialect: "claude-code" },
      commands: [{ ...commands[0], skillCommand: "/wrong" }],
    })).toThrow("unavailable skill");
  });

  it("binds visible metadata to the submitted skill token, including collisions", () => {
    const collisionCommands: UiComposerCommand[] = [
      ...commands,
      { name: "tdd", source: "extension" },
    ];
    expect(() => validatePreparedPrompt("/tdd fix the parser", prepared({
      visibleText: "fix the parser",
      runtimeText: "/tdd fix the parser",
      sourceFingerprint: clientMessageFingerprint("/tdd fix the parser", ["tdd"]),
    }), {
      backendKind: "claude-code",
      threadId: "thread",
      providerSessionId: "provider",
      runtimeCapabilities: { skillInvocationDialect: "claude-code" },
      commands: collisionCommands,
    })).not.toThrow();

    expect(() => validatePreparedPrompt("$tdd a different instruction", prepared(), {
      backendKind: "claude-code",
      threadId: "thread",
      providerSessionId: "provider",
      runtimeCapabilities: { skillInvocationDialect: "claude-code" },
      commands,
    })).toThrow("unavailable skill");
  });
});
