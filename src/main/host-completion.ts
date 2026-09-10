import { SettingsManager, type ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { UiModel } from "../shared/contracts.js";
import { modelAttribution } from "./model-attribution.js";
import { modelLogin } from "./model-login.js";
import { createPiModelRuntime } from "./pi-model-runtime.js";
import type { CompletionRequest } from "./runtime-types.js";

/**
 * One short answer for an extension's small job — a thread title, a branch
 * name, a commit message. It runs on the user's own model configuration in
 * `~/.pi/agent`, deliberately apart from the thread the job is about: which
 * program answers a conversation says nothing about which model should name
 * it, and a thread whose runtime cannot complete at all would otherwise go
 * unnamed.
 */
export interface HostCompletionOptions {
  agentDir: string;
  cwd(): string;
  /** The model runtime to complete on; the user's Pi configuration otherwise. */
  createRuntime?(agentDir: string): Promise<ModelRuntime>;
  settings?(cwd: string, agentDir: string): { getDefaultProvider(): string | undefined; getDefaultModel(): string | undefined };
}

export class HostCompletions {
  private cached?: Promise<ModelRuntime>;

  constructor(private readonly options: HostCompletionOptions) {}

  /** What `complete` can be asked for: the user's own catalog, whichever runtime owns the visible thread. */
  async models(): Promise<UiModel[]> {
    const runtime = await this.runtime();
    return (await runtime.getAvailable()).map((model) => ({
      provider: model.provider,
      id: model.id,
      name: model.name ?? model.id,
      ...(modelLogin(runtime, model.provider) ? { login: "subscription" as const } : {}),
    }));
  }

  private runtime(): Promise<ModelRuntime> {
    return (this.cached ??= (this.options.createRuntime ?? createPiModelRuntime)(this.options.agentDir));
  }

  async complete(request: CompletionRequest, model?: { provider: string; id: string }): Promise<string> {
    const runtime = await this.runtime();
    const resolved = this.resolve(runtime, model);
    if (!resolved) {
      throw new Error(model
        ? `Unknown model: ${model.provider}/${model.id}`
        : "No model is configured for this. Choose one in the extension's settings, or set a default model in ~/.pi/agent.");
    }
    const attribution = modelAttribution(resolved);
    const response = await runtime.completeSimple(
      resolved,
      { systemPrompt: request.system, messages: [{ role: "user", content: [{ type: "text", text: request.prompt }], timestamp: Date.now() }] },
      {
        maxTokens: request.maxTokens ?? 48,
        cacheRetention: "none",
        timeoutMs: 30_000,
        sessionId: attribution.sessionId,
        ...(attribution.headers ? { headers: attribution.headers } : {}),
      },
    );
    if (response.stopReason === "error" || response.stopReason === "aborted") {
      throw new Error(response.errorMessage || "The model did not complete.");
    }
    return response.content.map((part) => part.type === "text" ? part.text : "").join("").trim();
  }

  /** The named model, else Pi's own default; a default without a provider is matched by id. */
  private resolve(runtime: ModelRuntime, model: { provider: string; id: string } | undefined): ReturnType<ModelRuntime["getModel"]> {
    if (model) return runtime.getModel(model.provider, model.id);
    const settings = (this.options.settings ?? ((cwd, agentDir) => SettingsManager.create(cwd, agentDir)))(this.options.cwd(), this.options.agentDir);
    const id = settings.getDefaultModel();
    if (!id) return undefined;
    const provider = settings.getDefaultProvider();
    return provider ? runtime.getModel(provider, id) : runtime.getModels().find((candidate) => candidate.id === id);
  }
}
