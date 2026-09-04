import { describe, expect, it } from "vitest";
import {
  decodeBoolean,
  decodeClientTurnIdentity,
  decodeCommandName,
  decodeExtensionId,
  decodeExtensionUiAnswer,
  decodeHostTranscriptCursor,
  decodeNavigateOptions,
  decodeOptionalBoolean,
  decodeOptionalString,
  decodePreparedPrompt,
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
      expect(() => decodeUiPromptAttachments(CHANNEL, "field", [{ ...validAttachment, kind: "file" }])).toThrow('must be "image"');
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
