import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { TurnsInFlight, type InFlightTurn } from "./turns-in-flight.js";

async function store(): Promise<{ filePath: string; turns: TurnsInFlight }> {
  const filePath = join(await mkdtemp(join(tmpdir(), "tau-turns-")), "turns-in-flight.json");
  return { filePath, turns: new TurnsInFlight({ filePath }) };
}

const marker = (overrides: Partial<InFlightTurn> = {}): InFlightTurn => ({
  sessionId: "thread-1",
  cwd: "/repo",
  turnId: "turn-1",
  backend: "pi",
  startedAt: 1_700_000_000_000,
  prompt: { text: "do the thing" },
  ...overrides,
});

/** A marker as this process records it. */
const mine = (overrides: Partial<InFlightTurn> = {}): InFlightTurn => ({ ...marker(overrides), writer: { pid: process.pid } });

describe("TurnsInFlight", () => {
  it("persists an update's choice on unfinished work and new turns, then disarms after failure", async () => {
    const { filePath, turns } = await store();
    turns.record(marker());
    await turns.prepareUpdateRestart(false);
    expect((await new TurnsInFlight({ filePath }).load())[0]?.resumeAfterUpdate).toBe(false);
    turns.record(marker({ sessionId: "new-thread" }));
    await turns.flush();
    expect((await new TurnsInFlight({ filePath }).load()).every((entry) => entry.resumeAfterUpdate === false)).toBe(true);
    await turns.prepareUpdateRestart(undefined);
    expect((await new TurnsInFlight({ filePath }).load()).every((entry) => entry.resumeAfterUpdate === undefined)).toBe(true);
  });
  it("persists each continuation before delivery and transfers its count to the new marker", async () => {
    const { filePath, turns } = await store();
    await turns.continuing(marker({ continuationCount: 1 }), async () => {
      expect(await new TurnsInFlight({ filePath }).load()).toEqual([mine({ continuationCount: 2 })]);
      turns.record(marker({ turnId: "continued-turn" }));
      turns.resetContinuations("thread-1");
    });
    await turns.flush();
    expect(await new TurnsInFlight({ filePath }).load()).toEqual([mine({ turnId: "continued-turn", continuationCount: 2 })]);
    turns.resetContinuations("thread-1");
    await turns.flush();
    expect(await new TurnsInFlight({ filePath }).load()).toEqual([mine({ turnId: "continued-turn", continuationCount: 0 })]);
  });

  it("removes a continuation marker if delivery fails before a new turn starts", async () => {
    const { filePath, turns } = await store();
    await expect(turns.continuing(marker(), async () => { throw new Error("refused"); })).rejects.toThrow("refused");
    await turns.flush();
    expect(await new TurnsInFlight({ filePath }).load()).toEqual([]);
    turns.record(marker({ turnId: "user-turn" }));
    expect(turns.get("thread-1")?.continuationCount).toBeUndefined();
  });

  it("writes a marker and reads it back in the next run", async () => {
    const { filePath, turns } = await store();
    turns.record(marker({ prompt: { text: "do the thing", images: 2 } }));
    await turns.flush();

    const next = new TurnsInFlight({ filePath });
    expect(await next.load()).toEqual([mine({ prompt: { text: "do the thing", images: 2 } })]);
  });

  it("clears the marker when its own turn ends and keeps a newer one", async () => {
    const { filePath, turns } = await store();
    turns.record(marker());
    turns.clear("thread-1", "turn-0");
    expect(turns.get("thread-1")).toBeDefined();

    turns.record(marker({ turnId: "turn-2" }));
    turns.clear("thread-1", "turn-1");
    expect(turns.get("thread-1")?.turnId).toBe("turn-2");

    turns.clear("thread-1", "turn-2");
    await turns.flush();
    expect(await new TurnsInFlight({ filePath }).load()).toEqual([]);
  });

  it("keeps one marker per thread and writes the file atomically", async () => {
    const { filePath, turns } = await store();
    turns.record(marker());
    turns.record(marker({ turnId: "turn-2", prompt: { text: "second" } }));
    turns.record(marker({ sessionId: "thread-2", turnId: "turn-3", prompt: { text: "other" } }));
    await turns.flush();

    const written = JSON.parse(await readFile(filePath, "utf8")) as { version: number; turns: InFlightTurn[] };
    expect(written.version).toBe(1);
    expect(written.turns.map((turn) => turn.turnId)).toEqual(["turn-2", "turn-3"]);
  });

  it("keeps what it holds once frozen, so a shutdown's own aborts lose nothing", async () => {
    const { filePath, turns } = await store();
    turns.record(marker());
    await turns.flush();

    turns.freeze();
    turns.clear("thread-1", "turn-1");
    turns.record(marker({ sessionId: "thread-2" }));
    await turns.flush();

    expect(await new TurnsInFlight({ filePath }).load()).toEqual([mine()]);
  });

  it("clips a long prompt rather than copying the transcript", async () => {
    const { turns } = await store();
    turns.record(marker({ prompt: { text: "x".repeat(10_000) } }));
    expect(turns.get("thread-1")?.prompt.text).toHaveLength(4_000);
  });

  it("ignores entries it cannot read and starts empty without a file", async () => {
    const { filePath, turns } = await store();
    await turns.flush();
    await writeFile(filePath, JSON.stringify({ version: 1, turns: [{ sessionId: "broken" }, marker()] }), "utf8");
    expect(await new TurnsInFlight({ filePath }).load()).toEqual([marker()]);
    expect(await new TurnsInFlight({ filePath: join(dirname(filePath), "missing.json") }).load()).toEqual([]);
  });

  it("leaves a marker whose writer still runs alone, in the file and out of the answer", async () => {
    const { filePath, turns } = await store();
    await turns.flush();
    const live = marker({ sessionId: "live", writer: { pid: 4242 } });
    const dead = marker({ sessionId: "dead", writer: { pid: 4343 } });
    await writeFile(filePath, JSON.stringify({ version: 1, turns: [live, dead, marker({ sessionId: "old" })] }), "utf8");
    const warnings: string[] = [];
    const next = new TurnsInFlight({ filePath, alive: (pid) => pid === 4242, logger: { warn: (label) => warnings.push(label) } });

    expect((await next.load()).map((turn) => turn.sessionId)).toEqual(["dead", "old"]);
    expect(warnings).toEqual(["turns-in-flight.writer-alive"]);
    // Reconciling the others rewrites the file; the live writer's marker stays in it.
    next.clear("dead");
    next.clear("old");
    await next.flush();
    const written = JSON.parse(await readFile(filePath, "utf8")) as { turns: InFlightTurn[] };
    expect(written.turns).toEqual([live]);
  });
});
