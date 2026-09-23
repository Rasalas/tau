import { Suspense, lazy, useEffect, useRef, useState, useSyncExternalStore, type ComponentType, type ReactNode } from "react";
import { ArrowRight, Bot, Braces, Check, Copy, FolderPlus, GitMerge, GitPullRequest, Orbit, Sparkles, SquareTerminal } from "lucide-react";
import { loadSignInUi, useThreadStore, useWorkbenchShell, type OverlayProps, type WorkbenchActions } from "tau";
import { backendKit, defaultProjects, defaultSessions, type AgentStatus, type FlowState, type WelcomeFlow } from "./flow.js";
import type { ImportableSession, ProjectCandidate, ToolReport } from "./protocol.js";

const STEPS = ["Agents", "Projects", "Conversations"] as const;
const SignIn = lazy(() => loadSignInUi().then((module) => ({ default: module.SignInSetup })));
/** Pi Providers' card (`kits/pi-providers/protocol.ts`), named here: a kit never imports another. */
const PI_PROVIDERS_PAGE = "pi-providers.settings";

/** Terminal Kit's run service (`kits/terminal/protocol.ts`), for a login that runs in a terminal. */
export interface TerminalRunner {
  run(request: { command: string; label?: string }, actions?: WorkbenchActions): Promise<{ id: string; exitCode?: number }>;
}
const SCAN_LIMIT_MESSAGE = "Scan limit reached. Some projects or conversations may be missing.";

type RowState = "checking" | "ready" | "signIn" | "install" | "update" | "settings";
type Icon = ComponentType<{ size?: number; "aria-label"?: string }>;

export interface AgentRow {
  /** A runtime backend kind, or `gh`/`glab`. */
  id: string;
  label: string;
  state: RowState;
  summary: string;
  /** Shown to copy; without one the action opens `settings`. */
  command?: string;
  settings?: string;
  /** The backend kit whose sign-in opens in place, and the instance it is for. */
  signIn?: { extensionId: string; target: string };
}

/** A runtime backend as the snapshot lists it. */
export interface BackendEntry {
  kind: string;
  label: string;
  version?: { installed?: string };
}

const ICONS: Record<string, Icon> = { pi: Sparkles, "claude-code": Bot, codex: SquareTerminal, opencode: Braces, antigravity: Orbit, gh: GitPullRequest, glab: GitMerge };
const iconOf = (id: string): Icon => ICONS[id] ?? ICONS[id.split("@")[0]!] ?? Bot;
const SOURCE_LABEL = { "claude-code": "Claude Code", codex: "Codex", opencode: "OpenCode", pi: "Pi" } as const;

function plural(count: number, one: string): string {
  return `${count} ${count === 1 ? one : `${one}s`}`;
}

