import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenCodeApi, OpenCodeSignal } from "./api.js";
import { rulesForLevelV2, type PermissionRequest } from "./approvals.js";
import { OpenCodeClient, OpenCodeHttpError, type OpenCodeEvent } from "./client.js";
import { OpenCode2Api, parseEvent2Block } from "./client-v2.js";
import { connectOpenCodeApi } from "./connect.js";
import { startFakeOpenCode2, type FakeOpenCode2, type FakeOpenCode2Options, type FakeRequest2, type FakeTurn2 } from "./fixtures/fake-server-v2.js";

type Json = Record<string, unknown>;

const PASSWORD = "secret";
const DIR = "/repo";
const LOC = "location[directory]";
const ZERO = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } };

const fakes: FakeOpenCode2[] = [];
afterEach(async () => {
  await Promise.all(fakes.splice(0).map((fake) => fake.close()));
});

interface Setup { fake: FakeOpenCode2; api: OpenCode2Api; sleeps: number[]; connect(): Promise<OpenCode2Api> }

/** A fake server and an OpenCode 2 api on it; every pause is recorded and skipped. */
async function setup(options: FakeOpenCode2Options = {}, hooks: { fetch?: typeof globalThis.fetch; onSleep?(count: number): void } = {}): Promise<Setup> {
  const fake = await startFakeOpenCode2({ password: PASSWORD, script: () => undefined, ...options });
  fakes.push(fake);
  const sleeps: number[] = [];
  const connect = async () => {
    const api = await connectOpenCodeApi({
      url: fake.url,
      password: PASSWORD,
      ...(hooks.fetch ? { fetch: hooks.fetch } : {}),
      api2: { sleep: async (ms) => { sleeps.push(ms); hooks.onSleep?.(sleeps.length); } },
    });
    if (!(api instanceof OpenCode2Api)) throw new Error("not an OpenCode 2 api");
    return api;
  };
  return { fake, api: await connect(), sleeps, connect };
}

const route = (request: FakeRequest2) => `${request.method} ${request.path}`;
const since = (fake: FakeOpenCode2, mark: number) => fake.requests.slice(mark);
const routes = (fake: FakeOpenCode2, mark: number) => since(fake, mark).map(route);
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

/** Signals of the server's stream, taken in arrival order by kind. */
async function watch(api: OpenCodeApi, directory = DIR) {
  const seen: OpenCodeSignal[] = [];
  const wake: Array<() => void> = [];
  const subscription = await api.subscribe(directory, (event) => {
    const signal = api.signal(event);
    if (!signal) return;
    seen.push(signal);
    for (const resume of wake.splice(0)) resume();
  }, () => undefined);
  async function next<K extends OpenCodeSignal["kind"]>(kind: K): Promise<Extract<OpenCodeSignal, { kind: K }>> {
    for (;;) {
      const index = seen.findIndex((signal) => signal.kind === kind);
      if (index >= 0) return seen.splice(index, 1)[0] as Extract<OpenCodeSignal, { kind: K }>;
      await new Promise<void>((resolve) => wake.push(resolve));
    }
  }
  return { next, close: () => subscription.close() };
}

/** A script that asks each item in turn and keeps the client's replies. */
function asking(items: Array<{ kind: "permission" | "form"; payload: Json }>) {
  const replies: unknown[] = [];
  const script = async (turn: FakeTurn2) => {
    for (const item of items) replies.push(await turn.ask(item.kind, item.payload));
  };
  return { replies, script };
}

const POLICY = { level: "ask" as const };

describe("health, providers and config", () => {
  it("names itself generation 2 and says the version the server reports", async () => {
    const { fake, api } = await setup({ version: "2.0.99" });
    expect(api.generation).toBe(2);
    const mark = fake.requests.length;
    await expect(api.health()).resolves.toEqual({ healthy: true, version: "2.0.99" });
    expect(routes(fake, mark)).toEqual(["GET /api/info"]);
  });

  it("falls back to the version it connected with when the server does not say", async () => {
    const api = new OpenCode2Api(new OpenCodeClient({ url: "http://127.0.0.1:9", fetch: async () => json({}) }), "2.0.7");
    await expect(api.health()).resolves.toEqual({ healthy: true, version: "2.0.7" });
  });

  it("rejects a wrong password with the server's 401", async () => {
    const fake = await startFakeOpenCode2({ password: PASSWORD });
    fakes.push(fake);
    await expect(connectOpenCodeApi({ url: fake.url, password: "wrong" })).rejects.toMatchObject({ name: "OpenCodeHttpError", status: 401 });
  });

  it("lists providers and models in OpenCode 1's shape", async () => {
    const model = (providerID: string, id: string, name: string, extra: Json = {}): Json => ({
      id, modelID: id, providerID, name, capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
      variants: [], cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }], status: "active", enabled: true, limit: { context: 262144, output: 32768 }, ...extra,
    });
    const efforts = ["low", "medium", "high"].map((id) => ({ id }));
    const { fake, api } = await setup({
      providers: [{ id: "alpha", name: "Alpha Zen" }, { id: "beta", name: "Beta Hub" }],
      models: [
        model("alpha", "m-one", "Model One", { variants: efforts }),
        model("alpha", "m-two", "Model Two", { variants: [efforts[2]], limit: { context: 1048576, output: 131072 } }),
        model("alpha", "m-old", "Model Old", { status: "deprecated", limit: { context: 1000, output: 100 } }),
        model("beta", "m-three", "Model Three", { variants: [efforts[2]], cost: [{ input: 1.25, output: 10, cache: { read: 0.125, write: 0 } }], limit: { context: 400000, output: 128000 } }),
      ],
    });
    const mark = fake.requests.length;
    const list = await api.providers(DIR);
    expect(since(fake, mark).map((request) => [route(request), request.query])).toEqual(expect.arrayContaining([
      ["GET /api/provider", { [LOC]: DIR }],
      ["GET /api/model", { [LOC]: DIR }],
      ["GET /api/model/default", { [LOC]: DIR }],
    ]));
    expect(list.connected).toEqual(["alpha", "beta"]);
    expect(list.default).toEqual({ alpha: "m-one" });
    const base = { providerID: "alpha", capabilities: { reasoning: true, input: { image: true } }, cost: { input: 0, output: 0, cache: { read: 0, write: 0 } }, status: "active" };
    expect(list.all).toEqual([
      {
        id: "alpha",
        name: "Alpha Zen",
        models: {
          "m-one": { ...base, id: "m-one", name: "Model One", limit: { context: 262144, output: 32768 }, variants: { low: {}, medium: {}, high: {} } },
          "m-two": { ...base, id: "m-two", name: "Model Two", limit: { context: 1048576, output: 131072 }, variants: { high: {} } },
          "m-old": { ...base, id: "m-old", name: "Model Old", capabilities: { reasoning: false, input: { image: true } }, status: "deprecated", limit: { context: 1000, output: 100 }, variants: {} },
        },
      },
      {
        id: "beta",
        name: "Beta Hub",
        models: {
          "m-three": { ...base, providerID: "beta", id: "m-three", name: "Model Three", cost: { input: 1.25, output: 10, cache: { read: 0.125, write: 0 } }, limit: { context: 400000, output: 128000 }, variants: { high: {} } },
        },
      },
    ]);
  });

  it("keys a model by modelID, takes the untiered price, and leaves out disabled models and their providers", async () => {
    const { api } = await setup({
      providers: [{ id: "p1", name: "One" }],
      models: [
        { id: "a", modelID: "real-a", providerID: "p1" },
        { id: "b", providerID: "p1", enabled: false, name: "Disabled" },
        { id: "c", providerID: "p2", capabilities: { input: ["text"] }, cost: [{ tier: { over: 200000 }, input: 9, output: 9 }, { input: 1, output: 2 }], variants: [{ id: "x" }] },
        { id: "d", providerID: "p3", enabled: false },
      ],
    });
    const list = await api.providers(DIR);
    expect(list.connected).toEqual(["p1", "p2"]);
    expect(list.all).toEqual([
      { id: "p1", name: "One", models: { "real-a": { id: "real-a", providerID: "p1", name: "real-a", capabilities: { reasoning: false, input: { image: false } }, variants: {} } } },
      { id: "p2", models: { c: { id: "c", providerID: "p2", name: "c", capabilities: { reasoning: true, input: { image: false } }, cost: { input: 1, output: 2, cache: { read: 0, write: 0 } }, variants: { x: {} } } } },
    ]);
    expect(list.default).toEqual({ p1: "real-a" });
    expect(list.all[0]!.models["real-a"]).not.toHaveProperty("cost");
    expect(list.all[0]!.models["real-a"]).not.toHaveProperty("limit");
  });

  it("asks again, pausing, while the model list is empty and then answers", async () => {
    let calls = 0;
    const fetcher: typeof globalThis.fetch = async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/model" && (init?.method ?? "GET") === "GET" && ++calls <= 2) return json({ location: { directory: DIR }, data: [] });
      return globalThis.fetch(input, init);
    };
    const { api, sleeps } = await setup({}, { fetch: fetcher });
    const list = await api.providers(DIR);
    expect(calls).toBe(3);
    expect(sleeps).toEqual([500, 500]);
    expect(list.connected[0]).toBe("opencode");
  });

  it("gives up after ten tries and answers with no models", async () => {
    let calls = 0;
    const fetcher: typeof globalThis.fetch = async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/model" && (init?.method ?? "GET") === "GET") { calls += 1; return json({ location: { directory: DIR }, data: [] }); }
      return globalThis.fetch(input, init);
    };
    const { api, sleeps } = await setup({}, { fetch: fetcher });
    const list = await api.providers(DIR);
    expect(calls).toBe(10);
    expect(sleeps).toEqual(Array(9).fill(500));
    expect(list.all).toEqual([]);
    expect(list.connected).toEqual([]);
  });

  it("reads the default model from /api/model/default as provider/model", async () => {
    const { fake, api } = await setup();
    const mark = fake.requests.length;
    await expect(api.config(DIR)).resolves.toEqual({ model: "opencode/space-bunny-free" });
    expect(since(fake, mark).map((request) => [route(request), request.query])).toEqual([["GET /api/model/default", { [LOC]: DIR }]]);
    const other = await setup({ defaultModel: "opencode/exo-free" });
    await expect(other.api.config(DIR)).resolves.toEqual({ model: "opencode/exo-free" });
  });

  it("answers no model when the server has no default", async () => {
    const { api } = await setup({ models: [] });
    await expect(api.config(DIR)).resolves.toEqual({});
  });
});

