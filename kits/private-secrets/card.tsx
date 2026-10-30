import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { LockKeyhole } from "lucide-react";
import { errorMessage, type RegionProps } from "tau";
import type { SecretFilesFeed } from "./feed.js";
import type { SecretFileRequest } from "./protocol.js";

const lifetimeLabel = (minutes: number): string => minutes < 60 ? `${minutes} minutes` : minutes === 60 ? "1 hour" : `${minutes / 60} hours`;

function SecretCard({ request, feed, canManage, dismiss }: { request: SecretFileRequest; feed: SecretFilesFeed; canManage: boolean; dismiss(): void }) {
  const [value, setValue] = useState("");
  const [lifetime, setLifetime] = useState(request.lifetimeMinutes);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [now, setNow] = useState(Date.now());
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => { setNow(Date.now()); }, [request.status, request.expiresAt]);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    const composer = document.querySelector<HTMLTextAreaElement>(".composer-frame textarea");
    const active = document.activeElement;
    const mayFocus = active === document.body || active === composer || active instanceof Element && !!active.closest(".transcript-viewport, [aria-label=\"Conversation\"]");
    if (request.status === "pending" && canManage && !composer?.value && mayFocus) field.current?.focus();
  }, [canManage, request.status]);
  const send = async (command: "submit" | "decline" | "revoke") => {
    if (busy || !canManage) return;
    setBusy(true); setError(undefined);
    const privateValue = value;
    setValue("");
    try { await feed.invoke(command, { id: request.id, ...(command === "submit" ? { value: privateValue, lifetimeMinutes: lifetime } : {}) }); }
    catch (failure) { setError(errorMessage(failure)); }
    finally { setBusy(false); }
  };
  const errorLine = error ? <p role="alert">{error}</p> : null;
  if (request.status !== "pending") return <div className="private-command-secret" aria-label="Private command secret">
    <header><LockKeyhole size={14} /><strong>{request.label}</strong></header>
    {request.status === "ready" ? <p>Saved for commands · deletes in {Math.max(0, Math.ceil((request.expiresAt - now) / 60_000))} min</p> : request.cleanupFailed ? null : <p>{request.status === "declined" ? "Secret request declined." : request.saved ? "Deleted. Commands that read it will fail." : "Secret request ended. Nothing was saved."}</p>}
    {request.cleanupFailed ? <p role="alert">The private file could not be deleted. Try again.</p> : null}
    {errorLine}
    {request.status === "ready" || request.cleanupFailed ? <button type="button" disabled={busy || !canManage} onClick={() => void send("revoke")}>{busy ? "Deleting…" : "Delete now"}</button> : null}
    {request.status !== "ready" && !request.cleanupFailed ? <button type="button" onClick={dismiss}>Dismiss</button> : null}
  </div>;
  const choices = [...new Set([15, 60, 480, 1440, request.lifetimeMinutes])].filter((minutes) => minutes <= request.lifetimeMinutes).sort((a, b) => a - b);
  return <form className="private-command-secret" aria-label="Private command secret request" onSubmit={(event) => { event.preventDefault(); void send("submit"); }}>
    <header><LockKeyhole size={14} /><strong>Secret</strong><span>for a command in this thread</span></header>
    <label htmlFor={`command-secret-${request.id}`}>{request.label}</label><p>{request.reason}</p>
    <input id={`command-secret-${request.id}`} ref={field} type="password" autoComplete="new-password" spellCheck={false} placeholder="Paste the secret" disabled={busy || !canManage} value={value} onChange={(event) => setValue(event.target.value)} onKeyDown={(event) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); document.querySelector<HTMLTextAreaElement>(".composer-frame textarea")?.focus(); }
    }} />
    <label>Keep for <select value={lifetime} disabled={busy || !canManage} onChange={(event) => setLifetime(Number(event.target.value))}>{choices.map((minutes) => <option key={minutes} value={minutes}>{lifetimeLabel(minutes)}</option>)}</select></label>
    <small>{canManage ? "Kept out of the chat. Saved to a private file that this thread's commands can read until it expires. A command can still print it, so check what the agent runs." : "Save this in this machine's own Tau window."}</small>
    {errorLine}
    <footer><button type="button" disabled={busy || !canManage} onClick={() => void send("decline")}>Decline</button><button type="submit" className="primary" disabled={busy || !value || !canManage}>{busy ? "Saving…" : "Save for commands"}</button></footer>
  </form>;
}

export default function PrivateSecretFiles({ actions, feed }: RegionProps & { feed: SecretFilesFeed }) {
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const { state } = useSyncExternalStore(feed.subscribe, feed.get);
  const threadId = actions.activeThread()?.sessionId;
  const requests = state?.requests.filter((request) => request.threadId === threadId && !dismissed.has(request.id)) ?? [];
  const active = requests.filter((request) => request.status === "pending" || request.status === "ready" || request.cleanupFailed);
  const shown = active.length ? active : requests.slice(-1);
  return <>{shown.map((request) => <SecretCard key={request.id} request={request} feed={feed} canManage={state?.canManage === true} dismiss={() => setDismissed((ids) => new Set([...ids, request.id]))} />)}</>;
}
