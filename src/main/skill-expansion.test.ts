import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseKnownSkillInvocation } from "../shared/skill-envelope.js";
import { expandSkills, type PiSkillFile } from "./skill-expansion.js";
import { PI_AGENT_RUNTIME_ADAPTER } from "./runtime-adapters.js";
import { PiThreadRuntimeBackend } from "./thread-runtime-backend.js";

let root: string;
const files = new Map<string, PiSkillFile>();

async function skill(name: string, body: string): Promise<void> {
  const baseDir = join(root, name);
  await mkdir(baseDir, { recursive: true });
  const filePath = join(baseDir, "SKILL.md");
  await writeFile(filePath, `---\nname: ${name}\ndescription: ${name} skill\n---\n\n${body}\n`);
  files.set(name, { name, filePath, baseDir });
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "tau-skills-"));
  files.clear();
  await skill("tdd", "Write the test first.");
  await skill("lint", "Fix every warning.");
});
afterEach(() => rm(root, { recursive: true, force: true }));

const both = (visibleText: string) => ({
  visibleText,
  skills: ["tdd", "lint"].map((name) => ({ name, command: `/skill:${name}`, copyText: "" })),
});

describe("expanding every skill of a message", () => {
  it("puts one block per skill ahead of the text, which stays as typed", async () => {
    const text = "  fix it\n\n\n    indented  ";
    const expanded = await expandSkills(both(text), (name) => files.get(name));
    expect(expanded).toContain("Write the test first.");
    expect(expanded).toContain("Fix every warning.");
    expect(expanded).not.toContain("description: tdd skill");
    expect(expanded).toContain(`<skill name="tdd" location="${files.get("tdd")!.filePath}">\nReferences are relative to ${files.get("tdd")!.baseDir}.`);
    expect(expanded!.endsWith(`</skill>\n\n${text}`)).toBe(true);
  });

  it("reads back as the same skills and text", async () => {
    const expanded = await expandSkills(both("go on"), (name) => files.get(name));
    const parsed = parseKnownSkillInvocation(expanded!, [{ name: "skill:tdd", source: "skill" }, { name: "skill:lint", source: "skill" }]);
    expect(parsed).toMatchObject({ names: ["tdd", "lint"], userMessage: "go on" });
  });

  it("leaves one skill to Pi and fails loudly on a skill it cannot read", async () => {
    expect(await expandSkills({ visibleText: "x", skills: undefined }, (name) => files.get(name))).toBeUndefined();
    await expect(expandSkills(both("x"), (name) => name === "tdd" ? files.get(name) : undefined)).rejects.toThrow("'lint' is no longer available");
    await rm(files.get("lint")!.filePath);
    await expect(expandSkills(both("x"), (name) => files.get(name))).rejects.toThrow("Could not load the skill 'lint'");
  });
});

describe("the Pi backend with several skills", () => {
  function backend() {
    const prompt = vi.fn(async () => undefined);
    const steer = vi.fn(async () => undefined);
    const session = {
      prompt,
      steer,
      followUp: vi.fn(async () => undefined),
      settingsManager: { getEnableSkillCommands: () => true },
      resourceLoader: {
        getExtensions: () => ({ extensions: [] }),
        getPrompts: () => ({ prompts: [] }),
        getSkills: () => ({ skills: [...files.values()].map((file) => ({ ...file, description: file.name })) }),
      },
    };
    const instance = new PiThreadRuntimeBackend({ session } as never, PI_AGENT_RUNTIME_ADAPTER, { mapMessages: () => [] });
    return { instance, prompt, steer };
  }
  const draft = { source: "skill" as const, name: "tdd", command: "/skill:tdd", visibleText: "fix the parser", additionalSkills: [{ name: "lint", command: "/skill:lint" }] };

  it("sends the expanded text, so Pi loads both and the prompt is not trimmed", async () => {
    const { instance, prompt } = backend();
    const prepared = await instance.preparePrompt("$tdd $lint fix the parser", draft);
    expect(prepared.skills?.map((entry) => entry.name)).toEqual(["tdd", "lint"]);
    await instance.prompt({ text: "$tdd $lint fix the parser", prepared, delivery: "prompt" } as never);
    const sent = (prompt.mock.calls[0] as unknown as [string])[0];
    expect(sent.startsWith("<skill name=\"tdd\"")).toBe(true);
    expect(sent).toContain("Fix every warning.");
    expect(sent.endsWith("\n\nfix the parser")).toBe(true);
  });

  it("hands a queued steer the same text", async () => {
    const { instance, steer } = backend();
    const prepared = await instance.preparePrompt("$tdd $lint fix", { ...draft, visibleText: "fix" });
    await instance.prompt({ text: "$tdd $lint fix", prepared, delivery: "steer" } as never);
    expect((steer.mock.calls[0] as unknown as [string])[0]).toContain("Write the test first.");
  });

  it("keeps one skill on Pi's own spelling", async () => {
    const { instance, prompt } = backend();
    await instance.prompt({ text: "$tdd fix", delivery: "prompt" } as never);
    expect((prompt.mock.calls[0] as unknown as [string])[0]).toBe("/skill:tdd fix");
  });
});
