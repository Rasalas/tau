import { FileDocument } from "./document.js";
import type { FilesHost } from "./protocol.js";

/**
 * The files open in editor tabs, by project and path: two projects may both
 * have `src/index.ts`. A tab is drawn only while it is the active one, so its
 * buffer lives here, not in the component: switching tabs or projects keeps
 * unsaved work, closing the tab drops it.
 */
export class DocumentRegistry {
  private readonly documents = new Map<string, FileDocument>();

  constructor(private readonly host: FilesHost, private readonly autosaveMs: () => number | undefined) {}

  /** `workspace` is fixed for the document's life: it reads from and saves to that project only. */
  open(workspace: string, relPath: string): FileDocument {
    const key = documentKey(workspace, relPath);
    const existing = this.documents.get(key);
    if (existing) return existing;
    const host = this.host;
    const document = new FileDocument(relPath, {
      read: (path) => host.read(workspace, path),
      stat: (path) => host.stat(workspace, path),
      write: (path, text, expectedMtimeMs) => host.write(workspace, path, text, expectedMtimeMs),
    }, { autosaveMs: this.autosaveMs, workspace });
    this.documents.set(key, document);
    void document.load();
    return document;
  }

  get(workspace: string, relPath: string): FileDocument | undefined {
    return this.documents.get(documentKey(workspace, relPath));
  }

  close(document: FileDocument): void {
    const key = documentKey(document.workspace ?? "", document.relPath);
    if (this.documents.get(key) !== document) return;
    document.dispose();
    this.documents.delete(key);
  }

  clear(): void {
    for (const document of this.documents.values()) document.dispose();
    this.documents.clear();
  }

  /** Asks every open file whether the disk moved on, e.g. after the agent wrote. */
  checkAll(): Promise<void> {
    return Promise.all([...this.documents.values()].map((document) => document.check())).then(() => undefined);
  }
}

function documentKey(workspace: string, relPath: string): string {
  return `${workspace}\u0000${relPath}`;
}
