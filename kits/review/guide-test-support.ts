import { vi, type Mock } from "vitest";
import type { GuideClient } from "./guide-client.js";
import type { GuideEvent, GuideResult, GuideWriteResult, PullRequestGuide } from "./guide-protocol.js";

/** The head of the request `gh-pr-view-discussed.json` describes. */
export const HEAD = "0123456789abcdef0123456789abcdef01234567";

/** A guide over the files of `gh-pr-diff.patch`: one stop with an excerpt and notes, one of files only, one on a single line. */
export function sampleGuide(change: Partial<PullRequestGuide> = {}): PullRequestGuide {
  return {
    headSha: HEAD,
    generatedAt: "2026-10-12T10:00:00.000Z",
    model: "opencode-go/deepseek-flash",
    stops: [
      {
        title: "The output helper",
        summary: "Output is numbered by **byte offset**, so a client that replayed skips the overlap.",
        attention: { kind: "tradeoff", note: "Offsets count characters, not bytes." },
        excerpts: [{ path: "kits/terminal/output.ts", side: "new", start: 10, end: 13, caption: "The overlap rule" }],
        files: [{ path: "kits/package.json", note: "Engine bump" }],
        notes: [
          { path: "kits/terminal/output.ts", line: 11, title: "Ignores seen chunks", body: "A chunk at or before `drawn` is dropped." },
          { path: "kits/terminal/output.ts", line: 12, title: "Slices the overlap", body: "" },
        ],
        questions: ["Why not number by sequence?"],
      },
      {
        title: "The docs",
        summary: "Two documents describe it.",
        attention: null,
        excerpts: [],
        files: [{ path: "docs/CORE.md", note: "A table row" }, { path: "README.md" }],
        notes: [],
        questions: [],
      },
      {
        title: "The engine",
        summary: "Kits need the newer API.",
        attention: null,
        excerpts: [{ path: "kits/package.json", side: "new", start: 9, end: 9, caption: "" }],
        files: [],
        notes: [],
        questions: [],
      },
    ],
    ...change,
  };
}

export interface FakeGuideClient extends GuideClient {
  get: Mock<GuideClient["get"]>;
  write: Mock<GuideClient["write"]>;
  /** Changes what `get` answers and tells the listeners, as the host does when a run starts or ends. */
  publish(next: Partial<GuideResult>, kind?: GuideEvent["kind"]): void;
  listeners: Set<(event: GuideEvent) => void>;
}

export function fakeGuideClient(initial: Partial<GuideResult> = {}, url = "https://github.com/acme/tau/pull/7"): FakeGuideClient {
  let result: GuideResult = { guide: null, run: null, currentHeadSha: HEAD, enabled: true, ...initial };
  const listeners = new Set<(event: GuideEvent) => void>();
  const get = vi.fn<GuideClient["get"]>(async () => result);
  const write = vi.fn<GuideClient["write"]>(async (): Promise<GuideWriteResult> => {
    result = { ...result, run: { state: "running", headSha: HEAD, startedAt: "2026-10-12T10:00:00.000Z" } };
    return { ...result, outcome: "started", threadId: "guide-thread" };
  });
  return {
    get,
    write,
    listeners,
    onChanged: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    publish: (next, kind = "ready") => {
      result = { ...result, ...next };
      for (const listener of [...listeners]) listener({ url, number: 7, kind });
    },
  };
}