describe("sessions", () => {
  it("creates a session with the folder and the level's rules, and no title unless given", async () => {
    const { fake, api } = await setup();
    let mark = fake.requests.length;
    const plain = await api.createSession(DIR, { policy: POLICY });
    expect(since(fake, mark)).toEqual([{ method: "POST", path: "/api/session", query: {}, body: { location: { directory: DIR }, permissions: rulesForLevelV2("ask", undefined) } }]);
    expect(plain.id).toMatch(/^ses_/u);
    expect(plain).not.toHaveProperty("title");
    expect(plain).not.toHaveProperty("parentId");
    expect(fake.sessions.get(plain.id)).toMatchObject({ directory: DIR, permissions: rulesForLevelV2("ask") });

    mark = fake.requests.length;
    const titled = await api.createSession(DIR, { title: "Hello", policy: { level: "read-only", tools: ["read"] } });
    expect(since(fake, mark)[0]!.body).toEqual({ location: { directory: DIR }, title: "Hello", permissions: rulesForLevelV2("read-only", ["read"]) });
    expect(titled.title).toBe("Hello");
  });

  it("reads a session's title, parent, tokens and cost", async () => {
    const { fake, api } = await setup();
    fake.addSession({ id: "ses_child", directory: DIR, title: "Child", parentID: "ses_parent", cost: 2.5, tokens: { ...ZERO, input: 7 } });
    const mark = fake.requests.length;
    await expect(api.getSession(DIR, "ses_child")).resolves.toEqual({ id: "ses_child", title: "Child", parentId: "ses_parent", cost: 2.5, tokens: { ...ZERO, input: 7 } });
    expect(routes(fake, mark)).toEqual(["GET /api/session/ses_child"]);
  });

  it("rejects a missing session with the server's 404", async () => {
    const { api } = await setup();
    const error = await api.getSession(DIR, "ses_nope").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(OpenCodeHttpError);
    expect(error).toMatchObject({ status: 404, method: "GET", path: "/api/session/ses_nope" });
  });

  it("patches a session's permissions when the policy changes", async () => {
    const { fake, api } = await setup();
    const { id } = await api.createSession(DIR, { policy: POLICY });
    const mark = fake.requests.length;
    await api.applyPolicy(DIR, id, { level: "full", tools: ["bash"] });
    expect(since(fake, mark)).toEqual([{ method: "PATCH", path: `/api/session/${id}`, query: {}, body: { permissions: rulesForLevelV2("full", ["bash"]) } }]);
    expect(fake.sessions.get(id)!.permissions).toEqual(rulesForLevelV2("full", ["bash"]));
  });

  it("patches the title to rename", async () => {
    const { fake, api } = await setup();
    const { id } = await api.createSession(DIR, { policy: POLICY });
    const mark = fake.requests.length;
    await api.renameSession(DIR, id, "New name");
    expect(since(fake, mark)).toEqual([{ method: "PATCH", path: `/api/session/${id}`, query: {}, body: { title: "New name" } }]);
    expect(fake.sessions.get(id)!.title).toBe("New name");
  });
});

