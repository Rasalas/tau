import type { WorkbenchActions } from "tau";
import type { Chip, ComposerContextChips, PromptToolsHostCommands, StashedChip, StashEntry } from "./protocol.js";

type Commands = PromptToolsHostCommands;
export type HostApi = <K extends keyof Commands>(command: K, input: Commands[K]["input"]) => Promise<Commands[K]["output"]>;

const NO_ENTRIES: readonly StashEntry[] = [];

/** A project's folder name, for a list that names where an entry was stashed. */
export function projectLabel(project: string | undefined): string {
  if (!project) return "another project";
  const parts = project.split(/[\\/]+/u).filter(Boolean);
  return parts.at(-1) ?? project;
}

/**
 * A file chip names a path inside its project. Brought back into another
 * project it would name a file there, so it comes back as text naming the
 * file where it was: the project's path joined with the file's.
 */
function fileFromProject(chip: StashedChip, project: string | undefined): string {
  const path = typeof chip.payload.path === "string" ? chip.payload.path : chip.label;
  return project ? `@${project.replace(/[\\/]+$/u, "")}/${path.replace(/^[\\/]+/u, "")}` : `@${path} (in ${projectLabel(project)})`;
}

/** A chip as text, for a composer without Composer Context to hold it. */
export function chipAsText(chip: StashedChip): string {
  const payload = chip.payload;
  const field = (key: string) => typeof payload[key] === "string" ? payload[key] as string : "";
  switch (chip.kind) {
    case "text-excerpt": return `From ${field("source") || chip.label}:\n${field("text").split("\n").map((line) => line ? `> ${line}` : ">").join("\n")}`;
    case "file": return `@${field("path")}`;
    case "pull-request": return field("url") || chip.label;
    case "attachment": return field("path") || chip.label;
  }
}

/**
 * The stash as the desktop half sees it: each project's entries, fetched on
 * demand and refetched when the host says they changed, and the three verbs.
 */
export class StashController {
  private readonly entries = new Map<string, readonly StashEntry[]>();
  /** Other projects' entries, as last read for the project on screen. */
  private others: { project: string; entries: readonly StashEntry[] } | undefined;
  private readonly listeners = new Set<() => void>();
  chips: ComposerContextChips | undefined;

  constructor(private readonly host: HostApi) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  list(project: string | undefined): readonly StashEntry[] {
    return (project && this.entries.get(project)) || NO_ENTRIES;
  }

  async refresh(project: string): Promise<void> {
    this.entries.set(project, await this.host("stash-list", { project }));
    this.changed();
  }

  /** The entries of every other project's stash on this machine, newest first. */
  listOthers(project: string | undefined): readonly StashEntry[] {
    return project && this.others?.project === project ? this.others.entries : NO_ENTRIES;
  }

  async refreshOthers(project: string): Promise<void> {
    this.others = { project, entries: await this.host("stash-list-others", { project }) };
    this.changed();
  }

  /** After a change the host reported: the project's own list, and the others' once they were read. */
  async changedOn(project: string): Promise<void> {
    const current = this.others?.project;
    await Promise.all([
      project ? this.refresh(project) : undefined,
      current && current !== project ? this.refreshOthers(current) : undefined,
    ]);
  }

  /** Whether the composer on screen holds anything a stash would keep. */
  hasDraft(actions: WorkbenchActions): boolean {
    return Boolean(actions.composerDraft().trim() || this.chips?.chips().length || actions.composerImages?.().length);
  }

  /** Puts the draft on screen away and empties the composer; `false` when there was nothing to keep. */
  async stash(actions: WorkbenchActions): Promise<boolean> {
    const project = actions.activeThread()?.cwd;
    if (!project) throw new Error("Open a project to stash a prompt.");
    const chips: readonly Chip[] = this.chips?.chips() ?? [];
    if (chips.some((chip) => chip.kind === "attachment" && !chip.payload.path)) throw new Error("An attachment is still being stored; stash once it is.");
    const text = actions.composerDraft();
    const images = actions.composerImages?.() ?? [];
    if (!text.trim() && chips.length === 0 && images.length === 0) return false;
    await this.host("stash-add", {
      project,
      text,
      chips: chips.map(({ kind, label, payload }) => ({ kind, label, payload })),
      images: images.map(({ name, mimeType, size, data }) => ({ kind: "image", name, mimeType, size, data })),
    });
    actions.setComposerDraft?.("");
    for (const chip of chips) this.chips?.removeChip(chip.id);
    if (images.length > 0) actions.setComposerImages?.([]);
    await this.refresh(project);
    return true;
  }

  /**
   * Brings an entry back into the composer, stashing what was there first.
   * `from` is another project's entry: its text, images and attachments come
   * along, and a file it named comes back as that file's path in its project.
   * Images carry their bytes and attachments sit on this device's machine, so
   * sending them to a thread on another machine copies them as any draft's do.
   */
  async restore(actions: WorkbenchActions, id: string, from?: StashEntry): Promise<void> {
    const project = actions.activeThread()?.cwd;
    if (!project) return;
    const elsewhere = from !== undefined && from.project !== project;
    if (this.hasDraft(actions)) await this.stash(actions);
    const entry = elsewhere
      ? await this.host("stash-take", from.project ? { project: from.project, id } : { id, anyProject: true })
      : await this.host("stash-take", { project, id });
    await Promise.all([this.refresh(project), elsewhere ? this.refreshOthers(project) : undefined]);
    if (!entry) throw new Error("That stashed prompt is no longer there.");
    const source = entry.project ?? from?.project;
    const loose: string[] = [];
    let moved = 0;
    for (const chip of entry.chips) {
      if (elsewhere && chip.kind === "file") { loose.push(fileFromProject(chip, source)); moved += 1; continue; }
      try {
        if (!this.chips) throw new Error("no chip service");
        this.chips.addChip({ kind: chip.kind, label: chip.label, payload: chip.payload });
      } catch {
        loose.push(chipAsText(chip));
      }
    }
    actions.setComposerDraft?.([...loose, entry.text].filter((part) => part.trim()).join("\n\n"));
    const images = entry.images.flatMap((image) => image.data === undefined ? [] : [{ ...image, data: image.data }]);
    if (images.length > 0) actions.setComposerImages?.(images);
    if (moved > 0) actions.notify(`${moved === 1 ? "A file" : `${moved} files`} from ${projectLabel(source)} came back as ${moved === 1 ? "its path" : "their paths"} there.`);
    actions.focusComposer();
  }

  async drop(project: string, id: string): Promise<void> {
    await this.host("stash-drop", { project, id });
    await this.refresh(project);
  }

  /** Deletes another project's entry from the list of others. */
  async dropOther(project: string, entry: StashEntry): Promise<void> {
    await this.host("stash-drop", entry.project ? { project: entry.project, id: entry.id } : { id: entry.id, anyProject: true });
    await this.refreshOthers(project);
  }

  private changed(): void {
    for (const listener of [...this.listeners]) listener();
  }
}
