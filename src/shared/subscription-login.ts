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
  google: "Google",
  "google-antigravity": "Google",
  "openai-codex": "OpenAI",
  "github-copilot": "GitHub Copilot",
  "kimi-coding": "Kimi",
  xai: "xAI",
};

/**
 * Vendors whose terms allow a subscription login only in their own apps.
 * OpenAI allows it in third-party tools, so its models carry no warning.
 * `google` is the Antigravity Kit's provider.
 */
const RESTRICTED_PROVIDERS = new Set(["anthropic", "google", "google-antigravity"]);

export function isRestrictedSubscriptionLogin(provider: string): boolean {
  return RESTRICTED_PROVIDERS.has(provider);
}

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
  if (provider === "google" || provider === "google-antigravity") {
    return {
      title: "Antigravity subscription login",
      message: "This signs in to Google with your Antigravity subscription. Google allows that login only in its own apps "
        + "and has restricted accounts that used it elsewhere. Your account may be restricted or banned. "
        + "To stay within the terms, use a Gemini API key.",
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
export const SUBSCRIPTION_LOGIN_NOTE = "Anthropic and Google allow their subscription logins only in their own apps; Tau asks once before the first use of such a model.";
