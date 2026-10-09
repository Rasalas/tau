import type { ClientRelease, ClientStorage } from "tau";

export const STATISTICS_KEY = "device:tau.usage-statistics.v1";
export const TRACKING_URL = "https://analytics.tbuck.de/matomo.php";
export const ACTION_URL = "https://rasalas.github.io/tau/app";
export type Activity = "workbench_used" | "human_prompt_accepted";
const ACTIVITIES: readonly Activity[] = ["workbench_used", "human_prompt_accepted"];
const RETRY_MS = 5 * 60_000;

interface State {
  enabled: boolean;
  error?: string;
  id?: string;
  day?: string;
  sent: Activity[];
}

export interface ActivityReport {
  id: string;
  event: Activity;
  release: ClientRelease;
}

export type SendActivity = (report: ActivityReport, signal: AbortSignal) => Promise<void>;

function read(storage: ClientStorage | undefined): State {
  try {
    const value = JSON.parse(storage?.get(STATISTICS_KEY) ?? "null");
    const id = typeof value?.id === "string" && /^[0-9a-f]{16}$/u.test(value.id) ? value.id : undefined;
    const day = typeof value?.day === "string" && /^\d{4}-\d{2}-\d{2}$/u.test(value.day) ? value.day : undefined;
    return { enabled: value?.enabled === true && Boolean(id), id, day, sent: Array.isArray(value?.sent) ? ACTIVITIES.filter((event) => value.sent.includes(event)) : [] };
  } catch {
    return { enabled: false, sent: [] };
  }
}

function randomId(): string {
  return [...crypto.getRandomValues(new Uint8Array(8))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The complete wire payload is built here. No workbench objects or prompt text enter this module. */
export function trackingBody(report: ActivityReport): URLSearchParams {
  return new URLSearchParams({
    idsite: "4", rec: "1", apiv: "1", cid: report.id,
    url: ACTION_URL, e_c: "tau", e_a: report.event, ca: "1", send_image: "0",
    ua: "Tau", lang: "und", cookie: "0",
    dimension1: report.release.version,
    dimension2: report.release.platform,
    dimension3: report.release.channel,
  });
}

export const sendActivity: SendActivity = async (report, signal) => {
  // A form POST needs no CORS preflight. Matomo may return an opaque response;
  // successful delivery here is best effort, never proof of a real person.
  const response = await fetch(TRACKING_URL, {
    method: "POST", body: trackingBody(report), signal,
    mode: "no-cors", credentials: "omit", referrerPolicy: "no-referrer", redirect: "error", cache: "no-store",
  });
  if (!response.ok && response.type !== "opaque") throw new Error("Statistics delivery failed.");
};

/** Consent, identity and daily flags belong to the device, never to host settings or synced account data. */
export class UsageStatistics {
  private state: State;
  private release: ClientRelease | undefined;
  private listeners = new Set<() => void>();
  private pending = new Map<Activity, AbortController>();
  private retryAt = new Map<Activity, number>();
  private revision = 0;
  private unavailable = false;

  constructor(private readonly storage: ClientStorage | undefined, private readonly send: SendActivity = sendActivity,
    private readonly now: () => number = Date.now, private readonly newId: () => string = randomId) {
    this.state = read(storage);
  }

  getSnapshot = (): Readonly<State> => this.state;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };

  /** Installed release metadata comes from this client's shell; a host hello cannot turn reporting on. */
  start(release: ClientRelease | undefined): () => void {
    this.release = release;
    return () => { this.release = undefined; this.cancel(); };
  }

  refresh = (): void => {
    if (this.unavailable) return;
    const next = read(this.storage);
    if (JSON.stringify(next) === JSON.stringify(this.state)) return;
    if (!next.enabled || next.id !== this.state.id) this.cancel();
    this.state = next;
    this.listeners.forEach((listener) => listener());
  };

  setEnabled = (enabled: boolean): void => {
    this.refresh();
    const next = { ...this.state, error: undefined, enabled, ...(enabled && !this.state.id ? { id: this.newId() } : {}) };
    if (!enabled) this.cancel();
    // If durable storage fails, no consent is assumed and nothing is sent.
    try {
      if (!this.storage) throw new Error("No storage.");
      this.storage.set(STATISTICS_KEY, JSON.stringify(next));
    } catch {
      this.cancel();
      this.unavailable = true;
      this.state = { ...this.state, enabled: false, error: "This choice could not be saved. Reporting is stopped in this window; please try again." };
      this.listeners.forEach((listener) => listener());
      return;
    }
    this.unavailable = false;
    this.state = next;
    this.listeners.forEach((listener) => listener());
  };

  record = (event: Activity): void => {
    this.refresh();
    const { enabled, id } = this.state;
    const release = this.release;
    const now = this.now();
    const day = new Date(now).toISOString().slice(0, 10);
    if (!release || !enabled || !id || this.pending.has(event) || now < (this.retryAt.get(event) ?? 0)) return;
    if (this.state.day === day && this.state.sent.includes(event)) return;
    const abort = new AbortController();
    const revision = this.revision;
    this.pending.set(event, abort);
    const timeout = setTimeout(() => abort.abort(), 5_000);
    void Promise.resolve().then(() => {
      if (abort.signal.aborted || revision !== this.revision) return;
      return this.send({ id, event, release }, abort.signal);
    }).then(() => {
      this.refresh();
      if (abort.signal.aborted || revision !== this.revision || !this.state.enabled || this.state.id !== id) return;
      if (new Date(this.now()).toISOString().slice(0, 10) !== day) return;
      const next = { ...this.state, day, sent: [...new Set([...(this.state.day === day ? this.state.sent : []), event])] };
      this.storage?.set(STATISTICS_KEY, JSON.stringify(next));
      this.state = next;
      this.listeners.forEach((listener) => listener());
    }).catch(() => { if (revision === this.revision) this.retryAt.set(event, now + RETRY_MS); })
      .finally(() => { clearTimeout(timeout); if (this.pending.get(event) === abort) this.pending.delete(event); });
  };

  dispose = (): void => { this.release = undefined; this.cancel(); this.listeners.clear(); };

  private cancel(): void {
    this.revision++;
    for (const abort of this.pending.values()) abort.abort();
    this.pending.clear();
    this.retryAt.clear();
  }
}
