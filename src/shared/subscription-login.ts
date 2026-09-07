/**
 * What Tau says before a model is used through a subscription login Pi
 * performs. Pi offers those logins as a core feature, so Tau offers them too;
 * fairness means saying at the point of choice what the vendor's terms say.
 * Researched in docs/research/subscription-and-third-party-tools.md.
 */
export interface SubscriptionLoginWarning {
  title: string;
  message: string;
  /** The vendor's own statement, when there is one to point at. */
  source?: string;
}

const PROVIDER_NAMES: Record<string, string> = {
  anthropic: "Anthropic",
  "openai-codex": "OpenAI",
  "github-copilot": "GitHub Copilot",
  "kimi-coding": "Kimi",
  xai: "xAI",
};

export function subscriptionProviderName(provider: string): string {
  return PROVIDER_NAMES[provider] ?? provider;
}

export function subscriptionLoginWarning(provider: string): SubscriptionLoginWarning {
  if (provider === "anthropic") {
    return {
      title: "Subscription login through Pi",
      message: "Pi signs in to Anthropic with your Claude subscription and presents itself as Claude Code. "
        + "Anthropic permits subscription logins only in Claude Code and its own apps, asks developers to use API keys, "
        + "and says it enforces this without notice. Your account may be restricted or banned. "
        + "To stay within the terms, use an API key in Pi, or start a thread on the Claude Code runtime.",
      source: "https://code.claude.com/docs/en/legal-and-compliance",
    };
  }
  return {
    title: "Subscription login through Pi",
    message: `Pi signs in to ${subscriptionProviderName(provider)} with your subscription rather than an API key. `
      + "Check the vendor's terms before relying on it: some vendors allow subscription logins only in their own "
      + "applications and enforce that without notice.",
  };
}

/** One line for lists that mark such models. */
export const SUBSCRIPTION_LOGIN_NOTE = "Models marked \u201csubscription login\u201d go through a subscription Pi signs in with. Its vendor may not allow that outside its own apps; Tau asks once before the first use.";
