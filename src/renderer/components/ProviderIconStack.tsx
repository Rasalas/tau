import anthropicIcon from "@lobehub/icons-static-svg/icons/anthropic.svg?no-inline";
import claudeCodeIcon from "@lobehub/icons-static-svg/icons/claudecode.svg?no-inline";
import antigravityIcon from "@lobehub/icons-static-svg/icons/antigravity-color.svg?no-inline";
import codexIcon from "@lobehub/icons-static-svg/icons/codex-color.svg?no-inline";
import geminiIcon from "@lobehub/icons-static-svg/icons/gemini-color.svg?no-inline";
import openAiIcon from "@lobehub/icons-static-svg/icons/openai.svg?no-inline";
import openCodeIcon from "@lobehub/icons-static-svg/icons/opencode.svg?no-inline";
import piIcon from "@lobehub/icons-static-svg/icons/pi.svg?no-inline";
import vertexAiIcon from "@lobehub/icons-static-svg/icons/vertexai-color.svg?no-inline";
import { useContext, useSyncExternalStore } from "react";
import { providerMarks, useRuntimeMarkDeclarations, type RuntimeMarkDeclarations } from "../runtime-marks";
import { WorkbenchShellContext } from "../workbench-context";
import { runtimeDriver } from "../../shared/runtime-instances";
import { tooltipProps, type TooltipOptions } from "./ui/Tooltip";
import "./provider-marks.css";

interface ProviderIdentity {
  family: string;
  label: string;
  source?: string;
  color?: boolean;
  /** Drawn by `provider-marks.css`, which keeps these marks out of the initial script. */
  styled?: boolean;
  fallback: string;
}

/** The display name of a model provider or runtime, as the icons know it. */
export function providerLabel(value: string): string {
  return providerIdentity(value)?.label ?? value;
}

function providerIdentity(value: string | undefined): ProviderIdentity | undefined {
  if (!value) return undefined;
  // A runtime instance (`codex@work`) is drawn as its program.
  const key = runtimeDriver(value).toLocaleLowerCase().replace(/[_.\s]/gu, "-");
  if (["anthropic", "claude"].includes(key)) return { family: "anthropic", label: "Anthropic", source: anthropicIcon, fallback: "A" };
  if (key === "claude-code") return { family: "claude-code", label: "Claude Code", source: claudeCodeIcon, fallback: "C" };
  if (key === "antigravity") return { family: "antigravity", label: "Antigravity", source: antigravityIcon, color: true, fallback: "A" };
  if (key === "codex") return { family: "codex", label: "Codex", source: codexIcon, color: true, fallback: "C" };
  if (key === "openai-codex") return PLANS.codex;
  if (["openai", "gpt"].includes(key)) return { family: "openai", label: "OpenAI", source: openAiIcon, fallback: "O" };
  if (["google", "google-gemini", "gemini"].includes(key)) return { family: "gemini", label: "Google Gemini", source: geminiIcon, color: true, fallback: "G" };
  if (["vertex-ai", "vertexai", "google-vertex"].includes(key)) return { family: "vertex-ai", label: "Vertex AI", source: vertexAiIcon, color: true, fallback: "V" };
  if (["opencode", "opencode-go"].includes(key)) return { family: "opencode", label: key === "opencode-go" ? "OpenCode Go" : "OpenCode", source: openCodeIcon, fallback: "O" };
  if (key === "pi") return { family: "pi", label: "Pi", source: piIcon, fallback: "P" };
  const known = KNOWN.find(([, keys]) => keys.some((name) => key === name || key.startsWith(`${name}-`)));
  if (known) {
    const [label, keys] = known;
    // A variant (`minimax-cn`) keeps its own name, so two of them tell apart.
    return { family: keys[0]!, label: keys.includes(key) ? label : value, styled: true, fallback: monogram(label) };
  }
  return { family: key, label: value, fallback: monogram(value) };
}

/** A subscription plan wears its product's mark, as a ChatGPT plan wears Codex's. */
const PLANS = {
  codex: { family: "codex", label: "ChatGPT plan", source: codexIcon, color: true, fallback: "C" },
  claude: { family: "claude-code", label: "Claude plan", source: claudeCodeIcon, fallback: "C" },
  grok: { family: "grok", label: "Grok plan", styled: true, fallback: "G" },
} satisfies Record<string, ProviderIdentity>;

function planIdentity(value: string | undefined): ProviderIdentity | undefined {
  const identity = providerIdentity(value);
  if (identity?.family === "anthropic") return PLANS.claude;
  if (identity?.family === "xai") return PLANS.grok;
  return identity;
}

/** Providers whose mark `provider-marks.css` draws, keyed by their family (the first key); a key also matches `<key>-…`. */
const KNOWN: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["OpenRouter", ["openrouter"]],
  ["DeepSeek", ["deepseek"]],
  ["xAI", ["xai"]],
  ["Grok", ["grok"]],
  ["Mistral", ["mistral"]],
  ["Groq", ["groq"]],
  ["Cerebras", ["cerebras"]],
  ["Fireworks", ["fireworks"]],
  ["Together AI", ["together"]],
  ["Hugging Face", ["huggingface"]],
  ["Moonshot AI", ["moonshot", "moonshotai"]],
  ["Kimi", ["kimi"]],
  ["MiniMax", ["minimax"]],
  ["Z.ai", ["zai"]],
  ["Qwen", ["qwen"]],
  ["NVIDIA", ["nvidia"]],
  ["Amazon Bedrock", ["bedrock", "amazon-bedrock"]],
  ["Azure OpenAI", ["azure", "azure-openai", "azure-openai-responses"]],
  ["GitHub Copilot", ["copilot", "github-copilot"]],
  ["Vercel AI Gateway", ["vercel", "vercel-ai-gateway"]],
  ["Cloudflare", ["cloudflare"]],
  ["Xiaomi MiMo", ["xiaomi"]],
  ["Ollama", ["ollama"]],
  ["LM Studio", ["lmstudio"]],
  ["Cursor", ["cursor"]],
];

