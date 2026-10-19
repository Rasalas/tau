import { useEffect, useSyncExternalStore, type ReactNode } from "react";
import { AlertCircle, FileText, GitPullRequest, MessageSquare, Paperclip, Quote, X } from "lucide-react";
import { THREAD_PULL_REQUESTS_SERVICE, type ThreadPullRequestsService } from "tau";
import type {
  ComposerChipDetailProps,
  ComposerInlineChip,
  ComposerInlineContext,
  ComposerInlineProps,
  ComposerSendContribution,
  ComposerTriggerItem,
  DesktopExtension,
  HostExtensionClient,
  UiPromptFileAttachment,
} from "tau";
import { SentExcerptChip } from "./sent-excerpt.js";
import { readPullRequestDrop } from "./pull-request-drop.js";
import { readThreadDrop } from "./thread-drop.js";
import { ChipStore, formatBytes, isVideo, requestNumberOf, selectFiles, serializeChips, shouldFoldPaste, type ChipEntry } from "./chips.js";
import {
  COMPOSER_CONTEXT_CHIPS_SERVICE,
  COMPOSER_CONTEXT_ID,
  EXCERPT_TAG,
  PULL_REQUEST_DRAG_TYPE,
  THREAD_DRAG_TYPE,
  WORKSPACE_STORE_SERVICE,
  type Chip,
  type ChipInput,
  type ComposerContextChips,
  type ComposerContextHostCommands,
  type DescribedAttachment,
  type PullRequestSummary,
  type ReadFileResult,
  type ThreadSnapshot,
  UPLOAD_CHUNK_BYTES,
} from "./protocol.js";

type Commands = ComposerContextHostCommands;
type HostApi = <K extends keyof Commands>(command: K, input: Commands[K]["input"]) => Promise<Commands[K]["output"]>;

const hostApi = (host: HostExtensionClient): HostApi => (command, input) => host.invoke(command, input) as never;

function base64OfBytes(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(binary);
}

function readBytes(blob: Blob, name: string): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`${name} could not be read.`));
    reader.onload = () => {
      if (reader.result instanceof ArrayBuffer) resolve(new Uint8Array(reader.result));
      else reject(new Error(`${name} could not be read.`));
    };
    reader.readAsArrayBuffer(blob);
  });
}

/** Sends a file's bytes in chunks, the first creating it on the host; answers with where it landed. */
export async function storeInChunks(
  host: HostApi,
  target: { scope: string; name: string; mimeType: string; size: number },
  read: (start: number, end: number) => Promise<Uint8Array>,
): Promise<{ path: string; size: number }> {
  const chunk = async (start: number, into?: string) => host("store-attachment", {
    scope: target.scope,
    name: target.name,
    mimeType: target.mimeType,
    data: base64OfBytes(await read(start, Math.min(start + UPLOAD_CHUNK_BYTES, target.size))),
    ...(into ? { into } : {}),
  });
  let stored = await chunk(0);
  for (let start = UPLOAD_CHUNK_BYTES; start < target.size; start += UPLOAD_CHUNK_BYTES) stored = await chunk(start, stored.path);
  return stored;
}

/** A request the transport lost rather than one the host refused. */
export const TRANSIENT_UPLOAD_ERROR = /connection dropped|connection was closed|timed out|not available/iu;
const UPLOAD_RETRY_DELAYS_MS = [1_000, 3_000, 8_000];

/** Uploads again, from the start, when the connection to the host dropped on the way: after a reconnect it goes through. */
export async function storeWithRetry(
  host: HostApi,
  target: { scope: string; name: string; mimeType: string; size: number },
  read: (start: number, end: number) => Promise<Uint8Array>,
  wait: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<{ path: string; size: number }> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await storeInChunks(host, target, read);
    } catch (error) {
      const delay = UPLOAD_RETRY_DELAYS_MS[attempt];
      if (delay === undefined || !TRANSIENT_UPLOAD_ERROR.test(error instanceof Error ? error.message : String(error))) throw error;
      await wait(delay);
    }
  }
}

