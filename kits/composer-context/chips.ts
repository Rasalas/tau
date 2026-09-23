import {
  EMBED_TEXT_BYTES,
  MAX_ATTACHMENT_CHIPS,
  MAX_FILE_BYTES,
  MAX_IMAGE_BYTES,
  PASTE_FOLD_BYTES,
  type Chip,
  type ChipInput,
  type ChipKind,
  type ChipPayloads,
  type DescribedAttachment,
  type ReadFileResult,
} from "./protocol.js";

/** A chip as the kit holds it: the service's shape plus the upload it may be waiting on. */
export type ChipEntry = Chip & { uploading?: Promise<void>; error?: string };

type Persist = (value: unknown) => void;

let nextChipId = 0;
const chipId = () => `chip-${Date.now().toString(36)}-${(nextChipId++).toString(36)}`;

export function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

export function chipLabel(input: ChipInput): string {
  if (input.label?.trim()) return input.label.trim();
  switch (input.kind) {
    case "file": {
      const { path, startLine, endLine } = input.payload;
      const name = path.split("/").pop() || path;
      if (startLine === undefined) return name;
      return endLine !== undefined && endLine !== startLine ? `${name}:${startLine}-${endLine}` : `${name}:${startLine}`;
    }
    case "text-excerpt": return input.payload.source;
    case "pull-request": return `#${input.payload.number}`;
    case "attachment": return input.payload.name;
  }
}

/**
 * The chips of every draft, by the scope core names the draft with. A chip
 * being sent is hidden until core says whether the prompt went, then dropped
 * or put back; every change is written through the draft's own persistence.
 */
export class ChipStore {
  private readonly scopes = new Map<string, ChipEntry[]>();
  private readonly sending = new Map<string, ChipEntry[]>();
  private readonly errors = new Map<string, string>();
  private readonly persisters = new Map<string, Persist>();
  private readonly listeners = new Set<() => void>();
  private readonly pasteCounts = new Map<string, number>();
  /** The draft of the composer on screen; where the service puts chips. */
  activeScope: string | undefined;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  list(scope: string): readonly ChipEntry[] {
    return this.scopes.get(scope) ?? EMPTY;
  }

  has(scope: string): boolean {
    return this.list(scope).length > 0;
  }

  error(scope: string): string | undefined {
    return this.errors.get(scope);
  }

  setError(scope: string, message: string | undefined): void {
    if (message) this.errors.set(scope, message);
    else if (!this.errors.delete(scope)) return;
    this.changed(scope, false);
  }

  /** Brings back what a draft persisted, once, the first time its composer shows it. */
  hydrate(scope: string, persisted: unknown, persist: Persist): void {
    this.persisters.set(scope, persist);
    if (this.scopes.has(scope) || this.sending.has(scope)) return;
    const chips = decodeChips(persisted);
    if (chips.length === 0) return;
    this.scopes.set(scope, chips);
    this.changed(scope, false);
  }

  add(scope: string, input: ChipInput): ChipEntry {
    const entry = { ...input, id: chipId(), label: chipLabel(input) } as ChipEntry;
    this.scopes.set(scope, [...this.list(scope), entry]);
    this.changed(scope);
    return entry;
  }

  update(scope: string, id: string, patch: Partial<Pick<ChipEntry, "payload" | "uploading" | "error">>): void {
    const apply = (chips: readonly ChipEntry[] | undefined) => chips?.map((chip) => chip.id === id ? { ...chip, ...patch } as ChipEntry : chip);
    const listed = apply(this.scopes.get(scope));
    if (listed) this.scopes.set(scope, listed);
    // An upload may finish while its prompt is on the way.
    const sending = apply(this.sending.get(scope));
    if (sending) this.sending.set(scope, sending);
    this.changed(scope);
  }

  remove(scope: string, id: string): void {
    const chips = this.list(scope);
    if (!chips.some((chip) => chip.id === id)) return;
    this.scopes.set(scope, chips.filter((chip) => chip.id !== id));
    this.changed(scope);
  }