/** "now", "5m", "3h", "2d", "4mo": fits the fixed column T3 Code gives it. */
export function age(at: number, now: number): string {
  if (!at) return "";
  const minutes = Math.floor((now - at) / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d`;
  const months = Math.round(days / 30);
  return months < 12 ? `${months}mo` : `${Math.round(months / 12)}y`;
}

function backendRow(backend: BackendEntry, status: AgentStatus | undefined, commands: { install?: string }): AgentRow {
  const { kind: id, label } = backend;
  const kit = backendKit(id);
  // Without a command of its own, a runtime is set up on its Providers card.
  const next = (state: RowState, summary: string, command?: string): AgentRow => ({ id, label, state, summary, ...(command ? { command } : { settings: "providers" }) });
  if (!status) return { id, label, state: "checking", summary: "Checking…" };
  const version = status.version ?? backend.version?.installed;
  if (status.error) return next("settings", `${version ? `${version} · ` : ""}Could not check: ${status.error.replace(/\.$/u, "")}`);
  if (!status.installed) return next("install", "Not installed", commands.install);
  const shown = version ?? "Installed";
  if (status.update) return next("update", `${shown} is older than Tau speaks to`, status.update.command);
  if (status.signedIn) return { id, label, state: "ready", summary: `${shown} · ${status.account ?? "signed in"}` };
  // The kit's own sign-in (`sign-in-state` and the rest), opened in place under the row.
  if (status.signedIn === false) return { id, label, state: "signIn", summary: `${shown} · Not signed in`, signIn: { extensionId: kit.extensionId, target: kit.instance ?? "default" } };
  return next("settings", shown);
}

/**
 * What "Your agents" lists: Pi, then every registered runtime backend in the
 * order core gives, instances included. `gh`/`glab` are `toolRows`.
 */
export function agentRows(state: FlowState, piModels: number | undefined, backends: readonly BackendEntry[] = []): AgentRow[] {
  const pi: AgentRow = piModels === undefined
    ? { id: "pi", label: "Pi", state: "checking", summary: "Checking…" }
    : piModels > 0
      ? { id: "pi", label: "Pi", state: "ready", summary: `Tau's own runtime · ${plural(piModels, "model")} from your Pi configuration` }
      : { id: "pi", label: "Pi", state: "signIn", summary: "Tau's own runtime · No provider signed in", settings: PI_PROVIDERS_PAGE };
  return [
    pi,
    ...backends.filter((backend) => backend.kind !== "pi").map((backend) => {
      // An instance has a home of its own; the default login command would sign in the wrong one.
      const tool = backendKit(backend.kind).instance ? undefined : state.tools?.tools.find((entry) => entry.id === backend.kind);
      return backendRow(backend, state.agents[backend.kind], tool ?? {});
    }),
  ];
}

/** The review CLIs, for the optional group after the agents. */
export function toolRows(state: FlowState): AgentRow[] {
  return (["gh", "glab"] as const).map((id): AgentRow => {
    const label = id === "gh" ? "GitHub CLI" : "GitLab CLI";
    const report: ToolReport | undefined = state.tools?.tools.find((entry) => entry.id === id);
    if (!report) return { id, label, state: "checking", summary: "Checking…" };
    if (!report.path) return { id, label, state: "install", summary: "Not installed", command: report.install };
    const version = report.version ?? "Installed";
    return report.signedIn ? { id, label, state: "ready", summary: `${version} · Signed in` } : { id, label, state: "signIn", summary: `${version} · Not signed in`, command: report.login };
  });
}

function StepShell({ title, description, children }: { title: string; description: string; children?: ReactNode }) {
  return <>
    <h2 className="onboarding-title">{title}</h2>
    <p className="onboarding-description">{description}</p>
    {children}
  </>;
}

function Steps({ current, disabled, onStep }: { current: number; disabled: boolean; onStep(step: FlowState["step"]): void }) {
  return (
    <ol className="onboarding-steps" aria-label="Setup progress">
      {STEPS.map((label, index) => (
        <li key={label}>
          <button
            type="button"
            disabled={disabled || index >= current}
            aria-current={index === current ? "step" : undefined}
            aria-label={`${label}, step ${index + 1}`}
            className={index === current ? "current" : index < current ? "done" : ""}
            onClick={() => onStep(index as FlowState["step"])}
          >
            <span className="onboarding-step-mark" aria-hidden="true">{index < current ? <Check size={13} /> : index + 1}</span>
            <span>{label}</span>
          </button>
        </li>
      ))}
    </ol>
  );
}

function CommandBlock({ command, actions }: { command: string; actions: WorkbenchActions }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="onboarding-command">
      <code><span aria-hidden="true">$ </span>{command}</code>
      <button type="button" className="onboarding-icon-button" aria-label="Copy command" onClick={() => void actions.copyText(command).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); })}>
        {copied ? <Check size={13} /> : <Copy size={13} />}
      </button>
    </div>
  );
}

function AgentCard({ row, actions, flow, runner }: { row: AgentRow; actions: WorkbenchActions; flow?: WelcomeFlow; runner?: () => TerminalRunner | undefined }) {
  const [open, setOpen] = useState(false);
  const Glyph = iconOf(row.id);
  const inPlace = Boolean(row.signIn && flow);
  const label = inPlace || (row.command && row.state === "signIn") ? "Sign in" : !row.command ? "Open Settings" : row.state === "install" ? "Install" : row.state === "update" ? "Update" : "Sign in";
  const act = () => row.command || inPlace ? setOpen(!open) : actions.openSettings(row.settings);
  const run = runner?.();
  const place = useRef<HTMLDivElement>(null);
  // The list scrolls; a row near its end would open its sign-in below the fold.
  useEffect(() => { if (open) place.current?.scrollIntoView?.({ block: "nearest" }); }, [open]);
  return (
    <div className="onboarding-card-wrap">
      <div className="onboarding-card" data-state={row.state}>
        <Glyph size={18} />
        <span className="onboarding-card-text"><strong>{row.label}</strong><small>{row.summary}</small></span>
        {row.state === "ready"
          ? <span className="onboarding-ready"><Check size={13} /> Ready</span>
          : row.state === "checking"
            ? null
            : <button type="button" className="onboarding-button ghost small" aria-expanded={row.command || inPlace ? open : undefined} onClick={act}>{label}</button>}
      </div>
      {open && row.command ? <CommandBlock command={row.command} actions={actions} /> : null}
      {open && row.signIn && flow ? (
        <div className="onboarding-sign-in" ref={place}>
          <Suspense fallback={null}>
            <SignIn
              host={flow.kitHost(row.signIn.extensionId)}
              target={row.signIn.target}
              program={row.label}
              showAccount={false}
              {...(run ? { runInTerminal: (command: string) => run.run({ command, label: `Sign in to ${row.label}` }, actions) } : {})}
              openExternal={(url) => actions.openExternal(url)}
              copyText={(text) => actions.copyText(text)}
              onNotify={(message) => actions.notify(message)}
              onReport={(report) => { if (report.account?.signedIn) flow.recheckAgent(row.id); }}
            />
          </Suspense>
        </div>
      ) : null}
    </div>
  );
}

