import { useMemo, useState, type FormEvent } from "react";
import { Copy, Plus, SquareTerminal, TriangleAlert, X } from "lucide-react";
import type { UiRuntimeBackend } from "../../shared/contracts";
import {
  DEFAULT_INSTANCE_ID,
  formatEnvironment,
  instanceIdFromName,
  instanceIdProblem,
  parseEnvironment,
  type RuntimeInstanceConfig,
} from "../../shared/runtime-instances";
import { Dialog } from "./ui/Dialog";
import "./runtime-instances.css";

/**
 * The pieces a runtime backend kit builds its Providers cards and banners
 * from: an instance's setup with its add/edit dialog, and the version banner. One chunk,
 * loaded with `loadRuntimeInstanceUi` from `tau` when a kit draws either.
 */

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
          <input aria-label="Name" value={name} placeholder={isDefault ? program : "e.g. Work"} onChange={(event) => setName(event.target.value)} autoFocus />
          <small>Shown on the card and the picker tab{isDefault ? `; ${program} when empty` : ""}.</small>
        </label>
        {adding ? (
          <label className="runtime-instance-field">
            <span>Instance id</span>
            <input aria-label="Instance id" value={id} placeholder="work" aria-invalid={attempted && idProblem !== undefined} onChange={(event) => setIdOverride(event.target.value)} spellCheck={false} />
            {attempted && idProblem ? <small className="runtime-instance-problem">{idProblem}</small> : <small>What threads remember the instance by. It cannot change later.</small>}
          </label>
        ) : null}
        <label className="runtime-instance-field">
          <span>Executable</span>
          <input aria-label="Executable" value={command} placeholder={`${commandPlaceholder}, from your login shell's PATH`} onChange={(event) => setCommand(event.target.value)} spellCheck={false} />
          <small>A name on the PATH or an absolute path.</small>
        </label>
        {homeVariable ? (
          <label className="runtime-instance-field">
            <span>Home folder</span>
            <input aria-label="Home folder" value={home} placeholder={homePlaceholder} onChange={(event) => setHome(event.target.value)} spellCheck={false} />
            <small>Becomes <code>{homeVariable}</code>: where this instance keeps its login, configuration and sessions. Empty keeps {program}'s own.</small>
          </label>
        ) : null}
        <label className="runtime-instance-field">
          <span>Environment</span>
          <textarea aria-label="Environment" value={environment} rows={3} placeholder="NAME=value, one per line" aria-invalid={attempted && parsedEnvironment.problem !== undefined} onChange={(event) => setEnvironment(event.target.value)} spellCheck={false} />
          {attempted && parsedEnvironment.problem ? <small className="runtime-instance-problem">{parsedEnvironment.problem}</small> : <small>Added to the environment {program} starts with.</small>}
        </label>
        <label className="runtime-instance-field">
          <span>Launch arguments</span>
          <input aria-label="Launch arguments" value={args} placeholder="e.g. -c model_verbosity=low" onChange={(event) => setArgs(event.target.value)} spellCheck={false} />
          <small>Passed on every start, split like a shell would, without expansion.</small>
        </label>
        {failure ? <p className="runtime-instance-problem" role="alert">{failure}</p> : null}
        <footer>
          <button type="button" className="text-button" onClick={onClose}>Cancel</button>
          <button type="submit" className="primary" disabled={busy}>{busy ? "Saving…" : adding ? "Add instance" : "Save"}</button>
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
export function RuntimeInstanceSetup({ program, homeVariable, homePlaceholder, commandPlaceholder, instance, instances, onSave, onRemove }: RuntimeInstanceSetupProps) {
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
  return (
    <div className="runtime-instance-setup">
      <div className="settings-label">SETUP</div>
      <div className="runtime-instance-row">
        <span>{setupSummary(instance) ?? `${isDefault ? `${program}'s own` : "The default"} home and environment, no extra arguments.`}</span>
        <button type="button" className="runtime-instance-action" disabled={!instance} onClick={() => setDialog("edit")}>Edit…</button>
        {onRemove ? <button type="button" className="runtime-instance-action" onClick={() => setConfirming(true)}>Remove</button> : null}
      </div>
      {confirming ? (
        <div className="runtime-instance-row" role="alert">
          <span>
            Remove “{instance?.label ?? instance?.id}”?
            {threads ? ` Its ${threads} thread${threads === 1 ? "" : "s"} leave the thread list; an instance with the id “${instance?.id}” brings them back.` : ""}
          </span>
          <button type="button" className="runtime-instance-action" onClick={() => setConfirming(false)}>Keep</button>
          <button type="button" className="runtime-instance-action danger" onClick={() => void remove()}>Remove instance</button>
        </div>
      ) : null}
      {isDefault ? (
        <div className="runtime-instance-row">
          <span>Another account or home beside this one gets a card and a picker tab of its own.</span>
          <button type="button" className="runtime-instance-action" onClick={() => setDialog("add")}><Plus size={13} aria-hidden /> Add instance…</button>
        </div>
      ) : null}
      {failure ? <p className="settings-note" data-level="error">{failure}</p> : null}
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
    </div>
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
