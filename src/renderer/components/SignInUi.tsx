import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { CircleCheck, Copy, ExternalLink, SquareTerminal, TriangleAlert } from "lucide-react";
import {
  SIGN_IN_COMMANDS,
  SIGN_IN_EVENT,
  signInActive,
  type SignInEvent,
  type SignInFlowState,
  type SignInMethod,
  type SignInReport,
} from "../../shared/sign-in";
import type { HostExtensionClient } from "../extension-system";
import "./sign-in.css";

/**
 * The account part of a Providers card: who the program is signed in as, the
 * ways it offers to sign in, the flow while it runs — a consent page to open,
 * a device code to enter, a command in a terminal, a question — and sign-out.
 * The kit's host half runs the flow (`registerSignIn`); this draws and answers.
 * One chunk, loaded with `loadSignInUi` from `tau`.
 */
export interface SignInSetupProps {
  /** The kit's host half. */
  host: HostExtensionClient;
  /** The instance or provider; the kit's default when absent. */
  target?: string;
  /** What signs in, for the sentences: "Codex", "Anthropic". */
  program: string;
  /** The row's heading; "Account" by default. */
  heading?: string;
  /** Runs a command in a terminal the user sees and resolves when it ended; absent where no terminal can. */
  runInTerminal?(command: string): Promise<{ exitCode?: number }>;
  openExternal(url: string): void;
  copyText(text: string): Promise<void>;
  onNotify?(message: string): void;
  /** Every report the host sends, for a card that shows more of it. */
  onReport?(report: SignInReport): void;
  /** Draws the account row too; a caller that shows its own leaves it out. */
  showAccount?: boolean;
}

const DEFAULT_TARGET = "default";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The line under the account while a flow runs or after it ended. */
export function flowLine(flow: SignInFlowState, program: string): string {
  if (flow.message && (!signInActive(flow) || flow.phase === "verifying")) return flow.message;
  switch (flow.phase) {
    case "starting": return `Starting the ${program} sign-in…`;
    case "verifying": return `Checking the ${program} sign-in…`;
    case "succeeded": return `Signed in to ${program}.`;
    case "failed": return `The ${program} sign-in failed.`;
    case "cancelled": return "Sign-in cancelled.";
    default:
      if (flow.terminal) return "Finish signing in in the terminal.";
      if (flow.deviceCode) return "Enter this code on the page, then come back.";
      if (flow.browser) return flow.browser.instructions ?? `Continue in your browser; ${program} finishes the sign-in by itself.`;
      return flow.message ?? `Waiting for ${program}…`;
  }
}