function SourceMarks({ sources }: { sources: ReadonlyArray<keyof typeof SOURCE_LABEL> }) {
  return <>
    {(["claude-code", "codex", "opencode", "pi"] as const).map((source) => {
      const Glyph = iconOf(source);
      return <span key={source} className="onboarding-source">{sources.includes(source) ? <Glyph size={12} aria-label={SOURCE_LABEL[source]} /> : null}</span>;
    })}
  </>;
}

function Selection({ count, total, busy, onAll, onNone }: { count: number; total: number; busy: boolean; onAll(): void; onNone(): void }) {
  return (
    <div className="onboarding-selection">
      <span role="status">{count} of {total} selected</span>
      <span>
        <button type="button" className="onboarding-button ghost small" disabled={busy || count === total} onClick={onAll}>Select all</button>
        <button type="button" className="onboarding-button ghost small" disabled={busy || count === 0} onClick={onNone}>Select none</button>
      </span>
    </div>
  );
}

function Notes({ state }: { state: FlowState }) {
  const discovery = state.discovery;
  if (!discovery) return null;
  return <>
    {discovery.truncated ? <p className="onboarding-note" role="status">{SCAN_LIMIT_MESSAGE}</p> : null}
    {discovery.unavailable.map((entry) => <p key={entry.source} className="onboarding-note">Could not ask {SOURCE_LABEL[entry.source]}: {entry.reason}</p>)}
  </>;
}

function Looking({ onSkip, what }: { onSkip(): void; what: string }) {
  return <>
    <div className="onboarding-looking"><span className="spinner" /> Looking for {what} from Claude Code and Codex…</div>
    <div className="onboarding-actions"><button type="button" className="onboarding-button ghost" onClick={onSkip}>Do not import projects</button></div>
  </>;
}

function AgentsStep({ state, flow, actions, runner }: { state: FlowState; flow: WelcomeFlow; actions: WorkbenchActions; runner?: () => TerminalRunner | undefined }) {
  const snapshot = useWorkbenchShell().snapshot;
  const backends = (snapshot?.runtimeBackends ?? []).filter((backend) => backend.kind !== "pi");
  const kinds = backends.map((backend) => backend.kind);
  useEffect(() => { flow.askAgents(kinds); }, [kinds.join("\n")]);
  const rows = agentRows(state, snapshot ? (snapshot.completionModels ?? snapshot.models).length : undefined, backends);
  return (
    <StepShell title="Your agents" description="Agents available on this computer. Install or sign in to the ones you want to use; Settings → Providers has them later too.">
      <div className="onboarding-list">{rows.map((row) => <AgentCard key={row.id} row={row} actions={actions} flow={flow} {...(runner ? { runner } : {})} />)}</div>
      <section className="onboarding-optional" aria-labelledby="onboarding-pr-tools">
        <h3 id="onboarding-pr-tools" className="onboarding-subtitle">Tools for pull requests <span className="onboarding-badge">Optional</span></h3>
        <p className="onboarding-note">Tau uses them to open pull and merge requests and show their checks. Your agents work without them.</p>
        <div className="onboarding-list compact">{toolRows(state).map((row) => <AgentCard key={row.id} row={row} actions={actions} />)}</div>
      </section>
      <div className="onboarding-actions">
        <button type="button" className="onboarding-button ghost" onClick={() => flow.checkAgents()}>Check again</button>
        <button type="button" className="onboarding-button primary" onClick={() => flow.goTo(1)}>Continue <ArrowRight size={14} /></button>
      </div>
    </StepShell>
  );
}

