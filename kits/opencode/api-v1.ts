import type { OpenCodeApi, HistoryMessage, HistorySession, HistoryTranscript, NativeSession, OpenCodeSignal, QuestionRequest, SessionPolicy, SessionPrompt } from "./api.js";
import { rulesForLevel, type PermissionRequest, type QuestionInfo } from "./approvals.js";
import type { OpenCodeClient, OpenCodeEvent, OpenCodeMessage, OpenCodePromptBody, OpenCodeSession } from "./client.js";
import { OpenCodeTurnTranslator } from "./events.js";
import { openCodeToolSwitches } from "./tools.js";

/** OpenCode 1.x behind the generation-neutral interface. */

const PLAN_AGENT = "plan";
/** A plan reaches the transcript as a block Plan Kit draws as a card. */
const PLAN_SYSTEM = "You are in plan mode: explore and ask, change nothing. When the plan is ready, write it once inside a <proposed_plan> block.";

function native(session: OpenCodeSession): NativeSession {
  return {
    id: session.id,
    ...(session.title ? { title: session.title } : {}),
    ...(session.parentID ? { parentId: session.parentID } : {}),
    ...(session.tokens ? { tokens: session.tokens } : {}),
    ...(session.cost !== undefined ? { cost: session.cost } : {}),
  };
}

/** Visible text of a conversation; an assistant's text parts of one run join into one reply. */
export function visibleMessages(messages: readonly OpenCodeMessage[]): HistoryTranscript {
  const kept: HistoryMessage[] = [];
  let model: { provider: string; id: string } | undefined;
  for (const message of messages) {
    const role = message.info?.role;
    if (role !== "user" && role !== "assistant") continue;
    const text = message.parts
      .filter((part) => part.type === "text" && typeof part.text === "string" && part.synthetic !== true && part.ignored !== true)
      .map((part) => String(part.text).trim())
      .filter(Boolean)
      .join("\n\n");
    if (role === "assistant" && message.info.providerID && message.info.modelID) model = { provider: message.info.providerID, id: message.info.modelID };
    if (!text) continue;
    const timestamp = message.info.time?.created ?? Date.now();
    const last = kept.at(-1);
    if (role === "assistant" && last?.role === "assistant") last.text = `${last.text}\n\n${text}`;
    else kept.push({ role, text, timestamp });
  }
  return { messages: kept, ...(model ? { model } : {}) };
}

export class OpenCode1Api implements OpenCodeApi {
  readonly generation = 1 as const;

  constructor(readonly client: OpenCodeClient) {}

  health() { return this.client.health(); }
  providers(directory: string) { return this.client.providers(directory); }
  config(directory: string) { return this.client.config(directory); }

  async createSession(directory: string, input: { title?: string; policy: SessionPolicy }): Promise<NativeSession> {
    return native(await this.client.createSession(directory, { ...(input.title ? { title: input.title } : {}), permission: rulesForLevel(input.policy.level) }));
  }

  async getSession(directory: string, id: string): Promise<NativeSession> {
    return native(await this.client.getSession(directory, id));
  }

  async applyPolicy(directory: string, id: string, policy: SessionPolicy): Promise<void> {
    await this.client.updateSession(directory, id, { permission: rulesForLevel(policy.level) });
  }

  async renameSession(directory: string, id: string, title: string): Promise<void> {
    await this.client.updateSession(directory, id, { title });
  }

  prompt(directory: string, id: string, prompt: SessionPrompt): Promise<void> {
    const body: OpenCodePromptBody = {
      parts: prompt.parts,
      ...(prompt.model ? { model: prompt.model } : {}),
      ...(prompt.variant ? { variant: prompt.variant } : {}),
      ...(prompt.plan ? { agent: PLAN_AGENT, system: PLAN_SYSTEM } : {}),
      ...(prompt.tools ? { tools: openCodeToolSwitches(prompt.tools) } : {}),
    };
    return this.client.promptAsync(directory, id, body);
  }

  abort(directory: string, id: string): Promise<void> { return this.client.abort(directory, id); }

  // A server Tau starts per thread has nothing left over from an earlier connection.
  async settle(): Promise<void> {}

  // OpenCode 1 loads a prompt's tools when the prompt arrives.
  async awaitTools(): Promise<void> {}

  replyPermission(directory: string, request: PermissionRequest, reply: "once" | "always" | "reject", message?: string): Promise<void> {
    return this.client.replyPermission(directory, request.id, reply, message);
  }

  async answerQuestion(directory: string, _sessionId: string, request: QuestionRequest, answers: string[][] | undefined): Promise<void> {
    await (answers ? this.client.replyQuestion(directory, request.id, answers) : this.client.rejectQuestion(directory, request.id));
  }

  subscribe(directory: string, onEvent: (event: OpenCodeEvent) => void, onEnd: (error?: Error) => void) {
    return this.client.subscribe(directory, onEvent, onEnd);
  }

  signal(event: OpenCodeEvent): OpenCodeSignal | undefined {
    const properties = event.properties;
    if (event.type === "session.created" || event.type === "session.updated") {
      const info = properties.info as OpenCodeSession | undefined;
      if (!info || typeof info.id !== "string") return undefined;
      return { kind: "session", sessionId: info.id, ...(info.parentID ? { parentId: info.parentID } : {}), ...(info.title ? { title: info.title } : {}), ...(info.tokens ? { usage: { tokens: info.tokens, ...(info.cost !== undefined ? { cost: info.cost } : {}) } } : {}) };
    }
    const sessionId = properties.sessionID;
    if (typeof sessionId !== "string") return undefined;
    if (event.type === "permission.asked") return { kind: "permission", sessionId, request: properties as unknown as PermissionRequest };
    if (event.type === "question.asked") {
      const request = properties as unknown as { id: string; questions: QuestionInfo[] };
      return typeof request.id === "string" && Array.isArray(request.questions) ? { kind: "question", sessionId, request: { id: request.id, questions: request.questions } } : undefined;
    }
    return { kind: "turn", sessionId, type: event.type, properties };
  }

  translator(now: () => number) { return new OpenCodeTurnTranslator(now); }

  async listHistory(query: { roots?: boolean; limit?: number }): Promise<HistorySession[]> {
    return (await this.client.listAllSessions(query)).map((session): HistorySession => ({
      id: session.id,
      directory: session.directory,
      ...(session.title ? { title: session.title } : {}),
      ...(session.parentID ? { parentId: session.parentID } : {}),
      ...(session.time?.archived ? { archived: true } : {}),
      ...(session.time?.updated !== undefined ? { updatedAt: session.time.updated } : {}),
      ...(session.time?.created !== undefined ? { createdAt: session.time.created } : {}),
      ...(session.tokens ? { tokens: session.tokens } : {}),
      ...(session.cost !== undefined ? { cost: session.cost } : {}),
    }));
  }

  async historyMessages(directory: string, id: string): Promise<HistoryTranscript> {
    return visibleMessages(await this.client.messages(directory, id));
  }
}
