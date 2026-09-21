import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

describe("TurnsInFlight", () => {
  it("writes a marker and reads it back in the next run", async () => {
    const { filePath, turns } = await store();
    turns.record(marker({ prompt: { text: "do the thing", images: 2 } }));
    await turns.flush();

    const next = new TurnsInFlight({ filePath });
    expect(await next.load()).toEqual([marker({ prompt: { text: "do the thing", images: 2 } })]);
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
    expect(await new TurnsInFlight({ filePath: join(filePath, "missing.json") }).load()).toEqual([]);
  });
});
