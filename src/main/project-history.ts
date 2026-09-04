import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { UiProject } from "../shared/contracts.js";
import { resolveProjectIcon } from "./project-icon.js";

const MAX_PROJECTS = 24;
/** Bumped when the stored shape changes; `load()` stays backward compatible. */
const CURRENT_VERSION = 1;

type ProjectIconResolver = (path: string) => Promise<string | undefined>;

interface NormalizedStored {
  version?: number;
  projects: unknown;
  hiddenPaths: unknown;
}

function normalizeStored(value: unknown): NormalizedStored | undefined {
  if (Array.isArray(value)) return { projects: value, hiddenPaths: [] };
  if (!value || typeof value !== "object") return undefined;
  const stored = value as { version?: unknown; projects?: unknown; hiddenPaths?: unknown };
  return {
    version: typeof stored.version === "number" ? stored.version : undefined,
    projects: stored.projects,
    hiddenPaths: stored.hiddenPaths,
  };
}

export class ProjectHistory {
  private projects: UiProject[] = [];
  private hiddenPaths = new Set<string>();
  private dirty = false;
  private persistTimer?: ReturnType<typeof setTimeout>;
  private persistQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly filePath: string,
    private readonly resolveIcon: ProjectIconResolver = resolveProjectIcon,
  ) {}

  async load(): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch {
      // No file yet; start empty without treating it as corruption.
      return;
    }
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      await this.quarantineCorruptFile();
      return;
    }
    try {
      const stored = normalizeStored(value);
      if (!stored || !Array.isArray(stored.projects)) return;
      if (stored.version !== undefined && stored.version > CURRENT_VERSION) {
        // A newer Tau wrote this file. Read what this build understands and
        // leave the rest alone; persist() only runs from a real mutation, so
        // opening the file here never downgrades or drops unknown data.
        console.warn(`project history: ${this.filePath} is version ${stored.version}, newer than this build's ${CURRENT_VERSION}; reading it best-effort.`);
      }
      this.hiddenPaths = new Set(Array.isArray(stored.hiddenPaths)
        ? stored.hiddenPaths.filter((path): path is string => typeof path === "string")
        : []);
      const projects = stored.projects
        .filter((item): item is UiProject => {
          if (!item || typeof item !== "object") return false;
          const project = item as Partial<UiProject>;
          return typeof project.path === "string" && typeof project.lastOpenedAt === "number";
        })
        .slice(0, MAX_PROJECTS);
      this.projects = await Promise.all(projects.map(async (project) => ({
        path: project.path,
        name: project.name || basename(project.path) || project.path,
        lastOpenedAt: project.lastOpenedAt,
        ...await this.icon(project.path),
      })));
    } catch (error) {
      // Valid JSON but something in the shape or icon lookup blew up: start
      // empty like before, but this is not corruption, so the file stays put.
      console.warn(`project history: could not read ${this.filePath}`, error);
      this.projects = [];
    }
  }

  /** Renames an unparsable file aside instead of silently discarding it. */
  private async quarantineCorruptFile(): Promise<void> {
    const target = `${this.filePath}.corrupt-${new Date().toISOString()}`;
    try {
      await rename(this.filePath, target);
      console.warn(`project history: ${this.filePath} was not valid JSON; moved it to ${target} and starting empty.`);
    } catch (error) {
      console.warn(`project history: ${this.filePath} was not valid JSON and could not be moved aside`, error);
    }
  }

  list(): UiProject[] {
    return this.projects.map((project) => ({ ...project }));
  }

  isHidden(path: string): boolean {
    return this.hiddenPaths.has(path);
  }

  async remove(path: string): Promise<void> {
    this.projects = this.projects.filter((project) => project.path !== path);
    this.hiddenPaths.add(path);
    this.schedulePersist();
  }

  async remember(path: string, name = basename(path) || path): Promise<void> {
    const project: UiProject = {
      path,
      name,
      lastOpenedAt: Date.now(),
      ...await this.icon(path),
    };
    this.projects = [project, ...this.projects.filter((item) => item.path !== path)].slice(
      0,
      MAX_PROJECTS,
    );
    this.hiddenPaths.delete(path);
    this.schedulePersist();
  }

  private schedulePersist(): void {
    this.dirty = true;
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => {
      this.persistTimer = undefined;
      void this.persist().catch(() => {
        // Persistence is retried by the next mutation or surfaced by flush().
      });
    }, 100);
  }

  async flush(): Promise<void> {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = undefined;
    }
    if (this.dirty) await this.persist();
    await this.persistQueue;
  }

  private async icon(path: string): Promise<Pick<UiProject, "icon">> {
    try {
      const icon = await this.resolveIcon(path);
      return icon ? { icon } : {};
    } catch {
      return {};
    }
  }

  private persist(): Promise<void> {
    if (!this.dirty) return this.persistQueue;
    this.dirty = false;
    const storedProjects = this.projects.map(({ icon: _icon, ...project }) => project);
    const contents = JSON.stringify({
      version: CURRENT_VERSION,
      projects: storedProjects,
      hiddenPaths: [...this.hiddenPaths],
    }, null, 2);
    this.persistQueue = this.persistQueue.catch(() => undefined).then(() => this.writeAtomic(contents));
    return this.persistQueue;
  }

  /** Writes to a sibling temp file, then renames over the target: a crash mid-write never leaves a partial file. */
  private async writeAtomic(contents: string): Promise<void> {
    const dir = dirname(this.filePath);
    await mkdir(dir, { recursive: true });
    const temp = join(dir, `${basename(this.filePath)}.${randomUUID()}.tmp`);
    const handle = await open(temp, "wx", 0o600);
    try {
      await handle.writeFile(contents, "utf8");
    } finally {
      await handle.close();
    }
    try {
      await rename(temp, this.filePath);
    } catch (error) {
      await rm(temp, { force: true }).catch(() => undefined);
      throw error;
    }
  }
}
