import type { UiToolRun } from "../shared/contracts.js";

/** Public audience contract. No runtime ids, arguments, media, extras or lazy reads. */
export interface HostPublicTool {
  name: string;
  status: "running" | "done" | "error";
  output?: string;
  outputTruncated?: true;
}
export interface HostPublicTools {
  tools: HostPublicTool[];
  truncated: boolean;
}
export interface HostPublicToolOptions { includeOutput: boolean }

// These built-in cards display plain text. Unknown/custom tools, computer-use,
// edits/diffs, MCP apps and delegation never export a raw result. Adding a tool
// here requires checking its host translator AND its workbench presentation.
const TEXT_TOOLS = new Set(["bash", "Bash", "read", "Read", "grep", "Grep", "find", "ls", "Glob"]);
const PRIVATE_TOOL = /secret|credential|password|token|auth/iu;
const NAME = /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/u;

/** Display text only. This is not a guarantee against arbitrary secrets printed by commands. */
function cleanOutput(text: string): string {
  return text
    // oxlint-disable-next-line eslint/no-control-regex -- Strip terminal escapes and nonprinting controls from public text.
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/gu, "")
    // oxlint-disable-next-line eslint/no-control-regex -- Strip terminal escapes and nonprinting controls from public text.
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, "")
    // oxlint-disable-next-line eslint/no-control-regex -- Strip terminal escapes and nonprinting controls from public text.
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, "")
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/gu, "[REDACTED]")
    .replace(/^.*(?:authorization\s*[:=]|bearer\s+|(?:api[_-]?key|access[_-]?key|password|passwd|secret(?:ref)?|credential|token|(?:access|refresh|client)[_-]?token)\b["']?\s*[:=]).*$/gimu, "[REDACTED]")
    .replace(/\btau[gbc]\.[a-f0-9]{24}\.[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/gu, "[REDACTED]")
    .replace(/\btau_mcp_(?:local|access|refresh|code)_[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/gu, "[REDACTED]")
    .replace(/\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{16,}|github_pat_[A-Za-z0-9_]{16,}|AKIA[A-Z0-9]{16})\b/gu, "[REDACTED]")
    .replace(/(?:https?|ssh|postgres(?:ql)?|mysql):\/\/[^\s/@]+:[^\s/@]+@[^\s]+/giu, "[REDACTED]")
    .replace(/https?:\/\/[^\s]*[?&](?:token|(?:access|refresh|client)[_-]?token|key|secret|password|signature|credential)=[^\s]*/giu, "[REDACTED]");
}

/** Reapply the same text policy when a public projection crosses a persisted/HTTP boundary. */
export function sanitizePublicToolOutput(name: string, output: string): string | undefined {
  if (!TEXT_TOOLS.has(name)) return undefined;
  // Bound before scrubbing too. Dropping the partial first line prevents a
  // clipped credential prefix from disguising the rest of that line.
  if (output.includes("PRIVATE KEY")) return "[REDACTED]";
  const tail = output.length > 32_000 ? output.slice(-32_000).replace(/^[^\n]*(?:\n|$)/u, "") : output;
  return cleanOutput(tail);
}

/** Only canonical visible activity comes here, never a runtime session or result read. */
export function publicThreadTools(activity: readonly UiToolRun[], options: HostPublicToolOptions): HostPublicTools {
  const tools: HostPublicTool[] = [];
  let remaining = 200_000;
  let truncated = false;
  for (let index = activity.length - 1; index >= 0; index--) {
    const tool = activity[index]!;
    if (!tool || typeof tool.name !== "string" || !NAME.test(tool.name) || PRIVATE_TOOL.test(tool.name) || !["running", "done", "error"].includes(tool.status)) continue;
    if (tools.length >= 500 || remaining < tool.name.length) { truncated = true; break; }
    remaining -= tool.name.length;
    const row: HostPublicTool = { name: tool.name, status: tool.status };
    if (options.includeOutput === true && TEXT_TOOLS.has(tool.name) && !tool.kind && !tool.extras && !tool.media?.length && !tool.outputDeferred && typeof tool.output === "string") {
      const clean = sanitizePublicToolOutput(tool.name, tool.output)!;
      const output = clean.slice(-remaining);
      if (remaining > 0 && output) row.output = output;
      if (tool.output.length > 32_000 || clean.length > remaining || tool.outputTruncated || tool.fullOutputAvailable) { row.outputTruncated = true; truncated = true; }
      remaining -= row.output?.length ?? 0;
    }
    tools.push(row);
  }
  return { tools: tools.reverse(), truncated };
}
