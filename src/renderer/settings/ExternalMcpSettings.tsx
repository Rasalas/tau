import { useCallback, useEffect, useState } from "react";
import { errorMessage } from "../../workbench/error-message";
import { MCP_EXECUTION_LABELS, localMcpClientConfigs, type UiLocalMcpCreated, type UiLocalMcpStatus, type UiLocalMcpToken, type UiMcpExecution } from "../../shared/external-mcp";
import { useHostClient } from "../host-client-context";
import { ConfirmDialog } from "../deferred-surfaces";
import { Badge, Button, SegmentedControl } from "./controls";
import { SettingsSection } from "./settings-layout";
import { settingAnchor } from "./settings-search";

const EXPIRY = [{ value: "30", label: "30 days" }, { value: "90", label: "90 days" }, { value: "365", label: "1 year" }, { value: "never", label: "Never" }] as const;

function access(token: UiLocalMcpToken): string {
  return token.scopes.includes("tau:threads") ? `Reads, starts threads · ${MCP_EXECUTION_LABELS[token.execution]}` : "Reads only";
}

/**
 * Local MCP clients (ADR 0046): tokens for Claude Code, Codex and other
 * programs on this machine, and the loopback address they connect to. The
 * machine's own window only; a token is shown once, when it is created.
 */
