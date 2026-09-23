import anthropicIcon from "@lobehub/icons-static-svg/icons/anthropic.svg?no-inline";
import claudeCodeIcon from "@lobehub/icons-static-svg/icons/claudecode.svg?no-inline";
import antigravityIcon from "@lobehub/icons-static-svg/icons/antigravity-color.svg?no-inline";
import codexIcon from "@lobehub/icons-static-svg/icons/codex-color.svg?no-inline";
import cursorIcon from "@lobehub/icons-static-svg/icons/cursor.svg?no-inline";
import geminiIcon from "@lobehub/icons-static-svg/icons/gemini-color.svg?no-inline";
import openAiIcon from "@lobehub/icons-static-svg/icons/openai.svg?no-inline";
import openCodeIcon from "@lobehub/icons-static-svg/icons/opencode.svg?no-inline";
import piIcon from "@lobehub/icons-static-svg/icons/pi.svg?no-inline";
import vertexAiIcon from "@lobehub/icons-static-svg/icons/vertexai-color.svg?no-inline";
import kiConnectIcon from "../assets/providers/ki-connect.png";
import { providerMarks } from "../runtime-marks";
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
  if (["openai", "openai-codex", "gpt"].includes(key)) return { family: "openai", label: "OpenAI", source: openAiIcon, fallback: "O" };
  if (["google", "google-gemini", "gemini"].includes(key)) return { family: "gemini", label: "Google Gemini", source: geminiIcon, color: true, fallback: "G" };
  if (["vertex-ai", "vertexai", "google-vertex"].includes(key)) return { family: "vertex-ai", label: "Vertex AI", source: vertexAiIcon, color: true, fallback: "V" };
  if (key === "cursor") return { family: "cursor", label: "Cursor", source: cursorIcon, fallback: "C" };
  if (["opencode", "opencode-go"].includes(key)) return { family: "opencode", label: key === "opencode-go" ? "OpenCode Go" : "OpenCode", source: openCodeIcon, fallback: "O" };
  if (["ki:connect", "ki-connect", "kiconnect"].includes(key)) return { family: "ki-connect", label: "KI:connect", source: kiConnectIcon, color: true, fallback: "K" };
  if (key === "pi") return { family: "pi", label: "Pi", source: piIcon, fallback: "P" };
  const known = KNOWN.find(([, keys]) => keys.some((name) => key === name || key.startsWith(`${name}-`)));
  if (known) {
    const [label, keys] = known;
    // A variant (`minimax-cn`) keeps its own name, so two of them tell apart.
    return { family: keys[0]!, label: keys.includes(key) ? label : value, styled: true, fallback: monogram(label) };
  }
  return { family: key, label: value, fallback: monogram(value) };
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

/** One or two letters for a provider without a mark: "radius" → "R", "ant-ling" → "AL". */
export function monogram(value: string): string {
  const words = value.trim().split(/[\s_\-.:/]+/u).filter(Boolean);
  const letters = (words.length > 1 ? words.slice(0, 2).map((word) => word.charAt(0)) : [words[0]?.charAt(0) ?? ""]).join("");
  return letters.toUpperCase() || "·";
}

function ProviderIcon({ identity, layer }: { identity: ProviderIdentity; layer: "model" | "runtime" }) {
  const mark = identity.styled
    ? <span className="provider-mark provider-mark-styled" />
    : identity.source
    ? identity.color
      ? <img className="provider-mark" src={identity.source} alt="" />
      : <span className="provider-mark provider-mark-mono" style={{ maskImage: `url("${identity.source}")`, WebkitMaskImage: `url("${identity.source}")` }} />
    : identity.fallback;
  return (
    <span className={`provider-icon provider-icon-${layer} provider-family-${identity.family}${identity.source || identity.styled ? "" : " provider-icon-fallback"}`}>
      {mark}
    </span>
  );
}

/**
 * A model provider's mark, with the runtime's beside it where `providerMarks` says it tells something apart.
 * `hint` names it on hover: a native title by default, the tooltip layer's with options, nothing with `false`
 * (inside a control that names itself). `name` replaces the name the marks know, e.g. an instance's.
 */
export function ProviderIconStack({ modelProvider, runtimeProvider, className, hint, name }: { modelProvider?: string; runtimeProvider?: string; className?: string; hint?: TooltipOptions | false; name?: string }) {
  const marks = providerMarks(modelProvider, runtimeProvider);
  const model = providerIdentity(marks.model);
  const runtime = providerIdentity(marks.runtime);
  // Keep the runtime and model provider as a pair unless both identify the same program.
  const distinctRuntime = model && runtime && (runtime.family !== model.family || runtime.label !== model.label) ? runtime : undefined;
  if (!model && !runtime) return null;
  const label = name ?? (model && distinctRuntime
    ? `${model.label} via ${distinctRuntime.label}`
    : model?.label ?? runtime?.label ?? "Unknown provider");
  return (
    <span className={`provider-icon-stack ${distinctRuntime ? "stacked" : "single"}${className ? ` ${className}` : ""}`} role="img" aria-label={label} {...(hint === undefined ? { title: label } : hint ? tooltipProps(label, hint) : {})}>
      {distinctRuntime ? <ProviderIcon identity={distinctRuntime} layer="runtime" /> : null}
      {model ? <ProviderIcon identity={model} layer="model" /> : runtime ? <ProviderIcon identity={runtime} layer="model" /> : null}
    </span>
  );
}
