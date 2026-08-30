/** Display limits keep transcript layout and memory bounded without discarding host data. */
export const ACTIVE_TOOL_OUTPUT_LIMIT = 64 * 1024;
export const SETTLED_TOOL_OUTPUT_LIMIT = 24 * 1024;
export const TOOL_OUTPUT_TAIL_LINES = 240;

export interface BoundedToolOutput {
  text: string;
  truncated: boolean;
}

export function boundToolOutput(
  output: string | undefined,
  limit: number,
  tailLines = TOOL_OUTPUT_TAIL_LINES,
): BoundedToolOutput {
  if (!output || output.length <= limit) return { text: output ?? "", truncated: false };
  const start = output.length - limit;
  let text = output.slice(start);
  const firstNewline = text.indexOf("\n");
  if (firstNewline >= 0) text = text.slice(firstNewline + 1);
  const lines = text.split("\n");
  if (lines.length > tailLines) text = lines.slice(-tailLines).join("\n");
  return { text, truncated: true };
}

/** Coalesces updates by tool identity; the final update is always flushed explicitly. */
export class ToolOutputBatcher {
  private pending = new Map<string, string>();
  private timer?: ReturnType<typeof setTimeout>;

  constructor(private readonly flushUpdates: (updates: ReadonlyMap<string, string>) => void, private readonly intervalMs = 16) {}

  push(id: string, output: string): void {
    this.pending.set(id, output);
    if (this.timer === undefined) this.timer = setTimeout(() => this.flush(), this.intervalMs);
  }

  flushId(id: string): void {
    const output = this.pending.get(id);
    if (output === undefined) return;
    this.pending.delete(id);
    this.flushMap(new Map([[id, output]]));
  }

  flush(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.pending.size === 0) return;
    const pending = this.pending;
    this.pending = new Map();
    this.flushMap(pending);
  }

  dispose(): void {
    this.flush();
  }

  private flushMap(updates: ReadonlyMap<string, string>): void {
    this.flushUpdates(updates);
  }
}
