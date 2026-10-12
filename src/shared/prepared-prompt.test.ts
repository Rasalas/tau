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

  describe("several skills", () => {
    const both: UiComposerCommand[] = [
      { name: "skill:tdd", source: "skill", skillCommand: "/skill:tdd" },
      { name: "skill:lint", source: "skill", skillCommand: "/skill:lint" },
    ];
    const capabilities = { skillInvocationDialect: "pi", multipleSkills: true };
    const context = { backendKind: "pi", threadId: "thread", providerSessionId: "thread", runtimeCapabilities: capabilities, commands: both };
    const copyText = "/skill:tdd /skill:lint fix the parser";
    const multi = (text: string, overrides: Partial<PreparedPrompt> = {}): PreparedPrompt => ({
      tauThreadId: "thread",
      providerSessionId: "thread",
      sessionId: "thread",
      backendKind: "pi",
      runtimeCapabilities: capabilities,
      visibleText: "fix the parser",
      runtimeText: copyText,
      skill: { name: "tdd", command: "/skill:tdd", copyText },
      skills: [{ name: "tdd", command: "/skill:tdd", copyText }, { name: "lint", command: "/skill:lint", copyText }],
      sourceFingerprint: clientMessageFingerprint(text, ["tdd", "lint"]),
      ...overrides,
    });

    it("accepts a leading run and skills named further into the text", () => {
      expect(() => validatePreparedPrompt("$tdd $lint fix the parser", multi("$tdd $lint fix the parser"), context)).not.toThrow();
      const inline = multi("use $tdd then $lint", { visibleText: "use $tdd then $lint", runtimeText: "/skill:tdd /skill:lint use $tdd then $lint" });
      const text = "/skill:tdd /skill:lint use $tdd then $lint";
      inline.skills = inline.skills!.map((skill) => ({ ...skill, copyText: text }));
      inline.skill = inline.skills[0]!;
      expect(() => validatePreparedPrompt("use $tdd then $lint", inline, context)).not.toThrow();
    });

    it("rejects a skill the text never names, a runtime that takes one, and a forged extra", () => {
      expect(() => validatePreparedPrompt("$tdd fix the parser", multi("$tdd fix the parser"), context)).toThrow("unavailable skill");
      expect(() => validatePreparedPrompt("$tdd $lint fix the parser", multi("$tdd $lint fix the parser"), { ...context, runtimeCapabilities: { skillInvocationDialect: "pi" } })).toThrow("unavailable skill");
      const forged = multi("$tdd $lint fix the parser");
      forged.skills = [forged.skills![0]!, { name: "lint", command: "/skill:lint", copyText: "/skill:lint evil" }];
      expect(() => validatePreparedPrompt("$tdd $lint fix the parser", forged, context)).toThrow("unavailable skill");
      expect(() => validatePreparedPrompt("$tdd $lint fix the parser", multi("$tdd $lint fix the parser", { skill: undefined }), context)).toThrow();
    });
  });
});