describe("prompting", () => {
  const OC = { providerID: "opencode", modelID: "space-bunny-free" };
  const text = (value: string) => ({ type: "text" as const, text: value });

  async function session(context: Setup) {
    const { id } = await context.api.createSession(DIR, { policy: POLICY });
    return id;
  }

  it("switches the model only when it changed, and reads variant default as none", async () => {
    const context = await setup();
    const { fake, api } = context;
    const id = await session(context);
    const switches = (mark: number) => since(fake, mark).filter((request) => request.path.endsWith("/model")).map((request) => request.body);
    let mark = fake.requests.length;
    await api.prompt(DIR, id, { parts: [text("one")], model: OC, plan: false });
    expect(switches(mark)).toEqual([{ model: { id: "space-bunny-free", providerID: "opencode" } }]);

    mark = fake.requests.length;
    await api.prompt(DIR, id, { parts: [text("two")], model: OC, variant: "default", plan: false });
    expect(routes(fake, mark)).toEqual([`POST /api/session/${id}/prompt`]);

    mark = fake.requests.length;
    await api.prompt(DIR, id, { parts: [text("three")], model: OC, variant: "high", plan: false });
    expect(switches(mark)).toEqual([{ model: { id: "space-bunny-free", providerID: "opencode", variant: "high" } }]);

    mark = fake.requests.length;
    await api.prompt(DIR, id, { parts: [text("four")], model: OC, variant: "high", plan: false });
    expect(routes(fake, mark)).toEqual([`POST /api/session/${id}/prompt`]);

    mark = fake.requests.length;
    await api.prompt(DIR, id, { parts: [text("five")], model: OC, plan: false });
    expect(switches(mark)).toEqual([{ model: { id: "space-bunny-free", providerID: "opencode" } }]);

    mark = fake.requests.length;
    await api.prompt(DIR, id, { parts: [text("six")], model: { providerID: "opencode", modelID: "exo-free" }, plan: false });
    expect(switches(mark)).toEqual([{ model: { id: "exo-free", providerID: "opencode" } }]);
    expect(fake.sessions.get(id)!.model).toEqual({ id: "exo-free", providerID: "opencode" });
  });

  it("sends no model request when the prompt names no model", async () => {
    const context = await setup();
    const id = await session(context);
    const mark = context.fake.requests.length;
    await context.api.prompt(DIR, id, { parts: [text("hi")], plan: false });
    expect(routes(context.fake, mark)).toEqual([`POST /api/session/${id}/prompt`]);
  });

  it("plans on the plan agent with one instruction entry, and removes both once", async () => {
    const context = await setup();
    const { fake, api } = context;
    const id = await session(context);
    const entry = `/api/experimental/session/${id}/instructions/entries/tau-plan`;

    let mark = fake.requests.length;
    await api.prompt(DIR, id, { parts: [text("plan it")], plan: true });
    expect(routes(fake, mark)).toEqual([`POST /api/session/${id}/agent`, `PUT ${entry}`, `POST /api/session/${id}/prompt`]);
    expect(since(fake, mark)[0]!.body).toEqual({ agent: "plan" });
    expect(since(fake, mark)[1]!.body).toEqual({ value: expect.stringContaining("<proposed_plan>") });
    expect(Object.keys(fake.sessions.get(id)!.instructionEntries)).toEqual(["tau-plan"]);
    expect(fake.sessions.get(id)!.agent).toBe("plan");

    mark = fake.requests.length;
    await api.prompt(DIR, id, { parts: [text("still planning")], plan: true });
    expect(routes(fake, mark)).toEqual([`POST /api/session/${id}/prompt`]);

    mark = fake.requests.length;
    await api.prompt(DIR, id, { parts: [text("build it")], plan: false });
    expect(routes(fake, mark)).toEqual([`POST /api/session/${id}/agent`, `DELETE ${entry}`, `POST /api/session/${id}/prompt`]);
    expect(since(fake, mark)[0]!.body).toEqual({ agent: "build" });
    expect(fake.sessions.get(id)!.instructionEntries).toEqual({});
    expect(fake.sessions.get(id)!.agent).toBe("build");

    mark = fake.requests.length;
    await api.prompt(DIR, id, { parts: [text("again")], plan: false });
    expect(routes(fake, mark)).toEqual([`POST /api/session/${id}/prompt`]);
  });

  it("joins text parts, turns files into uri and name, and sends delivery steer only when asked", async () => {
    const context = await setup();
    const { fake, api } = context;
    const id = await session(context);
    let mark = fake.requests.length;
    await api.prompt(DIR, id, {
      parts: [text("first"), { type: "file", mime: "image/png", url: "file:///repo/a.png", filename: "a.png" }, text("second"), { type: "file", mime: "text/plain", url: "data:text/plain;base64,aGk=" }],
      plan: false,
    });
    expect(since(fake, mark)).toEqual([{ method: "POST", path: `/api/session/${id}/prompt`, query: {}, body: { text: "first\n\nsecond", files: [{ uri: "file:///repo/a.png", name: "a.png" }, { uri: "data:text/plain;base64,aGk=" }] } }]);

    mark = fake.requests.length;
    await api.prompt(DIR, id, { parts: [text("plain")], plan: false });
    const body = since(fake, mark)[0]!.body as Json;
    expect(body).toEqual({ text: "plain" });
    expect(body).not.toHaveProperty("delivery");
    expect(body).not.toHaveProperty("files");

    mark = fake.requests.length;
    await api.prompt(DIR, id, { parts: [text("steer")], plan: false, steer: true });
    expect(since(fake, mark)[0]!.body).toEqual({ text: "steer", delivery: "steer" });
  });

  it("starts from what getSession saw, so an unchanged model and agent send nothing", async () => {
    const { fake, api, connect } = await setup();
    fake.addSession({ id: "ses_known", directory: DIR, model: { providerID: "opencode", id: "exo-free", variant: "high" }, agent: "plan" });
    await api.getSession(DIR, "ses_known");
    const entry = "/api/experimental/session/ses_known/instructions/entries/tau-plan";
    let mark = fake.requests.length;
    await api.prompt(DIR, "ses_known", { parts: [text("x")], model: { providerID: "opencode", modelID: "exo-free" }, variant: "high", plan: true });
    expect(routes(fake, mark)).toEqual([`PUT ${entry}`, "POST /api/session/ses_known/prompt"]);

    // A session this api never read is read first.
    const fresh = await connect();
    mark = fake.requests.length;
    await fresh.prompt(DIR, "ses_known", { parts: [text("y")], model: { providerID: "opencode", modelID: "exo-free" }, variant: "high", plan: false });
    expect(routes(fake, mark)).toEqual(["GET /api/session/ses_known", "POST /api/session/ses_known/agent", "POST /api/session/ses_known/prompt"]);
  });

  // Bug: plan state starts as "off" for a session this api did not set up, so the entry a former
  // connection left behind is never removed (client-v2.ts, remember/prompt). Fix: read the entries.
  it.fails("removes the plan entry an earlier connection left when leaving plan mode", async () => {
    const { fake, connect } = await setup();
    fake.addSession({ id: "ses_left", directory: DIR, agent: "plan", instructionEntries: { "tau-plan": "You are in plan mode" } });
    const fresh = await connect();
    await fresh.prompt(DIR, "ses_left", { parts: [text("build it")], plan: false });
    expect(fake.sessions.get("ses_left")!.instructionEntries).toEqual({});
  });

  it("rejects with the 404 and sends nothing else for an unknown session", async () => {
    const { fake, api } = await setup();
    const mark = fake.requests.length;
    await expect(api.prompt(DIR, "ses_nope", { parts: [text("x")], plan: false })).rejects.toMatchObject({ status: 404 });
    expect(routes(fake, mark)).toEqual(["GET /api/session/ses_nope"]);
  });
});

describe("abort and settle", () => {
  it("posts the interrupt", async () => {
    const { fake, api } = await setup();
    fake.addSession({ id: "ses_a", directory: DIR });
    const mark = fake.requests.length;
    await api.abort(DIR, "ses_a");
    expect(since(fake, mark)).toEqual([{ method: "POST", path: "/api/session/ses_a/interrupt", query: {} }]);
  });

  it("does nothing but look when the session is not active", async () => {
    const { fake, api, sleeps } = await setup();
    fake.addSession({ id: "ses_idle", directory: DIR });
    fake.addSession({ id: "ses_other", directory: DIR, running: true });
    const mark = fake.requests.length;
    await api.settle(DIR, "ses_idle");
    expect(routes(fake, mark)).toEqual(["GET /api/session/active"]);
    expect(sleeps).toEqual([]);
  });

  it("interrupts an active session and polls until it is idle", async () => {
    let clear = () => undefined as void;
    const { fake, api, sleeps } = await setup({}, { onSleep: (count) => { if (count === 2) clear(); } });
    const busy = fake.addSession({ id: "ses_busy", directory: DIR, running: true });
    clear = () => { busy.running = false; };
    const mark = fake.requests.length;
    await api.settle(DIR, "ses_busy");
    expect(routes(fake, mark)).toEqual(["GET /api/session/active", "POST /api/session/ses_busy/interrupt", "GET /api/session/active", "GET /api/session/active", "GET /api/session/active"]);
    expect(sleeps).toEqual([250, 250]);
  });

  it("stops waiting after twenty tries and does not throw", async () => {
    const { fake, api, sleeps } = await setup();
    fake.addSession({ id: "ses_stuck", directory: DIR, running: true });
    const mark = fake.requests.length;
    await expect(api.settle(DIR, "ses_stuck")).resolves.toBeUndefined();
    expect(sleeps).toEqual(Array(20).fill(250));
    expect(routes(fake, mark).filter((entry) => entry === "GET /api/session/active")).toHaveLength(21);
    expect(routes(fake, mark).filter((entry) => entry.endsWith("/interrupt"))).toHaveLength(1);
  });

  it("still waits when the interrupt itself fails", async () => {
    const fetcher: typeof globalThis.fetch = async (input, init) => {
      if (new URL(String(input)).pathname.endsWith("/interrupt")) return new Response("boom", { status: 500 });
      return globalThis.fetch(input, init);
    };
    let clear = () => undefined as void;
    const { fake, api, sleeps } = await setup({}, { fetch: fetcher, onSleep: () => clear() });
    const busy = fake.addSession({ id: "ses_x", directory: DIR, running: true });
    clear = () => { busy.running = false; };
    await expect(api.settle(DIR, "ses_x")).resolves.toBeUndefined();
    expect(sleeps).toEqual([250]);
  });
});

