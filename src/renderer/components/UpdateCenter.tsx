import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ArrowUpCircle, Check, ChevronRight, Clock3, ExternalLink, Laptop, LoaderCircle, Server, TriangleAlert } from "lucide-react";
import { compareVersions } from "../../shared/runtime-version";
import { hostUpdatePending } from "../../shared/host-updates";
import type { UpdateCenterView, UpdateCoordinator, UpdateStep } from "../../workbench/update-center";
import { errorMessage } from "../../workbench/error-message";
import { useHostClient } from "../host-client-context";
import { useHostUpdate } from "../machine-updates";
import { useAppUpdate } from "../renderer-services-context";
import { usePlatform } from "../platform-context";
import { onOpenReleaseNotes, onOpenUpdates } from "../release-notes";
import { useReleaseNotes } from "../use-release-notes";
import { Popover } from "../deferred-surfaces";
import { ReleaseNotesContent, UpdateNotes } from "./UpdateNotes";
import "./update-center.css";

const EMPTY: UpdateCenterView = { steps: [], busy: false, reading: false, started: false };
const noSubscription = () => () => {};
const active = new Set(["downloading", "waiting", "installing"]);

/** One compact entry for a normal app update and the optional Machines extension's shared run. */
export function UpdateCenter({ coordinator, onSettings, readOnly = false }: { coordinator?: UpdateCoordinator | undefined; onSettings(): void; readOnly?: boolean }) {
  const client = useHostClient();
  const appUpdate = useAppUpdate();
  const host = useHostUpdate();
  const status = host.status;
  const environments = usePlatform().environments;
  const machines = useSyncExternalStore(environments?.subscribe ?? noSubscription, () => environments?.getSnapshot());
  const view = useSyncExternalStore(coordinator?.subscribe ?? noSubscription, coordinator?.getSnapshot ?? (() => EMPTY));
  const anchor = useRef<HTMLButtonElement>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const closeTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const previewArea = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState(false);
  const [notesVersion, setNotesVersion] = useState<string>();
  const [resume, setResume] = useState(true);
  const [working, setWorking] = useState(false);
  const [problem, setProblem] = useState<string>();
  const [expanded, setExpanded] = useState({ done: false, skipped: false, queued: false });
  const [dismissed, setDismissed] = useState(false);
  const [notesAttempt, setNotesAttempt] = useState(0);
  const versions = client?.getVersions();
  const plannedVersion = view.steps.flatMap((step) => step.version ? [step.version] : []).sort(compareVersions).at(-1);
  const deferred = (step: UpdateStep) => step.state === "queued" || step.state === "skipped" && step.deferUntilOnline === true;
  const newerOffer = appUpdate && plannedVersion && compareVersions(appUpdate.version, plannedVersion) > 0 && !view.busy && !view.steps.some((step) => step.uncertain || deferred(step));
  const usingPlan = !newerOffer && view.steps.some((step) => step.state !== "skipped" && step.state !== "reading" || deferred(step));
  const planStarted = usingPlan && view.started;
  const steps: UpdateStep[] = usingPlan ? view.steps : appUpdate || hostUpdatePending(status) ? [{
    machine: "local", machineName: "This machine", kind: "app", label: "Tau", version: appUpdate?.version ?? status?.latest,
    fromVersion: status?.version ?? versions?.window ?? versions?.host,
    state: status?.phase === "failed" ? "failed" : status?.phase === "installed" ? "running" : active.has(status?.phase ?? "") || appUpdate?.phase ? "running" : "pending",
  }] : [];
  const available = steps.some((step) => step.state === "pending" || step.state === "skipped" && step.deferUntilOnline);
  const waiting = new Set(steps.filter(deferred).map((step) => step.machine)).size;
  const running = view.busy || working || steps.some((step) => step.state === "running");
  const failed = steps.some((step) => step.state === "failed" || step.uncertain);
  const completed = steps.length > 0 && !available && !running && !waiting && !view.reading;
  const target = [...steps.filter((step) => step.kind !== "tools" && step.version).map((step) => step.version!), ...(appUpdate ? [appUpdate.version] : [])].sort(compareVersions).at(-1);
  const from = steps.map((step) => step.fromVersion).filter((value): value is string => Boolean(value)).sort(compareVersions)[0];
  const displayedVersion = notesVersion ?? target;
  const notes = useReleaseNotes(displayedVersion, notesVersion ? undefined : from, open || preview, notesAttempt);
  const entriesFor = (id: string) => steps.filter((step) => step.machine === id);
  const isLocal = (id: string) => entriesFor(id).some((step) => step.kind === "app") || machines?.environments.some((machine) => machine.id === id && machine.local) === true;
  const attention = (id: string) => entriesFor(id).some((step) => step.state === "failed" || step.uncertain);
  const ids = [...new Set(steps.map((step) => step.machine))].sort((a, b) => Number(attention(b)) - Number(attention(a)) || Number(isLocal(a)) - Number(isLocal(b)));
  const total = new Set(steps.filter((step) => step.state !== "skipped" || deferred(step)).map((step) => step.machine)).size;
  const done = ids.filter((id) => entriesFor(id).some((step) => step.state !== "skipped") && entriesFor(id).every((step) => step.state === "done" || step.state === "skipped")).length;

  useEffect(() => onOpenReleaseNotes((version) => { setNotesVersion(version); setOpen(true); setPreview(false); }), []);
  useEffect(() => onOpenUpdates(() => { setDismissed(false); setNotesVersion(undefined); setOpen(true); setPreview(false); }), []);
  useEffect(() => () => { clearTimeout(hoverTimer.current); clearTimeout(closeTimer.current); }, []);
  useEffect(() => { setDismissed(false); }, [target]);

  if ((!steps.length || dismissed) && !notesVersion) return null;
  const toolsOnly = steps.every((step) => step.kind === "tools");
  const label = running ? `Updating Tau, ${done} of ${total} machines finished` : waiting && planStarted ? `${waiting} machine${waiting === 1 ? "" : "s"} will update when online` : target ? `Tau ${target} is ready: restart to update` : toolsOnly ? "Agent tool updates" : "Machine updates";
  const close = () => { clearTimeout(closeTimer.current); setOpen(false); setNotesVersion(undefined); setPreview(false); };
  const progressLabel = total > 1 ? `${done}/${total}` : status?.phase === "waiting" ? "Ready" : status?.progress !== undefined ? `${Math.round(status.progress)}%` : undefined;
  const showPreview = (immediate = false) => {
    clearTimeout(hoverTimer.current);
    clearTimeout(closeTimer.current);
    if (!open) hoverTimer.current = setTimeout(() => setPreview(true), immediate ? 0 : 350);
  };
  const leavePreview = () => {
    clearTimeout(hoverTimer.current);
    clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => {
      if (!anchor.current?.matches(":hover") && !previewArea.current?.matches(":hover") && !anchor.current?.contains(document.activeElement) && !previewArea.current?.contains(document.activeElement)) setPreview(false);
    }, 250);
  };
  const run = async () => {
    setWorking(true); setProblem(undefined);
    try {
      if (coordinator && usingPlan) await coordinator.run(resume);
      else if (status && status.phase !== "unsupported") await host.store!.install();
      else appUpdate?.install();
    } catch (error) { setProblem(errorMessage(error)); }
    finally { setWorking(false); }
  };
  const needsCheck = steps.some((step) => step.uncertain);
  const row = (id: string) => {
    const entries = entriesFor(id);
    const step = entries.find((entry) => entry.state === "failed" || entry.uncertain) ?? entries.find((entry) => entry.state === "running" || entry.state === "pending" || deferred(entry)) ?? entries[0]!;
    const own = isLocal(id);
    const live = machines?.environments.find((machine) => machine.id === id)?.update ?? (own ? status : undefined);
    const detail = live && active.has(live.phase) ? live.phase === "waiting" ? live.reason ?? `Waits for ${live.runningTurns ?? "running"} turns` : live.phase === "downloading" ? `Downloading${live.progress !== undefined ? ` ${Math.round(live.progress)}%` : ""}` : "Restarting…"
      : step.message ?? (step.state === "done" ? "Updated" : step.state === "skipped" ? "Skipped" : step.kind === "tools" ? step.tools?.map((tool) => tool.label).join(", ") : `${step.fromVersion ?? ""} → ${step.version ?? ""}`);
    const cancellable = step.state === "queued" && Boolean(coordinator?.cancelQueued);
    const retryable = step.state === "failed" && Boolean(coordinator);
    const Icon = step.state === "done" ? Check : step.state === "failed" ? TriangleAlert : step.state === "running" ? LoaderCircle : own ? Laptop : Server;
    return <div className="update-machine" key={id} data-state={step.state} data-action={retryable || cancellable}>
      <Icon size={13} className={step.state === "running" ? "update-spin" : undefined} aria-hidden="true" />
      <span className="update-machine-name">{own ? "This machine" : step.machineName ?? id}</span>
      <span className="update-machine-detail" title={detail}>{detail}</span>
      {retryable || cancellable ? <button type="button" className="update-retry" aria-label={cancellable ? `Cancel queued update for ${step.machineName ?? id}` : undefined} disabled={readOnly || running || view.reading} onClick={() => void (cancellable ? coordinator!.cancelQueued!(id) : step.uncertain ? coordinator!.check() : coordinator!.retry?.(id) ?? coordinator!.review())}>{cancellable ? "Cancel" : step.uncertain ? "Check" : "Retry"}</button> : null}
    </div>;
  };
  const doneIds = ids.filter((id) => entriesFor(id).every((step) => step.state === "done"));
  const queuedIds = ids.filter((id) => entriesFor(id).some(deferred));
  const skippedIds = ids.filter((id) => !queuedIds.includes(id) && entriesFor(id).every((step) => step.state === "skipped"));
  const collapsed = ids.length > 5;
  const visible = ids.filter((id) => !collapsed || (!doneIds.includes(id) && !skippedIds.includes(id) && !queuedIds.includes(id)));
  const groups = ([['queued', queuedIds, 'When online'], ['done', doneIds, 'Updated'], ['skipped', skippedIds, 'Skipped']] as const).map(([key, entries, title]) => collapsed && entries.length ? <div key={key}>
    <button type="button" className="update-group" aria-expanded={expanded[key]} onClick={() => setExpanded((value) => ({ ...value, [key]: !value[key] }))}><ChevronRight size={13} /><span>{title}</span><small>{entries.length}</small></button>
    {expanded[key] ? entries.map(row) : null}
  </div> : null);
  const Mark = running ? LoaderCircle : waiting && planStarted ? Clock3 : completed && !failed ? Check : ArrowUpCircle;
  return <>
    <button ref={anchor} type="button" className="sidebar-update" aria-label={label} aria-haspopup="dialog" aria-expanded={open}
      onPointerEnter={(event) => { if (event.pointerType !== "touch") showPreview(); }}
      onPointerLeave={leavePreview}
      onFocus={(event) => { if (event.currentTarget.matches(":focus-visible")) showPreview(true); }} onBlur={leavePreview}
      onKeyDown={(event) => { if (preview && (event.key === "ArrowUp" || event.key === "Tab" && !event.shiftKey)) { event.preventDefault(); previewArea.current?.querySelector<HTMLButtonElement>("button")?.focus(); } }}
      onClick={() => { clearTimeout(hoverTimer.current); clearTimeout(closeTimer.current); setPreview(false); setOpen((value) => !value); }}>
      <Mark size={15} className={running ? "update-spin" : undefined} aria-hidden="true" />{running && progressLabel ? <small>{progressLabel}</small> : null}
      {!running && (planStarted && waiting ? waiting : total) > 1 ? <span className="update-count">{planStarted && waiting ? waiting : total}</span> : null}
    </button>
    {preview && !open ? <Popover anchor={anchor} side="top" align="end" label="Update preview" className="update-center update-preview" takeFocus={false} onClose={() => setPreview(false)}>
      <div ref={previewArea} className="update-preview-content" onPointerEnter={() => clearTimeout(closeTimer.current)} onPointerLeave={leavePreview} onFocus={() => clearTimeout(closeTimer.current)} onBlur={leavePreview}>
        <header className="update-center-head"><div><h3>{target ? "What's new" : toolsOnly ? "Agent tools" : "Updates"}</h3><p>{from && target && from !== target ? `${from} → ${target}` : target ?? "Available updates"}</p></div><button type="button" className="update-icon" aria-label="Review updates" onClick={() => { setPreview(false); setOpen(true); }}><ChevronRight size={14} /></button></header>
        {target ? <ReleaseNotesContent version={target} notes={notes} onRetry={() => setNotesAttempt((attempt) => attempt + 1)} /> : <p className="update-preview-tools">Updates for your machines.</p>}
      </div>
    </Popover> : null}
    {open ? <Popover anchor={anchor} side="top" align="end" label={notesVersion ? "What's new" : "Updates"} className="update-center" onClose={close}>
      {notesVersion ? <UpdateNotes version={notesVersion} fromVersion={notesVersion === target ? from : undefined} onBack={() => { if (steps.length) setNotesVersion(undefined); else close(); }} /> : <>
        <header className="update-center-head"><div><h3>{running ? "Updating" : waiting && planStarted ? "Waiting for machines" : completed ? failed ? `Updated ${done} of ${total}` : "Updates finished" : total <= 1 && target ? `${target} is available` : "Updates"}</h3><p>{waiting ? `${waiting} will update when online. Keep Tau open here.` : running ? "Running work finishes first." : total > 1 ? "This machine restarts last." : from ? `You have ${from}.` : undefined}</p></div><button type="button" className="update-icon" aria-label="Update settings" onClick={() => { close(); onSettings(); }}><ExternalLink size={13} /></button></header>
        {running || waiting && planStarted ? <div className="update-segments" aria-hidden="true">{ids.filter((id) => !skippedIds.includes(id)).map((id) => <i key={id} data-done={doneIds.includes(id)} />)}</div> : null}
        <div className="update-center-rows">
          {target ? <button type="button" className="update-notes-entry" onClick={() => setNotesVersion(target)}><span><strong>What's new in {target}</strong><small>{notes.state === "ready" ? notes.releases[0]?.items[0] : notes.state === "loading" ? "Loading release notes…" : "Read release notes"}</small></span><ChevronRight size={13} /></button> : null}
          {visible.map(row)}{groups}
        </div>
        {(problem ?? view.problem) ? <p className="update-problem" role="alert">{problem ?? view.problem}</p> : null}
        <footer className="update-center-foot">
          {total > 1 && !planStarted ? <label className="update-resume" title="Only this update. Questions still wait."><input type="checkbox" checked={resume} disabled={readOnly || running} onChange={(event) => setResume(event.target.checked)} /><span className="update-toggle" aria-hidden="true" /><span>Resume interrupted threads</span></label> : <span />}
          {needsCheck ? <button type="button" className="update-quiet" disabled={running} onClick={() => void coordinator?.check()}>Check results</button> : available && !planStarted ? <button type="button" className="update-primary" disabled={readOnly || running || view.reading} onClick={() => void run()}><ArrowUpCircle size={13} aria-hidden="true" />{total > 1 ? "Update all" : "Update"}</button> : failed && !running && !waiting ? <button type="button" className="update-quiet" disabled={readOnly} onClick={() => { if (coordinator && usingPlan) void coordinator.review(); else void run(); }}>{coordinator && usingPlan ? "Review again" : "Retry"}</button> : <button type="button" className="update-quiet" onClick={() => { close(); if (completed) setDismissed(true); }}>{running || waiting ? "Hide" : "Done"}</button>}
        </footer>
      </>}
    </Popover> : null}
  </>;
}
