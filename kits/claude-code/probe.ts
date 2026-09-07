import type { AccountInfo, ModelInfo, Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { UiModel } from "tau/host-extension";
import type { ClaudeQuery } from "./runtime-adapter.js";

export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];

export interface ClaudeProbe {
  /** What the plan offers, in the CLI's own order. */
  models: UiModel[];
  modelInfos: ModelInfo[];
  account?: AccountInfo;
  claudeCodeVersion?: string;
  /** The model the CLI would pick on its own. */
  defaultModel?: string;
  effort?: string;
  probedAt: number;
}

export interface ProbeInput {
  query: ClaudeQuery;
  executable: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** Bedrock setups boot slowly; the default leaves them room. */
  timeoutMs?: number;
  now?(): number;
}

export function uiModel(info: ModelInfo): UiModel {
  return { provider: "anthropic", id: info.value, name: info.displayName || info.value };
}

/** A plan label for the status page, from what the CLI knows about its login. */
export function describeAccount(account: AccountInfo | undefined, apiKeySource?: string): string {
  if (!account) return apiKeySource && apiKeySource !== "none" ? `API key (${apiKeySource})` : "signed in";
  const provider = account.apiProvider;
  if (provider && provider !== "firstParty") return `via ${provider}`;
  if (account.subscriptionType) return `Claude ${account.subscriptionType}`;
  if (account.tokenSource === "apiKey" || (account.apiKeySource && account.apiKeySource !== "none")) return "API key";
  return "signed in";
}

/**
 * Asks the CLI about itself without spending a token: a session whose prompt
 * never yields completes local initialization, reports account and models,
 * and is aborted before it could issue a request. Hooks stay off, since this
 * runs on a timer; nothing is persisted.
 */
export async function probeClaude(input: ProbeInput): Promise<ClaudeProbe> {
  const controller = new AbortController();
  const now = input.now ?? Date.now;
  // An input that ends only when the probe is aborted, so the CLI never starts a turn.
  const prompt: AsyncIterable<never> = {
    [Symbol.asyncIterator]() {
      const done = { done: true as const, value: undefined as never };
      return {
        next: () => new Promise<IteratorResult<never>>((resolve) => {
          if (controller.signal.aborted) resolve(done);
          else controller.signal.addEventListener("abort", () => resolve(done), { once: true });
        }),
        return: async () => done,
      };
    },
  };
  const options: Options = {
    cwd: input.cwd,
    pathToClaudeCodeExecutable: input.executable,
    env: input.env,
    permissionMode: "plan",
    persistSession: false,
    settings: { disableAllHooks: true },
    allowedTools: [],
    mcpServers: {},
    strictMcpConfig: true,
    abortController: controller,
    stderr: () => undefined,
  };
  const session = input.query({ prompt, options });
  let init: (SDKMessage & { type: "system" }) | undefined;
  const consumed = (async () => {
    for await (const message of session) {
      if (message.type === "system" && (message as { subtype: string }).subtype === "init") init = message as typeof init;
    }
  })().catch(() => undefined);
  try {
    const result = await Promise.race([
      session.initializationResult(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`Claude Code did not report its account and models within ${input.timeoutMs ?? 25_000} ms.`)), input.timeoutMs ?? 25_000).unref?.()),
    ]);
    const initFrame = init as { claude_code_version?: string; model?: string; effort?: string | null } | undefined;
    return {
      models: result.models.map(uiModel),
      modelInfos: result.models,
      account: result.account,
      ...(initFrame?.claude_code_version ? { claudeCodeVersion: initFrame.claude_code_version } : {}),
      ...(initFrame?.model ? { defaultModel: initFrame.model } : {}),
      ...(initFrame?.effort ? { effort: initFrame.effort } : {}),
      probedAt: now(),
    };
  } finally {
    controller.abort();
    await consumed;
  }
}