describe("permissions", () => {
  const ASK = { action: "shell", resources: ["npm test"], save: ["npm *"], metadata: { command: "npm test" } };

  /** Prompts a session whose script asks `payloads`, and hands back the first request. */
  async function asked(payloads: Json[]) {
    const questions = asking(payloads.map((payload) => ({ kind: "permission" as const, payload })));
    const context = await setup({ script: questions.script });
    const { id } = await context.api.createSession(DIR, { policy: POLICY });
    const stream = await watch(context.api);
    await context.api.prompt(DIR, id, { parts: [{ type: "text", text: "go" }], plan: false });
    return { ...context, ...questions, id, stream, next: async () => (await stream.next("permission")).request };
  }

  it("maps permission.asked to a request with the action, resources and save patterns", async () => {
    const context = await asked([ASK]);
    const request = await context.next();
    expect(request).toEqual({ id: expect.stringMatching(/^per_/u), sessionID: context.id, permission: "shell", patterns: ["npm test"], always: ["npm *"], metadata: { command: "npm test" } });
  });

  it("replies once with the decision once, and nothing else", async () => {
    const context = await asked([ASK]);
    const request = await context.next();
    const mark = context.fake.requests.length;
    await context.api.replyPermission(DIR, request, "once");
    expect(since(context.fake, mark)).toEqual([{ method: "POST", path: `/api/session/${context.id}/permission/${request.id}/reply`, query: {}, body: { decision: "once" } }]);
    await vi.waitFor(() => expect(context.replies).toEqual([{ decision: "once" }]));
  });

  it("rejects with Tau's text, or the one given", async () => {
    const context = await asked([ASK, ASK]);
    const first = await context.next();
    let mark = context.fake.requests.length;
    await context.api.replyPermission(DIR, first, "reject");
    expect(since(context.fake, mark)[0]!.body).toEqual({ decision: "reject", message: "The user declined this request." });

    const second = await context.next();
    mark = context.fake.requests.length;
    await context.api.replyPermission(DIR, second, "reject", "Not now.");
    expect(since(context.fake, mark)[0]!.body).toEqual({ decision: "reject", message: "Not now." });
    await vi.waitFor(() => expect(context.replies).toEqual([
      { decision: "reject", message: "The user declined this request." },
      { decision: "reject", message: "Not now." },
    ]));
  });

  it("grants an always to the session alone, before replying once", async () => {
    const context = await asked([ASK]);
    const request = await context.next();
    const before = context.fake.sessions.get(context.id)!.permissions;
    const mark = context.fake.requests.length;
    await context.api.replyPermission(DIR, request, "always");
    const sent = since(context.fake, mark);
    expect(sent.map(route)).toEqual([`GET /api/session/${context.id}`, `PATCH /api/session/${context.id}`, `POST /api/session/${context.id}/permission/${request.id}/reply`]);
    expect(sent[1]!.body).toEqual({ permissions: [...(before as unknown[]), { action: "shell", resource: "npm *", effect: "allow" }] });
    expect(sent[2]!.body).toEqual({ decision: "once" });
    expect(context.fake.sessions.get(context.id)!.permissions).toEqual([...rulesForLevelV2("ask"), { action: "shell", resource: "npm *", effect: "allow" }]);
    await vi.waitFor(() => expect(context.replies).toEqual([{ decision: "once" }]));
  });

  it("grants every pattern, or * when the request names none", async () => {
    const context = await asked([{ ...ASK, save: ["git status", "git diff *"] }, { ...ASK, action: "edit", save: [] }]);
    const first = await context.next();
    let mark = context.fake.requests.length;
    await context.api.replyPermission(DIR, first, "always");
    expect(since(context.fake, mark)[1]!.body).toEqual({ permissions: [...rulesForLevelV2("ask"), { action: "shell", resource: "git status", effect: "allow" }, { action: "shell", resource: "git diff *", effect: "allow" }] });

    const second = await context.next();
    mark = context.fake.requests.length;
    await context.api.replyPermission(DIR, second, "always");
    const grants = (since(context.fake, mark)[1]!.body as { permissions: unknown[] }).permissions.slice(-1);
    expect(grants).toEqual([{ action: "edit", resource: "*", effect: "allow" }]);
    expect((since(context.fake, mark)[1]!.body as { permissions: unknown[] }).permissions).toHaveLength(rulesForLevelV2("ask").length + 2 + 1);
  });

  it("does not reply when the grant cannot be stored", async () => {
    const context = await asked([ASK]);
    const request = await context.next();
    const mark = context.fake.requests.length;
    await expect(context.api.replyPermission(DIR, { ...request, sessionID: "ses_nope" }, "always")).rejects.toMatchObject({ status: 404 });
    expect(routes(context.fake, mark)).toEqual(["GET /api/session/ses_nope"]);
  });
});