  /** Where a chip lives, for the service's `removeChip`, which knows only the id. */
  scopeOf(id: string): string | undefined {
    for (const [scope, chips] of this.scopes) if (chips.some((chip) => chip.id === id)) return scope;
    return undefined;
  }

  nextPasteNumber(scope: string): number {
    const next = (this.pasteCounts.get(scope) ?? 0) + 1;
    this.pasteCounts.set(scope, next);
    return next;
  }

  /** Hides the draft's chips while its prompt is on the way and answers with them. */
  beginSend(scope: string): readonly ChipEntry[] {
    const chips = [...this.list(scope)];
    if (chips.length === 0) return chips;
    this.sending.set(scope, [...this.sending.get(scope) ?? [], ...chips]);
    this.scopes.set(scope, []);
    this.changed(scope, false);
    return chips;
  }

  /** A chip of the prompt on its way, as it is now. */
  sendingChip(scope: string, id: string): ChipEntry | undefined {
    return this.sending.get(scope)?.find((chip) => chip.id === id);
  }

  settle(scope: string, accepted: boolean): void {
    const sent = this.sending.get(scope);
    this.sending.delete(scope);
    if (!sent?.length) return;
    // A refused prompt puts its chips back ahead of any added meanwhile.
    if (!accepted) this.scopes.set(scope, [...sent, ...this.list(scope)]);
    this.changed(scope);
  }

  private changed(scope: string, persist = true): void {
    if (persist && !this.sending.has(scope)) this.persisters.get(scope)?.(encodeChips(this.list(scope)));
    for (const listener of [...this.listeners]) listener();
  }
}

const EMPTY: readonly ChipEntry[] = [];
const CHIP_KINDS: ReadonlySet<ChipKind> = new Set(["file", "text-excerpt", "pull-request", "attachment"]);

/** What a draft keeps: plain JSON, no renderer and no upload that never finished. */
export function encodeChips(chips: readonly ChipEntry[]): unknown {
  const kept = chips
    .filter((chip) => chip.kind !== "attachment" || (chip.payload.path && !chip.error))
    .map(({ id, kind, label, payload }) => ({ id, kind, label, payload }));
  return kept.length > 0 ? { version: 1, chips: kept } : undefined;
}

export function decodeChips(value: unknown): ChipEntry[] {
  const chips = (value as { version?: unknown; chips?: unknown } | undefined)?.chips;
  if (!Array.isArray(chips)) return [];
  return chips.flatMap((raw): ChipEntry[] => {
    const chip = raw as Partial<Chip>;
    if (typeof chip.id !== "string" || typeof chip.label !== "string" || !CHIP_KINDS.has(chip.kind as ChipKind)) return [];
    if (!chip.payload || typeof chip.payload !== "object") return [];
    return [{ id: chip.id, kind: chip.kind, label: chip.label, payload: chip.payload } as ChipEntry];
  });
}

export interface FileCandidate { name: string; type: string; size: number }

export function isVideo(mimeType: string | undefined): boolean {
  return mimeType?.startsWith("video/") === true;
}

/**
 * Which dropped files the kit takes and which it leaves to core: every file
 * that is not an image, and images too when the model cannot see them.
 */
export function selectFiles<T extends FileCandidate>(
  files: readonly T[],
  existing: readonly ChipEntry[],
  imageInput: boolean,
): { take: T[]; leave: T[]; error?: string } {
  const take: T[] = [];
  const leave: T[] = [];
  let error: string | undefined;
  let count = existing.filter((chip) => chip.kind === "attachment").length;
  for (const file of files) {
    const image = file.type.startsWith("image/");
    if (image && imageInput) { leave.push(file); continue; }
    const limit = image ? MAX_IMAGE_BYTES : MAX_FILE_BYTES;
    if (count >= MAX_ATTACHMENT_CHIPS) error ??= `Attach at most ${MAX_ATTACHMENT_CHIPS} files to a message.`;
    else if (file.size > limit) error ??= `${file.name} is larger than ${limit / 1024 / 1024} MB.`;
    else if (file.size === 0) error ??= `${file.name} is empty.`;
    else { take.push(file); count += 1; continue; }
  }
  return { take, leave, ...(error ? { error } : {}) };
}

