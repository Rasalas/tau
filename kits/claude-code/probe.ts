import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AccountInfo, ModelInfo, Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { commandInvocation, type UiModel } from "tau/host-extension";
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
  return { provider: "anthropic", id: info.value, name: versionedModelName(info) };
}

/**
 * The CLI's display names drop the generation ("Sonnet", "Opus (1M context)");
 * the wire id it resolves to carries it. A name without a version gets it back
 * from that id: "Sonnet 5", "Opus 5 (1M context)", "Default (recommended) · Sonnet 5".
 */
export function versionedModelName(info: Pick<ModelInfo, "value" | "displayName" | "resolvedModel">): string {
  const shown = (info.displayName || info.value).trim();
  const parsed = parseClaudeModelId(info.resolvedModel ?? info.value);
  if (!parsed || new RegExp(`\\b${parsed.version.replace(".", "\\.")}\\b`, "u").test(shown)) return shown;
  const family = parsed.family.charAt(0).toUpperCase() + parsed.family.slice(1);
  const pattern = new RegExp(`\\b${family}\\b`, "iu");
  if (pattern.test(shown)) return shown.replace(pattern, `${family} ${parsed.version}`);
  return `${shown} · ${family} ${parsed.version}`;
}

/** "claude-fable-5-1[1m]" → family "fable", version "5.1"; undefined for anything else. */
export function parseClaudeModelId(id: string): { family: string; version: string } | undefined {
  const match = /^claude-([a-z]+)-(\d+)(?:-(\d+))?(?:-\d{8})?(?:\[.*\])?$/u.exec(id.trim());
  if (!match) return undefined;
  return { family: match[1]!, version: match[3] ? `${match[2]}.${match[3]}` : match[2]! };
}

/** A plan label for the status page, from what the CLI knows about its login. */
/**
 * The CLI's own version. The initialize response carries none and the init
 * frame only arrives with a turn, so a page that wants the version asks the
 * binary. Never throws: an unreadable version is simply unknown.
 */
export async function readClaudeVersion(command: string, run: typeof execFile = execFile): Promise<string | undefined> {
  try {
    const invocation = commandInvocation(command, ["--version"]);
    const { stdout } = await promisify(run)(invocation.command, invocation.args, { timeout: 5_000, windowsHide: true, windowsVerbatimArguments: invocation.windowsVerbatimArguments });
    return /\d+\.\d+\.\d+[^\s]*/u.exec(String(stdout))?.[0];
  } catch {
    return undefined;
  }
}

export function describeAccount(account: AccountInfo | undefined, apiKeySource?: string): string {
  if (!account) return apiKeySource && apiKeySource !== "none" ? `API key (${apiKeySource})` : "signed in";
  const provider = account.apiProvider;
  if (provider && provider !== "firstParty") return `via ${provider}`;
  // The CLI names the plan either way round ("Max" or "Claude Max").
  if (account.subscriptionType) return /^claude\b/iu.test(account.subscriptionType) ? account.subscriptionType : `Claude ${account.subscriptionType}`;
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
