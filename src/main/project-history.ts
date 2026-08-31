import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname } from "node:path";
import type { UiProject } from "../shared/contracts.js";

const MAX_PROJECTS = 24;

export class ProjectHistory {
  private projects: UiProject[] = [];
  private hiddenPaths = new Set<string>();
  private dirty = false;
  private persistTimer?: ReturnType<typeof setTimeout>;
  private persistQueue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async load(): Promise<void> {
    try {
      const value = JSON.parse(await readFile(this.filePath, "utf8")) as unknown;
      const stored = Array.isArray(value) ? { projects: value, hiddenPaths: [] } : value as { projects?: unknown; hiddenPaths?: unknown };
      if (!Array.isArray(stored?.projects)) return;
      this.hiddenPaths = new Set(Array.isArray(stored.hiddenPaths)
        ? stored.hiddenPaths.filter((path): path is string => typeof path === "string")
        : []);
      this.projects = stored.projects
        .filter((item): item is UiProject => {
          if (!item || typeof item !== "object") return false;
          const project = item as Partial<UiProject>;
          return typeof project.path === "string" && typeof project.lastOpenedAt === "number";
        })
        .map((project) => ({
          path: project.path,
          name: project.name || basename(project.path) || project.path,
          lastOpenedAt: project.lastOpenedAt,
        }))
        .slice(0, MAX_PROJECTS);
    } catch {
      this.projects = [];
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

  private persist(): Promise<void> {
    if (!this.dirty) return this.persistQueue;
    this.dirty = false;
    const contents = JSON.stringify({ projects: this.projects, hiddenPaths: [...this.hiddenPaths] }, null, 2);
    this.persistQueue = this.persistQueue.catch(() => undefined).then(async () => {
      await mkdir(dirname(this.filePath), { recursive: true });
      await writeFile(this.filePath, contents, "utf8");
    });
    return this.persistQueue;
  }
}
