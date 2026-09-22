import { FileDocument, type DocumentPorts } from "./document.js";

/**
 * The files open in editor tabs, by their path in the workspace. A tab is drawn
 * only while it is the active one, so its buffer lives here, not in the
 * component: switching tabs keeps unsaved work, closing the tab drops it.
 */
export class DocumentRegistry {
  private readonly documents = new Map<string, FileDocument>();

  constructor(private readonly ports: DocumentPorts, private readonly autosaveMs: () => number | undefined) {}

  open(relPath: string): FileDocument {
    const existing = this.documents.get(relPath);
    if (existing) return existing;
    const document = new FileDocument(relPath, this.ports, { autosaveMs: this.autosaveMs });
    this.documents.set(relPath, document);
    void document.load();
    return document;
  }

  get(relPath: string): FileDocument | undefined {
    return this.documents.get(relPath);
  }

  close(relPath: string): void {
    this.documents.get(relPath)?.dispose();
    this.documents.delete(relPath);
  }

  /** Another project opened: its paths name other files. */
  clear(): void {
    for (const document of this.documents.values()) document.dispose();
    this.documents.clear();
  }

  /** Asks every open file whether the disk moved on, e.g. after the agent wrote. */
  checkAll(): Promise<void> {
    return Promise.all([...this.documents.values()].map((document) => document.check())).then(() => undefined);
  }
}
