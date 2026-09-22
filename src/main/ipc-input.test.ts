import { describe, expect, it } from "vitest";
import {
  decodeBoolean,
  decodeClientTurnIdentity,
  decodeCommandName,
  decodeConfigPatch,
  decodeCustomProviderInput,
  decodeExtensionId,
  decodeExtensionUiAnswer,
  decodeHostTranscriptCursor,
  decodeNavigateOptions,
  decodeNewThreadConfiguration,
  decodeOptionalBoolean,
  decodeOptionalString,
  decodePreparedPrompt,
  decodeSettingKeys,
  decodeSharedExports,
  decodeString,
  decodeStringOrClientTurnIdentity,
  decodeUiPromptAttachments,
  decodeUiSkillDraft,
  decodeWorkbenchReloadMode,
  decodeText,
  decodeOptionalText,
} from "./ipc-input.js";

const CHANNEL = "tau:test";

const validPreparedPrompt = {
  backendKind: "pi",
  runtimeCapabilities: { skillInvocationDialect: "pi" },
  visibleText: "hello",
  runtimeText: "hello",
  sourceFingerprint: "fp",
};

const validAttachment = { kind: "image", name: "a.png", mimeType: "image/png", data: "AA==", size: 2 };

describe("ipc-input decoders", () => {
  describe("decodeString", () => {
    it("accepts a non-empty string", () => {
      expect(decodeString(CHANNEL, "field", "x")).toBe("x");
    });
    it("rejects missing", () => {
      expect(() => decodeString(CHANNEL, "field", undefined)).toThrow("tau:test: field must be a non-empty string");
    });
    it("rejects wrong type", () => {
      expect(() => decodeString(CHANNEL, "field", 42)).toThrow("tau:test: field must be a non-empty string");
    });
    it("rejects an empty string", () => {
      expect(() => decodeString(CHANNEL, "field", "")).toThrow();
    });
  });

  describe("decodeOptionalString", () => {
    it("passes through undefined", () => {
      expect(decodeOptionalString(CHANNEL, "field", undefined)).toBeUndefined();
    });
    it("accepts a string", () => {
      expect(decodeOptionalString(CHANNEL, "field", "y")).toBe("y");
    });
    it("rejects wrong type", () => {
      expect(() => decodeOptionalString(CHANNEL, "field", 1)).toThrow();
    });
  });

  describe("decodeBoolean", () => {
    it("accepts a boolean", () => {
      expect(decodeBoolean(CHANNEL, "field", true)).toBe(true);
    });
    it("rejects missing", () => {
      expect(() => decodeBoolean(CHANNEL, "field", undefined)).toThrow();
    });
    it("rejects wrong type", () => {
      expect(() => decodeBoolean(CHANNEL, "field", "true")).toThrow();
    });
  });

  describe("decodeOptionalBoolean", () => {
    it("passes through undefined", () => {
      expect(decodeOptionalBoolean(CHANNEL, "field", undefined)).toBeUndefined();
    });
    it("rejects wrong type", () => {
      expect(() => decodeOptionalBoolean(CHANNEL, "field", "x")).toThrow();
    });
  });

  describe("decodeUiPromptAttachments", () => {
    it("passes through undefined", () => {
      expect(decodeUiPromptAttachments(CHANNEL, "field", undefined)).toBeUndefined();
    });
    it("accepts a valid array", () => {
      expect(decodeUiPromptAttachments(CHANNEL, "field", [validAttachment])).toEqual([validAttachment]);
    });
    it("rejects a non-array", () => {
      expect(() => decodeUiPromptAttachments(CHANNEL, "field", {})).toThrow("must be an array");
    });
    it("rejects an entry missing a required field", () => {
      expect(() => decodeUiPromptAttachments(CHANNEL, "field", [{ kind: "image", name: "a" }])).toThrow();
    });
    it("rejects the wrong kind", () => {
      expect(() => decodeUiPromptAttachments(CHANNEL, "field", [{ ...validAttachment, kind: "audio" }])).toThrow('must be "image" or "file"');
    });
    it("accepts a file on the host's disk and drops fields a file does not have", () => {
      const file = { kind: "file", name: "spec.pdf", mimeType: "application/pdf", path: "/state/attachments/t1/spec.pdf", size: 2048 };
      expect(decodeUiPromptAttachments(CHANNEL, "field", [{ ...file, data: "x" }])).toEqual([file]);
      expect(() => decodeUiPromptAttachments(CHANNEL, "field", [{ ...file, path: 3 }])).toThrow();
    });
  });

  describe("decodeNewThreadConfiguration", () => {
    it("accepts an explicit model and rejects incomplete identities", () => {
      expect(decodeNewThreadConfiguration(CHANNEL, "field", {
        model: { provider: "openai-codex", id: "gpt-6-astra" },
      })).toEqual({ model: { provider: "openai-codex", id: "gpt-6-astra" } });
      expect(decodeNewThreadConfiguration(CHANNEL, "field", undefined)).toBeUndefined();
      expect(() => decodeNewThreadConfiguration(CHANNEL, "field", { model: { provider: "openai-codex" } })).toThrow();
    });
  });

  describe("decodeClientTurnIdentity / decodeStringOrClientTurnIdentity", () => {
    it("accepts a well-formed identity", () => {
      expect(decodeClientTurnIdentity(CHANNEL, "field", { clientTurnId: "t1", clientMessageId: "m1" }))
        .toEqual({ clientTurnId: "t1", clientMessageId: "m1" });
    });
    it("rejects a missing clientMessageId", () => {
      expect(() => decodeClientTurnIdentity(CHANNEL, "field", { clientTurnId: "t1" })).toThrow();
    });
    it("passes a bare string through unchanged", () => {
      expect(decodeStringOrClientTurnIdentity(CHANNEL, "field", "legacy-id")).toBe("legacy-id");
    });
    it("passes through undefined", () => {
      expect(decodeStringOrClientTurnIdentity(CHANNEL, "field", undefined)).toBeUndefined();
    });
    it("rejects a non-object, non-string value", () => {
      expect(() => decodeStringOrClientTurnIdentity(CHANNEL, "field", 5)).toThrow();
    });
  });

  describe("decodePreparedPrompt", () => {
    it("passes through undefined", () => {
      expect(decodePreparedPrompt(CHANNEL, "field", undefined)).toBeUndefined();
    });
    it("accepts a minimal valid prompt", () => {
      expect(decodePreparedPrompt(CHANNEL, "field", validPreparedPrompt)).toEqual(validPreparedPrompt);
    });
    it("rejects a missing sourceFingerprint", () => {
      const { sourceFingerprint: _sourceFingerprint, ...rest } = validPreparedPrompt;
      expect(() => decodePreparedPrompt(CHANNEL, "field", rest)).toThrow();
    });
    it("rejects malformed runtimeCapabilities", () => {
      expect(() => decodePreparedPrompt(CHANNEL, "field", { ...validPreparedPrompt, runtimeCapabilities: {} })).toThrow();
    });
  });

  describe("decodeUiSkillDraft", () => {
    it("passes through undefined", () => {
      expect(decodeUiSkillDraft(CHANNEL, "field", undefined)).toBeUndefined();
    });
    it("accepts a well-formed draft", () => {
      const draft = { source: "skill", name: "tdd", visibleText: "/skill:tdd", command: "/skill:tdd" };
      expect(decodeUiSkillDraft(CHANNEL, "field", draft)).toEqual(draft);
    });
    it("rejects the wrong source", () => {
      expect(() => decodeUiSkillDraft(CHANNEL, "field", { source: "prompt", name: "x", visibleText: "x", command: "x" })).toThrow('must be "skill"');
    });
    it("rejects a missing command", () => {
      expect(() => decodeUiSkillDraft(CHANNEL, "field", { source: "skill", name: "x", visibleText: "x" })).toThrow();
    });
  });

  describe("decodeHostTranscriptCursor", () => {
    it("passes through undefined", () => {
      expect(decodeHostTranscriptCursor(CHANNEL, "field", undefined)).toBeUndefined();
    });
    it("accepts a non-empty string", () => {
      expect(decodeHostTranscriptCursor(CHANNEL, "field", "cursor-1")).toBe("cursor-1");
    });
    it("rejects an empty string", () => {
      expect(() => decodeHostTranscriptCursor(CHANNEL, "field", "")).toThrow();
    });
    it("rejects a non-string", () => {
      expect(() => decodeHostTranscriptCursor(CHANNEL, "field", 5)).toThrow();
    });
  });

  describe("decodeNavigateOptions", () => {
    it("passes through undefined", () => {
      expect(decodeNavigateOptions(CHANNEL, "field", undefined)).toBeUndefined();
    });
    it("accepts an object without summarize", () => {
      expect(decodeNavigateOptions(CHANNEL, "field", {})).toEqual({});
    });
    it("accepts summarize: true", () => {
      expect(decodeNavigateOptions(CHANNEL, "field", { summarize: true })).toEqual({ summarize: true });
    });
    it("rejects a non-boolean summarize", () => {
      expect(() => decodeNavigateOptions(CHANNEL, "field", { summarize: "yes" })).toThrow();
    });
  });

  describe("decodeExtensionUiAnswer", () => {
    it("accepts cancelled: true", () => {
      expect(decodeExtensionUiAnswer(CHANNEL, "field", { cancelled: true })).toEqual({ cancelled: true });
    });
    it("accepts a confirmed answer", () => {
      expect(decodeExtensionUiAnswer(CHANNEL, "field", { confirmed: false })).toEqual({ confirmed: false });
    });
    it("accepts a typed value answer", () => {
      expect(decodeExtensionUiAnswer(CHANNEL, "field", { value: "x", typed: true })).toEqual({ value: "x", typed: true });
    });
    it("rejects an object with none of the known shapes", () => {
      expect(() => decodeExtensionUiAnswer(CHANNEL, "field", {})).toThrow();
    });
    it("rejects cancelled: false", () => {
      expect(() => decodeExtensionUiAnswer(CHANNEL, "field", { cancelled: false })).toThrow();
    });
  });

  describe("decodeWorkbenchReloadMode", () => {
    it("accepts a known mode", () => {
      expect(decodeWorkbenchReloadMode(CHANNEL, "field", "wait")).toBe("wait");
    });
    it("rejects an unknown mode", () => {
      expect(() => decodeWorkbenchReloadMode(CHANNEL, "field", "later")).toThrow();
    });
    it("rejects a non-string", () => {
      expect(() => decodeWorkbenchReloadMode(CHANNEL, "field", 1)).toThrow();
    });
  });

  describe("decodeSharedExports", () => {
    it("accepts a valid map", () => {
      expect(decodeSharedExports(CHANNEL, "field", { react: ["default", "useState"] })).toEqual({ react: ["default", "useState"] });
    });
    it("rejects a non-array value", () => {
      expect(() => decodeSharedExports(CHANNEL, "field", { react: "default" })).toThrow();
    });
    it("rejects an array with a non-string entry", () => {
      expect(() => decodeSharedExports(CHANNEL, "field", { react: ["default", 1] })).toThrow();
    });
  });

  describe("decodeExtensionId", () => {
    it("accepts a dot-separated lowercase id", () => {
      expect(decodeExtensionId(CHANNEL, "tau.workspace-kit")).toBe("tau.workspace-kit");
    });
    it("rejects an uppercase id", () => {
      expect(() => decodeExtensionId(CHANNEL, "Tau.Kit")).toThrow();
    });
    it("rejects a missing id", () => {
      expect(() => decodeExtensionId(CHANNEL, undefined)).toThrow();
    });
  });

  describe("decodeCommandName", () => {
    it("accepts a plain identifier", () => {
      expect(decodeCommandName(CHANNEL, "list-directories")).toBe("list-directories");
    });
    it("rejects a command with spaces", () => {
      expect(() => decodeCommandName(CHANNEL, "list directories")).toThrow();
    });
    it("rejects a non-string", () => {
      expect(() => decodeCommandName(CHANNEL, 5)).toThrow();
    });
  });
});