/** `src/a.ts:10-20` into a path and its lines. */
export function parseFileQuery(query: string): { path: string; startLine?: number; endLine?: number } {
  const match = /^(.*?):(\d+)(?:-(\d+))?$/u.exec(query);
  if (!match) return { path: query };
  const startLine = Number(match[2]);
  const endLine = match[3] ? Number(match[3]) : undefined;
  return { path: match[1]!, startLine, ...(endLine !== undefined && endLine >= startLine ? { endLine } : {}) };
}

const ICONS = { "file": FileText, "text-excerpt": Quote, "pull-request": GitPullRequest, "thread": MessageSquare, "attachment": Paperclip } as const;

function chipTitle(chip: ChipEntry): string {
  switch (chip.kind) {
    case "file": return chip.payload.path;
    case "text-excerpt": return chip.payload.text.slice(0, 400);
    case "pull-request": return `${chip.payload.title}\n${chip.payload.url}`;
    case "thread": return `${chip.payload.title}\nIts latest turns go with the message.`;
    case "attachment": return `${chip.payload.name} · ${formatBytes(chip.payload.size)}`;
  }
}

/** The chip core draws in the text for one of the store's chips. */
export function inlineChip(chip: ChipEntry, Detail?: ComposerInlineChip["Detail"]): ComposerInlineChip {
  return {
    id: chip.id,
    label: chip.label,
    icon: chip.error ? AlertCircle : ICONS[chip.kind],
    // An excerpt's popover shows it in full; a title would say it twice.
    ...(chip.error || chip.kind !== "text-excerpt" ? { title: chip.error ?? chipTitle(chip) } : {}),
    ...(chip.uploading ? { state: "busy" as const } : chip.error ? { state: "failed" as const } : {}),
    ...(chip.kind === "text-excerpt" && Detail ? { Detail } : {}),
  };
}

/** An excerpt in full, and the user's own words about it, sent right below the quote. */
export function ExcerptDetail({ store, scope, chipId, close }: { store: ChipStore } & ComposerChipDetailProps) {
  const chip = useSyncExternalStore(store.subscribe, () => store.list(scope).find((entry) => entry.id === chipId));
  if (chip?.kind !== "text-excerpt") return null;
  const setComment = (comment: string) => store.update(scope, chip.id, { payload: { ...chip.payload, comment } });
  return (
    <div className="composer-context-excerpt">
      <small>{chip.payload.source}</small>
      <pre>{chip.payload.text}</pre>
      <textarea
        aria-label="Comment on this excerpt"
        placeholder="Add a comment for the agent…"
        rows={3}
        autoFocus
        value={chip.payload.comment ?? ""}
        onChange={(event) => setComment(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); close(); }
        }}
      />
    </div>
  );
}

/**
 * Core draws the chips in the text; the strip keeps the draft's chips loaded,
 * marks the composer on screen for the service, and shows what failed.
 */
export function ChipStrip({ store, scope, draftState, inline = false }: { store: ChipStore; inline?: boolean } & Pick<ComposerInlineProps, "scope" | "draftState">) {
  const chips = useSyncExternalStore(store.subscribe, () => store.list(scope));
  const error = useSyncExternalStore(store.subscribe, () => store.error(scope));
  useEffect(() => {
    store.hydrate(scope, draftState.read(), draftState.write);
    store.activeScope = scope;
    return () => { if (store.activeScope === scope) store.activeScope = undefined; };
  }, [draftState, scope, store]);
  const shown = inline ? [] : chips;
  if (shown.length === 0 && !error) return null;
  return (
    <div className="composer-context" aria-label="Context">
      {shown.map((chip) => {
        const Icon = chip.error ? AlertCircle : ICONS[chip.kind];
        const custom = chip.render?.(chip) as ReactNode | undefined;
        return (
          <span
            key={chip.id}
            className={`composer-context-chip ${chip.kind}${chip.uploading ? " uploading" : ""}${chip.error ? " failed" : ""}`}
            title={chip.error ?? chipTitle(chip)}
          >
            <Icon size={12} aria-hidden="true" />
            <span className="composer-context-label">{custom ?? chip.label}</span>
            <button type="button" aria-label={`Remove ${chip.label}`} onClick={() => store.remove(scope, chip.id)}>
              <X size={11} />
            </button>
          </span>
        );
      })}
      {error ? (
        <span className="composer-context-error" role="alert">
          {error}
          <button type="button" aria-label="Dismiss" onClick={() => store.setError(scope, undefined)}><X size={11} /></button>
        </span>
      ) : null}
    </div>
  );
}

