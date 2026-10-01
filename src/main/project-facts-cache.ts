import { basename } from "node:path";
import { performance } from "node:perf_hooks";
import { HostProjectFactsSet, type HostProjectFacts } from "./host-extensions.js";

export interface ProjectFactsCachePort {
  /** A label the providers answered with, once it differs from the last one. */
  onLabel(cwd: string, label: string | undefined): void;
  /** A name was read in the background and differs from the folder name; what shows it has to be published again. */
  onName(cwd: string, name: string): void;
  /** A path was classified as nested or root; what listed it has to be published again. */
  onNesting(cwd: string): void;
  recordBackground(name: string, startedAt: number): void;
  log(label: string, detail?: string): void;
  errorMessage(error: unknown): string;
}

/**
 * What extensions know about a project — its name, its label and whether it sits
 * inside another project — cached so no interactive path ever awaits a provider.
 * Every answer is fetched in the background and published when it changes.
 */
export class ProjectFactsCache {
  private readonly providers = new HostProjectFactsSet();
  /** A linked worktree keeps the repository's project name instead of becoming a new project. */
  private readonly names = new Map<string, string>();
  /** Last known label per project; the provider is never awaited on an interactive path. */
  private readonly nameLoads = new Map<string, Promise<void>>();
  /** Paths no provider named; asked again only once a provider is added. */
  private readonly unnamed = new Set<string>();
  private readonly labels = new Map<string, string | undefined>();
  private readonly labelRefreshes = new Map<string, Promise<void>>();
  /** Which known project paths are nested in another project. Unclassified paths stay absent. */
  private readonly nesting = new Map<string, boolean>();
  private readonly classifications = new Map<string, Promise<void>>();

  constructor(private readonly port: ProjectFactsCachePort) {}

  /** Registers a provider; the returned function removes it again. Paths nobody named so far are asked again. */
  add(facts: HostProjectFacts): () => void {
    const remove = this.providers.add(facts);
    const asked = [...this.unnamed];
    this.unnamed.clear();
    for (const cwd of asked) this.refreshName(cwd);
    return remove;
  }

  /** The folder name until a provider answers; an unknown path is read in the background and published when it differs. */
  name(cwd: string): string {
    const known = this.names.get(cwd);
    if (known) return known;
    if (!this.unnamed.has(cwd)) this.refreshName(cwd);
    return basename(cwd) || cwd;
  }

  private refreshName(cwd: string): void {
    if (this.nameLoads.has(cwd)) return;
    const pending = this.providers.name(cwd).then((name) => {
      if (!name) { this.unnamed.add(cwd); return; }
      this.names.set(cwd, name);
      if (name !== (basename(cwd) || cwd)) this.port.onName(cwd, name);
    }).catch((error) => {
      this.unnamed.add(cwd);
      this.port.log("project-name.failed", `${basename(cwd)}: ${this.port.errorMessage(error)}`);
    }).finally(() => { this.nameLoads.delete(cwd); });
    this.nameLoads.set(cwd, pending);
  }

  async loadName(cwd: string): Promise<string> {
    const known = this.names.get(cwd);
    if (known) return known;
    const name = await this.providers.name(cwd).catch(() => undefined) ?? (basename(cwd) || cwd);
    this.names.set(cwd, name);
    return name;
  }

  rememberName(cwd: string, name: string): void {
    this.names.set(cwd, name);
  }

  knownLabel(cwd: string): string | undefined {
    return this.labels.get(cwd);
  }

  /**
   * The label a project carries, as last seen. A refresh always runs in the
   * background and publishes when the answer changes, so opening or switching a
   * thread never waits on the provider — a busy repository used to hold
   * switches for seconds behind its own status scan.
   */
  label(cwd: string): string | undefined {
    this.refreshLabel(cwd);
    return this.labels.get(cwd);
  }

  private refreshLabel(cwd: string): void {
    if (this.labelRefreshes.has(cwd)) return;
    const startedAt = performance.now();
    const pending = this.providers.label(cwd).then((label) => {
      const known = this.labels.has(cwd);
      const previous = this.labels.get(cwd);
      this.labels.set(cwd, label);
      if (!known || previous !== label) this.port.onLabel(cwd, label);
    }).catch((error) => this.port.log("project-label.failed", `${basename(cwd)}: ${this.port.errorMessage(error)}`)).finally(() => {
      this.port.recordBackground("project-label", startedAt);
      this.labelRefreshes.delete(cwd);
    });
    this.labelRefreshes.set(cwd, pending);
  }

  /**
   * A project nested in another (Workspace Kit: a linked worktree) is not a
   * root of its own; the workspace bar moves inside the parent instead. The
   * provider is never awaited here; an unclassified path is withheld until its
   * background answer arrives.
   */
  isRoot(cwd: string): boolean {
    const nested = this.nesting.get(cwd);
    if (nested === undefined) {
      this.classify(cwd);
      return false;
    }
    return !nested;
  }

  classify(cwd: string): void {
    if (this.classifications.has(cwd)) return;
    const startedAt = performance.now();
    const pending = this.providers.nested(cwd).then((nested) => {
      if (this.nesting.get(cwd) === nested) return;
      this.nesting.set(cwd, nested);
      this.port.onNesting(cwd);
    }).catch(() => {
      // A path no provider can classify is simply a root.
      if (this.nesting.has(cwd)) return;
      this.nesting.set(cwd, false);
      this.port.onNesting(cwd);
    }).finally(() => {
      this.port.recordBackground("project-classification", startedAt);
      this.classifications.delete(cwd);
    });
    this.classifications.set(cwd, pending);
  }

  /** Waits for the classifications in flight; bootstrap is the one publication nobody can miss. */
  async settleClassifications(): Promise<void> {
    await Promise.allSettled([...this.classifications.values()]);
  }
}
