import { useCallback, useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Copy, ExternalLink, SquareTerminal } from "lucide-react";
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
import { Button, TextField } from "../settings/controls";
import { SettingRow } from "../settings/settings-layout";
import { ProviderCardBadgeReport, useProviderCardBadge, type ProviderCardBadge } from "../settings/provider-card-state";
import { ConfirmDialog } from "./ui/ConfirmDialog";
import "./sign-in.css";

/**
 * The account part of a Providers card: who the program is signed in as, the
 * ways it offers to sign in, the flow while it runs — a consent page to open,
 * a device code to enter, a command in a terminal, a question — and sign-out.
 * The kit's host half runs the flow (`registerSignIn`); this draws and answers.
 * One chunk, loaded with `loadSignInUi` from `tau`.
 */
/** Puts a badge into the head of the Providers card it is drawn in, for a kit whose rows are its own. */
export { ProviderCardBadgeReport };

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
  /** The account row's element id, for a search result to scroll to. */
  rowId?: string;
  /** Whether the account's state goes into the head of the Providers card this is drawn in; on by default. */
  cardBadge?: boolean;
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

/** What a method's button does, in a word or two; the method's own label names it beside the button. */
function methodVerb(method: SignInMethod): string {
  return method.kind === "api-key" ? "Add key" : "Sign in";
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
          <button key={option.id} type="button" className="sign-in-choice" disabled={busy} onClick={() => onAnswer(option.id)}>
            <strong>{option.label}</strong>
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
        <TextField
          id={id}
          label={prompt.message}
          value={value}
          width="full"
          secret={prompt.kind === "secret"}
          mono={prompt.kind !== "text"}
          placeholder={prompt.placeholder}
          disabled={busy}
          onChange={setValue}
        />
        <Button type="submit" disabled={busy || !value.trim()}>Continue</Button>
      </div>
    </form>
  );
}

/** One way in: what it is on the left, its button on the right, or why it cannot start. */
function MethodRow({ method, busy, onStart }: { method: SignInMethod; busy: boolean; onStart(): void }) {
  const titleId = useId();
  const note = method.unavailable ?? method.description;
  return (
    <div className="sign-in-method" data-unavailable={method.unavailable ? "" : undefined}>
      <div className="sign-in-method-text">
        <strong id={titleId}>{method.label}</strong>
        {note ? <small>{note}</small> : null}
      </div>
      <Button
        aria-describedby={titleId}
        icon={method.kind === "terminal" ? <SquareTerminal size={13} aria-hidden /> : undefined}
        disabled={busy || method.unavailable !== undefined}
        onClick={onStart}
      >{method.actionLabel ?? methodVerb(method)}</Button>
    </div>
  );
}

/** The badge the card's head shows for the account, once the program answered. */
function accountBadge(report: SignInReport | undefined, active: boolean): ProviderCardBadge | undefined {
  if (!report) return undefined;
  if (active) return { label: "Signing in", tone: "neutral" };
  if (report.account?.signedIn) return { label: "Signed in", tone: "success" };
  return { label: report.methods?.length ? "Needs sign-in" : "Not signed in", tone: "warn" };
}

