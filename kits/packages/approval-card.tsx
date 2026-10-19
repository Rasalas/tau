import { useState, useSyncExternalStore } from "react";
import { AlertTriangle, Package } from "lucide-react";
import {
  IN_PROCESS_WARNING, capabilityQuestions, errorMessage, workerDescription,
  type HostExtensionClient, type RegionProps, type WorkbenchActions,
} from "tau";
import { INSTALL_REQUESTS_EVENT, readInstallRequests, type InstallRequest, type InstallRequestList } from "./install-protocol.js";

/** The requests the host holds, in every client alike. */
export class InstallFeed {
  private value: InstallRequestList = { requests: [], canManage: false };
  private readonly listeners = new Set<() => void>();
  private stop: (() => void) | undefined;
  constructor(readonly host: HostExtensionClient) {}

  get = (): InstallRequestList => this.value;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    if (this.listeners.size === 1) {
      this.stop = this.host.onEvent(INSTALL_REQUESTS_EVENT, (payload) => this.set({ ...this.value, requests: readInstallRequests(payload) }));
      void this.read();
    }
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) { this.stop?.(); this.stop = undefined; }
    };
  };

  private set(next: InstallRequestList): void {
    this.value = next;
    for (const listener of [...this.listeners]) listener();
  }

  /** Reads the list afresh: the first time, and for what ended while the link was down. */
  async read(): Promise<void> {
    try {
      const answer = await this.host.invoke("install-requests") as Partial<InstallRequestList> | undefined;
      this.set({ requests: readInstallRequests(answer), canManage: answer?.canManage === true });
    } catch { /* The next event brings the list. */ }
  }

  answer(command: "allow-install" | "decline-install", id: string): Promise<unknown> {
    return this.host.invoke(command, { id });
  }
}

function InstallCard({ request, feed, actions, canManage }: { request: InstallRequest; feed: InstallFeed; actions: WorkbenchActions; canManage: boolean }) {
  const [busy, setBusy] = useState<"allow" | "decline">();
  const [error, setError] = useState<string>();
  const answer = async (command: "allow-install" | "decline-install") => {
    if (busy || !canManage) return;
    setBusy(command === "allow-install" ? "allow" : "decline");
    setError(undefined);
    try { await feed.answer(command, request.id); }
    catch (failure) { setError(errorMessage(failure)); }
    finally { setBusy(undefined); }
  };
  const questions = capabilityQuestions(request.name, request);
  return (
    <section className="install-card" aria-label={`Allow ${request.name}`}>
      <header>
        <Package size={12} aria-hidden="true" />
        <span className="install-title">{request.name}</span>
        {request.version ? <span className="install-version">{`v${request.version}`}</span> : null}
      </header>
      {request.description ? <p>{request.description}</p> : null}
      <p className="install-quiet">{request.previous ? "It changed what it asks for. It stays off until you answer." : "The agent wrote this package for Tau. It does not run until you answer."}</p>
      {questions.length > 0 ? (
        <ul className="install-questions" aria-label="What it asks for">
          {questions.map((question) => <li key={question}>{question}</li>)}
        </ul>
      ) : <p className="install-quiet">It asks for nothing beyond its own folder.</p>}
      {request.isolation === "in-process"
        ? <p className="install-warning" role="note"><AlertTriangle size={12} aria-hidden="true" />{IN_PROCESS_WARNING}</p>
        : <p className="install-quiet">{workerDescription(request.permissions)}</p>}
      {!canManage ? <p className="install-quiet">Allow it in this machine's own Tau window.</p> : null}
      {busy === "allow" ? <p className="install-quiet" role="status">Waiting for the confirmation dialog. Nothing is allowed until you confirm there.</p> : null}
      {error ? <p className="install-error" role="alert">{error}</p> : null}
      <div className="install-actions">
        <button type="button" className="install-link" onClick={() => actions.openSettings(`extensions/${request.packageId}`)}>Details</button>
        <span className="install-spacer" />
        <button type="button" className="install-link" disabled={busy !== undefined || !canManage} onClick={() => void answer("decline-install")}>Not now</button>
        <button type="button" className="install-allow" disabled={busy !== undefined || !canManage} onClick={() => void answer("allow-install")}>
          {busy === "allow" ? "Waiting for confirmation…" : questions.length > 0 ? "Allow these" : "Allow"}
        </button>
      </div>
    </section>
  );
}

/** Above the composer of the thread whose agent asked to install a package. */
export function createInstallRegion(feed: InstallFeed) {
  return function InstallRegion({ snapshot, actions }: RegionProps) {
    const { requests, canManage } = useSyncExternalStore(feed.subscribe, feed.get);
    const threadId = snapshot?.sessionId ?? actions.activeThread()?.sessionId;
    const request = threadId ? requests.find((entry) => entry.threadId === threadId && entry.status === "pending") : undefined;
    return request ? <InstallCard key={request.id} request={request} feed={feed} actions={actions} canManage={canManage} /> : null;
  };
}
