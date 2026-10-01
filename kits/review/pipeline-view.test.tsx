// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkbenchActions } from "tau";
import { ChecksPipeline, PipelineGraph } from "./pipeline-view.js";
import { workflowJobs } from "./pipeline.js";
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