function methodLabel(method: SignInMethod): string {
  return method.label;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function expiresLabel(at: number | undefined): string | undefined {
  if (!at) return undefined;
  return new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

/** Answers the flow's question: a field, or the options of a `select`. */
function PromptForm({ flow, busy, onAnswer }: { flow: SignInFlowState; busy: boolean; onAnswer(value: string): void }) {
  const prompt = flow.prompt!;
  const [value, setValue] = useState("");
  useEffect(() => { setValue(""); }, [prompt.id]);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (value.trim()) onAnswer(value.trim());
  };
  if (prompt.kind === "select") {
    return (
      <div className="sign-in-choices" role="group" aria-label={prompt.message}>
        <span>{prompt.message}</span>
        {prompt.options?.map((option) => (
          <button key={option.id} type="button" className="sign-in-button" disabled={busy} onClick={() => onAnswer(option.id)}>
            {option.label}
            {option.description ? <small>{option.description}</small> : null}
          </button>
        ))}
      </div>
    );
  }
  const id = `sign-in-prompt-${flow.flowId}-${prompt.id}`;
  return (
    <form className="sign-in-prompt" onSubmit={submit}>
      <label htmlFor={id}>{prompt.message}</label>
      <div className="sign-in-prompt-row">
        <input
          id={id}
          type={prompt.kind === "secret" ? "password" : "text"}
          autoComplete="off"
          spellCheck={false}
          placeholder={prompt.placeholder}
          value={value}
          disabled={busy}
          onChange={(event) => setValue(event.target.value)}
        />
        <button type="submit" className="sign-in-button primary" disabled={busy || !value.trim()}>Continue</button>
      </div>
    </form>
  );
}

export function SignInSetup({ host, target, program, heading = "Account", runInTerminal, openExternal, copyText, onNotify, onReport, showAccount = true }: SignInSetupProps) {
  const [report, setReport] = useState<SignInReport>();
  const [flow, setFlow] = useState<SignInFlowState>();
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const [confirming, setConfirming] = useState(false);
  const [copied, setCopied] = useState<string>();
  const [startedHere, setStartedHere] = useState<string>();
  /** Flows this window started: only those run their terminal command here. */
  const mine = useRef(new Set<string>());
  const ran = useRef(new Set<string>());
  const resolved = target ?? DEFAULT_TARGET;
  const scope = target ? { target } : {};
  const reportRef = useRef(onReport);
  reportRef.current = onReport;

  const take = useCallback((next: SignInReport) => {
    setReport(next);
    setFlow(next.flow);
    reportRef.current?.(next);
  }, []);

  const load = useCallback(async () => {
    try {
      take(await host.invoke(SIGN_IN_COMMANDS.state, target ? { target } : undefined) as SignInReport);
    } catch (failure) {
      setError(errorMessage(failure));
    }
  }, [host, target, take]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => host.onEvent(SIGN_IN_EVENT, (payload) => {
    const event = payload as Partial<SignInEvent> | undefined;
    if (!event || event.target !== resolved) return;
    if (event.report) take(event.report);
    else if (event.flow) setFlow(event.flow);
  }), [host, resolved, take]);

  const run = async <T,>(label: string, work: () => Promise<T>): Promise<T | undefined> => {
    setBusy(label);
    setError(undefined);
    try {
      return await work();
    } catch (failure) {
      setError(errorMessage(failure));
      return undefined;
    } finally {
      setBusy(undefined);
    }
  };

  const start = (method: SignInMethod) => void run("start", async () => {
    const started = await host.invoke(SIGN_IN_COMMANDS.start, { ...scope, method: method.id }) as SignInFlowState;
    mine.current.add(started.flowId);
    setStartedHere(started.flowId);
    setFlow((current) => current?.flowId === started.flowId && current.phase !== "starting" ? current : started);
  });
  const answer = (value: string) => {
    if (!flow) return;
    void run("answer", () => host.invoke(SIGN_IN_COMMANDS.respond, { ...scope, flowId: flow.flowId, value }));
  };
  const cancel = () => {
    if (!flow) return;
    void run("cancel", async () => { setFlow(await host.invoke(SIGN_IN_COMMANDS.cancel, { ...scope, flowId: flow.flowId }) as SignInFlowState); });
  };
  const signOut = () => {
    setConfirming(false);
    void run("sign-out", async () => {
      const next = await host.invoke(SIGN_IN_COMMANDS.signOut, scope) as SignInReport;
      take(next);
      onNotify?.(next.note ?? `Signed out of ${program}.`);
    });
  };
  const copy = (text: string, what: string) => void copyText(text).then(() => { setCopied(what); setTimeout(() => setCopied(undefined), 1500); }, () => setError("Could not copy. Select the text instead."));

  // A command this window asked for runs once, in a terminal the user sees; its exit status answers the flow.
  const terminalCommand = flow?.phase === "waiting" && flow.prompt ? flow.terminal?.command : undefined;
  useEffect(() => {
    if (!flow || !terminalCommand || !runInTerminal || !mine.current.has(flow.flowId) || ran.current.has(flow.flowId)) return;
    ran.current.add(flow.flowId);
    const flowId = flow.flowId;
    void runInTerminal(terminalCommand).then(
      (result) => host.invoke(SIGN_IN_COMMANDS.respond, { ...scope, flowId, value: result.exitCode === undefined ? "closed" : String(result.exitCode) }),
      (failure: unknown) => setError(errorMessage(failure)),
    ).catch(() => undefined);
  }, [flow?.flowId, terminalCommand, runInTerminal, startedHere]);

  const account = report?.account;
  const active = signInActive(flow);
  const methods = report?.methods ?? [];
  const ended = flow && !active ? flow : undefined;
  return (
    <div className="sign-in" data-state={active ? "active" : account?.signedIn ? "signed-in" : "signed-out"}>
      {showAccount ? <div className="settings-label">{heading}</div> : null}
      {showAccount ? (
        <div className="settings-field sign-in-field">
          {account?.signedIn ? <CircleCheck size={14} className="accent" /> : <TriangleAlert size={14} />}
          <span>
            <strong>{!report ? "Checking…" : account?.signedIn ? account.label ?? "Signed in" : "Not signed in"}</strong>
            {account?.detail ? <small>{account.detail}</small> : null}
          </span>
          {account?.signedIn && account.canSignOut && !active ? (
            <button type="button" className="sign-in-button" disabled={busy !== undefined} onClick={() => setConfirming(true)}>{busy === "sign-out" ? "Signing out…" : "Sign out"}</button>
          ) : null}
        </div>
      ) : null}
      {confirming ? (
        <div className="sign-in-row" role="alert">
          <span>Sign out of {program}{account?.label && account.label !== program ? ` (${account.label})` : ""}? Threads on it stop working until you sign in again; their history stays.</span>
          <button type="button" className="sign-in-button" onClick={() => setConfirming(false)}>Keep</button>
          <button type="button" className="sign-in-button danger" onClick={signOut}>Sign out</button>
        </div>
      ) : null}

      {active && flow ? (
        <div className="sign-in-flow">
          <p className="sign-in-status" role="status">{flowLine(flow, program)}</p>
          {flow.browser ? (
            <div className="sign-in-row">
              <button type="button" className="sign-in-button primary" onClick={() => openExternal(flow.browser!.url)}><ExternalLink size={13} aria-hidden /> Open sign-in page</button>
              <button type="button" className="sign-in-button" onClick={() => copy(flow.browser!.url, "link")}>{copied === "link" ? "Link copied" : "Copy sign-in link"}</button>
            </div>
          ) : null}
          {flow.deviceCode ? (
            <div className="sign-in-device">
              <code aria-label="Device code">{flow.deviceCode.code}</code>
              <button type="button" className="sign-in-button" onClick={() => copy(flow.deviceCode!.code, "code")}><Copy size={12} aria-hidden /> {copied === "code" ? "Copied" : "Copy code"}</button>
              <button type="button" className="sign-in-button primary" onClick={() => openExternal(flow.deviceCode!.url)}><ExternalLink size={13} aria-hidden /> Open {hostOf(flow.deviceCode.url)}</button>
            </div>
          ) : null}
          {flow.terminal ? (
            <div className="sign-in-terminal">
              <div className="sign-in-row">
                <SquareTerminal size={13} aria-hidden />
                <code>{flow.terminal.command}</code>
                <button type="button" className="sign-in-button" aria-label="Copy the command" onClick={() => copy(flow.terminal!.command, "command")}>{copied === "command" ? "Copied" : <Copy size={12} aria-hidden />}</button>
              </div>
              {!runInTerminal || !mine.current.has(flow.flowId) ? (
                <div className="sign-in-row">
                  <span>{runInTerminal ? "It runs in the terminal of the window that started it." : "Run it in a terminal, then say so here."}</span>
                  {flow.prompt ? <button type="button" className="sign-in-button" disabled={busy !== undefined} onClick={() => answer("done")}>I have signed in</button> : null}
                </div>
              ) : null}
            </div>
          ) : flow.prompt ? <PromptForm flow={flow} busy={busy !== undefined} onAnswer={answer} /> : null}
          {flow.links?.length ? (
            <div className="sign-in-row">
              {flow.links.map((link) => <button key={link.url} type="button" className="sign-in-link" onClick={() => openExternal(link.url)}>{link.label ?? link.url}</button>)}
            </div>
          ) : null}
          <div className="sign-in-row">
            {flow.deviceCode?.expiresAt ?? flow.expiresAt ? <span>Expires at {expiresLabel(flow.deviceCode?.expiresAt ?? flow.expiresAt)}.</span> : <span />}
            <button type="button" className="sign-in-button" disabled={busy === "cancel"} onClick={cancel}>Cancel sign-in</button>
          </div>
        </div>
      ) : null}

      {!active && report && !account?.signedIn && methods.length > 0 ? (
        <div className="sign-in-methods" role="group" aria-label={`Sign in to ${program}`}>
          {methods.map((method, index) => (
            <div key={method.id} className="sign-in-method">
              <button
                type="button"
                className={`sign-in-button${index === 0 ? " primary" : ""}`}
                disabled={busy !== undefined || method.unavailable !== undefined}
                onClick={() => start(method)}
              >
                {method.kind === "terminal" ? <SquareTerminal size={13} aria-hidden /> : null}
                {methodLabel(method)}
              </button>
              {method.unavailable ?? method.description ? <small>{method.unavailable ?? method.description}</small> : null}
            </div>
          ))}
        </div>
      ) : null}

      {ended?.message && ended.phase !== "succeeded" ? <p className="sign-in-status" data-level={ended.phase === "failed" ? "error" : undefined} role={ended.phase === "failed" ? "alert" : "status"}>{flowLine(ended, program)}</p> : null}
      {report?.note ? <p className="settings-note">{report.note}</p> : null}
      {error ? <p className="settings-note" data-level="error" role="alert">{error}</p> : null}
    </div>
  );
}
