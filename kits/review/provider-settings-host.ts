import { HostCommandError, type HostExtensionContext } from "tau/host-extension";
import { REQUEST_SERVICES, type RequestService, type SourceHosts, type SourceProviderStatus } from "./protocol.js";
import type { SourceControl } from "./provider-registry.js";
import { SERVICES } from "./request-cli.js";

const record = (input: unknown): Record<string, unknown> => input && typeof input === "object" ? input as Record<string, unknown> : {};

/**
 * Settings → Review's source-control part: whether each provider can be
 * used on this machine, and which provider a self-hosted server runs when
 * its name does not say.
 */
export function registerProviderSettings(context: HostExtensionContext, sources: SourceControl): void {
  context.registerCommand("source-providers", async (): Promise<SourceProviderStatus[]> => Promise.all(sources.all().map(async (provider) => {
    const base = { service: provider.kind, name: provider.info.name, tool: SERVICES[provider.kind].label };
    const missing = provider.missing();
    if (missing) return { ...base, installed: false, hint: missing };
    return { ...base, installed: true, ...await provider.status().catch(() => ({})) };
  })), { long: true });

  context.registerCommand("source-hosts", (): Promise<SourceHosts> => sources.hosts());

  context.registerCommand("set-source-host", async (input): Promise<SourceHosts> => {
    const fields = record(input);
    const host = typeof fields.host === "string" ? fields.host : "";
    const service = fields.service === null || fields.service === undefined ? undefined : REQUEST_SERVICES.find((entry) => entry === fields.service);
    if (fields.service !== null && fields.service !== undefined && !service) throw new HostCommandError("Choose GitHub, GitLab, Forgejo, Bitbucket or Azure DevOps.");
    const next = await sources.setHost(host, service as RequestService | undefined);
    context.services.log("source-host.set", `${host.trim()} · ${service ?? "detected"}`);
    return next;
  });
}
