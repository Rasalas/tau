import { useMemo, useState, type FormEvent, type ReactNode } from "react";
import { Copy, Plus, RefreshCw, SquareTerminal, TriangleAlert, X } from "lucide-react";
import type { UiRuntimeBackend } from "../../shared/contracts";
import {
  DEFAULT_INSTANCE_ID,
  formatEnvironment,
  instanceIdFromName,
  instanceIdProblem,
  parseEnvironment,
  runtimeDriver,
  type RuntimeInstanceConfig,
} from "../../shared/runtime-instances";
import { Button, TextField } from "../settings/controls";
import { SettingRow } from "../settings/settings-layout";
import { ProviderCardBadgeReport, useProviderCardBadge, type ProviderCardBadge } from "../settings/provider-card-state";
import { ConfirmDialog } from "./ui/ConfirmDialog";
import { Dialog } from "./ui/Dialog";
import "./runtime-instances.css";

/**
 * The pieces a runtime backend kit builds its Providers cards and banners
 * from: the program's rows (found, version, update, executable), an
 * instance's setup with its add/edit dialog, and the version banner. One
 * chunk, loaded with `loadRuntimeInstanceUi` from `tau` when a kit draws either.
 */

/** Puts a badge into the head of the Providers card it is drawn in, for a kit whose rows are its own. */
export { ProviderCardBadgeReport };
export type { ProviderCardBadge };

export interface RuntimeInstanceDialogProps {
  /** The program: "Codex". */
  program: string;
  /** The variable an instance's home becomes: `CODEX_HOME`. */
  homeVariable?: string;
  homePlaceholder?: string;
  /** The executable's name on the PATH: `codex`. */
  commandPlaceholder: string;
  /** The instance being edited; absent while one is added. */
  instance?: RuntimeInstanceConfig;
  /** Ids the new instance may not take. */
  takenIds: readonly string[];
  /** Saves; a rejection is shown in the dialog, which stays open. */
  onSave(instance: RuntimeInstanceConfig): Promise<void>;
  onClose(): void;
}

