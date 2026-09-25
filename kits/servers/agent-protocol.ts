// The agent's server tools as both halves see them; type imports only, so the desktop half may read it.
import type { DeployFilePlan } from "./deploy-protocol.js";

export const SERVER_TOOLS = {
  status: "server_status",
  list: "server_list",
  read: "server_read",
  diff: "server_diff",
  exec: "server_exec",
  putTmp: "server_put_tmp",
  proposeUpload: "server_propose_upload",
} as const;

export type ServerToolName = (typeof SERVER_TOOLS)[keyof typeof SERVER_TOOLS];

const NAMES = new Set<string>(Object.values(SERVER_TOOLS));
// Runtimes other than Pi see Tau's tools as `mcp__tau__<name>`.
const MCP_PREFIX = "mcp__tau__";

/** The tool's own name, with the MCP prefix taken off. */
export function serverToolName(name: string): ServerToolName | undefined {
  const bare = name.startsWith(MCP_PREFIX) ? name.slice(MCP_PREFIX.length) : name;
  return NAMES.has(bare) ? bare as ServerToolName : undefined;
}

/**
 * Every server tool's text starts with this line, so the transcript can name
 * the server a call went to: `[site · tester@example.com:22]`.
 */
export function serverMarkLine(label: string, address: string): string {
  return `[${label} · ${address}]`;
}

export function parseServerMark(output: string | undefined): { label: string; address: string } | undefined {
  const match = /^\[([^\]\n·]+) · ([^\]\n]+)\]/u.exec(output ?? "");
  return match ? { label: match[1]!.trim(), address: match[2]!.trim() } : undefined;
}

/**
 * What `server_propose_upload` answers, as JSON below the mark line. The card
 * in the transcript draws it; only the user's click there uploads.
 */
export interface UploadProposal {
  kind: "server-upload-proposal";
  /** The checkout the files come from. */
  workspace: string;
  /** The thread that proposed it; the deployment names it. */
  threadId: string;
  target: { id: string; label: string; address: string };
  note?: string;
  /** The server as read when the proposal was made; the upload reads it again. */
  files: DeployFilePlan[];
  /** Local deletions left out: they stay on the server. */
  kept: string[];
  warnings: string[];
  /** Paths left out of the proposal and why: nothing to upload, or credentials the user picks only in the server view. */
  leftOut: Array<{ path: string; reason: string }>;
  /** For the model: what happened and what did not. */
  message: string;
}

export function parseUploadProposal(output: string | undefined): UploadProposal | undefined {
  if (!output) return undefined;
  const start = output.indexOf("{");
  if (start < 0) return undefined;
  try {
    const value = JSON.parse(output.slice(start)) as Partial<UploadProposal>;
    if (value.kind !== "server-upload-proposal" || typeof value.workspace !== "string" || !value.target || !Array.isArray(value.files)) return undefined;
    return { kept: [], warnings: [], leftOut: [], ...value } as UploadProposal;
  } catch {
    return undefined;
  }
}