function ProjectsStep({ state, flow, actions, known }: { state: FlowState; flow: WelcomeFlow; actions: WorkbenchActions; known: ReadonlySet<string> }) {
  const now = Date.now();
  const skip = () => flow.goTo(2);
  if (!state.discovery && !state.discoverError) return <StepShell title="Choose your projects" description=""><Looking what="projects" onSkip={skip} /></StepShell>;
  const candidates = (state.discovery?.projects ?? []).filter((project) => !known.has(project.path));
  const selected = new Set(state.projects ?? defaultProjects(candidates, now));
  const chosen = candidates.filter((project) => selected.has(project.path));
  const busy = state.busy === "projects";
  const toggle = (project: ProjectCandidate, on: boolean) => flow.select("projects", on ? [...selected, project.path] : [...selected].filter((path) => path !== project.path));
  return (
    <StepShell title="Choose your projects" description="Folders Claude Code, Codex, OpenCode and Pi have worked in. The ones you choose are added to Tau.">
      {state.discoverError ? <p className="onboarding-error" role="alert">Could not check projects. {state.discoverError} <button type="button" className="onboarding-button ghost small" onClick={() => flow.discover()}>Retry</button></p> : null}
      {candidates.length > 0 ? <Selection count={chosen.length} total={candidates.length} busy={busy} onAll={() => flow.select("projects", candidates.map((project) => project.path))} onNone={() => flow.select("projects", [])} /> : null}
      <fieldset className="onboarding-list rows" disabled={busy}>
        <legend className="onboarding-sr">Projects to add</legend>
        {candidates.length === 0 && state.discovery
          ? <p className="onboarding-empty">{state.discovery.projects.length ? "Every folder found is a project in Tau already." : "No existing Claude Code or Codex projects found."}</p>
          : null}
        {candidates.map((project) => (
          <label key={project.path} className="onboarding-row" title={project.path}>
            <input type="checkbox" checked={selected.has(project.path)} onChange={(event) => toggle(project, event.target.checked)} />
            <span className="onboarding-row-text"><strong>{project.name}</strong><small>{project.path}</small></span>
            <span className="onboarding-meta"><SourceMarks sources={project.sources} /><span>{project.threadCount}</span><span>{age(project.lastActiveAt, now)}</span></span>
          </label>
        ))}
      </fieldset>
      <Notes state={state} />
      {state.error ? <p className="onboarding-error" role="alert">{state.error}</p> : null}
      <div className="onboarding-actions">
        <button type="button" className="onboarding-button ghost leading" disabled={busy} onClick={() => actions.openProjectSources()}><FolderPlus size={14} /> Add a folder…</button>
        <button type="button" className="onboarding-button ghost" disabled={busy} onClick={skip}>Do not add projects</button>
        <button type="button" className="onboarding-button primary" disabled={busy || chosen.length === 0} onClick={() => void flow.addProjects(actions, chosen.map((project) => project.path))}>
          {busy ? "Adding…" : `Add ${plural(chosen.length, "project")}`}
        </button>
      </div>
    </StepShell>
  );
}