export function shouldFoldPaste(text: string): boolean {
  return new TextEncoder().encode(text).length >= PASTE_FOLD_BYTES;
}

const escapeAttribute = (value: string) => value.replace(/&/gu, "&amp;").replace(/"/gu, "&quot;").replace(/</gu, "&lt;");
/** Captured text is data: it must not close the block it sits in. */
const escapeBody = (text: string) => text.replace(/<\/file>/giu, "<\\/file>");

function fileBlock(path: string, attributes: Record<string, string | undefined>, body?: string): string {
  const extra = Object.entries(attributes)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .map(([key, value]) => ` ${key}="${escapeAttribute(value)}"`)
    .join("");
  const open = `<file path="${escapeAttribute(path)}"${extra}`;
  return body === undefined ? `${open} />` : `${open}>\n${escapeBody(body)}\n</file>`;
}

const lines = (payload: ChipPayloads["file"]) => payload.startLine === undefined
  ? undefined
  : `${payload.startLine}-${payload.endLine ?? payload.startLine}`;

export interface SerializeInput {
  chips: readonly ChipEntry[];
  /** File chip contents, by chip id. */
  files?: ReadonlyMap<string, ReadFileResult>;
  /** Attachment text for a runtime without file support, by chip id. */
  attachments?: ReadonlyMap<string, DescribedAttachment>;
  /** The runtime takes attachments as files; they are not written into the text. */
  fileAttachments: boolean;
}

const ORDER: readonly ChipKind[] = ["file", "text-excerpt", "pull-request", "attachment"];

/**
 * The prompt prefix, in a fixed order whatever order the chips were added in:
 * files as `<file>` blocks, excerpts as quoted blocks, pull requests as a link
 * with their title, then attachments a runtime cannot open itself.
 */
export function serializeChips({ chips, files, attachments, fileAttachments }: SerializeInput): string {
  const blocks: string[] = [];
  for (const kind of ORDER) {
    for (const chip of chips) {
      if (chip.kind !== kind) continue;
      switch (chip.kind) {
        case "file": {
          const read = files?.get(chip.id);
          if (!read || read.error || read.text === undefined) {
            blocks.push(fileBlock(chip.payload.path, { lines: lines(chip.payload), unavailable: read?.error ?? "not read" }));
          } else {
            blocks.push(fileBlock(chip.payload.path, { lines: lines(chip.payload), truncated: read.truncated ? "true" : undefined }, read.text));
          }
          break;
        }
        case "text-excerpt": {
          const quoted = chip.payload.text.replace(/\s+$/u, "").split(/\r?\n/u).map((line) => line ? `> ${line}` : ">").join("\n");
          blocks.push(`From ${chip.payload.source}:\n${quoted}`);
          break;
        }
        case "pull-request":
          blocks.push(`Pull request [#${chip.payload.number}](${chip.payload.url}): ${chip.payload.title}`);
          break;
        case "attachment": {
          if ((fileAttachments && !isVideo(chip.payload.mimeType)) || !chip.payload.path) break;
          const described = attachments?.get(chip.id);
          const { name, mimeType, size, path } = chip.payload;
          if (described?.text !== undefined && size <= EMBED_TEXT_BYTES) {
            blocks.push(fileBlock(path, { name, truncated: described.truncated ? "true" : undefined }, described.text));
          } else {
            blocks.push(`The user attached ${name} (${mimeType || "unknown type"}, ${formatBytes(size)}). It is at ${path}; read it from there.`);
          }
          break;
        }
      }
    }
  }
  return blocks.join("\n\n");
}