/** Add or edit one setup of a program: its name, executable, home, environment and arguments. */
export function RuntimeInstanceDialog({ program, homeVariable, homePlaceholder, commandPlaceholder, instance, takenIds, onSave, onClose }: RuntimeInstanceDialogProps) {
  const adding = instance === undefined;
  const isDefault = instance?.id === DEFAULT_INSTANCE_ID;
  const [name, setName] = useState(instance?.name ?? "");
  const [idOverride, setIdOverride] = useState<string>();
  const [command, setCommand] = useState(instance?.command ?? "");
  const [home, setHome] = useState(instance?.home ?? "");
  const [environment, setEnvironment] = useState(formatEnvironment(instance?.env));
  const [args, setArgs] = useState(instance?.args ?? "");
  const [attempted, setAttempted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string>();

  const id = adding ? idOverride ?? instanceIdFromName(name) : instance.id;
  const idProblem = adding ? instanceIdProblem(id, takenIds) : undefined;
  const parsedEnvironment = useMemo(() => parseEnvironment(environment), [environment]);
  const problem = idProblem ?? parsedEnvironment.problem;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setAttempted(true);
    if (problem || busy) return;
    setBusy(true);
    setFailure(undefined);
    try {
      await onSave({
        id,
        ...(name.trim() ? { name: name.trim() } : {}),
        ...(command.trim() ? { command: command.trim() } : {}),
        ...(home.trim() ? { home: home.trim() } : {}),
        ...(Object.keys(parsedEnvironment.env).length ? { env: parsedEnvironment.env } : {}),
        ...(args.trim() ? { args: args.trim() } : {}),
      });
      onClose();
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const title = adding ? `Add a ${program} instance` : isDefault ? `Edit ${program}` : `Edit ${instance.name ?? instance.id}`;
  return (
    <Dialog className="runtime-instance-dialog" label={title} onClose={onClose}>
      <header>
        <h2>{title}</h2>
        <p>{adding
          ? <>Another {program} setup beside the one Tau starts with — for example a second account in its own home. It gets its own tab in the model picker, and each thread stays on the instance it started on.</>
          : <>Changes apply to the next {program} process an instance starts; a thread that runs keeps its process until it is reopened.</>}</p>
      </header>
      <form onSubmit={(event) => void submit(event)} noValidate>
        <label className="runtime-instance-field">
          <span>Name</span>
          <TextField label="Name" width="full" value={name} placeholder={isDefault ? program : "e.g. Work"} autoFocus onChange={setName} />
          <small>Shown on the card and the picker tab{isDefault ? `; ${program} when empty` : ""}.</small>
        </label>
        {adding ? (
          <label className="runtime-instance-field">
            <span>Instance id</span>
            <TextField label="Instance id" width="full" mono value={id} placeholder="work" error={attempted ? idProblem : undefined} onChange={setIdOverride} />
            {attempted && idProblem ? null : <small>What threads remember the instance by. It cannot change later.</small>}
          </label>
        ) : null}
        <label className="runtime-instance-field">
          <span>Executable</span>
          <TextField label="Executable" width="full" mono value={command} placeholder={`${commandPlaceholder}, from your login shell's PATH`} onChange={setCommand} />
          <small>A name on the PATH or an absolute path.</small>
        </label>
        {homeVariable ? (
          <label className="runtime-instance-field">
            <span>Home folder</span>
            <TextField label="Home folder" width="full" mono value={home} placeholder={homePlaceholder} onChange={setHome} />
            <small>Becomes <code>{homeVariable}</code>: where this instance keeps its login, configuration and sessions. Empty keeps {program}'s own.</small>
          </label>
        ) : null}
        <label className="runtime-instance-field">
          <span>Environment</span>
          <TextField label="Environment" width="full" mono rows={3} value={environment} placeholder="NAME=value, one per line" error={attempted ? parsedEnvironment.problem : undefined} onChange={setEnvironment} />
          {attempted && parsedEnvironment.problem ? null : <small>Added to the environment {program} starts with.</small>}
        </label>
        <label className="runtime-instance-field">
          <span>Launch arguments</span>
          <TextField label="Launch arguments" width="full" mono value={args} placeholder="e.g. -c model_verbosity=low" onChange={setArgs} />
          <small>Passed on every start, split like a shell would, without expansion.</small>
        </label>
        {failure ? <p className="runtime-instance-problem" role="alert">{failure}</p> : null}
        <footer>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" busy={busy}>{busy ? "Saving…" : adding ? "Add instance" : "Save"}</Button>
        </footer>
      </form>
    </Dialog>
  );
}

/** An instance as a card knows it: its settings, what the workbench calls it and how many threads it has. */
export interface RuntimeInstanceView extends RuntimeInstanceConfig {
  label: string;
  threads?: number;
}

export interface RuntimeInstanceSetupProps extends Pick<RuntimeInstanceDialogProps, "program" | "homeVariable" | "homePlaceholder" | "commandPlaceholder"> {
  /** The card's instance; absent until the host named it. */
  instance?: RuntimeInstanceView;
  /** Every instance of the program, for the ids a new one may not take. */
  instances: readonly RuntimeInstanceConfig[];
  /** Adds or edits an instance; a rejection stays in the dialog. */
  onSave(instance: RuntimeInstanceConfig): Promise<void>;
  /** Removes the card's instance; absent for the default one. */
  onRemove?(): Promise<void>;
  /** The setup row's element id, for a search result to scroll to; the add and remove rows take it with `-add` and `-remove`. */
  rowId?: string;
}

function setupSummary(instance: RuntimeInstanceConfig | undefined): string | undefined {
  if (!instance) return undefined;
  const variables = Object.keys(instance.env ?? {}).length;
  const parts = [
    instance.home ? `home ${instance.home}` : undefined,
    variables ? `${variables} variable${variables === 1 ? "" : "s"}` : undefined,
    instance.args ? `arguments ${instance.args}` : undefined,
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : undefined;
}

/**
 * The part of a Providers card that is about instances: how this one is set
 * up, editing or removing it, and — on the default instance's card — adding
 * another. The kit keeps the instances and saves them; this draws and asks.
 */
export function RuntimeInstanceSetup({ program, homeVariable, homePlaceholder, commandPlaceholder, instance, instances, onSave, onRemove, rowId }: RuntimeInstanceSetupProps) {
  const [dialog, setDialog] = useState<"add" | "edit">();
  const [confirming, setConfirming] = useState(false);
  const [failure, setFailure] = useState<string>();
  const isDefault = instance?.id === DEFAULT_INSTANCE_ID;
  const remove = async () => {
    setConfirming(false);
    setFailure(undefined);
    try {
      await onRemove?.();
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error));
    }
  };
  const threads = instance?.threads ?? 0;
  const name = instance?.label ?? instance?.id ?? program;
  const leaving = threads
    ? `Its ${threads} thread${threads === 1 ? "" : "s"} leave the thread list; an instance with the id “${instance?.id}” brings them back.`
    : `Tau forgets its setup; the login and sessions in its home stay.`;
  return (
    <>
      <SettingRow
        {...(rowId ? { id: rowId } : {})}
        title="Setup"
        description={setupSummary(instance) ?? `${isDefault ? `${program}'s own` : "The default"} home and environment, no extra arguments.`}
        status={failure ? <p className="runtime-row-error" role="alert">{failure}</p> : undefined}
        disabledReason={instance ? undefined : `Waiting for the host to name ${program}'s instances.`}
        control={<Button onClick={() => setDialog("edit")}>Edit…</Button>}
      />
      {isDefault ? (
        <SettingRow
          {...(rowId ? { id: `${rowId}-add` } : {})}
          title="Another instance"
          description="Another account or home beside this one gets a card and a picker tab of its own."
          control={<Button icon={<Plus size={13} aria-hidden />} onClick={() => setDialog("add")}>Add instance…</Button>}
        />
      ) : null}
      {onRemove ? (
        <SettingRow
          {...(rowId ? { id: `${rowId}-remove` } : {})}
          title="Remove this instance"
          description={leaving}
          control={<Button variant="danger" onClick={() => setConfirming(true)}>Remove…</Button>}
        />
      ) : null}
      {confirming ? (
        <ConfirmDialog
          title={`Remove “${name}”?`}
          message={leaving}
          confirmLabel="Remove instance"
          destructive
          onCancel={() => setConfirming(false)}
          onConfirm={() => void remove()}
        />
      ) : null}
      {dialog ? (
        <RuntimeInstanceDialog
          program={program}
          commandPlaceholder={commandPlaceholder}
          {...(homeVariable ? { homeVariable } : {})}
          {...(homePlaceholder ? { homePlaceholder } : {})}
          {...(dialog === "edit" && instance ? { instance } : {})}
          takenIds={instances.map((entry) => entry.id)}
          onSave={onSave}
          onClose={() => setDialog(undefined)}
        />
      ) : null}
    </>
  );
}

type RuntimeCompatibility = NonNullable<NonNullable<UiRuntimeBackend["version"]>["compatibility"]>;

/** What a kit's host half found out about its program, in the words the rows need. */
export interface RuntimeProgramState {
  /** On disk, or the server answered. */
  found: boolean;
  version?: string;
  /** Where: the executable's path, or the server's address. */
  location?: string;
  /** The host's word about a problem; shown instead of the location. */
  message?: string;
  /** The version found is older than Tau speaks to. */
  unsupported?: boolean;
  /** The oldest version Tau speaks to. */
  minimum?: string;
  /** A newer release than the one found. */
  latest?: string;
  updateCommand?: string;
  /** The version policy's verdict, when it is not "supported". */
  compatibility?: RuntimeCompatibility;
}

/** The word the card's head shows for the program. */
export function programBadge(state: RuntimeProgramState | undefined, installed = "Installed"): ProviderCardBadge | undefined {
  if (!state) return undefined;
  if (!state.found) return { label: "Not found", tone: "danger" };
  const verdict = state.compatibility?.status;
  if (verdict === "broken") return { label: "Does not work", tone: "danger" };
  if (state.unsupported) return { label: "Too old", tone: "danger" };
  if (verdict === "unsafe") return { label: "Known problems", tone: "warn" };
  if (state.message) return { label: "Needs attention", tone: "warn" };
  if (state.latest) return { label: "Update available", tone: "neutral" };
  return { label: installed, tone: "success" };
}

export interface RuntimeProgramRowsProps {
  /** The program as the card names it: "Codex", "Codex · Work". */
  program: string;
  /** What the rows' element ids start with: `setting-codex`; the rows add `-program`, `-version` and `-update`. */
  idPrefix: string;
  /** The first row's title: "CLI", "Server", "Runtime". */
  title?: string;
  /** What the first row's info glyph says: how threads use the program. */
  help?: string;
  /** Absent while the host is asked. */
  state?: RuntimeProgramState;
  /** The next step while it is not found. */
  missing: string;
  /** Beside Check again while it is not found: an install button. */
  missingAction?: ReactNode;
  /** The head's word for a healthy program; "Installed" by default. */
  installedLabel?: string;
  busy?: boolean;
  /** What went wrong asking the host or saving, under the first row. */
  error?: string;
  onCheck(): void;
  /** Hands a command to a terminal for the user to run; without it no row offers one. */
  onRunCommand?(command: string): void;
}

/**
 * A Providers card's rows about the program itself: found where and which
 * version, with Check again; a version Tau does not work well with, one too
 * old, or a newer release, each with the step that fixes it. Tau runs none
 * of those commands itself: they go into a terminal the user sees.
 */
export function RuntimeProgramRows({ program, idPrefix, title = "CLI", help, state, missing, missingAction, installedLabel, busy = false, error, onCheck, onRunCommand }: RuntimeProgramRowsProps) {
  useProviderCardBadge("program", programBadge(state, installedLabel));
  const compatibility = state?.compatibility && state.compatibility.status !== "supported" ? state.compatibility : undefined;
  const install = compatibility?.installCommand ?? state?.updateCommand;
  const terminal = (command: string | undefined, label: string) => command && onRunCommand
    ? <Button icon={<SquareTerminal size={13} aria-hidden />} onClick={() => onRunCommand(command)}>{label}</Button>
    : undefined;
  const where = state?.message ?? state?.location;
  return (
    <>
      <SettingRow
        id={`${idPrefix}-program`}
        title={title}
        {...(help ? { help } : {})}
        status={error ? <p className="runtime-row-error" role="alert">{error}</p> : undefined}
        description={!state ? error ? `Tau could not ask about ${program}.` : "Checking…"
          : state.found ? <>{state.version ? `${state.version}${where ? " · " : ""}` : ""}{state.message ?? (state.location ? <code>{state.location}</code> : null)}</>
            : state.message ?? missing}
        control={<>
          {state && !state.found ? missingAction : null}
          <Button icon={<RefreshCw size={13} aria-hidden />} busy={busy} onClick={onCheck}>{busy ? "Checking…" : "Check again"}</Button>
        </>}
      />
      {state && compatibility ? (
        <SettingRow
          id={`${idPrefix}-version`}
          title={`${program}${state.version ? ` ${state.version}` : ""} ${compatibility.status === "broken" ? "does not work with Tau" : "has known problems with Tau"}`}
          description={`${compatibility.message ?? (compatibility.status === "broken" ? "Threads on it do not start." : "Turns may fail or report less than they should.")}${compatibility.recommendedVersion ? ` Tau was tested with ${compatibility.recommendedVersion}.` : ""}`}
          control={terminal(install, compatibility.installCommand && compatibility.recommendedVersion ? `Install ${compatibility.recommendedVersion} in a terminal` : "Update in a terminal")}
        />
      ) : state?.unsupported ? (
        <SettingRow
          id={`${idPrefix}-version`}
          title="Version too old"
          description={`Tau speaks to ${program}${state.minimum ? ` ${state.minimum}` : ""} and newer${state.version ? `; ${state.version} is installed` : ""}.`}
          control={terminal(state.updateCommand, "Update in a terminal")}
        />
      ) : state?.latest ? (
        <SettingRow
          id={`${idPrefix}-update`}
          title="Update available"
          description={`${program} ${state.latest} is out${state.version ? `; ${state.version} is installed` : ""}.`}
          control={terminal(state.updateCommand, "Update in a terminal")}
        />
      ) : null}
    </>
  );
}

export interface RuntimeCommandRowProps {
  /** The row's element id. */
  id: string;
  /** "Codex": the field is "Codex executable". */
  program: string;
  /** The name looked up on the PATH when the field is empty; the host's command while it names no path. */
  commandName?: string;
  /** The variable in Tau's environment that overrides the setting; `TAU_<KIND>_COMMAND` from `kind` by default. */
  variable?: string;
  /** The runtime backend kind, for the default `variable`. */
  kind?: string;
  /** Whether the host has answered; the field waits until then. */
  known: boolean;
  /** The command the host runs, and who named it: `setting`, `env`, or neither for the default. */
  command?: string;
  source?: string;
  placeholder?: string;
  /** Says what an empty field means, where that is not the PATH. */
  description?: string;
  onSave(command: string): Promise<void> | void;
}

/** The variable most runtime kits read the executable from: `TAU_CODEX_COMMAND` for `codex@work`. */
export function commandVariable(kind: string): string {
  return `TAU_${runtimeDriver(kind).toUpperCase().replace(/[^A-Z0-9]+/gu, "_")}_COMMAND`;
}

/** Where Tau finds the program: a path or a name, saved when the field is left or on Enter; empty goes back to the default. */
export function RuntimeCommandRow({ id, program, commandName, variable, kind, known, command, source, placeholder, description, onSave }: RuntimeCommandRowProps) {
  const fromEnv = source === "env";
  const saved = source === "setting" ? command ?? "" : "";
  const name = commandName ?? (source === undefined ? command : undefined);
  const override = variable ?? (kind ? commandVariable(kind) : undefined);
  return (
    <SettingRow
      id={id}
      title="Executable"
      description={fromEnv ? `Set by ${override ?? "a variable"} in Tau's environment.`
        : description ?? `A name on the PATH or an absolute path. Empty looks for ${name ?? program} on the PATH.`}
      disabledReason={fromEnv ? `${override ?? "A variable"} in Tau's environment names it; change it there.` : !known ? `Waiting for the host to report ${program}.` : undefined}
      control={<TextField label={`${program} executable`} mono width="lg" value={fromEnv ? command ?? "" : saved} placeholder={placeholder ?? (name ? `${name}, from your login shell's PATH` : "A name or an absolute path")} onCommit={(text) => void onSave(text.trim())} />}
    />
  );
}

export interface RuntimeVersionBannerProps {
  backend: UiRuntimeBackend;
  /** Puts the command into a terminal without running it; absent where no terminal can take it. */
  onInstall?(command: string): void;
  onCopy?(command: string): void;
  /** Absent where the warning stays, as on a Providers card. */
  onDismiss?(): void;
}

/**
 * The warning above the composer when the thread's program is a version its
 * backend's policy calls unsafe or broken, with the release to install and
 * the command that installs it. Tau never runs that command itself.
 */
export function RuntimeVersionBanner({ backend, onInstall, onCopy, onDismiss }: RuntimeVersionBannerProps) {
  const version = backend.version;
  const compatibility = version?.compatibility;
  if (!compatibility || compatibility.status === "supported") return null;
  const broken = compatibility.status === "broken";
  const command = compatibility.installCommand ?? version?.updateCommand;
  const title = `${backend.label} ${version?.installed ?? ""} ${broken ? "does not work with Tau" : "has known problems with Tau"}`.replace(/\s+/gu, " ");
  const detail = compatibility.message
    ?? (broken ? "Threads on it do not start." : "Turns may fail or report less than they should.");
  const advice = compatibility.recommendedVersion ? ` Tau was tested with ${compatibility.recommendedVersion}.` : "";
  return (
    <div className="runtime-version-banner" role={broken ? "alert" : "status"} data-status={compatibility.status}>
      <TriangleAlert size={14} aria-hidden />
      <div className="runtime-version-banner-body">
        <strong>{title}</strong>
        <p>{detail}{advice}</p>
        {command ? (
          <div className="runtime-version-banner-actions">
            {onInstall ? (
              <button type="button" onClick={() => onInstall(command)}>
                <SquareTerminal size={13} aria-hidden /> {compatibility.installCommand && compatibility.recommendedVersion ? `Install ${compatibility.recommendedVersion} in a terminal` : "Update in a terminal"}
              </button>
            ) : null}
            <code>{command}</code>
            {onCopy ? <button type="button" className="runtime-version-banner-icon" aria-label="Copy the command" data-tooltip="Copy the command" onClick={() => onCopy(command)}><Copy size={12} aria-hidden /></button> : null}
          </div>
        ) : null}
      </div>
      {onDismiss ? <button type="button" className="runtime-version-banner-icon" aria-label={`Dismiss the ${backend.label} version warning`} onClick={onDismiss}><X size={13} aria-hidden /></button> : null}
    </div>
  );
}