describe("decodeText", () => {
  it("accepts an empty string so an attachment-only prompt passes", () => {
    expect(decodeText("tau:prompt", "text", "")).toBe("");
    expect(decodeOptionalText("tau:new-session", "initialPrompt", undefined)).toBeUndefined();
  });
  it("rejects non-strings", () => {
    expect(() => decodeText("tau:prompt", "text", 1)).toThrow("tau:prompt: text must be a string");
  });
});

describe("decodeCustomProviderInput", () => {
  const CH = "add-model-provider";
  const validInput = { providerId: "my-provider", models: [{ id: "my-model" }] };

  it("accepts a valid minimal payload", () => {
    const result = decodeCustomProviderInput(CH, "input", validInput);
    expect(result.providerId).toBe("my-provider");
    expect(result.models).toHaveLength(1);
    expect(result.models[0].id).toBe("my-model");
  });

  it("accepts a full payload with optional fields", () => {
    const result = decodeCustomProviderInput(CH, "input", {
      providerId: "p",
      name: "Provider",
      baseUrl: "https://api.example.com",
      api: "openai",
      apiKey: "sk-x",
      models: [{ id: "m1", name: "Model 1", reasoning: true, contextWindow: 128000, maxTokens: 4096 }],
    });
    expect(result.baseUrl).toBe("https://api.example.com");
    expect(result.models[0].reasoning).toBe(true);
    expect(result.models[0].contextWindow).toBe(128000);
  });

  it("rejects null — produces a clean message, not a TypeError", () => {
    expect(() => decodeCustomProviderInput(CH, "input", null))
      .toThrow("add-model-provider: input must be an object");
  });

  it("rejects a string payload", () => {
    expect(() => decodeCustomProviderInput(CH, "input", "x"))
      .toThrow("add-model-provider: input must be an object");
  });

  it("rejects an array payload", () => {
    expect(() => decodeCustomProviderInput(CH, "input", []))
      .toThrow("add-model-provider: input must be an object");
  });

  it("rejects a missing providerId", () => {
    expect(() => decodeCustomProviderInput(CH, "input", { models: [{ id: "m" }] }))
      .toThrow("add-model-provider: input.providerId must be a non-empty string");
  });

  it("rejects an empty models array", () => {
    expect(() => decodeCustomProviderInput(CH, "input", { providerId: "p", models: [] }))
      .toThrow("add-model-provider: input.models must be a non-empty array");
  });

  it("rejects a model without an id", () => {
    expect(() => decodeCustomProviderInput(CH, "input", { providerId: "p", models: [{ name: "no-id" }] }))
      .toThrow("add-model-provider: input.models[0].id must be a non-empty string");
  });
});