function ConversationsStep({ state, flow, actions, known, finish }: { state: FlowState; flow: WelcomeFlow; actions: WorkbenchActions; known: ReadonlySet<string>; finish(): void }) {
  const now = Date.now();
  if (!state.discovery && !state.discoverError) return <StepShell title="Import conversations" description=""><Looking what="conversations" onSkip={finish} /></StepShell>;
  const all = state.discovery?.sessions ?? [];
  const pending = all.filter((session) => !session.imported);
  const already = all.length - pending.length;
  const selected = new Set(state.sessions ?? defaultSessions(pending, new Set([...known, ...state.added]), now));
  const chosen = pending.filter((session) => selected.has(session.path));
  const importing = state.busy === "import";
  const groups = new Map<string, ImportableSession[]>();
  for (const session of pending) groups.set(session.cwd, [...groups.get(session.cwd) ?? [], session]);
  const toggle = (paths: readonly string[], on: boolean) => flow.select("sessions", on ? [...selected, ...paths] : [...selected].filter((path) => !paths.includes(path)));
  const run = async () => {
    const result = await flow.importSessions(actions, chosen);
    if (result.failed === 0) finish();
  };
  return (
    <StepShell title="Import conversations" description="Earlier Claude Code, Codex and OpenCode conversations become threads you can read and continue in Tau. Their text comes along; tool activity and attachments do not.">
      {pending.length > 0 ? <Selection count={chosen.length} total={pending.length} busy={importing} onAll={() => flow.select("sessions", pending.map((session) => session.path))} onNone={() => flow.select("sessions", [])} /> : null}
      <fieldset className="onboarding-list rows" disabled={importing}>
        <legend className="onboarding-sr">Conversations to import</legend>
        {pending.length === 0 ? <p className="onboarding-empty">{already ? "Every conversation found is in Tau already." : "No Claude Code or Codex conversations found."}</p> : null}
        {[...groups].map(([cwd, sessions]) => {
          const paths = sessions.map((session) => session.path);
          const count = paths.filter((path) => selected.has(path)).length;
          return (
            <div key={cwd} className="onboarding-group">
              <label className="onboarding-row" title={cwd}>
                <input type="checkbox" checked={count === paths.length} ref={(input) => { if (input) input.indeterminate = count > 0 && count < paths.length; }} onChange={(event) => toggle(paths, event.target.checked)} />
                <span className="onboarding-row-text"><strong>{cwd.split("/").pop() || cwd}</strong><small>{cwd}</small></span>
                <span className="onboarding-count">{plural(sessions.length, "conversation")}</span>
              </label>
              {sessions.map((session) => (
                <label key={session.path} className="onboarding-row nested">
                  <input type="checkbox" checked={selected.has(session.path)} onChange={(event) => toggle([session.path], event.target.checked)} />
                  <span className="onboarding-row-text"><span>{session.title || "Untitled conversation"}</span></span>
                  <span className="onboarding-meta"><SourceMarks sources={[session.source]} /><span /><span>{age(session.updatedAt, now)}</span></span>
                </label>
              ))}
            </div>
          );
        })}
      </fieldset>
      {already && pending.length ? <p className="onboarding-note">{plural(already, "conversation")} {already === 1 ? "is" : "are"} in Tau already.</p> : null}
      <Notes state={state} />
      {state.error ? <p className="onboarding-error" role="alert">{state.error}</p> : null}
      <div className="onboarding-actions">
        <button type="button" className="onboarding-button ghost" disabled={importing} onClick={finish}>{state.error ? "Continue without the rest" : "Do not import"}</button>
        <button type="button" className="onboarding-button primary" disabled={importing || chosen.length === 0} onClick={() => void run()}>
          {importing && state.progress ? `Importing… ${state.progress.done} of ${state.progress.total}` : `Import ${plural(chosen.length, "conversation")}`}
        </button>
      </div>
    </StepShell>
  );
}

/** The welcome wizard, drawn over the workbench as T3 Code draws its own over the workspace. */
export function createWelcomeWizard(flow: WelcomeFlow, runner?: () => TerminalRunner | undefined) {
  return function WelcomeWizard({ actions, onClose }: OverlayProps) {
    const state = useSyncExternalStore(flow.subscribe, flow.get);
    const threads = useThreadStore();
    const projects = useSyncExternalStore(threads.subscribeToProjects, () => threads.getSnapshot().projects);
    const known = new Set(projects.map((project) => project.path));
    useEffect(() => {
      flow.start();
      // Folders a reload interrupted are opened now.
      const pending = flow.get().pending;
      if (pending?.length) void flow.addProjects(actions, pending);
    }, []);
    const finish = () => { void flow.finish().then(onClose); };
    // The dialog, not a button, takes focus: the Enter that opened the wizard would press it.
    const dialog = useRef<HTMLElement>(null);
    useEffect(() => { dialog.current?.focus(); }, [state.step]);
    useEffect(() => {
      const key = (event: KeyboardEvent) => { if (event.key === "Escape" && !flow.get().busy) finish(); };
      window.addEventListener("keydown", key);
      return () => window.removeEventListener("keydown", key);
    });
    return (
      <div className="onboarding-screen">
        <section ref={dialog} tabIndex={-1} className="onboarding-dialog" role="dialog" aria-modal="true" aria-labelledby="onboarding-heading">
          <header className="onboarding-header">
            <h1 id="onboarding-heading" className="onboarding-sr">Set up Tau</h1>
            <div className="onboarding-identity" aria-hidden="true"><span className="onboarding-mark">τ</span>Tau</div>
            <Steps current={state.step} disabled={Boolean(state.busy)} onStep={(step) => flow.goTo(step)} />
          </header>
          <div className="onboarding-panel">
            {state.step === 0 ? <AgentsStep state={state} flow={flow} actions={actions} {...(runner ? { runner } : {})} />
              : state.step === 1 ? <ProjectsStep state={state} flow={flow} actions={actions} known={known} />
                : <ConversationsStep state={state} flow={flow} actions={actions} known={known} finish={finish} />}
          </div>
        </section>
      </div>
    );
  };
}

