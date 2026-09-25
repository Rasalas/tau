import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentDefinitionReader, findAgentDefinition, parseAgentDefinition, parseFrontmatter } from "./definitions.js";

const REVIEWER = `---
description: Reviews a diff and reports problems
model: anthropic/claude-haiku-4-5-20251001
tools: [read, grep, "find"]
access: read-only
workspace: shared
---
You review code. Report problems only.
`;

describe("the agent definition format", () => {
  it("reads scalars, both list spellings and the body", () => {
    const { fields, body } = parseFrontmatter("---\nname: a\n# a comment\ntools:\n  - read\n  - 'grep'\nmodel: \"x/y\"\n---\n\nPrompt\n");
    expect(Object.fromEntries(fields)).toEqual({ name: "a", tools: ["read", "grep"], model: "x/y" });
    expect(body).toBe("Prompt");
  });

  it("names the line it could not read", () => {
    expect(() => parseFrontmatter("no frontmatter")).toThrow("must start with a --- line");
    expect(() => parseFrontmatter("---\nname: a\n")).toThrow("no closing --- line");
    expect(() => parseFrontmatter("---\njust words\n---\nx")).toThrow('Line 2: expected "key: value"');
    expect(() => parseFrontmatter("---\n- item\n---\nx")).toThrow("Line 2: a list item needs a key");
    expect(() => parseFrontmatter("---\na: 1\na: 2\n---\nx")).toThrow('Line 3: "a" is set twice');
  });

  it("takes the name from the file and every setting from the frontmatter", () => {
    const { definition, warnings } = parseAgentDefinition("/p/.tau/agents/reviewer.md", REVIEWER);
    expect(definition).toEqual({
      name: "reviewer",
      description: "Reviews a diff and reports problems",
      file: "/p/.tau/agents/reviewer.md",
      systemPrompt: "You review code. Report problems only.",
      model: "anthropic/claude-haiku-4-5-20251001",
      tools: ["read", "grep", "find"],
      access: "read-only",
      workspace: "shared",
    });
    expect(warnings).toEqual([]);
  });

  it("warns about a field it does not know and still reads the file", () => {
    const { definition, warnings } = parseAgentDefinition("/x/helper.md", "---\ndescription: d\ncolor: blue\n---\nHelp.");
    expect(definition.name).toBe("helper");
    expect(warnings).toEqual(['"color" is not a field agent definitions have; it was ignored.']);
  });

  it("refuses what it cannot honour", () => {
    const parse = (frontmatter: string, body = "Prompt") => () => parseAgentDefinition("/x/a.md", `---\n${frontmatter}\n---\n${body}`);
    expect(parse("name: a")).toThrow('"description" is required');
    expect(parse("description: d", "")).toThrow("system prompt and must not be empty");
    expect(parse("name: Not A Slug\ndescription: d")).toThrow("lowercase letters");
    expect(parse("description: d\nmodel: sonnet")).toThrow("provider/model-id");
    expect(parse("description: d\naccess: root")).toThrow('"access" must be read-only, ask or full');
    expect(parse("description: d\nworkspace: elsewhere")).toThrow('"workspace" must be worktree or shared');
    expect(parse("description: d\ntools: []")).toThrow('"tools" lists no tool');
    expect(parse("description: d\nruntime: claude-code\naccess: ask")).toThrow('"access" only applies on the pi runtime');
  });

  it("names the machine its thread runs on", () => {
    const parse = (machine: string) => parseAgentDefinition("/x/a.md", `---\ndescription: d\nmachine: ${machine}\n---\nPrompt`).definition.machine;
    expect(parse("rex")).toBe("rex");
    expect(parse('"Mac mini"')).toBe("Mac mini");
    expect(parse("auto")).toBe("auto");
    expect(() => parse("x".repeat(129))).toThrow('"machine" must be 128 characters or fewer');
  });

  it("takes tools for any runtime, Tau's own in either spelling", () => {
    const { definition } = parseAgentDefinition("/x/a.md", "---\ndescription: d\nruntime: codex\ntools: [read, mcp__tau__tau_spawn_thread, tau_list_threads]\n---\nPrompt");
    expect(definition.tools).toEqual(["read", "tau_spawn_thread", "tau_list_threads"]);
  });
});

describe("agent definition discovery", () => {
  let dir: string | undefined;
  afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); dir = undefined; });

  const project = async (files: Record<string, string>) => {
    dir = await mkdtemp(join(tmpdir(), "tau-agent-defs-"));
    await mkdir(join(dir, ".tau", "agents"), { recursive: true });
    for (const [name, text] of Object.entries(files)) await writeFile(join(dir, ".tau", "agents", name), text);
    return dir;
  };

  it("reports a project without the folder as having none", async () => {
    dir = await mkdtemp(join(tmpdir(), "tau-agent-defs-"));
    const report = await new AgentDefinitionReader().read(dir);
    expect(report).toMatchObject({ definitions: [], problems: [], invalid: [] });
  });

  it("keeps the valid files, and names every broken one with its reason", async () => {
    const root = await project({
      "reviewer.md": REVIEWER,
      "broken.md": "---\ndescription: d\naccess: root\n---\nx",
      "zz-copy.md": "---\nname: reviewer\ndescription: d\n---\nx",
      "notes.txt": "not a definition",
    });
    const report = await new AgentDefinitionReader().read(root);
    expect(report.definitions.map((definition) => definition.name)).toEqual(["reviewer"]);
    expect(report.problems).toEqual([
      { file: join(root, ".tau", "agents", "broken.md"), message: '"access" must be read-only, ask or full.', level: "error" },
      { file: join(root, ".tau", "agents", "zz-copy.md"), message: 'The name "reviewer" is already taken by reviewer.md.', level: "error" },
    ]);
  });

  it("reads a changed file again and reuses an unchanged one", async () => {
    const root = await project({ "a.md": "---\ndescription: first\n---\nx" });
    const reader = new AgentDefinitionReader();
    const first = await reader.read(root);
    expect(first.definitions[0]!.description).toBe("first");
    await writeFile(join(root, ".tau", "agents", "a.md"), "---\ndescription: second, longer\n---\nx");
    expect((await reader.read(root)).definitions[0]!.description).toBe("second, longer");
  });

  it("says why a named definition cannot be used", async () => {
    const root = await project({ "reviewer.md": REVIEWER, "broken.md": "---\nname: broken\n---\nx" });
    const report = await new AgentDefinitionReader().read(root);
    expect(findAgentDefinition(report, "reviewer").name).toBe("reviewer");
    expect(() => findAgentDefinition(report, "broken")).toThrow(/"broken" \(.*broken\.md\) is invalid: "description" is required/u);
    expect(() => findAgentDefinition(report, "ghost")).toThrow('No agent definition "ghost"');
    expect(() => findAgentDefinition(report, "ghost")).toThrow("Available: reviewer.");
  });
});