describe("questions", () => {
  const FORM_ID = "frm_test";
  const form = (fields: unknown[], sessionID = "ses_1") => ({ type: "form.created", properties: { form: { id: FORM_ID, sessionID, title: "Questions", fields } } }) satisfies OpenCodeEvent;
  const question = (api: OpenCodeApi, event: OpenCodeEvent) => {
    const signal = api.signal(event);
    if (signal?.kind !== "question") throw new Error(`expected a question, got ${signal?.kind}`);
    return signal;
  };

  const FIELDS = [
    { key: "db", type: "string", title: "DB", description: "Which database?", options: [{ value: "pg", label: "Postgres", description: "Relational" }, { value: "sq", label: "SQLite" }] },
    { key: "note", type: "string", title: "Note" },
    { key: "targets", type: "multiselect", title: "Targets", options: [{ value: "web", label: "Web" }, { value: "ios", label: "iOS" }], custom: true },
    { key: "tests", type: "boolean", title: "Run tests?" },
    { key: "ratio", type: "number", title: "Ratio" },
    { key: "count", type: "integer", title: "Count" },
  ];

  it("shows each field as a question", async () => {
    const { api } = await setup();
    const { request } = question(api, form(FIELDS));
    expect(request.id).toBe(FORM_ID);
    expect(request.questions).toEqual([
      { question: "Which database?", header: "DB", options: [{ label: "Postgres", description: "Relational" }, { label: "SQLite" }], multiple: false, custom: false },
      { question: "Note", header: "Note", options: [], multiple: false, custom: true },
      { question: "Targets", header: "Targets", options: [{ label: "Web" }, { label: "iOS" }], multiple: true, custom: true },
      { question: "Run tests?", header: "Run tests?", options: [{ label: "Yes", description: "" }, { label: "No", description: "" }], multiple: false, custom: false },
      { question: "Ratio", header: "Ratio", options: [], multiple: false, custom: true },
      { question: "Count", header: "Count", options: [], multiple: false, custom: true },
    ]);
    expect(request).not.toHaveProperty("orphan");
  });

  it("marks a form outside any session as an orphan", async () => {
    const { api } = await setup();
    expect(question(api, form(FIELDS.slice(0, 1), "mcp_server")).request.orphan).toBe(true);
    expect(question(api, form(FIELDS.slice(0, 1), "mcp_server")).sessionId).toBe("mcp_server");
    expect(question(api, form(FIELDS.slice(0, 1), "ses_abc")).request).not.toHaveProperty("orphan");
  });

  it("ignores a form event without an id, a session or fields", async () => {
    const { api } = await setup();
    expect(api.signal({ type: "form.created", properties: {} })).toBeUndefined();
    expect(api.signal({ type: "form.created", properties: { form: { id: "f", fields: [] } } })).toBeUndefined();
    expect(api.signal({ type: "form.created", properties: { form: { id: "f", sessionID: "ses_1", fields: "no" } } })).toBeUndefined();
  });

  it("answers over the wire: label to value, free text, lists, yes and no, numbers", async () => {
    const asks = asking([
      { kind: "form", payload: { title: "Questions", fields: FIELDS } },
      { kind: "form", payload: { title: "More", fields: [
        { key: "no", type: "boolean" }, { key: "yes", type: "boolean" }, { key: "bad", type: "number" },
        { key: "many", type: "string" }, { key: "blank", type: "string" }, { key: "unlabelled", type: "string", options: [{ value: "v", label: "L" }] },
        { key: "skipped", type: "string" },
      ] } },
    ]);
    const context = await setup({ script: asks.script });
    const { id } = await context.api.createSession(DIR, { policy: POLICY });
    const stream = await watch(context.api);
    await context.api.prompt(DIR, id, { parts: [{ type: "text", text: "go" }], plan: false });

    const first = (await stream.next("question")).request;
    expect(first.questions).toHaveLength(6);
    let mark = context.fake.requests.length;
    await context.api.answerQuestion(DIR, id, first, [["Postgres"], ["  hello there "], ["Web", "iOS"], ["Yes"], ["3.5"], ["7.9"]]);
    expect(since(context.fake, mark)).toEqual([{ method: "POST", path: `/api/session/${id}/form/${first.id}/reply`, query: {}, body: { answer: { db: "pg", note: "hello there", targets: ["web", "ios"], tests: true, ratio: 3.5, count: 7 } } }]);

    const second = (await stream.next("question")).request;
    mark = context.fake.requests.length;
    await context.api.answerQuestion(DIR, id, second, [["No"], ["true"], ["abc"], ["a", "b"], [""], ["L"]]);
    expect(since(context.fake, mark)[0]!.body).toEqual({ answer: { no: false, yes: true, many: "a, b", unlabelled: "v" } });
    await vi.waitFor(() => expect(asks.replies).toHaveLength(2));
    expect(asks.replies[1]).toEqual({ answer: { no: false, yes: true, many: "a, b", unlabelled: "v" } });
  });

  it("dismisses with a DELETE and Tau's message", async () => {
    const asks = asking([{ kind: "form", payload: { title: "Q", fields: FIELDS.slice(0, 1) } }]);
    const context = await setup({ script: asks.script });
    const { id } = await context.api.createSession(DIR, { policy: POLICY });
    const stream = await watch(context.api);
    await context.api.prompt(DIR, id, { parts: [{ type: "text", text: "go" }], plan: false });
    const { request } = await stream.next("question");
    const mark = context.fake.requests.length;
    await context.api.answerQuestion(DIR, id, request, undefined);
    expect(since(context.fake, mark)).toEqual([{ method: "DELETE", path: `/api/session/${id}/form/${request.id}`, query: { message: "The user dismissed this question." } }]);
    await vi.waitFor(() => expect(asks.replies).toEqual([{ cancelled: true, message: "The user dismissed this question." }]));
  });

  it.each([
    ["a link to open", { key: "k", type: "external" }],
    ["a hidden field", { key: "k", type: "string", hidden: true }],
    ["a field that depends on another", { key: "k", type: "string", when: [{ key: "other" }] }],
    ["a date value", { key: "k", type: "date" }],
  ])("shows a form with %s as no questions and cancels it with a message", async (why, field) => {
    const asks = asking([{ kind: "form", payload: { title: "Odd", fields: [{ key: "ok", type: "string" }, field] } }]);
    const context = await setup({ script: asks.script });
    const { id } = await context.api.createSession(DIR, { policy: POLICY });
    const stream = await watch(context.api);
    await context.api.prompt(DIR, id, { parts: [{ type: "text", text: "go" }], plan: false });
    const { request } = await stream.next("question");
    expect(request.questions).toEqual([]);
    expect((request.native as { message: string }).message).toBe(`Tau cannot answer ${why}.`);
    const mark = context.fake.requests.length;
    // Even if somebody supplies answers, the form is cancelled.
    await context.api.answerQuestion(DIR, id, request, [["x"], ["y"]]);
    expect(since(context.fake, mark)).toEqual([{ method: "DELETE", path: `/api/session/${id}/form/${request.id}`, query: { message: `Tau cannot answer ${why}.` } }]);
    await vi.waitFor(() => expect(asks.replies).toEqual([{ cancelled: true, message: `Tau cannot answer ${why}.` }]));
  });
});

describe("signals", () => {
  const { api } = { api: new OpenCode2Api(new OpenCodeClient({ url: "http://127.0.0.1:9" }), "2.0.26") };
  const event = (type: string, properties: Json): OpenCodeEvent => ({ type, properties });

  it("maps a created session with its parent and title", () => {
    expect(api.signal(event("session.created", { sessionID: "ses_1", parentID: "ses_0", title: "Child", location: { directory: DIR } }))).toEqual({ kind: "session", sessionId: "ses_1", parentId: "ses_0", title: "Child" });
    expect(api.signal(event("session.created", { sessionID: "ses_1", title: "" }))).toEqual({ kind: "session", sessionId: "ses_1" });
    expect(api.signal(event("session.created", { sessionID: "ses_1", parentID: 5, title: 7 }))).toEqual({ kind: "session", sessionId: "ses_1" });
  });

  it("maps a rename, and ignores one without a title", () => {
    expect(api.signal(event("session.renamed", { sessionID: "ses_1", title: "New" }))).toEqual({ kind: "session", sessionId: "ses_1", title: "New" });
    expect(api.signal(event("session.renamed", { sessionID: "ses_1" }))).toBeUndefined();
  });

  it("maps usage with tokens and cost", () => {
    const tokens = { input: 3, output: 4, reasoning: 0, cache: { read: 1, write: 2 } };
    expect(api.signal(event("session.usage.updated", { sessionID: "ses_1", tokens, cost: 0.5 }))).toEqual({ kind: "session", sessionId: "ses_1", usage: { tokens, cost: 0.5 } });
    expect(api.signal(event("session.usage.updated", { sessionID: "ses_1", tokens }))).toEqual({ kind: "session", sessionId: "ses_1", usage: { tokens } });
  });

  it("maps permission.asked to a request with action, resources and save", () => {
    expect(api.signal(event("permission.asked", { id: "per_1", sessionID: "ses_1", action: "shell", resources: ["a", "b"], save: ["a *"], metadata: { command: "a" } })))
      .toEqual({ kind: "permission", sessionId: "ses_1", request: { id: "per_1", sessionID: "ses_1", permission: "shell", patterns: ["a", "b"], always: ["a *"], metadata: { command: "a" } } satisfies PermissionRequest });
    expect(api.signal(event("permission.asked", { id: "per_2", sessionID: "ses_1" })))
      .toEqual({ kind: "permission", sessionId: "ses_1", request: { id: "per_2", sessionID: "ses_1", permission: "", patterns: [], always: [], metadata: {} } });
    expect(api.signal(event("permission.asked", { sessionID: "ses_1", action: "shell" }))).toBeUndefined();
  });

  it("hands every other event with a session to its turn", () => {
    const properties = { sessionID: "ses_1", assistantMessageID: "msg_1", delta: "hi" };
    expect(api.signal(event("session.text.delta", properties))).toEqual({ kind: "turn", sessionId: "ses_1", type: "session.text.delta", properties });
    expect(api.signal(event("permission.replied", { sessionID: "ses_1", requestID: "per_1" }))).toMatchObject({ kind: "turn", type: "permission.replied" });
    expect(api.signal(event("form.replied", { sessionID: "ses_1", id: "frm_1" }))).toMatchObject({ kind: "turn", type: "form.replied" });
  });

  it("ignores events without a session", () => {
    expect(api.signal(event("server.connected", {}))).toBeUndefined();
    expect(api.signal(event("session.created", { title: "x" }))).toBeUndefined();
    expect(api.signal(event("session.text.delta", { sessionID: 5 }))).toBeUndefined();
    expect(api.signal(event("permission.asked", { id: "per_1" }))).toBeUndefined();
  });

  it("gives the same signal for a recorded event as the stream parser produces", () => {
    const block = `data: ${JSON.stringify({ id: "evt_1", type: "session.renamed", location: { directory: DIR }, data: { sessionID: "ses_1", title: "T" } })}`;
    expect(api.signal(parseEvent2Block(block)!)).toEqual({ kind: "session", sessionId: "ses_1", title: "T" });
  });
});

