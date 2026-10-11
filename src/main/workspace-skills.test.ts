import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { UiComposerCommand } from "../shared/contracts.js";
import { PI_RUNTIME_ADAPTER } from "./skill-invocation.js";
import { piWorkspaceCommands } from "./workspace-skills.js";

let root: string;
let previous: string | undefined;

async function skill(project: string, name: string): Promise<void> {
  const directory = join(root, project, ".pi", "skills", name);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "SKILL.md"), `---\nname: ${name}\ndescription: ${name} of ${project}\n---\n\nBody.\n`);
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "tau-workspace-skills-"));
  previous = process.env.PI_CODING_AGENT_DIR;
  // The user's own folders stay out of it.
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  await mkdir(join(root, "agent"), { recursive: true });
  await skill("a", "alpha-note");
  await skill("b", "bravo-note");
});
afterEach(async () => {
  if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
  await rm(root, { recursive: true, force: true });
});

describe("piWorkspaceCommands", () => {
  const base: UiComposerCommand[] = [{ name: "reload", source: "extension" }, { name: "skill:stale", source: "skill" }];

  it("lists the skills of the project asked for, in the runtime's spelling, beside the host's own commands", () => {
    const commands = piWorkspaceCommands(base, join(root, "b"), PI_RUNTIME_ADAPTER);
    expect(commands).toEqual([
      { name: "reload", source: "extension" },
      { name: "skill:bravo-note", description: "bravo-note of b", source: "skill", skillCommand: "/skill:bravo-note" },
    ]);
  });

  it("does not carry another project's skills", () => {
    const names = piWorkspaceCommands([], join(root, "a"), PI_RUNTIME_ADAPTER).map((command) => command.name);
    expect(names).toContain("skill:alpha-note");
    expect(names).not.toContain("skill:bravo-note");
  });
});
