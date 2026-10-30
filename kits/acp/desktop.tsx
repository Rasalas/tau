import { useEffect, useState } from "react";
import { Button, SettingRow, SettingsSection, TextField, type DesktopExtension, type HostExtensionClient } from "tau";
import { ACP_ID, MUSE, type AcpAgentConfig, type RegistryAgent } from "./protocol.js";

export function AcpAgentsPage({ host }: { host: HostExtensionClient }) {
  const [agents, setAgents] = useState<AcpAgentConfig[]>([]);
  const [registry, setRegistry] = useState<RegistryAgent[]>([]);
  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<AcpAgentConfig>({ id: "", name: "", command: "", args: [] });
  const [args, setArgs] = useState("[]"); const [models, setModels] = useState("[]"); const [env, setEnv] = useState("{}");
  const [problem, setProblem] = useState(""); const [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    void host.invoke("list").then(value => { if (active) setAgents((value as { agents: AcpAgentConfig[] }).agents); }, error => { if (active) setProblem(String(error)); });
    return () => { active = false; };
  }, [host]);
  const run = async (command: string, input?: unknown) => {
    setBusy(true); setProblem("");
    try {
      const value = await host.invoke(command, input);
      if (command === "registry") setRegistry(value as RegistryAgent[]);
      else setAgents((value as { agents: AcpAgentConfig[] }).agents);
    } catch (error) { setProblem(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };
  const edit = (agent: AcpAgentConfig) => { setEditing(agent); setArgs(JSON.stringify(agent.args)); setModels(JSON.stringify(agent.models ?? [])); setEnv(JSON.stringify(agent.env ?? {})); };
  const save = () => {
    try { void run("save", { ...editing, args: JSON.parse(args), models: JSON.parse(models), env: JSON.parse(env) }); }
    catch { setProblem("Arguments, models and environment must be valid JSON."); }
  };
  return <>
    <SettingsSection title="Your ACP agents">
      <p>Use an installed agent and its existing login, or add one from the ACP registry. Each agent keeps its own conversations.</p>
      {problem ? <p role="alert">{problem}</p> : null}
      {agents.map(agent => <SettingRow key={agent.id} title={agent.name} description={agent.id === MUSE.id ? "Muse ACP is experimental. Install Muse Code and run muse login first." : agent.command} control={<><Button disabled={busy} onClick={() => edit(agent)}>Configure</Button>{agent.id !== MUSE.id ? <Button disabled={busy} onClick={() => void run("remove", { id: agent.id })}>Remove</Button> : null}</>} />)}
    </SettingsSection>
    <SettingsSection title="Add or configure an agent">
      <SettingRow title="ID" description="Use a new ID for a separate account or launch configuration." control={<TextField label="Agent ID" value={editing.id} onChange={value => setEditing({ ...editing, id: value })} />} />
      <SettingRow title="Name" control={<TextField label="Agent name" value={editing.name} onChange={value => setEditing({ ...editing, name: value })} />} />
      <SettingRow title="Executable" control={<TextField label="Agent executable" value={editing.command} onChange={value => setEditing({ ...editing, command: value })} />} />
      <SettingRow title="Arguments" description={'JSON array, for example ["acp"].'} control={<TextField label="Agent arguments" value={args} onChange={setArgs} />} />
      <SettingRow title="Environment" description='JSON object of environment variables. Values are stored privately on this machine.' control={<TextField secret label="Agent environment" value={env} onChange={setEnv} />} />
      <SettingRow title="Custom model IDs" description='Optional JSON array for models the agent does not list before its first session.' control={<TextField label="Agent custom models" value={models} onChange={setModels} />} />
      <SettingRow title="Authentication method" description="Optional ACP authentication method ID. Leave empty to use the agent's existing login." control={<TextField label="Agent authentication method" value={editing.authMethod ?? ""} onChange={value => setEditing({ ...editing, authMethod: value || undefined })} />} />
      <Button disabled={busy} onClick={save}>Save agent</Button>
      <Button disabled={busy} onClick={() => edit({ id: "", name: "", command: "", args: [] })}>New agent</Button>
    </SettingsSection>
    <SettingsSection title="ACP registry">
      <p>Adding a registry agent allows its program to run on this machine. Package agents download through npx or uvx when first used. Binary downloads are checked against the registry's SHA-256.</p>
      <Button disabled={busy} onClick={() => void run("registry")}>{busy ? "Working…" : "Refresh registry"}</Button>
      <TextField label="Search ACP registry" value={search} onChange={setSearch} placeholder="Find an agent" />
      {registry.filter(agent => `${agent.name} ${agent.description}`.toLowerCase().includes(search.toLowerCase())).map(agent => <SettingRow key={agent.id} title={`${agent.name} ${agent.version}`} description={agent.description} control={<Button disabled={busy || agents.some(saved => saved.id === agent.id)} onClick={() => void run("install", { id: agent.id })}>{agents.some(saved => saved.id === agent.id) ? "Added" : "Add agent"}</Button>} />)}
    </SettingsSection>
  </>;
}

const extension: DesktopExtension = { id: ACP_ID, name: "ACP agents", activate(context) {
  return context.registerSettingsPage({ id: "acp.settings", label: "ACP agents", order: 35, profiles: ["desktop", "web"], keywords: ["Muse", "Amp", "Cline", "Copilot", "ACP", "registry", "custom agent"], Component: () => <AcpAgentsPage host={context.host} /> });
} };
export default extension;
