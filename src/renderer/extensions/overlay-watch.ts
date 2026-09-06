/**
 * The preview view is a sibling of the whole renderer document, not a layer
 * inside it, so no z-index can put a modal in front of the page. The panel has
 * to hide the view instead, and this is the one place that knows when.
 *
 * Only surfaces that own the window belong here. A toast or a menu stays out:
 * it is expected to keep away from the panel's rectangle, not to blank it.
 */
const BLOCKING_SELECTOR = [
  ".modal-scrim",
  ".palette-backdrop",
  ".project-picker-scrim",
  ".project-modal-scrim",
  ".attachment-lightbox",
  ".reload-curtain",
  // Escape hatch for a surface that owns the window without wearing a scrim.
  "[data-preview-overlay]",
].join(",");

export function blockingOverlayPresent(root: ParentNode = document): boolean {
  return root.querySelector(BLOCKING_SELECTOR) !== null;
}

type Listener = (blocked: boolean) => void;

/**
 * Watches the document for overlays that must win over the preview view.
 * One observer for the whole window, started with the first subscriber and
 * stopped with the last; every subscriber is told the current answer at once,
 * so a panel that remounts under an open modal starts out hidden.
 */
export class OverlayWatch {
  private blocked = false;

  private listeners = new Set<Listener>();

  private observer?: MutationObserver;

  private frame?: number;

  constructor(private readonly root: () => ParentNode | undefined = () => globalThis.document) {}

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    if (this.listeners.size === 1) this.start();
    this.evaluate();
    listener(this.blocked);
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) this.stop();
    };
  }

  isBlocked(): boolean {
    return this.blocked;
  }

  /** Re-reads the DOM now and notifies if the answer changed. */
  evaluate(): boolean {
    const root = this.root();
    const blocked = root ? blockingOverlayPresent(root) : false;
    if (blocked === this.blocked) return blocked;
    this.blocked = blocked;
    this.listeners.forEach((listener) => listener(blocked));
    return blocked;
  }

  private start(): void {
    const body = (this.root() as Document | undefined)?.body;
    if (!body || typeof MutationObserver === "undefined") return;
    // A modal can mount anywhere — the checkpoint dialog lives inside a dock
    // panel, the lightbox portals to the body — so the subtree is the scope.
    // Class changes are not: every one of these surfaces mounts and unmounts.
    this.observer = new MutationObserver(() => this.schedule());
    this.observer.observe(body, { childList: true, subtree: true });
  }

  private stop(): void {
    this.observer?.disconnect();
    this.observer = undefined;
    if (this.frame !== undefined && typeof cancelAnimationFrame === "function") cancelAnimationFrame(this.frame);
    this.frame = undefined;
    this.blocked = false;
  }

  /** A streaming transcript mutates constantly; answer once per frame, not per batch. */
  private schedule(): void {
    if (this.frame !== undefined) return;
    if (typeof requestAnimationFrame !== "function") {
      this.evaluate();
      return;
    }
    this.frame = requestAnimationFrame(() => {
      this.frame = undefined;
      this.evaluate();
    });
  }
}

export const overlayWatch = new OverlayWatch();
