import { closeSync, openSync, readdirSync, readSync } from "node:fs";
import { join, resolve } from "node:path";
import { sdkExtraArgs } from "./runtime-adapter.js";

export interface ProjectSkill { name: string; description?: string }

const MAX_SKILLS_PER_ROOT = 200;
/** The frontmatter sits at the top of the file; the body is never needed. */
const HEAD_BYTES = 8 * 1024;
const FRESH_MS = 3_000;
const found = new Map<string, { at: number; skills: ProjectSkill[] }>();

/** The folders whose `.claude/skills` the CLI loads: the project and the launch's `--add-dir` value. */
export function skillRoots(cwd: string, launchArgs: readonly string[]): string[] {
  const added = sdkExtraArgs(launchArgs).extraArgs["add-dir"];
  return [...new Set([resolve(cwd), ...(added ? [resolve(cwd, added)] : [])])];
}

function head(file: string): string | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(file, "r");
    const buffer = Buffer.alloc(HEAD_BYTES);
    return buffer.subarray(0, readSync(fd, buffer, 0, HEAD_BYTES, 0)).toString("utf8");
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function unquote(value: string): string {
  const text = value.trim();
  return text.length >= 2 && (text[0] === "\"" || text[0] === "'") && text.endsWith(text[0]!) ? text.slice(1, -1) : text;
}

/** `name` and `description` of a SKILL.md; a `>` or `|` description is the indented lines below it, joined. */
export function skillFields(text: string): { name?: string; description?: string } {
  const lines = text.replace(/^﻿/u, "").split(/\r?\n/u);
  if (lines[0]?.trim() !== "---") return {};
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  const out: { name?: string; description?: string } = {};
  for (let index = 1; index < (end < 0 ? lines.length : end); index += 1) {
    const match = /^(name|description):\s*(.*)$/u.exec(lines[index]!);
    if (!match) continue;
    const key = match[1] as "name" | "description";
    let value = match[2]!.trim();
    if (/^[>|][+-]?$/u.test(value)) {
      const block: string[] = [];
      while (index + 1 < (end < 0 ? lines.length : end) && /^\s+\S/u.test(lines[index + 1]!)) block.push(lines[++index]!.trim());
      value = block.join(" ");
    }
    const field = unquote(value);
    if (field) out[key] = field;
  }
  return out;
}

function skillsIn(root: string): ProjectSkill[] {
  const base = join(root, ".claude", "skills");
  let entries: string[];
  try {
    entries = readdirSync(base).sort().slice(0, MAX_SKILLS_PER_ROOT);
  } catch {
    return [];
  }
  const skills: ProjectSkill[] = [];
  for (const entry of entries) {
    const text = head(join(base, entry, "SKILL.md"));
    if (text === undefined) continue;
    const { name, description } = skillFields(text);
    skills.push({ name: name ?? entry, ...(description ? { description } : {}) });
  }
  return skills;
}

/** The skills the project's own folders offer, the project first; the first of a name wins. */
export function projectSkills(cwd: string, launchArgs: readonly string[]): ProjectSkill[] {
  const roots = skillRoots(cwd, launchArgs);
  const key = roots.join("\u0000");
  const cached = found.get(key);
  if (cached && Date.now() - cached.at < FRESH_MS) return cached.skills;
  const byName = new Map<string, ProjectSkill>();
  for (const skill of roots.flatMap(skillsIn)) if (!byName.has(skill.name)) byName.set(skill.name, skill);
  const skills = [...byName.values()];
  found.set(key, { at: Date.now(), skills });
  return skills;
}