describe("parseEvent2Block", () => {
  it("hands on type and data, with the location folded into the properties", () => {
    const block = `id: 7\nevent: x\ndata: ${JSON.stringify({ id: "evt_1", type: "session.renamed", location: { directory: DIR }, data: { sessionID: "ses_1", title: "T" } })}`;
    expect(parseEvent2Block(block)).toEqual({ type: "session.renamed", properties: { sessionID: "ses_1", title: "T", location: { directory: DIR } } });
  });

  it("leaves the location out when the event has none", () => {
    const event = parseEvent2Block('data: {"type":"session.usage.updated","data":{"sessionID":"s"}}')!;
    expect(event).toEqual({ type: "session.usage.updated", properties: { sessionID: "s" } });
    expect(event.properties).not.toHaveProperty("location");
  });

  it("joins several data lines with a newline, with or without the space and with CRLF", () => {
    expect(parseEvent2Block('data: {"type":"a",\ndata: "data":{"n":1}}')).toEqual({ type: "a", properties: { n: 1 } });
    expect(parseEvent2Block('data:{"type":"b",\r\ndata:"data":{"n":2}}')).toEqual({ type: "b", properties: { n: 2 } });
  });

  it("takes empty properties for data that is no object", () => {
    expect(parseEvent2Block('data: {"type":"c"}')).toEqual({ type: "c", properties: {} });
    expect(parseEvent2Block('data: {"type":"c","data":"text"}')).toEqual({ type: "c", properties: {} });
    expect(parseEvent2Block('data: {"type":"c","data":[1,2]}')).toEqual({ type: "c", properties: {} });
  });

  it("ignores comments, blocks without data, and garbage", () => {
    expect(parseEvent2Block(": heartbeat")).toBeUndefined();
    expect(parseEvent2Block("")).toBeUndefined();
    expect(parseEvent2Block("event: x\nid: 1")).toBeUndefined();
    expect(parseEvent2Block("data: not json")).toBeUndefined();
    expect(parseEvent2Block('data: {"data":{}}')).toBeUndefined();
    expect(parseEvent2Block('data: {"type":5}')).toBeUndefined();
    expect(parseEvent2Block("data: null")).toBeUndefined();
    expect(parseEvent2Block("data: 5")).toBeUndefined();
    expect(parseEvent2Block('data: {"type":"d"')).toBeUndefined();
  });

  it("reads the data lines even beside a comment", () => {
    expect(parseEvent2Block(': ping\ndata: {"type":"e","data":{"k":1}}')).toEqual({ type: "e", properties: { k: 1 } });
  });
});

describe("the event stream", () => {
  it("follows /api/event and hands on type and properties", async () => {
    const { fake, api } = await setup();
    const events: OpenCodeEvent[] = [];
    const wake: Array<() => void> = [];
    const onEnd = vi.fn();
    const subscription = await api.subscribe(DIR, (event) => { events.push(event); for (const resume of wake.splice(0)) resume(); }, onEnd);
    expect(fake.listeners).toBe(1);
    expect(fake.requests.filter((request) => route(request) === "GET /api/event")).toHaveLength(1);
    fake.broadcast("session.renamed", { sessionID: "ses_1", title: "T" }, { directory: DIR });
    fake.broadcast("session.usage.updated", { sessionID: "ses_1", cost: 1 });
    while (events.length < 3) await new Promise<void>((resolve) => wake.push(resolve));
    expect(events).toEqual([
      { type: "server.connected", properties: {} },
      { type: "session.renamed", properties: { sessionID: "ses_1", title: "T", location: { directory: DIR } } },
      { type: "session.usage.updated", properties: { sessionID: "ses_1", cost: 1 } },
    ]);
    subscription.close();
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(onEnd).toHaveBeenCalledWith();
  });

  it("tells onEnd with an error when the server closes the stream", async () => {
    const { fake, api } = await setup();
    const ended = new Promise<Error | undefined>((resolve) => { void api.subscribe(DIR, () => undefined, resolve); });
    await vi.waitFor(() => expect(fake.listeners).toBe(1));
    await fake.close();
    expect(await ended).toBeInstanceOf(Error);
  });

  it("ends without an error on close, once, and sends nothing more", async () => {
    const { fake, api } = await setup();
    const onEvent = vi.fn();
    const onEnd = vi.fn();
    const subscription = await api.subscribe(DIR, onEvent, onEnd);
    subscription.close();
    subscription.close();
    fake.broadcast("session.renamed", { sessionID: "ses_1", title: "late" });
    await fake.close();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(onEnd).toHaveBeenCalledWith();
    expect(onEvent.mock.calls.map(([event]) => (event as OpenCodeEvent).properties.title)).not.toContain("late");
  });

  it("rejects the subscription when the server refuses it", async () => {
    const fake = await startFakeOpenCode2({ password: PASSWORD });
    fakes.push(fake);
    const api = new OpenCode2Api(new OpenCodeClient({ url: fake.url, password: "wrong" }), "2.0.26");
    await expect(api.subscribe(DIR, () => undefined, () => undefined)).rejects.toMatchObject({ name: "OpenCodeHttpError", status: 401 });
  });
});

