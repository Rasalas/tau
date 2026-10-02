// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkbenchActions } from "tau";
import { ChecksMini, ChecksPipeline, PipelineGraph, PipelineMini } from "./pipeline-view.js";
import { workflowJobs, type Pipeline } from "./pipeline.js";
import type { PullRequestCheck } from "./protocol.js";
import type { PullRequestClient } from "./pull-request-client.js";

afterEach(() => { cleanup(); delete document.body.dataset.profile; });

const REQUEST = "https://github.com/acme/demo/pull/7";
const RUN = "https://github.com/acme/demo/actions/runs/42/job/";
const CHECKS: PullRequestCheck[] = [
  { name: "lint", status: "passed", workflow: "CI", url: `${RUN}1`, startedAt: "2026-10-01T10:00:00Z", completedAt: "2026-10-01T10:01:05Z" },
  { name: "test", status: "pending", workflow: "CI", url: `${RUN}2`, startedAt: new Date(Date.now() - 30_000).toISOString() },
  { name: "deploy", status: "pending", workflow: "CI", url: `${RUN}3`, queued: true },
];
const FILE = "jobs:\n  lint:\n    x: 1\n  test:\n    needs: lint\n  deploy:\n    needs: [test]\n";

const actions = () => ({ openExternal: vi.fn() }) as unknown as WorkbenchActions & { openExternal: ReturnType<typeof vi.fn> };
const stages = () => screen.getAllByRole("group", { name: /^Stage / }).map((group) => within(group).getAllByRole("button").map((button) => button.getAttribute("aria-label")!.split(":")[0]));

