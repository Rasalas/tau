import type { AcpAgentConfig, RegistryAgent } from "./protocol.js";

export function parseAgent(value: unknown): AcpAgentConfig {
  if (!value || typeof value !== "object") throw new Error("Provide an ACP agent configuration.");
  const entry = value as AcpAgentConfig;
  if (!/^[a-z][a-z0-9-]{0,47}$/u.test(entry.id)) throw new Error("Use a short lowercase agent ID with letters, numbers and hyphens.");
  if (typeof entry.name !== "string" || !entry.name.trim() || entry.name.length > 80) throw new Error("Name the agent.");
  if (typeof entry.command !== "string" || !entry.command.trim() || /[\r\n\0]/u.test(entry.command)) throw new Error("Provide an executable, without shell syntax.");
  if (!Array.isArray(entry.args) || entry.args.length > 100 || !entry.args.every(arg => typeof arg === "string" && arg.length < 8192 && !arg.includes("\0"))) throw new Error("Arguments must be a JSON array of strings.");
  if (entry.env && (typeof entry.env !== "object" || Array.isArray(entry.env) || !Object.entries(entry.env).every(([key, val]) => /^[A-Za-z_][A-Za-z0-9_]*$/u.test(key) && typeof val === "string" && !val.includes("\0")))) throw new Error("Environment must map variable names to strings.");
  if (entry.authMethod !== undefined && (typeof entry.authMethod !== "string" || !entry.authMethod || entry.authMethod.length > 200)) throw new Error("Invalid authentication method.");
  if (entry.models && (!Array.isArray(entry.models) || !entry.models.every(id => typeof id === "string" && id.length > 0 && id.length < 200))) throw new Error("Models must be an array of model IDs.");
  return { id: entry.id, name: entry.name.trim(), command: entry.command.trim(), args: [...entry.args], ...(entry.env ? { env: { ...entry.env } } : {}), ...(entry.authMethod ? { authMethod: entry.authMethod } : {}), ...(entry.models ? { models: [...entry.models] } : {}) };
}

export function parseRegistry(value: unknown): RegistryAgent[] {
  const agents = (value as { agents?: unknown })?.agents;
  if (!Array.isArray(agents) || agents.length > 2000) throw new Error("The ACP registry returned an invalid agent list.");
  const seen = new Set<string>();
  return agents.map((raw: RegistryAgent) => {
    if (!raw || !/^[a-z][a-z0-9-]{0,47}$/u.test(raw.id) || seen.has(raw.id) || typeof raw.name !== "string" || typeof raw.version !== "string" || !raw.distribution || typeof raw.distribution !== "object") throw new Error("The ACP registry contains an invalid agent.");
    seen.add(raw.id);
    return raw;
  });
}

export function packageAgent(agent: RegistryAgent): AcpAgentConfig | undefined {
  const dist = agent.distribution.npx ?? agent.distribution.uvx;
  if (!dist) return undefined;
  // Package selectors are passed as arguments, never evaluated by a shell.
  if (typeof dist.package !== "string" || !/^@?[a-zA-Z0-9][a-zA-Z0-9@/._+=-]*$/u.test(dist.package)) throw new Error("The registry names an invalid package.");
  const pinned = agent.distribution.npx
    ? (dist.package.replace(/^@[^/]+\//u, "").includes("@") ? dist.package : `${dist.package}@${agent.version}`)
    : (dist.package.includes("==") ? dist.package : `${dist.package}==${agent.version}`);
  return parseAgent({ id: agent.id, name: agent.name, command: agent.distribution.npx ? "npx" : "uvx", args: [...(agent.distribution.npx ? ["--yes", "--", pinned] : ["--", pinned]), ...dist.args ?? []], env: dist.env });
}