/** What the kit contributes to a prompt; exported for its tests. */
export async function prepareSend(
  store: ChipStore,
  host: HostApi,
  cwd: string | undefined,
  context: ComposerInlineContext,
  /** Starts a failed upload again; false when the chip cannot be retried. */
  retry: (chipId: string) => boolean = () => false,
): Promise<ComposerSendContribution | undefined> {
  const chips = store.beginSend(context.scope);
  if (chips.length === 0) return undefined;
  await Promise.all(chips.map((chip) => chip.uploading));
  // An upload that finished while the prompt waited updated the chip; read it again.
  const latest = () => chips.map((chip) => store.sendingChip(context.scope, chip.id) ?? chip);
  // A failed upload gets one more try on send before the prompt is refused.
  const retried = latest().filter((chip) => chip.error && retry(chip.id));
  if (retried.length > 0) await Promise.all(retried.map((chip) => store.sendingChip(context.scope, chip.id)?.uploading));
  const current = latest();
  const failed = current.find((chip) => chip.error || (chip.kind === "attachment" && !chip.payload.path));
  if (failed) throw new Error(`${failed.label} could not be attached. Remove it and try again.`);

  const files = current.filter((chip): chip is Extract<ChipEntry, { kind: "file" }> => chip.kind === "file");
  const fileResults = new Map<string, ReadFileResult>();
  if (files.length > 0) {
    if (!cwd) throw new Error("No project is open to read the files from.");
    const read = await host("read-files", { cwd, files: files.map((chip) => chip.payload) });
    files.forEach((chip, index) => { if (read[index]) fileResults.set(chip.id, read[index]!); });
  }
  const attachments = current.filter((chip): chip is Extract<ChipEntry, { kind: "attachment" }> => chip.kind === "attachment");
  const described = new Map<string, DescribedAttachment>();
  if (attachments.length > 0 && !context.fileAttachments) {
    const answers = await host("describe-attachments", { paths: attachments.map((chip) => chip.payload.path!) });
    attachments.forEach((chip, index) => { if (answers[index]) described.set(chip.id, answers[index]!); });
  }
  const threadChips = current.filter((chip): chip is Extract<ChipEntry, { kind: "thread" }> => chip.kind === "thread");
  const threads = new Map<string, ThreadSnapshot>();
  // A snapshot fails loudly: sending without it would drop context the user asked for.
  await Promise.all(threadChips.map(async (chip) => {
    try { threads.set(chip.id, await host("snapshot-thread", { scope: context.scope, threadId: chip.payload.threadId, title: chip.payload.title })); }
    catch (error) { throw new Error(`${chip.label} could not be attached: ${error instanceof Error ? error.message : String(error)}`, { cause: error }); }
  }));
  const prefix = serializeChips({ chips: current, files: fileResults, attachments: described, threads, fileAttachments: context.fileAttachments });
  // A video goes as a path whatever the runtime: no runtime takes video input.
  const fileParts: UiPromptFileAttachment[] = context.fileAttachments
    ? [
      ...attachments.filter((chip) => !isVideo(chip.payload.mimeType)).map((chip) => ({ kind: "file" as const, name: chip.payload.name, mimeType: chip.payload.mimeType || "application/octet-stream", path: chip.payload.path!, size: chip.payload.size })),
      ...[...threads.values()].map((snapshot) => ({ kind: "file" as const, name: snapshot.name, mimeType: "text/markdown", path: snapshot.path, size: snapshot.size })),
    ]
    : [];
  return { context: prefix, attachments: fileParts };
}