describe("the pipeline", () => {
  it("draws one stage until the workflow file arrives, then a stage per need", async () => {
    let answer!: (facts: unknown) => void;
    const pipeline = vi.fn(() => new Promise((resolve) => { answer = resolve; }));
    render(<ChecksPipeline client={{ pipeline } as unknown as PullRequestClient} url={REQUEST} checks={CHECKS} actions={actions()} />);
    expect(screen.getByRole("region", { name: "CI" })).toBeTruthy();
    expect(stages()).toEqual([["lint", "test", "deploy"]]);
    await waitFor(() => expect(pipeline).toHaveBeenCalledWith(REQUEST, ["42"]));
    answer({ 42: { jobs: workflowJobs(FILE), expected: { test: 120_000 } } });
    await waitFor(() => expect(stages()).toEqual([["lint"], ["test"], ["deploy"]]));
    expect(screen.getByText("1 of 3 done")).toBeTruthy();
  });

  it("says each job's state and time, fills a running one by its usual time, spins one without", async () => {
    render(<PipelineGraph actions={actions()} pipelines={[{ name: "CI", stages: [[
      { name: "lint", state: "passed", startedAt: 1_000, endedAt: 66_000 },
      { name: "test", state: "running", startedAt: Date.now() - 30_000, expectedMs: 120_000 },
      { name: "e2e", state: "running", startedAt: Date.now() - 30_000 },
      { name: "deploy", state: "queued", expectedMs: 60_000 },
    ]] }]} />);
    const lint = screen.getByRole("button", { name: "lint: Passed · 1m 5s" });
    expect(lint.getAttribute("data-tooltip")).toBe("lint\nPassed · 1m 5s");
    const test = screen.getByRole("button", { name: /^test: Running · 3\ds of about 2m 0s$/u });
    const wedge = test.querySelector(".pl-wedge")!;
    const [filled, turn] = wedge.getAttribute("stroke-dasharray")!.split(" ").map(Number);
    expect(filled! / turn!).toBeCloseTo(0.25, 1);
    const e2e = screen.getByRole("button", { name: /^e2e: Running · 3\ds, no usual time yet$/u });
    expect(e2e.querySelector(".pl-circle.spin .pl-arc")).not.toBeNull();
    expect(screen.getByRole("button", { name: "deploy: Queued · usually 1m 0s" })).toBeTruthy();
  });

  it("picks a job on click, with its log a click away", () => {
    const spy = actions();
    render(<PipelineGraph actions={spy} pipelines={[{ name: "CI", stages: [[{ name: "lint", state: "failed", url: `${RUN}1` }]] }]} />);
    const lint = screen.getByRole("button", { name: "lint: Failed" });
    fireEvent.click(lint);
    expect(lint.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(within(screen.getByRole("status")).getByRole("button", { name: "Open log" }));
    expect(spy.openExternal).toHaveBeenCalledWith(`${RUN}1`);
    fireEvent.click(lint);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("draws circles alone on a phone, without tooltips", () => {
    document.body.dataset.profile = "compact";
    render(<PipelineGraph actions={actions()} pipelines={[{ name: "Project scripts", stages: [[{ name: "test", state: "passed" }]] }]} />);
    const button = screen.getByRole("button", { name: "test: Passed" });
    expect(button.textContent).toBe("");
    expect(button.hasAttribute("data-tooltip")).toBe(false);
    expect(document.querySelector(".pl.phone")).not.toBeNull();
  });

  it("says when there is nothing", () => {
    render(<PipelineGraph actions={actions()} pipelines={[]} empty="No checks ran." />);
    expect(screen.getByText("No checks ran.")).toBeTruthy();
  });
});

describe("the mini pipeline", () => {
  const job = (name: string, state: Pipeline["stages"][number][number]["state"]) => ({ name, state });
  const CI: Pipeline = { name: "CI", stages: [[job("lint", "passed"), job("types", "passed")], [job("test", "failed"), job("build", "running")], [job("deploy", "skipped")]] };

  it("draws a circle per stage with the stage's worst state, workflows side by side, the rest as +N", () => {
    const one = (name: string, state: Pipeline["stages"][number][number]["state"]): Pipeline => ({ name, stages: [[job(name, state)]] });
    render(<PipelineMini pipelines={[CI, one("CodeQL", "queued"), { name: "Big", stages: [[job("a", "passed")], [job("b", "passed")], [job("c", "passed")], [job("d", "passed")]] }, one("Other checks", "passed")]} onOpen={vi.fn()} />);
    const mini = screen.getByRole("button", { name: "Checks: CI passed, failed, skipped; CodeQL queued; Big passed, passed, passed, passed; Other checks passed" });
    const runs = [...mini.querySelectorAll(".plm-run")].map((run) => [...run.querySelectorAll(".plm-stage")].map((stage) => stage.getAttribute("data-state")));
    expect(runs).toEqual([["passed", "failed", "skipped"], ["queued"]]);
    const more = mini.querySelector(".plm-more")!;
    expect(more.textContent).toBe("+2");
    expect(more.getAttribute("data-tooltip")).toBe("Big\nOther checks");
  });

  it("opens the full pipeline on a click, and inside a row's button draws none of its own", () => {
    const open = vi.fn();
    const row = vi.fn();
    render(<button type="button" onClick={row}><PipelineMini pipelines={[CI]} nested onOpen={open} /></button>);
    const mini = screen.getByRole("img", { name: /^Checks: CI/u });
    expect(mini.querySelector("button")).toBeNull();
    fireEvent.click(mini.querySelector(".plm-stage")!);
    expect(open).toHaveBeenCalledTimes(1);
    expect(row).not.toHaveBeenCalled();
  });

  it("on a phone is one 44 px target that lists the jobs in a sheet, with the way to the full pipeline", async () => {
    document.body.dataset.profile = "compact";
    const open = vi.fn();
    render(<PipelineMini pipelines={[CI]} onOpen={open} />);
    const mini = screen.getByRole("button", { name: /^Checks: CI/u });
    expect(mini.classList.contains("phone")).toBe(true);
    fireEvent.pointerEnter(mini.querySelector(".plm-stage")!);
    expect(screen.queryByRole("tooltip")).toBeNull();
    fireEvent.click(mini);
    const sheet = await screen.findByRole("dialog", { name: "Checks" });
    expect([...sheet.querySelectorAll(".plm-jobs li .pl-name")].map((name) => name.textContent)).toEqual(["lint", "types", "test", "build", "deploy"]);
    fireEvent.click(within(sheet).getByRole("button", { name: "Show the pipeline" }));
    expect(open).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("asks a list row's stages by workflow name", async () => {
    const pipeline = vi.fn(async () => ({ 42: { jobs: workflowJobs(FILE), expected: {} } }));
    render(<ChecksMini client={{ pipeline } as unknown as PullRequestClient} url={REQUEST} checks={CHECKS} byName nested />);
    await waitFor(() => expect(pipeline).toHaveBeenCalledWith(REQUEST, ["42"], { 42: "CI" }));
    expect(await screen.findByRole("img", { name: "Checks: CI passed, running, queued" })).toBeTruthy();
  });

  it("draws nothing without checks", () => {
    const { container } = render(<PipelineMini pipelines={[]} />);
    expect(container.innerHTML).toBe("");
  });
});
