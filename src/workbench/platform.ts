import type { ClientStorage } from "./client-storage";

/**
 * What the workbench needs from the machine it runs on, and nothing else.
 * Electron supplies one implementation (`src/renderer/platform-electron.ts`);
 * a browser or mobile client supplies its own. Every capability here is one a
 * client may lack: `files` is absent when the host's paths are not this
 * machine's, and `importModule` is how a client evaluates an extension bundle
 * under whatever policy its page has.
 */
export interface Platform {
  /** The user's clipboard, not the host's: on a remote host these are different machines. */
  clipboard: {
    writeText(text: string): Promise<void>;
    /** Absent where the client cannot put an image on the clipboard. */
    writeImage?(dataUrl: string): Promise<void>;
  };
  /** Opens a URL outside the workbench; the workbench itself never navigates. */
  openExternal(url: string): void;
  /** Present only where the host's files are this machine's files. */
  files?: {
    openInEditor(path: string): void;
  };
  storage: ClientStorage;
  /** Evaluates a module URL. A page with a strict CSP decides here what it will run. */
  importModule(url: string): Promise<unknown>;
}
