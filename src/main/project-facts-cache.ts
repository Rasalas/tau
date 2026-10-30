import { basename } from "node:path";
import { performance } from "node:perf_hooks";
import { HostProjectFactsSet, type HostProjectFacts } from "./host-extensions.js";

const LISTED_LABEL_MAX_AGE_MS = 3 * 60_000;

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
  private readonly labelAskedAt = new Map<string, number>();
  /** Which known project paths are nested in another project. Unclassified paths stay absent. */
  private readonly nesting = new Map<string, boolean>();
  private readonly privateWorkspaces = new Map<string, boolean>();
  private readonly classifications = new Map<string, Promise<void>>();
  /** The project a folder's settings follow; a folder that is its own is asked again after a minute. */
  private readonly owners = new Map<string, { path: string; until: number }>();

  constructor(private readonly port: ProjectFactsCachePort) {}

  /** Registers a provider; the returned function removes it again. Paths nobody named so far are asked again. */
  add(facts: HostProjectFacts): () => void {
    const remove = this.providers.add(facts);
    const asked = [...this.unnamed];
    this.unnamed.clear();
    if (facts.label) this.labelAskedAt.clear();
    for (const cwd of asked) this.refreshName(cwd);
    // Paths listed before the Workspace Kit loaded were read as roots; a worktree among them must leave the list.
    if (facts.nested || facts.projectless) {
      for (const cwd of new Set([...this.nesting.keys(), ...this.classifications.keys()])) this.classify(cwd, true);
    }
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

  async projectless(cwd: string): Promise<boolean> {
    const value = await this.providers.projectless(cwd);
    this.privateWorkspaces.set(cwd, value);
    return value;
  }

  knownProjectless(cwd: string): boolean { return this.privateWorkspaces.get(cwd) === true; }

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

  /** A provider changed durable project metadata, without changing the workspace. */
  async refresh(cwd: string): Promise<void> {
    await Promise.allSettled([this.nameLoads.get(cwd), this.classifications.get(cwd), this.labelRefreshes.get(cwd)]);
    const previousName = this.names.get(cwd);
    this.names.delete(cwd);
    this.unnamed.delete(cwd);
    this.nesting.delete(cwd);
    this.privateWorkspaces.delete(cwd);
    this.owners.delete(cwd);
    this.labelAskedAt.delete(cwd);
    const name = await this.loadName(cwd);
    if (name !== previousName) this.port.onName(cwd, name);
    this.classify(cwd);
    await this.classifications.get(cwd);
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

  /**
   * The label of a project a thread list names, asked of its provider at most
   * every few minutes: a scan names every project on each pass, and each answer
   * may cost a git call. The open thread's project reads `label`.
   */
  listedLabel(cwd: string): string | undefined {
    if (Date.now() - (this.labelAskedAt.get(cwd) ?? Number.NEGATIVE_INFINITY) >= LISTED_LABEL_MAX_AGE_MS) this.refreshLabel(cwd);
    return this.labels.get(cwd);
  }

  private refreshLabel(cwd: string): void {
    if (this.labelRefreshes.has(cwd)) return;
    this.labelAskedAt.set(cwd, Date.now());
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

  /** Whether `cwd` sits inside another project, waiting for its classification when none is known yet. */
  async nested(cwd: string): Promise<boolean> {
    if (!this.nesting.has(cwd)) {
      this.classify(cwd);
      await this.classifications.get(cwd);
    }
    return this.nesting.get(cwd) === true;
  }

  /** The project whose settings `cwd` follows: the one a linked worktree was made from, else `cwd` itself. */
  async owner(cwd: string): Promise<string> {
    const known = this.owners.get(cwd);
    if (known && known.until > Date.now()) return known.path;
    const root = await this.providers.root(cwd).catch(() => undefined);
    this.owners.set(cwd, { path: root ?? cwd, until: root ? Number.POSITIVE_INFINITY : Date.now() + 60_000 });
    return root ?? cwd;
  }

  /** `again` asks once more after any classification in flight, which may predate a provider. */
  classify(cwd: string, again = false): void {
    const running = this.classifications.get(cwd);
    if (running && !again) return;
    const startedAt = performance.now();
    const pending: Promise<void> = (running ?? Promise.resolve()).then(() => Promise.all([this.providers.nested(cwd), this.projectless(cwd)])).then(([nested]) => {
      if (this.nesting.get(cwd) === nested) return;
      this.nesting.set(cwd, nested);
      this.port.onNesting(cwd);
    }).catch((error: unknown) => {
      // A path no provider can classify is simply a root.
      this.port.log("project-classification.failed", `${basename(cwd)}: ${this.port.errorMessage(error)}`);
      if (this.nesting.has(cwd)) return;
      this.nesting.set(cwd, false);
      this.port.onNesting(cwd);
    }).finally(() => {
      this.port.recordBackground("project-classification", startedAt);
      if (this.classifications.get(cwd) === pending) this.classifications.delete(cwd);
    });
    this.classifications.set(cwd, pending);
  }

  /** Waits for the classifications in flight; bootstrap is the one publication nobody can miss. */
  async settleClassifications(): Promise<void> {
    await Promise.allSettled([...this.classifications.values()]);
  }
}
