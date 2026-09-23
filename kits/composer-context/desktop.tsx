import { useEffect, useSyncExternalStore, type ReactNode } from "react";
import { AlertCircle, FileText, GitPullRequest, Paperclip, Quote, X } from "lucide-react";
import type {
  ComposerInlineContext,
  ComposerInlineProps,
  ComposerSendContribution,
  ComposerTriggerItem,
  DesktopExtension,
  HostExtensionClient,
  UiPromptFileAttachment,
} from "tau";
import { ChipStore, formatBytes, isVideo, selectFiles, serializeChips, shouldFoldPaste, type ChipEntry } from "./chips.js";
import {
  COMPOSER_CONTEXT_CHIPS_SERVICE,
  COMPOSER_CONTEXT_ID,
  WORKSPACE_STORE_SERVICE,
  type Chip,
  type ChipInput,
  type ComposerContextChips,
  type ComposerContextHostCommands,
  type DescribedAttachment,
  type PullRequestSummary,
  type ReadFileResult,
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
const TRANSIENT_UPLOAD_ERROR = /connection dropped|connection was closed|timed out|not available/iu;
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

const ICONS = { "file": FileText, "text-excerpt": Quote, "pull-request": GitPullRequest, "attachment": Paperclip } as const;

function chipTitle(chip: ChipEntry): string {
  switch (chip.kind) {
    case "file": return chip.payload.path;
    case "text-excerpt": return chip.payload.text.slice(0, 400);
    case "pull-request": return `${chip.payload.title}\n${chip.payload.url}`;
    case "attachment": return `${chip.payload.name} · ${formatBytes(chip.payload.size)}`;
  }
}

export function ChipStrip({ store, scope, draftState }: { store: ChipStore } & Pick<ComposerInlineProps, "scope" | "draftState">) {
  const chips = useSyncExternalStore(store.subscribe, () => store.list(scope));
  const error = useSyncExternalStore(store.subscribe, () => store.error(scope));
  useEffect(() => {
    store.hydrate(scope, draftState.read(), draftState.write);
    store.activeScope = scope;
    return () => { if (store.activeScope === scope) store.activeScope = undefined; };
  }, [draftState, scope, store]);
  if (chips.length === 0 && !error) return null;
  return (
    <div className="composer-context" aria-label="Context">
      {chips.map((chip) => {
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
): Promise<ComposerSendContribution | undefined> {
  const chips = store.beginSend(context.scope);
  if (chips.length === 0) return undefined;
  await Promise.all(chips.map((chip) => chip.uploading));
  // An upload that finished while the prompt waited updated the chip; read it again.
  const current = chips.map((chip) => store.sendingChip(context.scope, chip.id) ?? chip);
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
  const prefix = serializeChips({ chips: current, files: fileResults, attachments: described, fileAttachments: context.fileAttachments });
  // A video goes as a path whatever the runtime: no runtime takes video input.
  const fileParts: UiPromptFileAttachment[] = context.fileAttachments
    ? attachments.filter((chip) => !isVideo(chip.payload.mimeType)).map((chip) => ({ kind: "file", name: chip.payload.name, mimeType: chip.payload.mimeType || "application/octet-stream", path: chip.payload.path!, size: chip.payload.size }))
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
    const cwdFor = (inline: ComposerInlineContext) => workspace?.getSnapshot().cwd ?? inline.snapshot?.cwd;

    const upload = (scope: string, name: string, mimeType: string, size: number, read: (start: number, end: number) => Promise<Uint8Array>) => {
      const chip = store.add(scope, { kind: "attachment", payload: { name, mimeType, size } });
      const uploading = storeWithRetry(host, { scope, name, mimeType, size }, read)
        .then((stored) => store.update(scope, chip.id, { payload: { name, mimeType, size: stored.size, path: stored.path }, uploading: undefined }))
        .catch((error: unknown) => store.update(scope, chip.id, { error: error instanceof Error ? error.message : String(error), uploading: undefined }));
      store.update(scope, chip.id, { uploading });
    };

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

    const Strip = ({ scope, draftState }: ComposerInlineProps) => <ChipStrip store={store} scope={scope} draftState={draftState} />;

    context.registerComposerInline({
      id: "composer-context",
      profiles: ["desktop"],
      Component: Strip,
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
            const cwd = cwdFor(inline);
            if (!cwd) return [];
            const needle = query.toLowerCase();
            const list = await host("list-pull-requests", { cwd });
            return list
              .filter((pr) => !needle || String(pr.number).startsWith(needle) || pr.title.toLowerCase().includes(needle))
              .map((pr) => ({ id: JSON.stringify(pr), label: `#${pr.number} ${pr.title}`, ...(pr.branch ? { description: pr.branch } : {}), ...(pr.draft ? { hint: "draft" } : {}) }));
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
      takeFiles: (files, inline) => {
        const { take, leave, error } = selectFiles(files, store.list(inline.scope), inline.imageInput);
        store.setError(inline.scope, error);
        for (const file of take) upload(inline.scope, file.name, file.type, file.size, (start, end) => readBytes(file.slice(start, end), file.name));
        return leave;
      },
      hasContent: (scope) => store.has(scope),
      subscribe: store.subscribe,
      prepareSend: (inline) => prepareSend(store, host, cwdFor(inline), inline),
      settleSend: (scope, accepted) => store.settle(scope, accepted),
    });
  },
};

export default composerContext;
