import { errorMessage, type UiFileContent, type UiFileStat, type UiFileWriteResult } from "tau";

/** What a document needs of the host: Files Kit's own commands, or a stand-in in tests. */
export interface DocumentPorts {
  read(relPath: string): Promise<UiFileContent>;
  stat(relPath: string): Promise<UiFileStat>;
  write(relPath: string, text: string, expectedMtimeMs?: number | null): Promise<UiFileWriteResult>;
}

/** The disk changed under an edit, or the file is gone; the user chooses which side wins. */
export interface DocumentConflict {
  deleted: boolean;
  mtimeMs?: number;
}

export interface DocumentState {
  status: "loading" | "ready" | "error";
  error?: string;
  /** What the host answered last: its kind, size, language and whether it was cut. */
  content?: UiFileContent;
  /** The editor's text. */
  text: string;
  /** The text the disk holds as far as this document knows. */
  savedText: string;
  dirty: boolean;
  saving: boolean;
  saveError?: string;
  conflict?: DocumentConflict;
  /** Text that was read whole; a cut file or a binary one is only shown. */
  editable: boolean;
}

const LOADING: DocumentState = { status: "loading", text: "", savedText: "", dirty: false, saving: false, editable: false };

/**
 * One open file: the buffer, what was last read from or written to disk, and
 * the rules between them. A save names the mtime it last saw, so a file the
 * agent rewrote meanwhile is refused rather than overwritten; a change on disk
 * reloads a clean buffer silently and turns a dirty one into a conflict the
 * user resolves — reload, or keep this version and save over the disk's.
 */
export class FileDocument {
  private state: DocumentState = LOADING;
  private readonly listeners = new Set<() => void>();
  /** The mtime of the disk's file as of `savedText`; `null` once it is known to be gone. */
  private mtimeMs: number | null | undefined;
  private pendingSave = false;
  /** The disk holds something other than `savedText`, and the user chose to keep the buffer anyway. */
  private diverged = false;
  private autosaveTimer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;

  constructor(
    readonly relPath: string,
    private readonly ports: DocumentPorts,
    private readonly options: { autosaveMs?: () => number | undefined } = {},
  ) {}

  getState = (): DocumentState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  private set(patch: Partial<DocumentState>): void {
    if (this.disposed) return;
    const next = { ...this.state, ...patch };
    next.dirty = next.editable && (next.text !== next.savedText || this.diverged);
    this.state = next;
    for (const listener of [...this.listeners]) listener();
  }

  async load(): Promise<void> {
    try {
      const content = await this.ports.read(this.relPath);
      this.adopt(content);
    } catch (error) {
      this.set({ status: "error", error: errorMessage(error) });
    }
  }

  private adopt(content: UiFileContent): void {
    this.mtimeMs = content.mtimeMs;
    this.diverged = false;
    const text = content.kind === "text" ? content.text ?? "" : "";
    this.set({
      status: "ready",
      error: undefined,
      content,
      text,
      savedText: text,
      editable: content.kind === "text" && !content.truncated,
      conflict: undefined,
      saveError: undefined,
    });
  }

  edit(text: string): void {
    if (!this.state.editable || text === this.state.text) return;
    this.set({ text, saveError: undefined });
    this.scheduleAutosave();
  }

  private scheduleAutosave(): void {
    const delay = this.options.autosaveMs?.();
    if (this.autosaveTimer) clearTimeout(this.autosaveTimer);
    this.autosaveTimer = undefined;
    if (delay === undefined || !this.state.dirty) return;
    this.autosaveTimer = setTimeout(() => {
      this.autosaveTimer = undefined;
      void this.save();
    }, delay);
  }

  /** Writes the buffer; true once the disk holds it. A conflict waits for the user. */
  async save(): Promise<boolean> {
    if (!this.state.editable || this.state.conflict) return !this.state.dirty;
    if (this.state.saving) { this.pendingSave = true; return false; }
    if (!this.state.dirty) return true;
    const text = this.state.text;
    this.set({ saving: true, saveError: undefined });
    let result: UiFileWriteResult;
    try {
      result = await this.ports.write(this.relPath, text, this.mtimeMs);
    } catch (error) {
      this.set({ saving: false, saveError: errorMessage(error) });
      return false;
    }
    if (result.status === "conflict") {
      this.set({ saving: false, conflict: conflictOf(result) });
      return false;
    }
    this.mtimeMs = result.mtimeMs;
    this.diverged = false;
    this.set({ saving: false, savedText: text, content: this.state.content ? { ...this.state.content, size: result.size, mtimeMs: result.mtimeMs } : undefined });
    if (this.pendingSave) {
      this.pendingSave = false;
      return this.save();
    }
    return !this.state.dirty;
  }

  /** Asks the disk whether the file moved on; the tab calls it while it is on screen. */
  async check(): Promise<void> {
    if (this.state.status !== "ready" || this.state.saving || this.state.conflict) return;
    let stat: UiFileStat;
    try { stat = await this.ports.stat(this.relPath); } catch { return; }
    if (this.state.saving || this.state.conflict) return;
    if (!stat.exists) {
      if (this.mtimeMs === null) return;
      this.set({ conflict: { deleted: true } });
      return;
    }
    if (stat.mtimeMs === this.mtimeMs) return;
    if (this.state.dirty) {
      this.set({ conflict: { deleted: false, ...(stat.mtimeMs !== undefined ? { mtimeMs: stat.mtimeMs } : {}) } });
      return;
    }
    await this.load();
  }

  /** Drops the buffer for what the disk holds now. */
  async reload(): Promise<void> {
    this.set({ status: "loading", conflict: undefined });
    await this.load();
  }

  /** Keeps this version: the next save writes over whatever the disk holds, or recreates the file. */
  keepMine(): void {
    const conflict = this.state.conflict;
    if (!conflict) return;
    this.mtimeMs = conflict.deleted ? null : conflict.mtimeMs;
    // The disk no longer holds what was saved, so the buffer is unsaved work either way.
    this.diverged = true;
    this.set({ conflict: undefined });
  }

  dispose(): void {
    if (this.autosaveTimer) clearTimeout(this.autosaveTimer);
    this.disposed = true;
    this.listeners.clear();
  }
}

function conflictOf(result: Extract<UiFileWriteResult, { status: "conflict" }>): DocumentConflict {
  return result.mtimeMs === undefined ? { deleted: true } : { deleted: false, mtimeMs: result.mtimeMs };
}
