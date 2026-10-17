import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { frameResponsePolicy, prepareFrameDocument } from "tau/host-extension";
import { createHeadlessPreviewSurface, HEADLESS_DOCUMENT_URL, previewBrowserCommand } from "../preview/headless-surface.js";
import type { PreviewSurface } from "../preview/host.js";
import { PageError, preparePageDocument } from "./document.js";
import { preparePage, type ShowInput } from "./show.js";

export interface PagePreviewInput extends ShowInput { width?: unknown; colorScheme?: unknown }
export interface PagePreview {
  base64: string;
  width: number;
  height: number;
  consoleErrors: string[];
  notes: string[];
}

interface PreviewServices {
  stateDir: string;
  findCommand(name: string): string | undefined;
  noteSubprocess(): void;
}

/** One browser at a time, always with a fresh profile, including across threads. */
export class PagePreviewer {
  private readonly stopping = new AbortController();
  private pending: Promise<unknown> = Promise.resolve();

  constructor(private readonly services: PreviewServices, private readonly createSurface = createHeadlessPreviewSurface) {}

  render(thread: { cwd: string }, input: PagePreviewInput, caller?: AbortSignal): Promise<PagePreview> {
    const signal = AbortSignal.any([this.stopping.signal, ...(caller ? [caller] : [])]);
    const work = this.pending.then(() => this.capture(thread, input, signal));
    this.pending = work.catch(() => undefined);
    return work;
  }

  async dispose(): Promise<void> {
    this.stopping.abort();
    await this.pending;
  }

  private async capture(thread: { cwd: string }, input: PagePreviewInput, caller: AbortSignal): Promise<PagePreview> {
    const signal = AbortSignal.any([caller, AbortSignal.timeout(30_000)]);
    signal.throwIfAborted();
    const page = await preparePage(thread, input);
    const executable = previewBrowserCommand((name) => this.services.findCommand(name));
    if (!executable) throw new PageError("HTML preview needs Chrome or Chromium installed on this machine, or TAU_PREVIEW_BROWSER pointing to it.");
    await mkdir(this.services.stateDir, { recursive: true, mode: 0o700 });
    const directory = await mkdtemp(join(this.services.stateDir, "html-preview-"));
    let surface: PreviewSurface | undefined;
    const abort = () => { void Promise.resolve(surface?.destroy()).catch(() => undefined); };
    signal.addEventListener("abort", abort, { once: true });
    try {
      signal.throwIfAborted();
      const colorScheme = input.colorScheme === "dark" ? "dark" : "light";
      const csp = { resourceDomains: page.origins };
      this.services.noteSubprocess();
      surface = await this.createSurface({
        partition: "persist:tau-preview", workspaceRoot: () => "", onChange: () => undefined, log: () => undefined,
      }, executable, directory, {
        html: prepareFrameDocument(preparePageDocument(page.html, {}), { csp, colorScheme }),
        contentSecurityPolicy: frameResponsePolicy(csp),
      });
      signal.throwIfAborted();
      const width = typeof input.width === "number" && Number.isFinite(input.width) ? Math.round(Math.max(240, Math.min(1600, input.width))) : 1000;
      surface.place({ x: 0, y: 0, width, height: page.maxHeight }, false);
      await surface.setAppearance(colorScheme);
      await surface.load(HEADLESS_DOCUMENT_URL, 15_000);
      signal.throwIfAborted();
      // Two painted frames let synchronous charts and their layout settle.
      // The isolated world keeps page scripts from replacing these APIs.
      const url = await surface.evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(location.href))))", true);
      if (typeof url !== "string" || url.split("#")[0] !== HEADLESS_DOCUMENT_URL) throw new PageError("The HTML page navigated away before it could be checked.");
      signal.throwIfAborted();
      const image = await surface.capture(width);
      signal.throwIfAborted();
      return { ...image, consoleErrors: surface.state().consoleErrors.slice(-20).map((line) => line.slice(0, 2000)), notes: page.notes };
    } catch (error) {
      if (error instanceof PageError) throw error;
      throw new PageError(signal.aborted ? "HTML preview was stopped or exceeded 30 seconds." : `HTML preview failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      signal.removeEventListener("abort", abort);
      await surface?.destroy();
      await rm(directory, { recursive: true, force: true });
    }
  }
}
