import { describe, expect, it } from "vitest";
import type { UiComposerCommand } from "../shared/contracts.js";
import { mapMessage } from "./pi-host.js";
import { PI_RUNTIME_ADAPTER, type SkillRuntimeAdapter } from "./skill-invocation.js";

const skillCommands: UiComposerCommand[] = [{ name: "skill:tdd", source: "skill" }];

describe("Pi message mapping", () => {
  it("keeps user image content for the renderer", () => {
    expect(mapMessage({
      role: "user",
      content: [
        { type: "text", text: "please inspect" },
        { type: "image", mimeType: "image/png", data: "iVBORw==" },
      ],
      timestamp: 1,
    }, 0)).toMatchObject({
      role: "user",
      text: "please inspect",
      images: [{ mimeType: "image/png", data: "iVBORw==" }],
    });
  });

  it("resolves Pi skill envelopes before sending typed UI data to the renderer", () => {
    const message = mapMessage({
      role: "user",
      content: [{ type: "text", text: `<skill name="tdd" location="/tmp/tdd/SKILL.md">\nReferences are relative to /tmp/tdd.\n\nInjected body\n</skill>\n\nFix **the parser**` }],
      timestamp: 1,
    }, 0, { skillRuntimeAdapter: PI_RUNTIME_ADAPTER, skillCommands });
    expect(message).toMatchObject({
      role: "user",
      text: "Fix **the parser**",
      skill: { name: "tdd", command: "/skill:tdd", copyText: "/skill:tdd Fix **the parser**" },
    });
    expect(message?.text).not.toContain("Injected body");
    expect(message?.text).not.toContain("/tmp/tdd");
    expect(message?.skill?.copyText).not.toContain("Injected body");
    expect(message?.skill?.copyText).not.toContain("/tmp/tdd");
  });

  it("uses the runtime adapter dialect for Claude Code without reading model.provider", () => {
    const claudeCode: SkillRuntimeAdapter = { capabilities: { skillInvocationDialect: "claude-code" } };
    const message = mapMessage({
      role: "user",
      content: [{ type: "text", text: "$tdd fix it" }],
      timestamp: 1,
    }, 0, { skillRuntimeAdapter: claudeCode, skillCommands });
    expect(message).toMatchObject({
      text: "fix it",
      skill: { name: "tdd", command: "/tdd", copyText: "/tdd fix it" },
    });
  });

  it("keeps unknown and malformed wrappers as the original user text", () => {
    const malformed = `<skill name="tdd" location="/tmp/tdd">\nInjected body\n</skill`;
    expect(mapMessage({ role: "user", content: [{ type: "text", text: malformed }] }, 0, {
      skillRuntimeAdapter: PI_RUNTIME_ADAPTER,
      skillCommands,
    })).toMatchObject({ text: malformed });
  });
});
