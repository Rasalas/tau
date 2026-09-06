import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

/**
 * APIs whose request payload accepts `service_tier`. Anthropic's own field only
 * takes "auto"/"standard_only" — it cannot ask for anything faster — so models on
 * other APIs simply have no fast tier to offer.
 */
export const SERVICE_TIER_APIS = new Set([
  "openai-responses",
  "azure-openai-responses",
  "openai-codex-responses",
]);

export interface ServiceTierControl {
  fastRequested(): boolean;
  available(): boolean;
  /** Called per request; `scope` names the thread and model so the host can report once. */
  onApplied(scope: string): void;
}

/**
 * Pi exposes no service-tier setting, but `before_provider_request` may replace
 * the outgoing payload, and the returned object becomes the actual request body.
 */
export function createServiceTierExtension(control: ServiceTierControl): ExtensionFactory {
  return (pi) => {
    pi.on("before_provider_request", (event, ctx) => {
      if (!control.fastRequested() || !control.available()) return undefined;
      const payload = event.payload;
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
      control.onApplied(`${ctx.sessionManager.getSessionId()} · ${ctx.model?.provider ?? "?"}/${ctx.model?.id ?? "?"}`);
      return { ...(payload as Record<string, unknown>), service_tier: "priority" };
    });
  };
}
