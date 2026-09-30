import { useEffect, useState } from "react";
import { errorMessage } from "../../workbench/error-message";
import type { ConnectStatus } from "../../shared/connect";
import { useHostClient } from "../host-client-context";
import { Button } from "./controls";
import { SettingsSection } from "./settings-layout";

export function ConnectSettings({ onNotify }: { onNotify(message: string): void }) {
  const client = useHostClient();
  const [status, setStatus] = useState<ConnectStatus>();
  const [relay, setRelay] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  useEffect(() => {
    if (!client?.connectStatus) return;
    let active = true;
    const refresh = () => { void client.connectStatus!().then((value) => { if (active) setStatus(value); }, () => undefined); };
    refresh(); const timer = setInterval(refresh, 5_000);
    return () => { active = false; clearInterval(timer); };
  }, [client]);
  if (!status) return null;
  const run = async (action: () => Promise<void>) => {
    setBusy(true); setProblem("");
    try { await action(); }
    catch (error: unknown) { setProblem(errorMessage(error)); }
    finally { setBusy(false); }
  };
  return <SettingsSection title="Tau Connect">
    <p>Reach this machine across networks through your own Tau relay. Deploy the relay before registering this machine.</p>
    {status.phase === "disabled" ? <form onSubmit={(event) => { event.preventDefault(); void run(async () => { const next = await client!.configureConnect!({ relay, enrollmentToken: token }); setStatus(next); setToken(""); }); }}>
      <label className="machine-add-field"><span>Relay address</span><input aria-label="Relay address" type="url" placeholder="https://connect.example.com" value={relay} onChange={(event) => setRelay(event.target.value)} disabled={busy} required /></label>
      <label className="machine-add-field"><span>Enrollment token</span><input aria-label="Enrollment token" type="password" autoComplete="off" value={token} onChange={(event) => setToken(event.target.value)} disabled={busy} required /></label>
      <Button type="submit" busy={busy}>Register this machine</Button>
    </form> : <>
      <p role="status">{status.phase === "connected" ? "Connected" : status.phase === "connecting" ? "Connecting…" : "Offline"} · {status.relay}</p>
      {status.detail ? <p>{status.detail}</p> : null}
      <Button disabled={busy || status.phase !== "connected"} onClick={() => void run(async () => { const { link } = await client!.createConnectLink!(); await client!.copyText(link); onNotify("Tau Connect pairing link copied. Paste it in Settings → Machines on the other desktop."); })}>Copy pairing link</Button>
      <Button disabled={busy} onClick={() => void run(async () => { const next = await client!.removeConnect!(); setStatus(next); onNotify(next.detail ?? "Tau Connect disconnected and its relay route was revoked."); })}>Disconnect</Button>
    </>}
    {problem ? <p role="alert">{problem}</p> : null}
  </SettingsSection>;
}
