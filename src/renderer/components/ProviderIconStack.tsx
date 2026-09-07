import claudeIcon from "@lobehub/icons-static-svg/icons/claude-color.svg?no-inline";
import claudeCodeIcon from "@lobehub/icons-static-svg/icons/claudecode-color.svg?no-inline";
import antigravityIcon from "@lobehub/icons-static-svg/icons/antigravity-color.svg?no-inline";
import geminiIcon from "@lobehub/icons-static-svg/icons/gemini-color.svg?no-inline";
import openAiIcon from "@lobehub/icons-static-svg/icons/openai.svg?no-inline";
import openCodeIcon from "@lobehub/icons-static-svg/icons/opencode.svg?no-inline";
import kiConnectIcon from "../assets/providers/ki-connect.png";

interface ProviderIdentity {
  family: string;
  label: string;
  source?: string;
  fallback: string;
}

/** The display name of a model provider or runtime, as the icons know it. */
export function providerLabel(value: string): string {
  return providerIdentity(value)?.label ?? value;
}

/** Whether this provider has a mark of its own; a letter beside its name would only repeat it. */
export function hasProviderMark(value: string | undefined): boolean {
  return providerIdentity(value)?.source !== undefined;
}

function providerIdentity(value: string | undefined, runtime = false): ProviderIdentity | undefined {
  if (!value) return undefined;
  const key = value.toLocaleLowerCase().replace(/[_.\s]/gu, "-");
  if (["anthropic", "claude"].includes(key)) return { family: "claude", label: "Claude", source: claudeIcon, fallback: "C" };
  if (key === "claude-code") return { family: "claude", label: "Claude Code", source: claudeCodeIcon, fallback: "C" };
  if (key === "antigravity") return { family: "google", label: "Antigravity", source: antigravityIcon, fallback: "A" };
  if (["openai", "openai-codex", "gpt"].includes(key)) return { family: "openai", label: "OpenAI", source: openAiIcon, fallback: "O" };
  if (["google", "google-gemini", "gemini", "vertex-ai", "vertexai"].includes(key)) return { family: "google", label: "Google Gemini", source: geminiIcon, fallback: "G" };
  if (key === "opencode") return { family: "opencode", label: "OpenCode", source: openCodeIcon, fallback: "O" };
  if (["ki:connect", "ki-connect", "kiconnect"].includes(key)) return { family: "ki-connect", label: "KI:connect", source: kiConnectIcon, fallback: "K" };
  if (runtime && key === "pi") return undefined;
  return { family: key, label: value, fallback: value.trim().charAt(0).toUpperCase() || "·" };
}

function ProviderIcon({ identity, layer }: { identity: ProviderIdentity; layer: "model" | "runtime" }) {
  return (
    <span className={`provider-icon provider-icon-${layer} provider-family-${identity.family}`}>
      {identity.source ? <img src={identity.source} alt="" /> : identity.fallback}
    </span>
  );
}

export function ProviderIconStack({ modelProvider, runtimeProvider = "pi", className }: { modelProvider?: string; runtimeProvider?: string; className?: string }) {
  const model = providerIdentity(modelProvider);
  const runtime = providerIdentity(runtimeProvider, true);
  // The runtime's logo sits behind the model's unless it is the same program (Pi shows none).
  const distinctRuntime = runtime && (runtime.family !== model?.family || runtime.label !== model?.label) ? runtime : undefined;
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
