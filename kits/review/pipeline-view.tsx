import { Fragment, useEffect, useState, type MouseEvent } from "react";
import { createPortal } from "react-dom";
import { Ban, Check, ChevronsRight, Clock, ExternalLink, Pause, X } from "lucide-react";
import { Sheet, tooltipProps, type WorkbenchActions } from "tau";
import { useCompactProfile } from "./compact-profile.js";
import type { PullRequestCheck } from "./protocol.js";
import type { PullRequestClient } from "./pull-request-client.js";
import { checksPipelines, isActive, jobProgress, jobTiming, runIdOf, stageProgress, stageState, STATE_WORDS, type JobState, type Pipeline, type PipelineFacts, type PipelineJob } from "./pipeline.js";

/** A clock that ticks only while something runs. */
export function useNow(active: boolean): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active]);
  return now;
}

/** The facts of the checks' workflow runs, asked again only when the set of runs changes; the host caches them.
 * `byName` reads the files on the default branch by workflow name, which a list's rows share. */
export function usePipelineFacts(client: PullRequestClient | undefined, url: string, checks: readonly PullRequestCheck[], byName = false): PipelineFacts | undefined {
  const key = JSON.stringify([...new Map(checks.flatMap((check) => { const id = runIdOf(check.url); return id ? [[id, check.workflow ?? ""] as const] : []; }))].sort());
  const [facts, setFacts] = useState<PipelineFacts>();
  useEffect(() => {
    const runs = JSON.parse(key) as Array<[string, string]>;
    if (!runs.length || !client) return;
    let live = true;
    const ids = runs.map(([id]) => id);
    Promise.resolve().then(() => byName ? client.pipeline(url, ids, Object.fromEntries(runs)) : client.pipeline(url, ids))
      .then((found) => { if (live) setFacts(found ?? {}); }, () => undefined);
    return () => { live = false; };
  }, [client, url, key, byName]);
  return facts;
}

const ICONS: Partial<Record<JobState, typeof Check>> = { passed: Check, failed: X, cancelled: Ban, skipped: ChevronsRight, queued: Clock, waiting: Pause };

/** A job's circle: its state as an icon; while it runs, a wedge that fills with the time it usually takes, or a spinning arc without one. */
export function JobCircle({ job, now, size = 22, progress = jobProgress({ name: "", ...job }, now) }: { job: Pick<PipelineJob, "state" | "startedAt" | "expectedMs">; now: number; size?: number; progress?: number | undefined }) {
  const Icon = ICONS[job.state];
  const middle = size / 2;
  const ring = middle - 1;
  const wedge = (ring - 2) / 2;
  const turn = 2 * Math.PI * wedge;
  return (
    <span className={`pl-circle ${job.state}${progress === undefined ? " spin" : ""}`} style={{ width: size, height: size }}>
      <svg className="pl-svg" viewBox={`0 0 ${size} ${size}`} width={size} height={size} aria-hidden="true">
        <circle className="pl-ring" cx={middle} cy={middle} r={ring} />
        {job.state === "running" ? (
          progress === undefined
            ? <circle className="pl-arc" cx={middle} cy={middle} r={ring} strokeDasharray={`${ring * 1.6} ${ring * 10}`} />
            : <circle className="pl-wedge" cx={middle} cy={middle} r={wedge} strokeWidth={wedge * 2} strokeDasharray={`${turn * progress} ${turn}`} transform={`rotate(-90 ${middle} ${middle})`} />
        ) : null}
      </svg>
      {Icon ? <Icon size={Math.round(size * 0.55)} strokeWidth={2.5} aria-hidden="true" /> : null}
    </span>
  );
}

function headline(jobs: readonly PipelineJob[]): string {
  const failed = jobs.filter((job) => job.state === "failed").length;
  const running = jobs.filter(isActive).length;
  const done = jobs.length - running;
  if (running) return `${done} of ${jobs.length} done`;
  if (failed) return `${failed} of ${jobs.length} failed`;
  return jobs.every((job) => job.state === "passed" || job.state === "skipped") ? "All passed" : `${jobs.length} finished`;
}

