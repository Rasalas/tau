import type { RuntimePermissionLevel, ThreadRuntimeEvent, UiToolRun } from "tau/host-extension";
import type { PermissionRequest, QuestionInfo } from "./approvals.js";
import type { OpenCodeEvent, OpenCodeInputPart, OpenCodeProviderList, OpenCodeTokens } from "./client.js";

/**
 * What a thread, the catalog and the history import need of an OpenCode
 * server, whatever its generation. OpenCode 1 and OpenCode 2 speak different
 * HTTP APIs; each has an implementation (`client.ts` with `api-v1.ts`,
 * `client-v2.ts`), and everything else in the kit talks to this interface.
 */

/** Tau's access level for a session, and the tools it is limited to. */
export interface SessionPolicy {
  level: RuntimePermissionLevel;
  /** Pi's tool names; absent for a thread with every tool. */
  tools?: readonly string[];
}

export interface NativeSession {
  id: string;
  title?: string;
  parentId?: string;
  tokens?: OpenCodeTokens;
  cost?: number;
}

export interface SessionPrompt {
  parts: OpenCodeInputPart[];
  model?: { providerID: string; modelID: string };
  variant?: string;
  /** OpenCode's plan agent, with Tau's instruction to write the plan as a block. */
  plan: boolean;
  tools?: readonly string[];
  /** The prompt joins a turn that already runs. */
  steer?: boolean;
}

export interface QuestionRequest {
  id: string;
  questions: QuestionInfo[];
  /** Asked outside any session (an MCP server's request); a thread answers it only on a server it started. */
  orphan?: boolean;
  /** Whatever the implementation needs to answer it again (a form's field keys). */
  native?: unknown;
}

/** An event of the server's stream, sorted into what a thread does with it. */
export type OpenCodeSignal =
  | { kind: "session"; sessionId: string; parentId?: string; title?: string; usage?: { tokens: OpenCodeTokens; cost?: number } }
  | { kind: "permission"; sessionId: string; request: PermissionRequest }
  | { kind: "question"; sessionId: string; request: QuestionRequest }
  /** Something that belongs to a turn; the turn's translator reads it. */
  | { kind: "turn"; sessionId: string; type: string; properties: Record<string, unknown> };

/** The events of one turn as Tau's runtime events (`events.ts`, `events-v2.ts`). */
export interface TurnTranslator {
  readonly running: Map<string, UiToolRun>;
  outcome?: { status: "completed" | "interrupted" | "failed"; error?: string; texts: string[] };
  /** The model the turn's assistant messages ran on. */
  model?: { providerID: string; modelID: string };
  /** The last step's tokens, for the context meter. */
  lastStep?: OpenCodeTokens & { total?: number };
  push(type: string, properties: Record<string, unknown>): ThreadRuntimeEvent[];
  /** The turn ended without the server saying so. */
  abandon(status: "interrupted" | "failed", error?: string): ThreadRuntimeEvent[];
}

export interface HistorySession {
  id: string;
  directory: string;
  title?: string;
  parentId?: string;
  archived?: boolean;
  updatedAt?: number;
  createdAt?: number;
  tokens?: OpenCodeTokens;
  cost?: number;
}

export interface HistoryMessage {
  role: "user" | "assistant";
  text: string;
  timestamp: number;
}

export interface HistoryTranscript {
  messages: HistoryMessage[];
  /** The model the session last ran on. */
  model?: { provider: string; id: string };
}

export interface OpenCodeApi {
  readonly generation: 1 | 2;
  /** The server's version; a server that does not say is no OpenCode Tau knows. */
  health(): Promise<{ healthy: boolean; version: string }>;
  /** Providers and models in OpenCode 1's shape, whatever the server speaks. */
  providers(directory: string): Promise<OpenCodeProviderList>;
  /** The configured default model as `provider/model`. */
  config(directory: string): Promise<{ model?: string }>;

  createSession(directory: string, input: { title?: string; policy: SessionPolicy }): Promise<NativeSession>;
  /** Rejects with an `OpenCodeHttpError` of status 404 when the server has no such session. */
  getSession(directory: string, id: string): Promise<NativeSession>;
  applyPolicy(directory: string, id: string, policy: SessionPolicy): Promise<void>;
  renameSession(directory: string, id: string, title: string): Promise<void>;
  /** Queues the prompt and answers at once; the turn arrives on the event stream. */
  prompt(directory: string, id: string, prompt: SessionPrompt): Promise<void>;
  abort(directory: string, id: string): Promise<void>;
  /** Stops what an earlier connection left running on the session and waits until it is idle. */
  settle(directory: string, id: string): Promise<void>;
  /** Waits, for a while at most, until the named MCP servers are connected or have failed. */
  awaitTools(directory: string, servers: readonly string[]): Promise<void>;

  replyPermission(directory: string, request: PermissionRequest, reply: "once" | "always" | "reject", message?: string): Promise<void>;
  /** Answers a question; `undefined` dismisses it. */
  answerQuestion(directory: string, sessionId: string, request: QuestionRequest, answers: string[][] | undefined): Promise<void>;

  /** Follows the stream until `close()` or the server ends it; resolves once the server accepted. */
  subscribe(directory: string, onEvent: (event: OpenCodeEvent) => void, onEnd: (error?: Error) => void): Promise<{ close(): void }>;
  signal(event: OpenCodeEvent): OpenCodeSignal | undefined;
  translator(now: () => number): TurnTranslator;

  /** Sessions across the server's projects, newest first; sub-agents' sessions are left out when `roots`. */
  listHistory(query: { roots?: boolean; limit?: number }): Promise<HistorySession[]>;
  /** The visible conversation of one session: user and assistant text. */
  historyMessages(directory: string, id: string): Promise<HistoryTranscript>;
}