/** Composer Context: typed chips in the composer, file attachments and folded pastes. */
const composerContext: DesktopExtension = {
  id: COMPOSER_CONTEXT_ID,
  name: "Composer Context",
  activate(context) {
    const store = new ChipStore();
    const host = hostApi(context.host);
    let workspace: { getSnapshot(): { cwd?: string } } | undefined;
    context.useService<{ getSnapshot(): { cwd?: string } }>(WORKSPACE_STORE_SERVICE, (value) => {
      workspace = value;
      return () => { if (workspace === value) workspace = undefined; };
    });
    let pullRequests: ThreadPullRequestsService | undefined;
    context.useService<ThreadPullRequestsService>(THREAD_PULL_REQUESTS_SERVICE, (value) => {
      pullRequests = value;
      return () => { if (pullRequests === value) pullRequests = undefined; };
    });
    const cwdFor = (inline: ComposerInlineContext) => workspace?.getSnapshot().cwd ?? inline.snapshot?.cwd;

    // Uploads the connection lost for good, started again once the host is back.
    const lost = new Map<string, () => void>();
    // Every upload that failed, so sending can try it again.
    const failedUploads = new Map<string, { scope: string; start: () => void }>();
    const upload = (scope: string, name: string, mimeType: string, size: number, read: (start: number, end: number) => Promise<Uint8Array>) => {
      const chip = store.add(scope, { kind: "attachment", payload: { name, mimeType, size } });
      const start = () => {
        lost.delete(chip.id);
        const uploading = storeWithRetry(host, { scope, name, mimeType, size }, read)
          .then((stored) => {
            failedUploads.delete(chip.id);
            store.update(scope, chip.id, { payload: { name, mimeType, size: stored.size, path: stored.path }, uploading: undefined });
          })
          .catch((error: unknown) => {
            const message = error instanceof Error ? error.message : String(error);
            store.update(scope, chip.id, { error: message, uploading: undefined });
            // Drop retries of chips that were removed meanwhile.
            for (const [id, entry] of failedUploads) if (!store.list(entry.scope).some((c) => c.id === id) && !store.sendingChip(entry.scope, id)) failedUploads.delete(id);
            failedUploads.set(chip.id, { scope, start });
            if (TRANSIENT_UPLOAD_ERROR.test(message)) lost.set(chip.id, start);
          });
        store.update(scope, chip.id, { uploading, error: undefined });
      };
      start();
    };
    let connected = true;
    context.events.on("host-connection", ({ state }) => {
      const back = state === "connected" && !connected;
      connected = state === "connected";
      if (!back) return;
      for (const [id, restart] of [...lost]) {
        if (store.scopeOf(id)) restart();
        else lost.delete(id);
      }
    });

    const service: ComposerContextChips = {
      addChip: (input: ChipInput) => {
        const scope = store.activeScope;
        if (!scope) throw new Error("No composer is open to take the chip.");
        return store.add(scope, input).id;
      },
      removeChip: (id) => {
        const scope = store.scopeOf(id);
        if (scope) store.remove(scope, id);
      },
      chips: () => (store.activeScope ? store.list(store.activeScope) : []) as readonly Chip[],
      subscribe: store.subscribe,
    };
    context.provideService(COMPOSER_CONTEXT_CHIPS_SERVICE, service);
    // A sent excerpt reads as a chip with its quote in a popover, wherever the thread is read.
    context.registerMessageBlock({ id: "composer-context.excerpt", tag: EXCERPT_TAG, roles: ["user"], profiles: ["desktop", "web", "compact"], Component: SentExcerptChip });

    const Strip = ({ scope, draftState }: ComposerInlineProps) => <ChipStrip store={store} scope={scope} draftState={draftState} inline />;
    const Detail = (props: ComposerChipDetailProps) => <ExcerptDetail store={store} {...props} />;

    context.registerComposerInline({
      id: "composer-context",
      profiles: ["desktop"],
      Component: Strip,
      chips: {
        list: (scope) => store.list(scope).map((chip) => inlineChip(chip, Detail)),
        remove: (scope, id) => store.remove(scope, id),
      },
      triggers: [
        {
          char: "@",
          label: "Files",
          search: async (query, inline): Promise<ComposerTriggerItem[]> => {
            const cwd = cwdFor(inline);
            if (!cwd) return [];
            const { path, startLine, endLine } = parseFileQuery(query);
            const lines = startLine === undefined ? undefined : `:${startLine}${endLine !== undefined ? `-${endLine}` : ""}`;
            return (await host("list-files", { cwd, query: path })).map((file) => ({ id: file, label: file, ...(lines ? { hint: lines } : {}) }));
          },
          select: (item, query, inline) => {
            const { startLine, endLine } = parseFileQuery(query);
            store.add(inline.scope, { kind: "file", payload: { path: item.id, ...(startLine !== undefined ? { startLine } : {}), ...(endLine !== undefined ? { endLine } : {}) } });
          },
        },
        {
          char: "#",
          label: "Pull requests",
          search: async (query, inline): Promise<ComposerTriggerItem[]> => {
            const sessionId = inline.snapshot?.sessionId;
            const linked: PullRequestSummary[] = (sessionId ? pullRequests?.forThread(sessionId) ?? [] : []).map((pr) => ({
              number: pr.number, title: pr.title ?? pr.repo, url: pr.url,
              ...(pr.headRef ? { branch: pr.headRef } : {}), ...(pr.draft ? { draft: true } : {}),
            }));
            const cwd = cwdFor(inline);
            let listed: PullRequestSummary[] = [];
            if (cwd) {
              try { listed = await host("list-pull-requests", { cwd }); }
              catch (error) { if (!linked.length) throw error; }
            }
            const needle = query.toLowerCase();
            const seen = new Set<string>();
            return [...linked, ...listed]
              .filter((pr) => {
                if (seen.has(pr.url)) return false;
                seen.add(pr.url);
                return !needle || String(pr.number).startsWith(needle) || pr.title.toLowerCase().includes(needle);
              })
              .map((pr) => ({ id: JSON.stringify(pr), label: `${requestNumberOf(pr.url, pr.number)} ${pr.title}`, ...(pr.branch ? { description: pr.branch } : {}), ...(pr.draft ? { hint: "draft" } : {}) }));
          },
          select: (item, _query, inline) => {
            const pr = JSON.parse(item.id) as PullRequestSummary;
            store.add(inline.scope, { kind: "pull-request", payload: { number: pr.number, title: pr.title, url: pr.url, ...(pr.branch ? { branch: pr.branch } : {}) } });
          },
        },
      ],
      pasteText: (text, inline) => {
        if (!shouldFoldPaste(text)) return false;
        const bytes = new TextEncoder().encode(text);
        const name = `pasted-text-${store.nextPasteNumber(inline.scope)}.txt`;
        upload(inline.scope, name, "text/plain", bytes.length, async (start, end) => bytes.subarray(start, end));
        return true;
      },
      drop: {
        mimeType: PULL_REQUEST_DRAG_TYPE,
        take: (text, inline) => {
          const payload = readPullRequestDrop(text);
          if (!payload) return false;
          store.add(inline.scope, { kind: "pull-request", payload });
          return true;
        },
      },
      takeFiles: (files, inline) => {
        const { take, leave, error } = selectFiles(files, store.list(inline.scope), inline.imageInput);
        store.setError(inline.scope, error);
        for (const file of take) upload(inline.scope, file.name, file.type, file.size, (start, end) => readBytes(file.slice(start, end), file.name));
        return leave;
      },
      hasContent: (scope) => store.has(scope),
      subscribe: store.subscribe,
      prepareSend: (inline) => prepareSend(store, host, cwdFor(inline), inline, (id) => {
        const failed = failedUploads.get(id);
        if (!failed) return false;
        failedUploads.delete(id);
        failed.start();
        return true;
      }),
      settleSend: (scope, accepted) => store.settle(scope, accepted),
    });
    // `drop` takes one type; the rail's thread drag is a second contribution of this kit.
    context.registerComposerInline({
      id: "composer-context.thread-drop",
      profiles: ["desktop"],
      drop: {
        mimeType: THREAD_DRAG_TYPE,
        take: (text, inline) => {
          const payload = readThreadDrop(text);
          if (!payload) return false;
          store.add(inline.scope, { kind: "thread", payload });
          return true;
        },
      },
    });
  },
};

export default composerContext;
