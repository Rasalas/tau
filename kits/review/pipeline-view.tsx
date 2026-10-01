import { Fragment, useEffect, useState } from "react";
import { Ban, Check, ChevronsRight, Clock, ExternalLink, Pause, X } from "lucide-react";
import { tooltipProps, type WorkbenchActions } from "tau";
import { useCompactProfile } from "./compact-profile.js";
import type { PullRequestCheck } from "./protocol.js";
import type { PullRequestClient } from "./pull-request-client.js";
import { checksPipelines, isActive, jobProgress, jobTiming, pipelinesProgress, runIdOf, type JobState, type Pipeline, type PipelineFacts, type PipelineJob } from "./pipeline.js";

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

/** The facts of the checks' workflow runs, asked again only when the set of runs changes; the host caches them. */
export function usePipelineFacts(client: PullRequestClient | undefined, url: string, checks: readonly PullRequestCheck[]): PipelineFacts | undefined {
  const key = [...new Set(checks.map((check) => runIdOf(check.url)).filter(Boolean))].sort().join(",");
  const [facts, setFacts] = useState<PipelineFacts>();
  useEffect(() => {
    if (!key || !client) return;
    let live = true;
    Promise.resolve().then(() => client.pipeline(url, key.split(","))).then((found) => { if (live) setFacts(found ?? {}); }, () => undefined);
    return () => { live = false; };
  }, [client, url, key]);
  return facts;
}

const ICONS: Partial<Record<JobState, typeof Check>> = { passed: Check, failed: X, cancelled: Ban, skipped: ChevronsRight, queued: Clock, waiting: Pause };

/** A job's circle: its state as an icon; while it runs, a wedge that fills with the time it usually takes, or a spinning arc without one. */
export function JobCircle({ job, now, size = 22 }: { job: Pick<PipelineJob, "state" | "startedAt" | "expectedMs">; now: number; size?: number }) {
  const progress = jobProgress({ name: "", ...job }, now);
  const Icon = ICONS[job.state];
  const middle = size / 2;
  const ring = middle - 1;
  const wedge = (ring - 2) / 2;
  const turn = 2 * Math.PI * wedge;
  return (
    <span className={`pl-circle ${job.state}${progress === undefined ? " spin" : ""}`} style={{ width: size, height: size }}>
      <svg viewBox={`0 0 ${size} ${size}`} width={size} height={size} aria-hidden="true">
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

/** The thread's PR chip: one ring that fills with every job's progress, and how many are done. */
export function PipelineRing({ pipelines, size = 14 }: { pipelines: readonly Pipeline[]; size?: number }) {
  const now = useNow(true);
  const { fraction, done, total } = pipelinesProgress(pipelines, now);
  const middle = size / 2;
  const ring = middle - 1.25;
  const turn = 2 * Math.PI * ring;
  return (
    <span className="pl-chip" {...tooltipProps(`Checks: ${done} of ${total} done`)}>
      <svg viewBox={`0 0 ${size} ${size}`} width={size} height={size} aria-hidden="true">
        <circle className="pl-ring" cx={middle} cy={middle} r={ring} />
        <circle className="pl-fill" cx={middle} cy={middle} r={ring} strokeDasharray={`${turn * fraction} ${turn}`} transform={`rotate(-90 ${middle} ${middle})`} />
      </svg>
      <span>{done}/{total}</span>
    </span>
  );
}

/** A request's checks as pipelines, with what the host knows of their workflows. */
export function ChecksPipeline({ client, url, checks, actions }: { client: PullRequestClient | undefined; url: string; checks: readonly PullRequestCheck[]; actions: WorkbenchActions }) {
  const facts = usePipelineFacts(client, url, checks);
  return <PipelineGraph pipelines={checksPipelines(checks, facts)} actions={actions} />;
}
