import anthropicIcon from "@lobehub/icons-static-svg/icons/anthropic.svg?no-inline";
import claudeCodeIcon from "@lobehub/icons-static-svg/icons/claudecode.svg?no-inline";
import antigravityIcon from "@lobehub/icons-static-svg/icons/antigravity-color.svg?no-inline";
import geminiIcon from "@lobehub/icons-static-svg/icons/gemini-color.svg?no-inline";
import openAiIcon from "@lobehub/icons-static-svg/icons/openai.svg?no-inline";
import openCodeIcon from "@lobehub/icons-static-svg/icons/opencode.svg?no-inline";
import piIcon from "@lobehub/icons-static-svg/icons/pi.svg?no-inline";
import vertexAiIcon from "@lobehub/icons-static-svg/icons/vertexai-color.svg?no-inline";
import kiConnectIcon from "../assets/providers/ki-connect.png";

interface ProviderIdentity {
  family: string;
  label: string;
  source?: string;
  color?: boolean;
  fallback: string;
}

/** The display name of a model provider or runtime, as the icons know it. */
export function providerLabel(value: string): string {
  return providerIdentity(value)?.label ?? value;
}

function providerIdentity(value: string | undefined): ProviderIdentity | undefined {
  if (!value) return undefined;
  const key = value.toLocaleLowerCase().replace(/[_.\s]/gu, "-");
  if (["anthropic", "claude"].includes(key)) return { family: "anthropic", label: "Anthropic", source: anthropicIcon, fallback: "A" };
  if (key === "claude-code") return { family: "claude-code", label: "Claude Code", source: claudeCodeIcon, fallback: "C" };
  if (key === "antigravity") return { family: "antigravity", label: "Antigravity", source: antigravityIcon, color: true, fallback: "A" };
  if (["openai", "openai-codex", "gpt"].includes(key)) return { family: "openai", label: "OpenAI", source: openAiIcon, fallback: "O" };
  if (["google", "google-gemini", "gemini"].includes(key)) return { family: "gemini", label: "Google Gemini", source: geminiIcon, color: true, fallback: "G" };
  if (["vertex-ai", "vertexai"].includes(key)) return { family: "vertex-ai", label: "Vertex AI", source: vertexAiIcon, color: true, fallback: "V" };
  if (["opencode", "opencode-go"].includes(key)) return { family: "opencode", label: key === "opencode-go" ? "OpenCode Go" : "OpenCode", source: openCodeIcon, fallback: "O" };
  if (["ki:connect", "ki-connect", "kiconnect"].includes(key)) return { family: "ki-connect", label: "KI:connect", source: kiConnectIcon, color: true, fallback: "K" };
  if (key === "pi") return { family: "pi", label: "Pi", source: piIcon, fallback: "P" };
  return { family: key, label: value, fallback: value.trim().charAt(0).toUpperCase() || "·" };
}

function ProviderIcon({ identity, layer }: { identity: ProviderIdentity; layer: "model" | "runtime" }) {
  const mark = identity.source
    ? identity.color
      ? <img className="provider-mark" src={identity.source} alt="" />
      : <span className="provider-mark provider-mark-mono" style={{ maskImage: `url("${identity.source}")`, WebkitMaskImage: `url("${identity.source}")` }} />
    : identity.fallback;
  return (
    <span className={`provider-icon provider-icon-${layer} provider-family-${identity.family}${identity.source ? "" : " provider-icon-fallback"}`}>
      {mark}
    </span>
  );
}

export function ProviderIconStack({ modelProvider, runtimeProvider = "pi", className }: { modelProvider?: string; runtimeProvider?: string; className?: string }) {
  const model = providerIdentity(modelProvider);
  const runtime = providerIdentity(runtimeProvider);
  // Keep the runtime and model provider as a pair unless both identify the same program.
  const distinctRuntime = model && runtime && (runtime.family !== model.family || runtime.label !== model.label) ? runtime : undefined;
  if (!model && !runtime) return null;
  const label = model && distinctRuntime
    ? `${model.label} via ${distinctRuntime.label}`
    : model?.label ?? runtime?.label ?? "Unknown provider";
  return (
    <span className={`provider-icon-stack ${distinctRuntime ? "stacked" : "single"}${className ? ` ${className}` : ""}`} role="img" aria-label={label} title={label}>
      {distinctRuntime ? <ProviderIcon identity={distinctRuntime} layer="runtime" /> : null}
      {model ? <ProviderIcon identity={model} layer="model" /> : runtime ? <ProviderIcon identity={runtime} layer="model" /> : null}
    </span>
  );
}
