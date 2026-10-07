import { useEffect, useRef, useState, useSyncExternalStore, type FormEvent } from "react";
import { LockKeyhole } from "lucide-react";
import { errorMessage, type RegionProps } from "tau";
import type { SchedulingFeed } from "./feed.js";
import type { SecretRequest } from "./protocol.js";

function SecretCard({ request, feed, canManage }: { request: SecretRequest; feed: SchedulingFeed; canManage: boolean }) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const composer = document.querySelector<HTMLTextAreaElement>(".composer-frame textarea");
    if (canManage && !composer?.value) field.current?.focus();
  }, [canManage]);
  const send = async (decline = false) => {
    if (busy || !canManage) return;
    setBusy(true); setError(undefined);
    const privateValue = value;
    setValue("");
    try { await feed.invoke(decline ? "decline-secret" : "save-secret", decline ? { id: request.id } : { id: request.id, value: privateValue }); }
    catch (failure) { setError(errorMessage(failure)); }
    finally { setBusy(false); }
  };
  return <form className="scheduling-secret" aria-label="Private secret request" onSubmit={(event: FormEvent) => { event.preventDefault(); void send(); }}>
    <header><LockKeyhole size={14} /><strong>Secret</strong><span>for this webhook signature</span></header>
    <label htmlFor={`secret-${request.id}`}>{request.label}</label><p>{request.reason}</p>
    <input id={`secret-${request.id}`} ref={field} type="password" className="scheduling-private-field" autoComplete="new-password" maxLength={8192} spellCheck={false} placeholder="Paste the secret" disabled={busy || !canManage} value={value} onChange={(event) => setValue(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); document.querySelector<HTMLTextAreaElement>(".composer-frame textarea")?.focus(); } }} />
    <small>{!canManage ? "Save this in the host's own Tau window." : value ? `${value.length} characters` : "Used only to verify this webhook. Never included in the conversation."}</small>
    {error ? <p role="alert">{error}</p> : null}
    <footer><button type="button" disabled={busy || !canManage} onClick={() => void send(true)}>Decline</button><button type="submit" className="primary" disabled={busy || !value || !canManage}>{busy ? "Saving…" : "Save privately"}</button></footer>
  </form>;
}

export default function PrivateSecret({ actions, feed }: RegionProps & { feed: SchedulingFeed }) {
  const { state } = useSyncExternalStore(feed.subscribe, feed.get);
  const request = state?.secretRequests.find((entry) => entry.threadId === actions.activeThread()?.sessionId && entry.status === "pending");
  return request ? <SecretCard key={request.id} request={request} feed={feed} canManage={state?.canManage === true} /> : null;
}
