import { useEffect, useState } from "react";
import { errorMessage, type HostExtensionClient } from "tau";
import { PROVIDERS, type PublishInfo, type PublishResult, type RequestService } from "./protocol.js";

const LABELS: Record<RequestService, string> = Object.fromEntries(Object.values(PROVIDERS).map((entry) => [entry.kind, entry.name])) as Record<RequestService, string>;
const VALID_PATH = /^[A-Za-z0-9_.][A-Za-z0-9_.-]*(?:\/[A-Za-z0-9_.][A-Za-z0-9_.-]*)*$/u;

type Visibility = "private" | "public";
type Protocol = "https" | "ssh";

/**
 * "Publish repository" in the Changes panel: where to
 * host it, its name and visibility, then one sentence that says exactly what
 * happens. Only that last step's button reaches the host with `confirm`.
 */
export function PublishForm({ host, workspace, onPublished, onCancel }: {
  host: HostExtensionClient;
  workspace?: string;
  onPublished(result: PublishResult): void;
  onCancel(): void;
}) {
  const [info, setInfo] = useState<PublishInfo>();
  const [error, setError] = useState<string>();
  const [service, setService] = useState<RequestService>();
  const [repository, setRepository] = useState("");
  const [visibility, setVisibility] = useState<Visibility>("private");
  const [protocol, setProtocol] = useState<Protocol>("https");
  const [step, setStep] = useState<"form" | "confirm" | "publishing">("form");
  // The repository exists and has its remote, but the first push failed.
  const [unpushed, setUnpushed] = useState<PublishResult>();
  const [pushing, setPushing] = useState(false);

  useEffect(() => {
    let current = true;
    host.invoke("publish-info", workspace ? { workspace } : undefined).then((answer) => {
      if (!current) return;
      const next = answer as PublishInfo;
      setInfo(next);
      const ready = next.services.find((entry) => entry.ready);
      if (ready) choose(ready.service, next);
    }, (reason: unknown) => { if (current) setError(errorMessage(reason)); });
    return () => { current = false; };
  }, [host, workspace]);

  const choose = (next: RequestService, facts = info) => {
    const entry = facts?.services.find((candidate) => candidate.service === next);
    setService(next);
    setProtocol(entry?.protocol ?? "https");
    setRepository(`${entry?.account ? `${entry.account}/` : ""}${facts?.folder ?? ""}`);
  };

  const path = repository.trim();
  const valid = Boolean(service) && VALID_PATH.test(path) && !path.endsWith(".git");
  const publish = async () => {
    if (!service) return;
    setStep("publishing");
    setError(undefined);
    try {
      const result = await host.invoke("publish-repository", { service, repository: path, visibility, protocol, confirm: true, ...(workspace ? { workspace } : {}) }) as PublishResult;
      if (result.pushProblem) setUnpushed(result);
      else onPublished(result);
    } catch (reason) {
      setError(errorMessage(reason));
      setStep("confirm");
    }
  };
  const pushAgain = async () => {
    if (!unpushed) return;
    setPushing(true);
    setError(undefined);
    try {
      await host.invoke("publish-push", workspace ? { workspace } : undefined);
      const { pushProblem: _solved, ...result } = unpushed;
      onPublished({ ...result, pushed: true });
    } catch (reason) {
      setError(errorMessage(reason));
      setPushing(false);
    }
  };

  if (!info) {
    return <div className="request-form publish-form">
      {error ? <p className="request-error" role="alert">{error}</p> : <p className="request-busy">Asking gh and glab…</p>}
      <div className="commit-actions"><button onClick={onCancel}>Cancel</button></div>
    </div>;
  }
  const ready = info.services.some((entry) => entry.ready);

  if (unpushed) {
    return <div className="request-form publish-form" role="group" aria-label="Publish repository">
      <p className="request-error" role="alert">{error ?? `${unpushed.repository} was created and added as origin, but the push failed. ${unpushed.pushProblem}`}</p>
      <div className="commit-actions">
        <button className="primary" disabled={pushing} onClick={() => void pushAgain()}>{pushing ? "Pushing…" : "Push again"}</button>
        <button disabled={pushing} onClick={() => onPublished(unpushed)}>Close</button>
      </div>
    </div>;
  }

  if (step !== "form" && service) {
    return <div className="request-form publish-form" role="group" aria-label="Publish repository">
      <p className="request-confirm">
        Create the {visibility} repository <code>{path}</code> on {LABELS[service]}, add it as <code>origin</code> over {protocol === "ssh" ? "SSH" : "HTTPS"} and push <code>{info.branch ?? "HEAD"}</code>?
      </p>
      {error ? <p className="request-error" role="alert">{error}</p> : null}
      <div className="commit-actions">
        <button className="primary" disabled={step === "publishing"} onClick={() => void publish()}>{step === "publishing" ? "Publishing…" : `Publish to ${LABELS[service]}`}</button>
        <button disabled={step === "publishing"} onClick={() => setStep("form")}>Back</button>
      </div>
    </div>;
  }

  return (
    <div className="request-form publish-form" role="group" aria-label="Publish repository">
      <div className="toggle-group" role="radiogroup" aria-label="Where to host it">
        {info.services.map((entry) => (
          <button key={entry.service} role="radio" aria-checked={service === entry.service} className={service === entry.service ? "active" : ""}
            disabled={!entry.ready} title={entry.problem} onClick={() => choose(entry.service)}>{LABELS[entry.service]}</button>
        ))}
      </div>
      {!ready ? <p className="request-problem" role="note">{info.services.map((entry) => entry.problem).filter(Boolean).join(" ")}</p> : null}
      <input aria-label="Repository" placeholder="owner/name" spellCheck={false} value={repository} disabled={!ready} onChange={(event) => setRepository(event.target.value)}
        onKeyDown={(event) => { if (event.key === "Enter" && valid) setStep("confirm"); }} />
      <div className="publish-options">
        <div className="toggle-group" role="radiogroup" aria-label="Visibility">
          {(["private", "public"] as const).map((next) => (
            <button key={next} role="radio" aria-checked={visibility === next} className={visibility === next ? "active" : ""} onClick={() => setVisibility(next)}>{next === "private" ? "Private" : "Public"}</button>
          ))}
        </div>
        <div className="toggle-group" role="radiogroup" aria-label="Remote protocol">
          {(["https", "ssh"] as const).map((next) => (
            <button key={next} role="radio" aria-checked={protocol === next} className={protocol === next ? "active" : ""} onClick={() => setProtocol(next)}>{next === "ssh" ? "SSH" : "HTTPS"}</button>
          ))}
        </div>
      </div>
      {error ? <p className="request-error" role="alert">{error}</p> : null}
      <div className="commit-actions">
        <button className="primary" disabled={!valid} onClick={() => setStep("confirm")}>Continue…</button>
        <button onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}
