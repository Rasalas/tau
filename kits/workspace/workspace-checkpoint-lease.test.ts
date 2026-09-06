import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WorkspaceCheckpointLeaseManager } from "./workspace-checkpoint-lease.js";
import { createWorkspaceKitCheckpointMaintenance } from "./workspace-kit-checkpoints.js";

async function repository(prefix: string): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), prefix));
  execFileSync("git", ["init", "-q"], { cwd });
  return cwd;
}

// Every case runs real git in temp repositories; the whole suite pushes single cases past 5 s.
describe("workspace checkpoint leases", { timeout: 60_000 }, () => {
  it("serializes turns sharing a checkout and hands ownership over in FIFO order", async () => {
    const cwd = await repository("tau-lease-shared-");
    try {
      const manager = new WorkspaceCheckpointLeaseManager({ pollMs: 5, staleAfterMs: 500 });
      const states: string[] = [];
      const first = await manager.acquire(cwd, {
        sessionId: "session-a",
        turnId: "turn-a",
        onState: (state) => states.push(`a:${state}`),
      });
      let secondReady = false;
      const secondPromise = manager.acquire(cwd, {
        sessionId: "session-b",
        turnId: "turn-b",
        onState: (state) => states.push(`b:${state}`),
      }).then((lease) => { secondReady = true; return lease; });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(secondReady).toBe(false);
      await first.release();
      const second = await secondPromise;
      expect(secondReady).toBe(true);
      expect(states.indexOf("a:acquired")).toBeLessThan(states.indexOf("b:acquired"));
      await second.release();
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("keeps FIFO admission across independent manager instances", async () => {
    const cwd = await repository("tau-lease-cross-process-fifo-");
    try {
      const firstManager = new WorkspaceCheckpointLeaseManager({ pollMs: 5, staleAfterMs: 500 });
      const secondManager = new WorkspaceCheckpointLeaseManager({ pollMs: 5, staleAfterMs: 500 });
      const thirdManager = new WorkspaceCheckpointLeaseManager({ pollMs: 5, staleAfterMs: 500 });
      await Promise.all([
        firstManager.canonicalKey(cwd),
        secondManager.canonicalKey(cwd),
        thirdManager.canonicalKey(cwd),
      ]);
      for (let round = 0; round < 3; round += 1) {
        const order: string[] = [];
        const first = await firstManager.acquire(cwd, { sessionId: `first-${round}`, turnId: "turn" });
        let secondWaiting = false;
        const secondPromise = secondManager.acquire(cwd, {
          sessionId: `second-${round}`,
          turnId: "turn",
          onState: (state) => { if (state === "waiting") secondWaiting = true; },
        }).then((lease) => { order.push("second"); return lease; });
        // oxlint-disable-next-line eslint/no-unmodified-loop-condition -- secondWaiting flips inside the onState callback above.
        for (let attempt = 0; attempt < 100 && !secondWaiting; attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 2));
        }
        expect(secondWaiting).toBe(true);
        let thirdWaiting = false;
        const thirdPromise = thirdManager.acquire(cwd, {
          sessionId: `third-${round}`,
          turnId: "turn",
          onState: (state) => { if (state === "waiting") thirdWaiting = true; },
        }).then((lease) => { order.push("third"); return lease; });
        // oxlint-disable-next-line eslint/no-unmodified-loop-condition -- thirdWaiting flips inside the onState callback above.
        for (let attempt = 0; attempt < 100 && !thirdWaiting; attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 2));
        }
        expect(thirdWaiting).toBe(true);

        await first.release();
        const second = await secondPromise;
        await second.release();
        const third = await thirdPromise;
        await third.release();
        expect(order).toEqual(["second", "third"]);
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }, 30_000);

  it("allows independent workspaces to hold leases concurrently", async () => {
    const firstCwd = await repository("tau-lease-one-");
    const secondCwd = await repository("tau-lease-two-");
    try {
      const manager = new WorkspaceCheckpointLeaseManager({ pollMs: 5, staleAfterMs: 500 });
      const [first, second] = await Promise.all([
        manager.acquire(firstCwd, { sessionId: "one", turnId: "turn" }),
        manager.acquire(secondCwd, { sessionId: "two", turnId: "turn" }),
      ]);
      expect(first.key).not.toBe(second.key);
      expect(first.lockPath).not.toBe(second.lockPath);
      await Promise.all([first.release(), second.release()]);
    } finally {
      await Promise.all([
        rm(firstCwd, { recursive: true, force: true }),
        rm(secondCwd, { recursive: true, force: true }),
      ]);
    }
  });

  it("does not serialize linked worktrees that share a Git common directory", async () => {
    const cwd = await repository("tau-lease-linked-root-");
    const linked = await mkdtemp(join(tmpdir(), "tau-lease-linked-child-"));
    try {
      execFileSync("git", ["config", "user.email", "tau-tests@example.invalid"], { cwd });
      execFileSync("git", ["config", "user.name", "Tau tests"], { cwd });
      await writeFile(join(cwd, "README.md"), "base\n");
      execFileSync("git", ["add", "README.md"], { cwd });
      execFileSync("git", ["commit", "-qm", "base"], { cwd });
      execFileSync("git", ["worktree", "add", "-q", "-b", "linked", linked, "HEAD"], { cwd });

      const manager = new WorkspaceCheckpointLeaseManager({ pollMs: 5, staleAfterMs: 500 });
      const [rootKey, linkedKey] = await Promise.all([
        manager.canonicalKey(cwd),
        manager.canonicalKey(linked),
      ]);
      expect(rootKey).not.toBe(linkedKey);
      const [rootLease, linkedLease] = await Promise.all([
        manager.acquire(cwd, { sessionId: "root", turnId: "turn" }),
        manager.acquire(linked, { sessionId: "linked", turnId: "turn" }),
      ]);
      await Promise.all([rootLease.release(), linkedLease.release()]);
    } finally {
      execFileSync("git", ["worktree", "remove", "--force", linked], { cwd, stdio: "ignore" });
      await Promise.all([
        rm(linked, { recursive: true, force: true }),
        rm(cwd, { recursive: true, force: true }),
      ]);
    }
  });

  it("keeps plain workspaces out of their user data", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tau-lease-folder-"));
    try {
      const manager = new WorkspaceCheckpointLeaseManager({ pollMs: 5, staleAfterMs: 500 });
      const lease = await manager.acquire(cwd, { sessionId: "folder", turnId: "turn" });
      expect(lease.lockPath.startsWith(join(cwd, "tau-turn-checkpoint.lock"))).toBe(false);
      await lease.release();
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("recovers a stale marker left by a crashed owner", async () => {
    const cwd = await repository("tau-lease-stale-");
    try {
      const manager = new WorkspaceCheckpointLeaseManager({ pollMs: 5, staleAfterMs: 100 });
      const key = await manager.canonicalKey(cwd);
      const lockPath = join(key, "tau-turn-checkpoint.lock");
      await mkdir(key, { recursive: true });
      await writeFile(lockPath, `${JSON.stringify({
        ownerId: "crashed-owner",
        pid: 999_999,
        host: "crashed-host",
        cwd,
        sessionId: "old-session",
        turnId: "old-turn",
        acquiredAt: 1,
        heartbeatAt: 1,
      })}\n`);
      const lease = await manager.acquire(cwd, {
        sessionId: "new-session",
        turnId: "new-turn",
        now: () => 1_000,
        processAlive: () => false,
      });
      expect(JSON.parse(await readFile(lockPath, "utf8"))).toMatchObject({ ownerId: lease.ownerId });
      await lease.release();
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("reclaims a dead same-host owner without waiting out its heartbeat window", async () => {
    const cwd = await repository("tau-lease-dead-owner-");
    try {
      const staleAfterMs = 60_000;
      const manager = new WorkspaceCheckpointLeaseManager({ pollMs: 5, staleAfterMs });
      const key = await manager.canonicalKey(cwd);
      const lockPath = join(key, "tau-turn-checkpoint.lock");
      await mkdir(key, { recursive: true });
      // A host that was killed leaves a fresh heartbeat behind. Its PID is the
      // proof that nobody will ever release it.
      await writeFile(lockPath, `${JSON.stringify({
        ownerId: "killed-owner",
        pid: 999_999,
        host: hostname(),
        cwd,
        sessionId: "killed-session",
        turnId: "killed-turn",
        acquiredAt: Date.now(),
        heartbeatAt: Date.now(),
      })}\n`);

      const lease = await manager.acquire(cwd, {
        sessionId: "next-session",
        turnId: "next-turn",
        timeoutMs: 2_000,
        processAlive: (pid) => pid !== 999_999,
      });
      expect(JSON.parse(await readFile(lockPath, "utf8"))).toMatchObject({ ownerId: lease.ownerId });
      await lease.release();
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("never lets a stale owner's late release remove a recovered generation", async () => {
    const cwd = await repository("tau-lease-stale-generation-");
    try {
      const staleAfterMs = 100;
      const oldManager = new WorkspaceCheckpointLeaseManager({ pollMs: 5, staleAfterMs });
      const oldLease = await oldManager.acquire(cwd, { sessionId: "old", turnId: "turn" });
      const recoveryNow = Date.now() + staleAfterMs + 100;
      const newManager = new WorkspaceCheckpointLeaseManager({
        pollMs: 5,
        staleAfterMs,
        now: () => recoveryNow,
        processAlive: () => false,
      });
      const newLease = await newManager.acquire(cwd, { sessionId: "new", turnId: "turn" });
      await oldLease.release();
      expect(JSON.parse(await readFile(newLease.lockPath, "utf8"))).toMatchObject({ ownerId: newLease.ownerId });
      await newLease.release();
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }, 30_000);

  it("cancels an aborted waiter without letting later turns bypass the owner", async () => {
    const cwd = await repository("tau-lease-abort-");
    try {
      const manager = new WorkspaceCheckpointLeaseManager({ pollMs: 5, staleAfterMs: 500 });
      const first = await manager.acquire(cwd, { sessionId: "one", turnId: "first" });
      const controller = new AbortController();
      const second = manager.acquire(cwd, { sessionId: "two", turnId: "second", signal: controller.signal });
      const third = manager.acquire(cwd, { sessionId: "three", turnId: "third" });
      controller.abort();
      await expect(second).rejects.toThrow("aborted");
      let thirdReady = false;
      void third.then(() => { thirdReady = true; });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(thirdReady).toBe(false);
      await first.release();
      const thirdLease = await third;
      await thirdLease.release();
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

describe("checkpoint ref housekeeping", { timeout: 60_000 }, () => {
  it("skips a checkout a turn is holding instead of waiting for it", async () => {
    const cwd = await repository("tau-lease-maintenance-");
    try {
      const manager = new WorkspaceCheckpointLeaseManager({ pollMs: 5, staleAfterMs: 5_000 });
      const skipped: string[] = [];
      const maintenance = createWorkspaceKitCheckpointMaintenance(manager, {
        maintenanceLeaseTimeoutMs: 100,
        onSkipped: (path) => skipped.push(path),
      });
      // A turn owns the checkout, exactly as it does while its agent runs.
      const turn = await manager.acquire(cwd, { sessionId: "session-a", turnId: "turn-a" });
      await maintenance.cleanupOrphanRefs(cwd, "session-b", []);
      expect(skipped).toEqual([cwd]);
      await turn.release();
      // Once the turn lets go, the same call takes the lease and runs.
      await maintenance.cleanupOrphanRefs(cwd, "session-b", []);
      expect(skipped).toEqual([cwd]);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