describe("decodeConfigPatch", () => {
  const CH = "update-config";

  it("accepts a valid partial patch", () => {
    const result = decodeConfigPatch(CH, "patch", { theme: "dark", showCosts: true });
    expect(result.theme).toBe("dark");
    expect(result.showCosts).toBe(true);
  });

  it("carries vim mode and the restart setting, which it used to drop", () => {
    const result = decodeConfigPatch(CH, "patch", { vimMode: true, threads: { continueAfterRestart: true } });
    expect(result).toEqual({ vimMode: true, threads: { continueAfterRestart: true } });
    expect(() => decodeConfigPatch(CH, "patch", { threads: { continueAfterRestart: "yes" } }))
      .toThrow("update-config: patch.threads.continueAfterRestart must be a boolean");
  });

  it("decodes the keys clear-config removes", () => {
    expect(decodeSettingKeys("clear-config", "keys", ["showCosts", "values.tau.x"])).toEqual(["showCosts", "values.tau.x"]);
    expect(() => decodeSettingKeys("clear-config", "keys", [])).toThrow("clear-config: keys must be a list of 1 to 100 setting keys");
    expect(() => decodeSettingKeys("clear-config", "keys", [""])).toThrow("clear-config: keys must hold non-empty setting keys");
  });

  it("silently drops unknown keys", () => {
    const result = decodeConfigPatch(CH, "patch", { theme: "dark", unknownKey: "value" });
    expect(result.theme).toBe("dark");
    expect("unknownKey" in result).toBe(false);
  });

  it("rejects non-objects", () => {
    expect(() => decodeConfigPatch(CH, "patch", null)).toThrow("update-config: patch must be an object");
    expect(() => decodeConfigPatch(CH, "patch", "x")).toThrow();
  });

  it("rejects wrong type for a known field (showCosts must be boolean)", () => {
    expect(() => decodeConfigPatch(CH, "patch", { showCosts: "yes" }))
      .toThrow("update-config: patch.showCosts must be a boolean");
  });

  it("rejects invalid transcriptDetail value", () => {
    expect(() => decodeConfigPatch(CH, "patch", { transcriptDetail: "all" }))
      .toThrow('must be "focused", "detailed" or "everything"');
  });

  it("accepts an empty patch", () => {
    expect(decodeConfigPatch(CH, "patch", {})).toEqual({});
  });

  it("decodes the models sub-object", () => {
    const result = decodeConfigPatch(CH, "patch", { models: { default: "anthropic/claude-3" } });
    expect(result.models?.default).toBe("anthropic/claude-3");
  });
});