/** Whether Tau draws a mark of its own for this provider or runtime; any other gets a kit's picture or its initial. */
export function providerHasMark(value: string): boolean {
  const identity = providerIdentity(value);
  return Boolean(identity?.source || identity?.styled);
}

/** One or two letters for a provider without a mark: "radius" → "R", "ant-ling" → "AL". */
export function monogram(value: string): string {
  const words = value.trim().split(/[\s_\-.:/]+/u).filter(Boolean);
  const letters = (words.length > 1 ? words.slice(0, 2).map((word) => word.charAt(0)) : [words[0]?.charAt(0) ?? ""]).join("");
  return letters.toUpperCase() || "·";
}

const noSubscribe = () => () => undefined;

/** A kit's picture for a provider Tau has no mark for (`setProviderIcons`). */
function useProviderPicture(value: string | undefined): string | undefined {
  const registry = useContext(WorkbenchShellContext)?.registry;
  return useSyncExternalStore(registry?.subscribe ?? noSubscribe, () => (value ? registry?.providerIcon(value) : undefined));
}

function ProviderIcon({ identity, layer, value }: { identity: ProviderIdentity; layer: "model" | "runtime"; value?: string | undefined }) {
  const picture = useProviderPicture(identity.source || identity.styled ? undefined : value);
  const mark = picture
    ? <img className="provider-mark provider-mark-picture" src={picture} alt="" />
    : identity.styled
    ? <span className="provider-mark provider-mark-styled" />
    : identity.source
    ? identity.color
      ? <img className="provider-mark" src={identity.source} alt="" />
      : <span className="provider-mark provider-mark-mono" style={{ maskImage: `url("${identity.source}")`, WebkitMaskImage: `url("${identity.source}")` }} />
    : identity.fallback;
  return (
    <span className={`provider-icon provider-icon-${layer} provider-family-${identity.family}${picture || identity.source || identity.styled ? "" : " provider-icon-fallback"}`}>
      {mark}
    </span>
  );
}

function stackIdentities(modelProvider: string | undefined, runtimeProvider: string | undefined, plan: boolean | undefined, runtimeName?: string, runtimes?: RuntimeMarkDeclarations) {
  const marks = providerMarks(modelProvider, runtimeProvider, { plan: plan === true, ...(runtimes ? { runtimes } : {}) });
  const model = marks.plan ? planIdentity(marks.model) : providerIdentity(marks.model);
  const runtime = providerIdentity(marks.runtime);
  const home = providerIdentity(marks.home);
  const runtimeLabel = runtimeName ?? runtime?.label;
  const route = model && runtimeLabel
    ? `${runtimeLabel} via ${model.label}`
    : runtimeLabel && home && home.label !== runtimeLabel
      ? `${runtimeLabel} (${home.label})`
      : model?.label ?? runtimeLabel ?? "Unknown provider";
  return { model, runtime, route, marks };
}

/** What `ProviderIconStack` names its marks without a model name: "Pi via OpenAI", "Codex (OpenAI)". */
export function providerStackLabel(modelProvider: string | undefined, runtimeProvider: string | undefined, options: { plan?: boolean } = {}): string {
  return stackIdentities(modelProvider, runtimeProvider, options.plan).route;
}

/**
 * The marks `providerMarks` gives a model provider and the runtime that runs it: the provider's (or plan's) mark
 * and the runtime's side by side, or one mark alone. `hint` names them on hover: a native title
 * by default, the tooltip layer's with options, nothing with `false` (inside a control that names itself). `name`
 * replaces the whole name; `runtimeName` only the runtime's (an instance's), and `modelName` leads it. `plan` says
 * the provider is reached through a subscription plan, where its id alone does not tell. `runtimeMark: false` leaves
 * the runtime's mark out where the surrounding UI already names the runtime; the name keeps it.
 */
export function ProviderIconStack({ modelProvider, runtimeProvider, plan, runtimeMark = true, modelName, runtimeName, className, hint, name }: {
  modelProvider?: string;
  runtimeProvider?: string;
  plan?: boolean;
  runtimeMark?: boolean;
  modelName?: string;
  runtimeName?: string;
  className?: string;
  hint?: TooltipOptions | false;
  name?: string;
}) {
  const runtimes = useRuntimeMarkDeclarations();
  const { model, runtime, route, marks } = stackIdentities(modelProvider, runtimeProvider, plan, runtimeName, runtimes);
  if (!model && !runtime) return null;
  const label = name ?? (modelName ? `${modelName} · ${route}` : route);
  const stacked = Boolean(runtimeMark && model && runtime);
  return (
    <span className={`provider-icon-stack ${stacked ? "stacked" : "single"}${className ? ` ${className}` : ""}`} role="img" aria-label={label} {...(hint === undefined ? { title: label } : hint ? tooltipProps(label, hint) : {})}>
      {model ? <ProviderIcon identity={model} layer="model" value={marks.model} /> : runtime ? <ProviderIcon identity={runtime} layer="model" value={marks.runtime} /> : null}
      {stacked && runtime ? <ProviderIcon identity={runtime} layer="runtime" value={marks.runtime} /> : null}
    </span>
  );
}
