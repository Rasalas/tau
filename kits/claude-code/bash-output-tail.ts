import { open, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { boundedToolOutput, MAX_TOOL_OUTPUT_BYTES } from "./sdk-events.js";

const POLL_MS = 250;
/** Gives up on a file the CLI never wrote (another layout, or Windows). */
const MAX_LOCATE_ATTEMPTS = 40;
/** Bytes read per poll; a faster writer skips ahead, only the tail is shown. */
const MAX_READ_BYTES = 256 * 1024;

/** The CLI's per-user temp root; none where the platform has no uid. This layout is the CLI's own, not SDK API. */
export function taskOutputRoot(env: NodeJS.ProcessEnv, currentUid: () => number | undefined = () => process.getuid?.()): string | undefined {
  const uid = currentUid();
  if (uid === undefined) return undefined;
  return join(env.CLAUDE_CODE_TMPDIR?.trim() || "/tmp", `claude-${uid}`);
}

function object(value: unknown): Record<string, unknown> { return value && typeof value === "object" ? value as Record<string, unknown> : {}; }
function string(value: unknown): string | undefined { return typeof value === "string" && value ? value : undefined; }

interface Tail {
  stopped: boolean;
  timer?: ReturnType<typeof setTimeout>;
}

export interface LiveBashOutputOptions {
  /** The latest output of a running foreground command, whole and bounded. */
  onOutput(toolUseId: string, output: string): void;
  root?: string | undefined;
  pollMs?: number;
}

/**
 * Live output for a foreground Bash call. The SDK sends no output before the
 * tool result, but the CLI writes each running command's output to a file named
 * by its `task_started` frame. Every failure to find or read it means no live
 * output; the tool result still carries the whole of it.
 */
export class LiveBashOutput {
  private readonly bashCalls = new Set<string>();
  private readonly tails = new Map<string, Tail>();
  private readonly root: string | undefined;
  private readonly pollMs: number;

  constructor(private readonly options: LiveBashOutputOptions) {
    this.root = "root" in options ? options.root : taskOutputRoot(process.env);
    this.pollMs = options.pollMs ?? POLL_MS;
  }

  /** Sees every frame of the main loop, before the turn's translator does. */
  push(raw: unknown): void {
    const frame = object(raw);
    if (frame.type === "assistant" && !frame.parent_tool_use_id) {
      const content = object(frame.message).content;
      for (const block of Array.isArray(content) ? content.map(object) : []) {
        if (block.type === "tool_use" && block.name === "Bash" && string(block.id)) this.bashCalls.add(String(block.id));
      }
      return;
    }
    if (frame.type === "user" && !frame.parent_tool_use_id) {
      const content = object(frame.message).content;
      for (const block of Array.isArray(content) ? content.map(object) : []) {
        if (block.type === "tool_result" && string(block.tool_use_id)) this.finish(String(block.tool_use_id));
      }
      return;
    }
    if (frame.type === "result") { this.stop(); return; }
    if (frame.type !== "system" || frame.subtype !== "task_started") return;
    const toolUseId = string(frame.tool_use_id);
    const taskId = string(frame.task_id);
    const sessionId = string(frame.session_id);
    // Older builds omit the flag on a foreground call.
    if (!this.root || !toolUseId || !taskId || !sessionId || frame.task_type !== "local_bash" || frame.is_backgrounded === true) return;
    if (!this.bashCalls.has(toolUseId) || this.tails.has(toolUseId)) return;
    const tail: Tail = { stopped: false };
    this.tails.set(toolUseId, tail);
    void this.follow(toolUseId, tail, this.root, sessionId, taskId).catch(() => undefined);
  }

  /** Ends every tail; whatever it has not reported comes with the tool result. */
  stop(): void {
    for (const id of [...this.tails.keys()]) this.finish(id);
    this.bashCalls.clear();
  }

  private finish(toolUseId: string): void {
    this.bashCalls.delete(toolUseId);
    const tail = this.tails.get(toolUseId);
    if (!tail) return;
    tail.stopped = true;
    if (tail.timer) clearTimeout(tail.timer);
    this.tails.delete(toolUseId);
  }

  private pause(tail: Tail): Promise<void> {
    return new Promise((resolve) => { tail.timer = setTimeout(resolve, this.pollMs); });
  }

  private async locate(tail: Tail, root: string, sessionId: string, taskId: string): Promise<string | undefined> {
    for (let attempt = 0; attempt < MAX_LOCATE_ATTEMPTS && !tail.stopped; attempt += 1) {
      const projects = await readdir(root).catch(() => [] as string[]);
      for (const project of projects) {
        const candidate = join(root, project, sessionId, "tasks", `${taskId}.output`);
        if (await stat(candidate).then(() => true, () => false)) return candidate;
      }
      await this.pause(tail);
    }
    return undefined;
  }

  private async follow(toolUseId: string, tail: Tail, root: string, sessionId: string, taskId: string): Promise<void> {
    const file = await this.locate(tail, root, sessionId, taskId);
    if (!file) return;
    const decoder = new StringDecoder("utf8");
    let text = "";
    let offset = 0;
    while (!tail.stopped) {
      const size = await stat(file).then((info) => info.size, () => offset);
      if (size < offset) offset = 0;
      if (size > offset) {
        const start = size - offset > MAX_READ_BYTES ? size - MAX_READ_BYTES : offset;
        const bytes = await readRange(file, start, size - start);
        if (tail.stopped) return;
        if (bytes) {
          // Skipped output must not splice two lines together.
          text += (start > offset ? "\n" : "") + decoder.write(bytes);
          offset = start + bytes.length;
          if (text.length > MAX_TOOL_OUTPUT_BYTES * 2) text = text.slice(-MAX_TOOL_OUTPUT_BYTES * 2);
          this.options.onOutput(toolUseId, boundedToolOutput(text));
        }
      }
      await this.pause(tail);
    }
  }
}

async function readRange(file: string, start: number, length: number): Promise<Buffer | undefined> {
  const handle = await open(file, "r").catch(() => undefined);
  if (!handle) return undefined;
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    return buffer.subarray(0, bytesRead);
  } catch {
    return undefined;
  } finally {
    await handle.close().catch(() => undefined);
  }
}