export function ExternalMcpSettings({ onNotify }: { onNotify(message: string, level?: "info" | "warning" | "error"): void }) {
  const client = useHostClient();
  const [status, setStatus] = useState<UiLocalMcpStatus>();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<UiLocalMcpCreated & { name: string }>();
  const [snippet, setSnippet] = useState("claude-code");
  const [revoking, setRevoking] = useState<UiLocalMcpToken>();
  const [name, setName] = useState("");
  const [projects, setProjects] = useState<string[]>([]);
  const [control, setControl] = useState(false);
  const [ceiling, setCeiling] = useState<UiMcpExecution>("ask");
  const [expiry, setExpiry] = useState<string>("90");

  const refresh = useCallback(async () => {
    if (!client?.manageExternalMcp || client.isOwner?.() === false) return;
    try { setStatus(await client.manageExternalMcp({ action: "local-status" }) as UiLocalMcpStatus); }
    catch { setStatus(undefined); }
  }, [client]);
  useEffect(() => { void refresh(); }, [refresh]);
  if (!status || !client?.manageExternalMcp) return null;

  const run = async (action: () => Promise<void>) => {
    setBusy(true); setProblem("");
    try { await action(); }
    catch (error: unknown) { setProblem(errorMessage(error)); }
    finally { setBusy(false); await refresh(); }
  };
  const copy = (text: string, what: string) => void client.copyText(text).then(() => onNotify(`${what} copied`), (error: unknown) => onNotify(errorMessage(error), "error"));
  const manage = (input: Record<string, unknown>) => client.manageExternalMcp!(input);
  const create = () => void run(async () => {
    const result = await manage({ action: "local-create", name: name.trim(), projectIds: projects, control, ...(control ? { execution: ceiling } : {}), expiresInDays: expiry === "never" ? null : Number(expiry) }) as UiLocalMcpCreated;
    setCreated({ ...result, name: name.trim() });
    setCreating(false); setName(""); setProjects([]); setControl(false); setCeiling("ask");
  });
  const projectName = (id: string) => status.projects.find((project) => project.id === id)?.name ?? "a removed project";
  const configs = created?.url ? localMcpClientConfigs(created.url, created.token) : [];
  const shown = configs.find((config) => config.id === snippet) ?? configs[0];

  return <SettingsSection title="MCP clients" id={settingAnchor("MCP clients")}>
    <p>Let Claude Code, Codex or another MCP client on this machine read the projects you choose and, if you allow it, start threads and steer the threads it started. Only programs on this machine can connect, each with a token you create here.</p>
    <p role="status">
      {status.listening ? <>Listening on <code>{status.url}</code> </> : status.enabled ? "Not listening. " : "Off. "}
      {status.listening && status.url ? <Button variant="ghost" onClick={() => copy(status.url!, "Address")}>Copy address</Button> : null}
      <Button disabled={busy} onClick={() => void run(async () => { setStatus(await manage({ action: status.enabled ? "local-disable" : "local-enable" }) as UiLocalMcpStatus); })}>{status.enabled ? "Turn off" : "Turn on"}</Button>
    </p>
    {status.problem ? <p role="alert">{status.problem}</p> : null}
    {status.tokens.length ? <table className="settings-table">
      <thead><tr><th scope="col">Client</th><th scope="col">Projects</th><th scope="col">Access</th><th scope="col" aria-label="Actions" /></tr></thead>
      <tbody>{status.tokens.map((token) => <tr key={token.id}>
        <td>{token.name}{token.expiresAt === undefined ? null : <small> · expires {new Date(token.expiresAt).toLocaleDateString()}</small>}</td>
        <td>{token.projectIds.map(projectName).join(", ")}</td>
        <td>{access(token)}{token.execution === "full" ? <Badge tone="warn">Full access</Badge> : null}</td>
        <td><Button variant="ghost" disabled={busy} aria-label={`Revoke ${token.name}`} onClick={() => setRevoking(token)}>Revoke…</Button></td>
      </tr>)}</tbody>
    </table> : null}
    {created ? <div className="connection-created" role="region" aria-label="New MCP token">
      <p><strong>{created.name} can connect.</strong> Copy its configuration now: Tau shows this token only once.</p>
      {created.url ? <>
        <SegmentedControl label="Client" value={shown?.id ?? snippet} options={configs.map((config) => ({ value: config.id, label: config.label }))} onChange={setSnippet} />
        <pre aria-label="Client configuration"><code>{shown?.text}</code></pre>
        <Button onClick={() => copy(shown!.text, `${shown!.label} configuration`)}>Copy configuration</Button>
      </> : <p>Turn the listener on to get its address.</p>}
      <Button variant="ghost" onClick={() => copy(created.token, "Token")}>Copy the token only</Button>
      <Button variant="ghost" onClick={() => setCreated(undefined)}>Done</Button>
    </div> : null}
    {creating ? <form onSubmit={(event) => { event.preventDefault(); create(); }}>
      <label className="machine-add-field"><span>Name</span><input aria-label="Client name" value={name} maxLength={80} placeholder="e.g. Claude Code" onChange={(event) => setName(event.target.value)} disabled={busy} required /></label>
      <fieldset className="machine-add-field"><legend>Projects it may read</legend>
        {status.projects.map((project) => <label key={project.id}><input type="checkbox" checked={projects.includes(project.id)} disabled={busy}
          onChange={(event) => setProjects(event.target.checked ? [...projects, project.id] : projects.filter((id) => id !== project.id))} /> {project.name}</label>)}
      </fieldset>
      <label><input type="checkbox" checked={control} disabled={busy} onChange={(event) => setControl(event.target.checked)} /> It may start threads and steer or stop the threads it started</label>
      {control ? <label className="machine-add-field"><span>Most its threads may do</span>
        <select aria-label="Execution ceiling" value={ceiling} disabled={busy} onChange={(event) => setCeiling(event.target.value as UiMcpExecution)}>
          {(Object.keys(MCP_EXECUTION_LABELS) as UiMcpExecution[]).map((level) => <option key={level} value={level}>{MCP_EXECUTION_LABELS[level]}</option>)}
        </select>
        <small>{ceiling === "full" ? "Its threads edit and run commands without asking anyone." : "Your own access level still applies when it is stricter. Questions wait for you in Tau."}</small>
      </label> : null}
      <label className="machine-add-field"><span>Expires after</span>
        <select aria-label="Expires after" value={expiry} disabled={busy} onChange={(event) => setExpiry(event.target.value)}>
          {EXPIRY.map((entry) => <option key={entry.value} value={entry.value}>{entry.label}</option>)}
        </select>
      </label>
      <Button type="submit" variant="primary" busy={busy} disabled={!name.trim() || !projects.length}>Create token</Button>
      <Button onClick={() => setCreating(false)}>Cancel</Button>
    </form> : <Button disabled={busy || !status.projects.length} onClick={() => { setCreated(undefined); setCreating(true); }}>Create token…</Button>}
    {problem ? <p role="alert">{problem}</p> : null}
    {revoking ? <ConfirmDialog
      title={`Revoke ${revoking.name}?`}
      message={`${revoking.name} can no longer connect. Calls it is making end now, and turns of threads it started stop; the threads stay.`}
      confirmLabel="Revoke"
      destructive
      onCancel={() => setRevoking(undefined)}
      onConfirm={() => {
        const token = revoking;
        setRevoking(undefined);
        void run(async () => { await manage({ action: "local-revoke", id: token.id }); onNotify(`${token.name} is revoked`); });
      }}
    /> : null}
  </SettingsSection>;
}
