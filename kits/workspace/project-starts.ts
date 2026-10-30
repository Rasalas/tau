import { gitEnvironment } from "tau/host-extension";
import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { githubRepositoryPath, type NewProjectGithub, type NewProjectRepository, type RepositoryVisibility } from "./project-github.js";

const execute = promisify(execFile);

/** A project name is one portable folder name, never a path. */
export function projectFolderName(value: string): string {
  const name = value.trim();
  // oxlint-disable-next-line eslint/no-control-regex -- Portable folder names must reject control characters.
  if (!name || name.length > 120 || /[<>:"/\\|?*\x00-\x1f]/u.test(name) || /[. ]$/u.test(name) || name === "." || name === ".." || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(name)) {
    throw new Error("Choose a project name without path separators or reserved characters.");
  }
  return name;
}

export function isScratchWorkspace(stateDir: string, path: string): boolean {
  const canonical = (value: string) => { try { return realpathSync(value); } catch { return resolve(value); } };
  const leaf = relative(canonical(join(stateDir, "scratch")), canonical(path));
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(leaf);
}

export async function createScratchWorkspace(stateDir: string, git = "git"): Promise<string> {
  if (!isAbsolute(stateDir)) throw new Error("This machine has no private workspace storage.");
  const root = join(stateDir, "scratch");
  await mkdir(root, { recursive: true, mode: 0o700 });
  const canonicalRoot = await realpath(root);
  try {
    const inherited = await execute(git, ["rev-parse", "--show-toplevel"], { env: gitEnvironment(), cwd: canonicalRoot, timeout: 10_000 });
    if (inherited.stdout.trim()) throw new Error("Private scratch storage is inside a Git repository. Choose a data folder on this machine outside that repository.");
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === 128)) throw error;
  }
  const path = join(canonicalRoot, randomUUID());
  await mkdir(path, { mode: 0o700 });
  return path;
}

/** Creates only a fresh directory. Git failures keep the usable project. */
export async function createNamedProject(parentPath: string, value: string, git: string): Promise<{ path: string; warning?: string }> {
  const name = projectFolderName(value);
  if (!isAbsolute(parentPath)) throw new Error("Choose an absolute parent folder.");
  const parent = await realpath(parentPath);
  const path = join(parent, name);
  await mkdir(path); // Atomic collision refusal; never overwrite another project.
  const letters = name.replace(/[^a-z0-9]/giu, "").slice(0, 2).toUpperCase() || "PR";
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  const hue = hash % 360;
  await writeFile(join(path, "README.md"), `# ${name}\n`);
  await writeFile(join(path, "project-icon.svg"), `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="hsl(${hue} 48% 38%)"/><text x="32" y="41" text-anchor="middle" font-family="sans-serif" font-size="25" font-weight="700" fill="white">${letters}</text></svg>\n`);
  await writeFile(join(path, "t3.json"), JSON.stringify({ iconPath: "project-icon.svg" }, null, 2) + "\n");
  try {
    await execute(git, ["init", "--initial-branch=main"], { env: gitEnvironment(), cwd: path, timeout: 30_000 });
    await execute(git, ["add", "--", "README.md", "project-icon.svg", "t3.json"], { env: gitEnvironment(), cwd: path, timeout: 30_000 });
    await execute(git, ["commit", "-m", "Initial commit"], { env: gitEnvironment(), cwd: path, timeout: 30_000 });
    return { path };
  } catch {
    return { path, warning: "Project created. Git setup could not finish; check Git and your commit identity." };
  }
}

/** Review Kit's `publish-repository`, as the host's own call reaches it. */
export type PublishRepository = (input: { workspace: string; service: "github"; repository: string; visibility: RepositoryVisibility; confirm: true }) => Promise<unknown>;

const sentence = (text: string): string => /[.!?]$/u.test(text.trim()) ? text.trim() : `${text.trim()}.`;
const LATER = "Publish it later with \"Publish repository…\" in the Changes panel.";

/**
 * Creates the GitHub repository of a project just made, on the machine that made it,
 * and pushes the first commit, which sets `main`'s upstream to `origin/main`. Every
 * failure leaves the project as it is and comes back as a warning that says what to do.
 */
export async function publishNewProject(
  publish: PublishRepository,
  project: { workspace: string; name: string; warning?: string },
  github: NewProjectGithub,
): Promise<{ github?: NewProjectRepository; warning?: string }> {
  // Without a first commit there is nothing to push and no upstream to set.
  if (project.warning) return { warning: `${sentence(project.warning)} Its GitHub repository was not created; publish it with "Publish repository…" in the Changes panel once Git works.` };
  const repository = githubRepositoryPath(project.name, github.owner);
  if (!repository) return { warning: `Project created, but not its GitHub repository: GitHub needs a name with letters or digits. ${LATER}` };
  let answer: Record<string, unknown>;
  try {
    const result = await publish({ workspace: project.workspace, service: "github", repository, visibility: github.visibility, confirm: true });
    answer = result && typeof result === "object" ? result as Record<string, unknown> : {};
  } catch (error) {
    return { warning: `Project created, but not its GitHub repository: ${sentence(error instanceof Error ? error.message : String(error))} ${LATER}` };
  }
  const created: NewProjectRepository = {
    repository: typeof answer.repository === "string" ? answer.repository : repository,
    url: typeof answer.url === "string" ? answer.url : "",
    pushed: answer.pushed === true,
    ...(typeof answer.branch === "string" ? { branch: answer.branch } : {}),
  };
  if (typeof answer.pushProblem === "string") {
    return { github: created, warning: `Created ${created.repository} on GitHub and added it as origin, but the first push failed. ${sentence(answer.pushProblem)}` };
  }
  return { github: created };
}
