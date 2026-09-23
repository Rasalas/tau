// Shared by both halves; no imports, so either side may read it.

export const PI_PROVIDERS_EXTENSION_ID = "tau.pi-providers";
/** Every provider Pi knows, with how it signs in and whether it is set up: `PiProviderView[]`. */
export const PROVIDERS_COMMAND = "providers";
/** The Providers card's page id; Onboarding opens it for Pi. */
export const PI_PROVIDERS_PAGE = "pi-providers.settings";

/** One of Pi's model providers, as the card lists it (the host seam's `HostModelProviderAuth`). */
export interface PiProviderView {
  id: string;
  name: string;
  configured: boolean;
  source?: "stored" | "runtime" | "environment" | "fallback" | "models_json_key" | "models_json_command";
  label?: string;
  stored?: "api_key" | "oauth";
  apiKey?: { name: string; interactive: boolean };
  oauth?: { name: string; label?: string; subscription: boolean };
}