export function SignInSetup({ host, target, program, heading = "Account", runInTerminal, openExternal, copyText, onNotify, onReport, showAccount = true, rowId, cardBadge = true }: SignInSetupProps) {
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
  const copiedTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(copiedTimer.current), []);
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
    setError(undefined);
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
  const copy = (text: string, what: string) => void copyText(text).then(() => { setCopied(what); clearTimeout(copiedTimer.current); copiedTimer.current = setTimeout(() => setCopied(undefined), 1500); }, () => setError("Could not copy. Select the text instead."));

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
  useProviderCardBadge("account", showAccount && cardBadge ? accountBadge(report, active) : undefined);
  const who = account?.label && account.label !== program ? ` (${account.label})` : "";

  const messages: ReactNode[] = [];
  if (ended?.message && ended.phase !== "succeeded") {
    messages.push(<p key="ended" className="sign-in-status" data-level={ended.phase === "failed" ? "error" : undefined} role={ended.phase === "failed" ? "alert" : "status"}>{flowLine(ended, program)}</p>);
  }
  if (error && (report || !showAccount)) messages.push(<p key="error" className="sign-in-status" data-level="error" role="alert">{error}</p>);
  if (report?.note && !showAccount) messages.push(<p key="note" className="sign-in-status">{report.note}</p>);

  return (
    <>
      {showAccount ? (
        <SettingRow
          {...(rowId ? { id: rowId } : {})}
          title={heading}
          {...(report?.note ? { help: report.note } : {})}
          description={!report
            ? error ? `Could not ask ${program} who is signed in: ${error}` : "Checking…"
            : account?.signedIn
              ? <><strong className="sign-in-who">{account.label ?? "Signed in"}</strong>{account.detail ? <> · <span>{account.detail}</span></> : null}</>
              : "Not signed in"}
          status={messages.length ? <>{messages}</> : undefined}
          control={!report && error ? <Button onClick={() => void load()}>Ask again</Button>
            : account?.signedIn && account.canSignOut && !active ? (
              <Button busy={busy === "sign-out"} disabled={busy !== undefined} onClick={() => setConfirming(true)}>{busy === "sign-out" ? "Signing out…" : "Sign out"}</Button>
            ) : undefined}
        />
      ) : messages.length ? <div className="sign-in-messages">{messages}</div> : null}
      {confirming ? (
        <ConfirmDialog
          title={`Sign out of ${program}${who}?`}
          message={`Threads on ${program} stop working until you sign in again; their history stays.`}
          confirmLabel="Sign out"
          destructive
          onCancel={() => setConfirming(false)}
          onConfirm={signOut}
        />
      ) : null}

      {active && flow ? (
        <div className="sign-in-flow">
          <div className="sign-in-flow-head">
            <p className="sign-in-status" role="status">{flowLine(flow, program)}</p>
            <Button variant="ghost" disabled={busy === "cancel"} onClick={cancel}>Cancel sign-in</Button>
          </div>
          {flow.browser ? (
            <div className="sign-in-actions">
              <Button icon={<ExternalLink size={13} aria-hidden />} onClick={() => openExternal(flow.browser!.url)}>Open sign-in page</Button>
              <Button variant="ghost" onClick={() => copy(flow.browser!.url, "link")}>{copied === "link" ? "Link copied" : "Copy sign-in link"}</Button>
            </div>
          ) : null}
          {flow.deviceCode ? (
            <div className="sign-in-actions">
              <code className="sign-in-device-code" aria-label="Device code">{flow.deviceCode.code}</code>
              <Button icon={<Copy size={12} aria-hidden />} onClick={() => copy(flow.deviceCode!.code, "code")}>{copied === "code" ? "Copied" : "Copy code"}</Button>
              <Button icon={<ExternalLink size={13} aria-hidden />} onClick={() => openExternal(flow.deviceCode!.url)}>Open {hostOf(flow.deviceCode.url)}</Button>
            </div>
          ) : null}
          {/* The command shows only where this window cannot run it: then the user has to. */}
          {flow.terminal && (!runInTerminal || !mine.current.has(flow.flowId)) ? (
            <div className="sign-in-terminal">
              <div className="sign-in-actions">
                <SquareTerminal size={13} aria-hidden />
                <code>{flow.terminal.command}</code>
                <button type="button" className="tau-icon-button" aria-label="Copy the command" onClick={() => copy(flow.terminal!.command, "command")}><Copy size={12} aria-hidden /></button>
              </div>
              <div className="sign-in-actions">
                <span>{copied === "command" ? "Copied. " : ""}{runInTerminal ? "It runs in the terminal of the window that started it." : "Run it in a terminal, then say so here."}</span>
                {flow.prompt ? <Button disabled={busy !== undefined} onClick={() => answer("done")}>I have signed in</Button> : null}
              </div>
            </div>
          ) : !flow.terminal && flow.prompt ? <PromptForm flow={flow} busy={busy !== undefined} onAnswer={answer} /> : null}
          {flow.links?.length ? (
            <div className="sign-in-actions">
              {flow.links.map((link) => <button key={link.url} type="button" className="sign-in-link" onClick={() => openExternal(link.url)}>{link.label ?? link.url}</button>)}
            </div>
          ) : null}
          {flow.deviceCode?.expiresAt ?? flow.expiresAt ? <p className="sign-in-expiry">Expires at {expiresLabel(flow.deviceCode?.expiresAt ?? flow.expiresAt)}.</p> : null}
        </div>
      ) : null}

      {!active && report && methods.some((method) => !account?.signedIn || method.availableWhenSignedIn) ? (
        <div className="sign-in-methods" role="group" aria-label={`Sign in to ${program}`}>
          {methods.filter((method) => !account?.signedIn || method.availableWhenSignedIn).map((method) => <MethodRow key={method.id} method={method} busy={busy !== undefined} onStart={() => start(method)} />)}
        </div>
      ) : null}
    </>
  );
}