describe("OpenCodeClient.follow", () => {
  /** A response whose body the test writes to. */
  function pipe() {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({ start: (c) => { controller = c; } });
    const encoder = new TextEncoder();
    return {
      fetch: (async () => new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } })) as typeof globalThis.fetch,
      write: (text: string) => controller.enqueue(encoder.encode(text)),
      end: () => controller.close(),
    };
  }

  it("ends a silent stream with an error once silenceMs passes", async () => {
    const source = pipe();
    const client = new OpenCodeClient({ url: "http://127.0.0.1:9", fetch: source.fetch });
    let finish!: (error?: Error) => void;
    const done = new Promise<Error | undefined>((resolve) => { finish = resolve; });
    const events: unknown[] = [];
    await client.follow("/api/event", {}, parseEvent2Block, (event) => events.push(event), finish, 5);
    const error = await done;
    expect(error?.message).toBe("OpenCode stopped sending events.");
    expect(events).toEqual([]);
  });

  it("reads events split across chunks, with CRLF and comments, then ends with an error when the body ends", async () => {
    const source = pipe();
    const client = new OpenCodeClient({ url: "http://127.0.0.1:9", fetch: source.fetch });
    const events: OpenCodeEvent[] = [];
    let finish!: (error?: Error) => void;
    const done = new Promise<Error | undefined>((resolve) => { finish = resolve; });
    await client.follow("/api/event", {}, parseEvent2Block, (event) => events.push(event), finish);
    source.write('data: {"type":"a","da');
    source.write('ta":{"n":1}}\r\n\r\n: ping\n\ndata: {"type":"b"}\n');
    source.write("\n");
    source.end();
    const error = await done;
    expect(events).toEqual([{ type: "a", properties: { n: 1 } }, { type: "b", properties: {} }]);
    expect(error?.message).toBe("OpenCode closed its event stream.");
  });

  it("throws the HTTP error of a refused stream", async () => {
    const client = new OpenCodeClient({ url: "http://127.0.0.1:9", fetch: async () => new Response("no", { status: 503 }) });
    await expect(client.follow("/api/event", {}, parseEvent2Block, () => undefined, () => undefined)).rejects.toMatchObject({ status: 503, path: "/api/event", body: "no" });
  });
});

describe("history", () => {
  const session = (fake: FakeOpenCode2, id: string, extra: Record<string, unknown> = {}) => fake.addSession({ id, directory: DIR, ...extra } as Parameters<FakeOpenCode2["addSession"]>[0]);
  const sessionQueries = (fake: FakeOpenCode2, mark: number) => since(fake, mark).filter((request) => route(request) === "GET /api/session").map((request) => request.query);

  /** The fake's cursor does not carry the first request's limit, a real server's does; add it. */
  function cursorKeepsLimit() {
    const sent: Array<{ path: string; query: Record<string, string> }> = [];
    const limits = new Map<string, string>();
    const fetcher: typeof globalThis.fetch = async (input, init) => {
      const url = new URL(String(input));
      if ((init?.method ?? "GET") === "GET") {
        sent.push({ path: url.pathname, query: Object.fromEntries(url.searchParams) });
        const limit = url.searchParams.get("limit");
        if (limit && !url.searchParams.get("cursor") && !url.searchParams.get("type")) limits.set(url.pathname, limit);
        else if (url.searchParams.get("cursor") && !limit && limits.has(url.pathname)) url.searchParams.set("limit", limits.get(url.pathname)!);
      }
      return globalThis.fetch(url, init);
    };
    return { fetch: fetcher, sent };
  }

  it("lists sessions newest first and maps their fields", async () => {
    const { fake, api } = await setup();
    session(fake, "ses_new", { title: "One", directory: "/a", cost: 1.5, tokens: { ...ZERO, input: 9 }, time: { created: 100, updated: 300 } });
    session(fake, "ses_child", { parentID: "ses_new", directory: "/a", time: { created: 150, updated: 200 } });
    session(fake, "ses_old", { directory: "/b", title: "Old", time: { created: 10, updated: 100, archived: 150 } });
    let mark = fake.requests.length;
    const all = await api.listHistory({});
    expect(sessionQueries(fake, mark)).toEqual([{ limit: "50", order: "desc" }]);
    expect(all).toEqual([
      { id: "ses_new", directory: "/a", title: "One", updatedAt: 300, createdAt: 100, tokens: { ...ZERO, input: 9 }, cost: 1.5 },
      { id: "ses_child", directory: "/a", parentId: "ses_new", updatedAt: 200, createdAt: 150, tokens: ZERO, cost: 0 },
      { id: "ses_old", directory: "/b", title: "Old", archived: true, updatedAt: 100, createdAt: 10, tokens: ZERO, cost: 0 },
    ]);
    expect(all[0]).not.toHaveProperty("archived");
    expect(all[0]).not.toHaveProperty("parentId");
    expect(all[1]).not.toHaveProperty("title");

    mark = fake.requests.length;
    const roots = await api.listHistory({ roots: true, limit: 10 });
    expect(sessionQueries(fake, mark)).toEqual([{ limit: "10", order: "desc", parentID: "null" }]);
    expect(roots.map((entry) => entry.id)).toEqual(["ses_new", "ses_old"]);
  });

  it("takes the folder from the session's location", async () => {
    const { fake, api } = await setup();
    session(fake, "ses_x", { directory: "/some/where" });
    expect((await api.listHistory({}))[0]!.directory).toBe("/some/where");
  });

  it("pages with the cursor until the limit, and stops at a short page", async () => {
    const shim = cursorKeepsLimit();
    const { fake, api } = await setup({}, { fetch: shim.fetch });
    for (let index = 1; index <= 250; index += 1) session(fake, `ses_${String(index).padStart(3, "0")}`, { time: { created: index, updated: index } });

    let from = shim.sent.length;
    const full = await api.listHistory({ limit: 300 });
    let queries = shim.sent.slice(from).filter((request) => request.path === "/api/session").map((request) => request.query);
    expect(queries).toHaveLength(2);
    expect(queries[0]).toEqual({ limit: "200", order: "desc" });
    expect(Object.keys(queries[1]!)).toEqual(["cursor"]);
    expect(full).toHaveLength(250);
    expect(full[0]!.id).toBe("ses_250");
    expect(full.at(-1)!.id).toBe("ses_001");

    from = shim.sent.length;
    const exact = await api.listHistory({ limit: 250 });
    queries = shim.sent.slice(from).filter((request) => request.path === "/api/session").map((request) => request.query);
    expect(queries).toHaveLength(2);
    expect(exact).toHaveLength(250);

    from = shim.sent.length;
    const some = await api.listHistory({ limit: 120 });
    queries = shim.sent.slice(from).filter((request) => request.path === "/api/session").map((request) => request.query);
    expect(queries).toEqual([{ limit: "120", order: "desc" }]);
    expect(some.map((entry) => entry.id)).toEqual(full.slice(0, 120).map((entry) => entry.id));
  });

  const user = (id: string, text: string, created: number) => ({ id, type: "user", text, time: { created } });
  const assistant = (id: string, content: unknown[], created: number, model?: { id: string; providerID: string }) => ({ id, type: "assistant", content, time: { created }, ...(model ? { model } : {}) });
  const words = (value: string) => ({ type: "text", text: value });

  it("lists user text and assistant text, merging assistants and skipping tool-only ones", async () => {
    const { fake, api } = await setup();
    session(fake, "ses_h", { messages: [
      user("m1", "  hi  ", 10),
      assistant("m2", [{ type: "reasoning", text: "hmm" }, words(" hello "), { type: "tool", id: "t1" }], 20, { id: "m-one", providerID: "p" }),
      assistant("m3", [{ type: "tool", id: "t2" }], 30, { id: "m-two", providerID: "p" }),
      assistant("m4", [words("more")], 40, { id: "m-two", providerID: "p" }),
      { id: "m5", type: "synthetic", text: "ignored", time: { created: 45 } },
      { id: "m6", type: "model-switched", time: { created: 46 } },
      user("m7", "   ", 50),
      user("m8", "again", 60),
      assistant("m9", [words("x"), words("y"), words("  ")], 70, { id: "m-three", providerID: "q" }),
      { id: "m10", type: "idle", outcome: "succeeded", time: { created: 80 } },
    ] });
    const mark = fake.requests.length;
    await expect(api.historyMessages(DIR, "ses_h")).resolves.toEqual({
      messages: [
        { role: "user", text: "hi", timestamp: 10 },
        { role: "assistant", text: "hello\n\nmore", timestamp: 20 },
        { role: "user", text: "again", timestamp: 60 },
        { role: "assistant", text: "x\n\ny", timestamp: 70 },
      ],
      model: { provider: "q", id: "m-three" },
    });
    expect(since(fake, mark).map((request) => [route(request), request.query])).toEqual([["GET /api/session/ses_h/message", { limit: "200", order: "desc" }]]);
  });

  it("answers no model when no assistant message names one, and nothing for an empty session", async () => {
    const { fake, api } = await setup();
    session(fake, "ses_e", { messages: [user("m1", "hi", 1)] });
    session(fake, "ses_empty");
    const transcript = await api.historyMessages(DIR, "ses_e");
    expect(transcript).toEqual({ messages: [{ role: "user", text: "hi", timestamp: 1 }] });
    expect(transcript).not.toHaveProperty("model");
    await expect(api.historyMessages(DIR, "ses_empty")).resolves.toEqual({ messages: [] });
    await expect(api.historyMessages(DIR, "ses_none")).rejects.toMatchObject({ status: 404 });
  });

  /** Messages m000..: user on even indexes, assistant on odd ones, the first user text "first". */
  const conversation = (count: number) => Array.from({ length: count }, (_, index) => {
    const id = `m${String(index).padStart(3, "0")}`;
    return index % 2 === 0 ? user(id, index === 0 ? "first" : `q${index}`, index + 1) : assistant(id, [words(`a${index}`)], index + 1, { id: "m", providerID: "p" });
  });

  it("reads a conversation of 450 messages in three pages, in order, without a separate first message", async () => {
    const shim = cursorKeepsLimit();
    const { fake, api } = await setup({}, { fetch: shim.fetch });
    session(fake, "ses_450", { messages: conversation(450) });
    const from = shim.sent.length;
    const { messages } = await api.historyMessages(DIR, "ses_450");
    const queries = shim.sent.slice(from).map((request) => request.query);
    expect(queries).toHaveLength(3);
    expect(queries[0]).toEqual({ limit: "200", order: "desc" });
    expect(queries.slice(1).every((query) => Object.keys(query).join() === "cursor")).toBe(true);
    expect(messages).toHaveLength(450);
    expect(messages[0]).toEqual({ role: "user", text: "first", timestamp: 1 });
    expect(messages.at(-1)).toEqual({ role: "assistant", text: "a449", timestamp: 450 });
    expect(messages.map((message) => message.timestamp)).toEqual(Array.from({ length: 450 }, (_, index) => index + 1));
  });

  it("keeps the newest 800 messages of a longer conversation, in order, with the first user message in front", async () => {
    const shim = cursorKeepsLimit();
    const { fake, api } = await setup({}, { fetch: shim.fetch });
    session(fake, "ses_850", { messages: conversation(850) });
    const from = shim.sent.length;
    const { messages, model } = await api.historyMessages(DIR, "ses_850");
    const queries = shim.sent.slice(from).map((request) => request.query);
    expect(queries).toHaveLength(5);
    expect(queries[0]).toEqual({ limit: "200", order: "desc" });
    expect(queries.slice(1, 4).every((query) => Object.keys(query).join() === "cursor")).toBe(true);
    expect(queries[4]).toEqual({ limit: "20", order: "asc", type: "user" });
    expect(messages).toHaveLength(801);
    expect(messages[0]).toEqual({ role: "user", text: "first", timestamp: 1 });
    expect(messages[1]).toEqual({ role: "user", text: "q50", timestamp: 51 });
    expect(messages.at(-1)).toEqual({ role: "assistant", text: "a849", timestamp: 850 });
    const stamps = messages.slice(1).map((message) => message.timestamp);
    expect(stamps).toEqual(Array.from({ length: 800 }, (_, index) => index + 51));
    expect(model).toEqual({ provider: "p", id: "m" });
  });

  it("does not repeat the first message when the newest 800 already hold it", async () => {
    const shim = cursorKeepsLimit();
    const { fake, api } = await setup({}, { fetch: shim.fetch });
    session(fake, "ses_800", { messages: conversation(800) });
    const from = shim.sent.length;
    const { messages } = await api.historyMessages(DIR, "ses_800");
    expect(shim.sent.slice(from).map((request) => request.query).at(-1)).toEqual({ limit: "20", order: "asc", type: "user" });
    expect(messages).toHaveLength(800);
    expect(messages.filter((message) => message.text === "first")).toHaveLength(1);
  });
});

