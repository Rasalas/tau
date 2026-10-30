export const ACP_ID = "tau.acp";
export const REGISTRY_URL = "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json";
export interface AcpAgentConfig {
  id: string;
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  authMethod?: string;
  models?: string[];
}
export const MUSE: AcpAgentConfig = { id: "muse", name: "Muse Code", command: "muse", args: ["acp"], env: { MUSE_EXPERIMENTAL_ACP: "on" } };
export const kindOf = (id: string) => `acp@${id}`;
export interface RegistryAgent { id: string; name: string; version: string; description: string; distribution: { npx?: { package: string; args?: string[]; env?: Record<string, string> }; uvx?: { package: string; args?: string[]; env?: Record<string, string> }; binary?: Record<string, { archive: string; sha256?: string; cmd: string; args?: string[]; env?: Record<string, string> }> } }