/**
 * Checks as pipelines, the way GitLab draws them: stages left to right,
 * joined by lines, each job a circle. Hovering a job tells its state and
 * time; a click picks it, with its log one more click away. A phone draws
 * the circles alone, each a 44 px target.
 */
export function PipelineGraph({ pipelines, actions, empty = "No checks reported." }: { pipelines: readonly Pipeline[]; actions: WorkbenchActions; empty?: string }) {
  const phone = useCompactProfile();
  const now = useNow(pipelines.some((pipeline) => pipeline.stages.some((stage) => stage.some(isActive))));
  const [picked, setPicked] = useState<string>();
  if (pipelines.length === 0) return <p className="pr-empty">{empty}</p>;
  return (
    <div className={`pl${phone ? " phone" : ""}`}>
      {pipelines.map((pipeline) => {
        const jobs = pipeline.stages.flat();
        const chosen = jobs.find((job) => `${pipeline.name}\0${job.name}` === picked);
        return (
          <section key={pipeline.name} className="pl-pipeline" aria-label={pipeline.name}>
            <header className="pl-head"><strong>{pipeline.name}</strong><span>{headline(jobs)}</span></header>
            <div className="pl-graph">
              {pipeline.stages.map((stage, index) => (
                <Fragment key={index}>
                  {index > 0 ? <span className="pl-link" aria-hidden="true" /> : null}
                  <div className="pl-stage" role="group" aria-label={`Stage ${index + 1}`}>
                    {stage.map((job) => {
                      const id = `${pipeline.name}\0${job.name}`;
                      const timing = jobTiming(job, now);
                      return (
                        <button key={job.name} type="button" className="pl-job" aria-pressed={picked === id} aria-label={`${job.name}: ${timing}`}
                          {...(phone ? {} : tooltipProps(`${job.name}\n${timing}`, { variant: "lines" }))} onClick={() => setPicked(picked === id ? undefined : id)}>
                          <JobCircle job={job} now={now} size={phone ? 28 : 22} />
                          {phone ? null : <span className="pl-name">{job.name}</span>}
                        </button>
                      );
                    })}
                  </div>
                </Fragment>
              ))}
            </div>
            {chosen ? (
              <p className="pl-detail" role="status">
                <strong>{chosen.name}</strong>
                <span>{jobTiming(chosen, now)}</span>
                {chosen.url ? <button type="button" className="pl-log" onClick={() => actions.openExternal(chosen.url!)}>Open log <ExternalLink size={11} aria-hidden="true" /></button> : null}
              </p>
            ) : null}
          </section>
        );
      })}
    </div>
  );
}

/** Circles a mini pipeline draws at most; later workflows fold into "+N". */
const MINI_MAX = 7;

function StageJobs({ jobs, now }: { jobs: readonly PipelineJob[]; now: number }) {
  return (
    <ul className="plm-jobs">
      {/* The circle says the state; the line only the time. */}
      {jobs.map((job) => <li key={job.name}><JobCircle job={job} now={now} size={16} /><span className="pl-name">{job.name}</span><span>{jobTiming(job, now).replace(/^[^·]*· /u, "")}</span></li>)}
    </ul>
  );
}

interface Hovered { pipeline: Pipeline; stage: number; at: DOMRect }

/** A stage's jobs beside its circle, kept inside the window; it never takes the focus. */
function StageCard({ shown: { pipeline, stage, at }, now }: { shown: Hovered; now: number }) {
  const below = at.bottom + 260 < window.innerHeight;
  const style = { left: Math.max(8, Math.min(at.left - 12, window.innerWidth - 388)), ...(below ? { top: at.bottom + 6 } : { top: "auto", bottom: window.innerHeight - at.top + 6 }) };
  return createPortal(
    <div className="popover plm-card" role="tooltip" style={style}>
      <header><strong>{pipeline.name}</strong>{pipeline.stages.length > 1 ? <span>Stage {stage + 1} of {pipeline.stages.length}</span> : null}</header>
      <StageJobs jobs={pipeline.stages[stage]!} now={now} />
    </div>,
    document.body,
  );
}