describe("waiting for MCP tools", () => {
  const entry = (name: string, status: string) => ({ name, status: { status } });
  const mcpCalls = (fake: FakeOpenCode2, mark: number) => since(fake, mark).filter((request) => route(request) === "GET /api/mcp");

  it("returns at once when the server is connected, asking for the folder's servers", async () => {
    const { fake, api, sleeps } = await setup({ mcp: [entry("tau", "connected")] });
    const mark = fake.requests.length;
    await api.awaitTools(DIR, ["tau"]);
    expect(mcpCalls(fake, mark).map((request) => request.query)).toEqual([{ [LOC]: DIR }]);
    expect(sleeps).toEqual([]);
  });

  it("counts a failed server as settled, and looks at the named servers only", async () => {
    const { fake, api, sleeps } = await setup({ mcp: [entry("other", "pending"), entry("tau", "failed")] });
    const mark = fake.requests.length;
    await api.awaitTools(DIR, ["tau"]);
    expect(mcpCalls(fake, mark)).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });

  it("returns at once for no servers", async () => {
    const { fake, api, sleeps } = await setup();
    const mark = fake.requests.length;
    await api.awaitTools(DIR, []);
    expect(mcpCalls(fake, mark)).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });

  it("keeps polling while the server is pending", async () => {
    const mcp = [entry("tau", "pending")];
    const { fake, api, sleeps } = await setup({ mcp }, { onSleep: (count) => { if (count === 2) mcp[0]!.status.status = "connected"; } });
    const mark = fake.requests.length;
    await api.awaitTools(DIR, ["tau"]);
    expect(mcpCalls(fake, mark)).toHaveLength(3);
    expect(sleeps).toEqual([250, 250]);
  });

  it("keeps polling while the server is not listed yet", async () => {
    const mcp: Array<ReturnType<typeof entry>> = [];
    const { fake, api, sleeps } = await setup({ mcp }, { onSleep: (count) => { if (count === 3) mcp.push(entry("tau", "connected")); } });
    const mark = fake.requests.length;
    await api.awaitTools(DIR, ["tau"]);
    expect(mcpCalls(fake, mark)).toHaveLength(4);
    expect(sleeps).toHaveLength(3);
  });

  it("waits for every named server", async () => {
    const mcp = [entry("tau", "connected"), entry("docs", "pending")];
    const { fake, api, sleeps } = await setup({ mcp }, { onSleep: (count) => { if (count === 1) mcp[1]!.status.status = "failed"; } });
    const mark = fake.requests.length;
    await api.awaitTools(DIR, ["tau", "docs"]);
    expect(mcpCalls(fake, mark)).toHaveLength(2);
    expect(sleeps).toEqual([250]);
  });

  it("polls again after a failed request", async () => {
    let failed = false;
    const fetcher: typeof globalThis.fetch = async (input, init) => {
      if (new URL(String(input)).pathname === "/api/mcp" && !failed) { failed = true; return new Response("boom", { status: 500 }); }
      return globalThis.fetch(input, init);
    };
    const { api, sleeps } = await setup({ mcp: [entry("tau", "connected")] }, { fetch: fetcher });
    await api.awaitTools(DIR, ["tau"]);
    expect(failed).toBe(true);
    expect(sleeps).toEqual([250]);
  });

  it("gives up after forty tries without throwing", async () => {
    const { fake, api, sleeps } = await setup({ mcp: [entry("tau", "pending")] });
    const mark = fake.requests.length;
    await expect(api.awaitTools(DIR, ["tau"])).resolves.toBeUndefined();
    expect(mcpCalls(fake, mark)).toHaveLength(40);
    expect(sleeps).toEqual(Array(40).fill(250));
  });
});
