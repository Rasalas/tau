import type { WorkbenchActions } from "tau";
import type { Chip, ComposerContextChips, PromptToolsHostCommands, StashedChip, StashEntry } from "./protocol.js";

type Commands = PromptToolsHostCommands;
export type HostApi = <K extends keyof Commands>(command: K, input: Commands[K]["input"]) => Promise<Commands[K]["output"]>;

const NO_ENTRIES: readonly StashEntry[] = [];

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
  private readonly listeners = new Set<() => void>();
  /** Set by the palette command; the control opens its list and clears it. */
  listRequested = false;
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

  requestList(): void {
    this.listRequested = true;
    this.changed();
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

  /** Brings an entry back into the composer, stashing what was there first. */
  async restore(actions: WorkbenchActions, id: string): Promise<void> {
    const project = actions.activeThread()?.cwd;
    if (!project) return;
    if (this.hasDraft(actions)) await this.stash(actions);
    const entry = await this.host("stash-take", { project, id });
    await this.refresh(project);
    if (!entry) throw new Error("That stashed prompt is no longer there.");
    const loose: string[] = [];
    for (const chip of entry.chips) {
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
    actions.focusComposer();
  }

  async drop(project: string, id: string): Promise<void> {
    await this.host("stash-drop", { project, id });
    await this.refresh(project);
  }

  private changed(): void {
    for (const listener of [...this.listeners]) listener();
  }
}
