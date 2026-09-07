/** The credential kind a runtime reports for a provider, as far as the workbench cares. */
export interface ProviderLoginSource {
  isUsingSubscription?(provider: string): boolean;
}

/** "subscription" when the runtime reaches the provider through a consumer-subscription login it performed. */
export function modelLogin(runtime: ProviderLoginSource | undefined, provider: string): "subscription" | undefined {
  try {
    return runtime?.isUsingSubscription?.(provider) === true ? "subscription" : undefined;
  } catch {
    return undefined;
  }
}
