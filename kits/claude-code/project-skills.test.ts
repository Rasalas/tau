import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { projectSkills, skillFields, skillRoots } from "./project-skills.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("project skills", () => {
  it("reads name and description, with a folded description and the folder name as fallback", () => {
    expect(skillFields("---\nname: 'review'\ndescription: >\n  Reviews a diff\n  line by line\n---\nBody")).toEqual({ name: "review", description: "Reviews a diff line by line" });
    expect(skillFields("no frontmatter")).toEqual({});
  });

  it("takes the launch's --add-dir beside the project, resolved against it", () => {
    expect(skillRoots("/repo", ["--add-dir", "../other"])).toEqual(["/repo", "/other"]);
    expect(skillRoots("/repo", ["--add-dir=/abs", "--verbose"])).toEqual(["/repo", "/abs"]);
    expect(skillRoots("/repo", [])).toEqual(["/repo"]);
  });

  it("lists folders that hold a SKILL.md and skips the rest", async () => {
    const root = await mkdtemp(join(tmpdir(), "tau-project-skills-"));
    roots.push(root);
    await mkdir(join(root, ".claude", "skills", "deploy"), { recursive: true });
    await mkdir(join(root, ".claude", "skills", "empty"), { recursive: true });
    await writeFile(join(root, ".claude", "skills", "deploy", "SKILL.md"), "---\ndescription: Ship it\n---\n");
    await writeFile(join(root, ".claude", "skills", "notes.md"), "not a skill");
    expect(projectSkills(root, [])).toEqual([{ name: "deploy", description: "Ship it" }]);
    expect(projectSkills(join(root, "missing"), [])).toEqual([]);
  });
});
