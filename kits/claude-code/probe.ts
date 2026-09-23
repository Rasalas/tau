import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AccountInfo, ModelInfo, Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { commandInvocation, type HostCatalogModel, type HostRuntimeNewThreadCatalog, type SignInAccount, type UiModel, type UiModelBilling } from "tau/host-extension";
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

/** What `auth status --json` prints: whether the CLI can reach a model, and through what. */
export interface ClaudeAuthStatus {
  loggedIn: boolean;
  /** `claude.ai`, `api_key`, `oauth_token` (a token in the environment), `third_party`, `none`. */
  authMethod?: string;
  /** `firstParty`, `bedrock`, `vertex`, `foundry`. */
  apiProvider?: string;
  /** Where a key comes from: a variable's name, or the key a console login stored. */
  apiKeySource?: string;
  email?: string;
  orgName?: string;
  subscriptionType?: string;
}

/**
 * Asks the CLI whether it is signed in, without a session: `auth status`
 * answers from its own files and the environment, and exits 1 when nothing
 * is set up. Undefined when the CLI cannot say (an older release).
 */
export async function readClaudeAuth(command: string, env: NodeJS.ProcessEnv, run: typeof execFile = execFile): Promise<ClaudeAuthStatus | undefined> {
  const invocation = commandInvocation(command, ["auth", "status", "--json"]);
  const stdout = await new Promise<string>((resolve) => {
    run(invocation.command, invocation.args, { env, timeout: 10_000, windowsHide: true, windowsVerbatimArguments: invocation.windowsVerbatimArguments }, (_error, out) => resolve(String(out ?? "")));
  });
  try {
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    if (typeof parsed.loggedIn !== "boolean") return undefined;
    const text = (key: string) => typeof parsed[key] === "string" && parsed[key] ? { [key]: parsed[key] as string } : {};
    return { loggedIn: parsed.loggedIn, ...text("authMethod"), ...text("apiProvider"), ...text("apiKeySource"), ...text("email"), ...text("orgName"), ...text("subscriptionType") };
  } catch {
    return undefined;
  }
}

/** The account row: who, through what, and whether a sign-out has anything to remove. */
export function claudeAuthAccount(auth: ClaudeAuthStatus | undefined): SignInAccount {
  if (!auth?.loggedIn) return { signedIn: false };
  const plan = auth.subscriptionType ? (/^claude\b/iu.test(auth.subscriptionType) ? auth.subscriptionType : `Claude ${auth.subscriptionType.charAt(0).toUpperCase()}${auth.subscriptionType.slice(1)}`) : undefined;
  // A key or token from the environment, or a cloud provider's account, is not the CLI's to forget.
  const fromEnvironment = auth.authMethod === "third_party" || auth.authMethod === "oauth_token" || /^[A-Z][A-Z0-9_]+$/u.test(auth.apiKeySource ?? "");
  if (auth.authMethod === "third_party") return { signedIn: true, label: `via ${auth.apiProvider ?? "a cloud provider"}`, detail: "Billed by that provider", canSignOut: false };
  if (auth.authMethod === "api_key") return { signedIn: true, label: auth.email ?? "API key", detail: auth.apiKeySource ? `API key · ${auth.apiKeySource}` : "API key", canSignOut: !fromEnvironment };
  return { signedIn: true, label: auth.email ?? plan ?? "Signed in", ...(auth.email && (plan ?? auth.orgName) ? { detail: [plan, auth.orgName].filter(Boolean).join(" · ") } : {}), canSignOut: !fromEnvironment };
}

/** How the account pays, from `auth status`: a plan is the subscription, anything else per token. */
export function authBilling(auth: ClaudeAuthStatus | undefined): UiModelBilling | undefined {
  if (!auth?.loggedIn) return undefined;
  return auth.authMethod === "claude.ai" || auth.subscriptionType ? "subscription" : "api-key";
}

/** A plan login is the subscription; a key or a cloud provider's account is billed per token. */
export function probeBilling(account: AccountInfo | undefined): UiModelBilling | undefined {
  if (!account) return undefined;
  if (account.apiProvider && account.apiProvider !== "firstParty") return "api-key";
  if (account.subscriptionType) return "subscription";
  return account.tokenSource === "apiKey" || (account.apiKeySource && account.apiKeySource !== "none") ? "api-key" : undefined;
}

/** A catalog row: the alias the CLI takes, priced by the wire id it resolves to. */
function catalogModel(info: ModelInfo, billing: UiModelBilling | undefined): HostCatalogModel {
  return {
    ...uiModel(info),
    ...(billing ? { billing } : {}),
    ...(info.resolvedModel ? { apiModelId: info.resolvedModel } : {}),
    ...(info.supportsEffort || info.supportsAdaptiveThinking || info.supportedEffortLevels?.length ? { reasoning: true } : {}),
  };
}

/**
 * What a new thread may start on, from a probe: the plan's models, the one the
 * CLI would pick itself, and each model's efforts after the CLI's own default.
 */
export function probeNewThreadCatalog(probe: Pick<ClaudeProbe, "modelInfos" | "defaultModel" | "effort" | "account">): HostRuntimeNewThreadCatalog {
  const infos = probe.modelInfos;
  const start = infos.find((info) => info.value === probe.defaultModel)
    ?? infos.find((info) => info.value !== "default" && info.resolvedModel === probe.defaultModel)
    ?? infos.find((info) => info.value === "default")
    ?? infos[0];
  const own = probe.effort ? `default (${probe.effort})` : "default";
  const billing = probeBilling(probe.account);
  return {
    models: infos.map((info) => catalogModel(info, billing)),
    ...(start ? { model: catalogModel(start, billing) } : {}),
    thinkingLevels: Object.fromEntries(infos.map((info) => [info.value, [own, ...(info.supportedEffortLevels ?? EFFORT_LEVELS)]])),
  };
}