/** Checks in one row as GitLab draws them on a merge request: a circle per stage, its jobs on hover, the pipeline on a click.
 * On a phone the row is one 44 px target with a sheet; `nested` (inside a row's button) draws no button of its own. */
export function PipelineMini({ pipelines, onOpen, nested = false, size = 18 }: { pipelines: readonly Pipeline[]; onOpen?: () => void; nested?: boolean; size?: number }) {
  const phone = useCompactProfile();
  const now = useNow(pipelines.some((pipeline) => pipeline.stages.some((stage) => stage.some(isActive))));
  const [shown, setShown] = useState<Hovered>();
  const [sheet, setSheet] = useState(false);
  let room = MINI_MAX;
  const kept = pipelines.filter((pipeline, index) => (room -= pipeline.stages.length) >= 0 || index === 0);
  const rest = pipelines.slice(kept.length);
  if (!pipelines.length) return null;
  const label = `Checks: ${pipelines.map((pipeline) => `${pipeline.name} ${pipeline.stages.map((stage) => STATE_WORDS[stageState(stage)].toLowerCase()).join(", ")}`).join("; ")}`;
  const circles = (
    <>
      {kept.map((pipeline) => (
        <span key={pipeline.name} className="plm-run">
          {pipeline.stages.map((stage, index) => (
            <span key={index} className="plm-stage" data-state={stageState(stage)}
              onPointerEnter={phone ? undefined : (event) => setShown({ pipeline, stage: index, at: event.currentTarget.getBoundingClientRect() })}>
              <JobCircle job={{ state: stageState(stage) }} progress={stageProgress(stage, now)} now={now} size={size} />
            </span>
          ))}
        </span>
      ))}
      {rest.length ? <span className="plm-more" {...tooltipProps(rest.map((pipeline) => pipeline.name).join("\n"), { variant: "lines" })}>+{rest.length}</span> : null}
      {shown && !phone ? <StageCard shown={shown} now={now} /> : null}
    </>
  );
  const leave = () => setShown(undefined);
  const open = (event: MouseEvent) => { event.stopPropagation(); event.preventDefault(); leave(); onOpen?.(); };
  return (
    <>
      {nested
        ? <span className="plm" role="img" aria-label={label} onPointerLeave={leave} onClick={onOpen && !phone ? open : undefined}>{circles}</span>
        : <button type="button" className={`plm${phone ? " phone" : ""}`} aria-label={label} onPointerLeave={leave} onClick={phone ? () => setSheet(true) : open}>{circles}</button>}
      {sheet ? (
        <Sheet title="Checks" className="plm-sheet" onClose={() => setSheet(false)}>
          {pipelines.map((pipeline) => <section key={pipeline.name}><h3>{pipeline.name}</h3>{pipeline.stages.map((stage, index) => <StageJobs key={index} jobs={stage} now={now} />)}</section>)}
          {onOpen ? <button type="button" className="plm-all" onClick={() => { setSheet(false); onOpen(); }}>Show the pipeline</button> : null}
        </Sheet>
      ) : null}
    </>
  );
}

/** A request's checks as pipelines, with what the host knows of their workflows. */
export function ChecksPipeline({ client, url, checks, actions }: { client: PullRequestClient | undefined; url: string; checks: readonly PullRequestCheck[]; actions: WorkbenchActions }) {
  const facts = usePipelineFacts(client, url, checks);
  return <PipelineGraph pipelines={checksPipelines(checks, facts)} actions={actions} />;
}

/** A request's checks in one row; `byName` for a list's rows (see `usePipelineFacts`). */
export function ChecksMini({ client, url, checks, byName = false, ...rest }: { client: PullRequestClient | undefined; url: string; checks: readonly PullRequestCheck[]; byName?: boolean; onOpen?: () => void; nested?: boolean; size?: number }) {
  const facts = usePipelineFacts(client, url, checks, byName);
  return <PipelineMini pipelines={checksPipelines(checks, facts)} {...rest} />;
}
